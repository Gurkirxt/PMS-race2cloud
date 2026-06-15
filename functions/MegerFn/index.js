"use strict";

const catalyst = require("zcatalyst-sdk-node");
const { Readable } = require("stream");
const { runFifoForLots } = require("./fifo.js");

const REBUILD_BATCH = 400;

async function queueRebuildHoldingsJobs(catalystApp, accountCodes, source, isins) {
  const uniq = [...new Set(accountCodes)]
    .map((a) => String(a || "").trim())
    .filter(Boolean);
  if (!uniq.length) return;

  /* Scope the rebuild to the ISIN(s) this merger touched. Without this the
     downstream RebuildHoldingtable re-derives EVERY ISIN for EVERY account,
     which blows past the 15-min Catalyst timeout once the book is large. */
  const scopedIsins = [...new Set(isins || [])]
    .map((i) => String(i || "").trim().toUpperCase())
    .filter(Boolean);

  const scheduling = catalystApp.jobScheduling();
  for (let i = 0; i < uniq.length; i += REBUILD_BATCH) {
    const chunk = uniq.slice(i, i + REBUILD_BATCH);
    const catalystJobName = `H${Date.now()}${i}`.slice(0, 20);
    await scheduling.JOB.submitJob({
      job_name: catalystJobName,
      jobpool_name: "CorporateActions",
      target_name: "RebuildHoldingtable",
      target_type: "Function",
      /* Catalyst Job Pool: retries only on execution failure. Min interval 1m. */
      job_config: {
        number_of_retries: 5,
        retry_interval: 60 * 1000,
      },
      params: {
        accountCodesJson: JSON.stringify(chunk),
        source,
        ...(scopedIsins.length
          ? { isinsJson: JSON.stringify(scopedIsins) }
          : {}),
      },
    });
  }
}

const ZCQL_ROW_LIMIT = 270;
const STRATUS_BUCKET = "upload-data-bucket";
const BULK_WRITE_MAX = 50000;
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_WAIT_MS = 10 * 60 * 1000;
const MERGER_TRAN_TYPE = "MERGER";

/** Written to JobStatusPerAccount.jobType (override via params.jobType). */
const MERGER_JOB_TYPE_DEFAULT = "MERGER_APPLY";

const esc = (v) => String(v ?? "").replace(/'/g, "''");

function rowFromJobStatusRow(r) {
  if (!r) return null;
  return r.JobStatusPerAccount || r;
}

async function getPerAccountJobStatus(zcql, jobName, accountCode) {
  try {
    const rows = await zcql.executeZCQLQuery(`
      SELECT status FROM JobStatusPerAccount
      WHERE jobName = '${esc(jobName)}' AND WS_Account_code = '${esc(accountCode)}'
      LIMIT 1
    `);
    if (!rows?.length) return "";
    const st = rowFromJobStatusRow(rows[0]);
    return String(st?.status ?? "").trim();
  } catch (e) {
    console.warn("[MegerFn][JobStatusPerAccount] read failed:", e.message);
    return "";
  }
}

async function upsertAccountRowRunning(zcql, jobName, jobType, accountCode) {
  try {
    await zcql.executeZCQLQuery(`
      INSERT INTO JobStatusPerAccount (jobType, WS_Account_code, status, lastError, jobName)
      VALUES (
        '${esc(jobType)}',
        '${esc(accountCode)}',
        'RUNNING',
        '',
        '${esc(jobName)}'
      )
    `);
  } catch (insertErr) {
    try {
      await zcql.executeZCQLQuery(`
        UPDATE JobStatusPerAccount
        SET status = 'RUNNING', lastError = '', jobType = '${esc(jobType)}'
        WHERE jobName = '${esc(jobName)}' AND WS_Account_code = '${esc(accountCode)}'
      `);
    } catch (upErr) {
      console.warn(
        `[MegerFn][JobStatusPerAccount] upsert RUNNING failed ${accountCode}:`,
        upErr.message,
      );
    }
  }
}

async function markAccountSuccess(zcql, jobName, accountCode) {
  try {
    await zcql.executeZCQLQuery(`
      UPDATE JobStatusPerAccount
      SET status = 'SUCCESS', lastError = ''
      WHERE jobName = '${esc(jobName)}' AND WS_Account_code = '${esc(accountCode)}'
    `);
  } catch (e) {
    console.warn(`[MegerFn][JobStatusPerAccount] SUCCESS failed ${accountCode}:`, e.message);
  }
}

async function markAccountFailed(zcql, jobName, accountCode, errMsg) {
  const msg = esc(String(errMsg || "UNKNOWN").slice(0, 500));
  try {
    await zcql.executeZCQLQuery(`
      UPDATE JobStatusPerAccount
      SET status = 'FAILED', lastError = '${msg}'
      WHERE jobName = '${esc(jobName)}' AND WS_Account_code = '${esc(accountCode)}'
    `);
  } catch (e) {
    console.warn(`[MegerFn][JobStatusPerAccount] FAILED failed ${accountCode}:`, e.message);
  }
}

/** Safe on retry: skip INSERT when header row already exists for this event. */
async function ensureMergerRecordHeader(zcql, payload) {
  const {
    newIsin,
    secCode,
    secName,
    oldIsin,
    r1,
    r2,
    effectiveDateIso,
  } = payload;
  const existing = await zcql.executeZCQLQuery(`
    SELECT ROWID FROM Merger_Record
    WHERE OldISIN = '${esc(oldIsin)}' AND ISIN = '${esc(newIsin)}'
      AND TRANDATE = '${esc(effectiveDateIso)}'
    LIMIT 1
  `);
  if (existing?.length) {
    console.log("[MegerFn] Merger_Record header already exists — skip INSERT (retry)");
    return true;
  }
  await zcql.executeZCQLQuery(`
    INSERT INTO Merger_Record
    (
      ISIN,
      Security_Code,
      Security_Name,
      OldISIN,
      Ratio1,
      Ratio2,
      TRANDATE,
      SETDATE
    )
    VALUES
    (
      '${esc(newIsin)}',
      '${esc(secCode)}',
      '${esc(secName)}',
      '${esc(oldIsin)}',
      ${r1},
      ${r2},
      '${esc(effectiveDateIso)}',
      '${esc(effectiveDateIso)}'
    )
  `);
  return true;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildMergerCsv(rows) {
  const header = [
    "ISIN",
    "SecurityCode",
    "Security_Name",
    "WS_Account_code",
    "Holding",
    "OldISIN",
    "WAP",
    "Total_Amount",
    "TRANDATE",
    "SETDATE",
    "Record_Date",
    "Tran_Type",
    "Quantity",
    "HoldingValue",
    "Source_Tran_ROWID",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.ISIN,
        r.SecurityCode,
        r.Security_Name,
        r.WS_Account_code,
        r.Holding,
        r.OldISIN,
        r.WAP,
        r.Total_Amount,
        r.TRANDATE,
        r.SETDATE,
        r.Record_Date,
        r.Tran_Type,
        r.Quantity,
        r.HoldingValue,
        r.Source_Tran_ROWID || "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n");
}

async function pollBulkWriteJob(bulkWrite, jobId) {
  const start = Date.now();
  while (Date.now() - start < POLL_MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const res = await bulkWrite.getStatus(jobId);
      const st = String(res.status || "").toUpperCase();
      console.log(`[MegerFn] Bulk write ${jobId} status: ${st}`);
      if (st === "COMPLETED") return res;
      if (st === "FAILED")
        throw new Error(`Bulk write job ${jobId} failed: ${JSON.stringify(res)}`);
    } catch (err) {
      if (err.message?.includes("failed")) throw err;
      console.error(`[MegerFn] Error polling bulk job ${jobId}:`, err);
    }
  }
  throw new Error(`Bulk write job ${jobId} timed out after ${POLL_MAX_WAIT_MS}ms`);
}

async function fetchAccountsForOldIsin(zcql, oldIsin) {
  const accountSet = new Set();
  let offset = 0;
  while (true) {
    const batch = await zcql.executeZCQLQuery(`
      SELECT WS_Account_code
      FROM Transaction
      WHERE ISIN = '${esc(oldIsin)}'
      LIMIT ${ZCQL_ROW_LIMIT} OFFSET ${offset}
    `);
    if (!batch || !batch.length) break;
    for (const r of batch) {
      const acc = (r.Transaction || r).WS_Account_code;
      if (acc) accountSet.add(acc);
    }
    if (batch.length < ZCQL_ROW_LIMIT) break;
    offset += ZCQL_ROW_LIMIT;
  }
  return accountSet;
}

function nextDayIso(asOnDateISO) {
  const d = new Date(asOnDateISO);
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

async function fetchAllForIsinAsOnDate({ zcql, table, isin, dateColumn, asOnDateISO }) {
  const cutoff = nextDayIso(asOnDateISO);
  const out = [];
  const seen = new Set();
  let offset = 0;
  while (true) {
    const batch = await zcql.executeZCQLQuery(`
      SELECT *
      FROM ${table}
      WHERE ISIN = '${esc(isin)}' AND ${dateColumn} < '${esc(cutoff)}'
      ORDER BY ROWID ASC
      LIMIT ${ZCQL_ROW_LIMIT} OFFSET ${offset}
    `);
    if (!batch || !batch.length) break;
    for (const row of batch) {
      const rec = row[table] || row;
      const rowId = rec.ROWID;
      if (rowId != null && seen.has(rowId)) continue;
      if (rowId != null) seen.add(rowId);
      out.push(rec);
    }
    if (batch.length < ZCQL_ROW_LIMIT) break;
    offset += ZCQL_ROW_LIMIT;
  }
  return out;
}

/** Transactions need both TRANDATE and SETDATE compared (matches existing analytics filter). */
async function fetchTransactionsForIsinAsOnDate({ zcql, isin, asOnDateISO }) {
  const cutoff = nextDayIso(asOnDateISO);
  const out = [];
  const seen = new Set();
  let offset = 0;
  while (true) {
    const batch = await zcql.executeZCQLQuery(`
      SELECT *
      FROM Transaction
      WHERE ISIN = '${esc(isin)}'
        AND (TRANDATE < '${esc(cutoff)}' OR SETDATE < '${esc(cutoff)}')
      ORDER BY ROWID ASC
      LIMIT ${ZCQL_ROW_LIMIT} OFFSET ${offset}
    `);
    if (!batch || !batch.length) break;
    for (const row of batch) {
      const rec = row.Transaction || row;
      const rowId = rec.ROWID;
      if (rowId != null && seen.has(rowId)) continue;
      if (rowId != null) seen.add(rowId);
      out.push(rec);
    }
    if (batch.length < ZCQL_ROW_LIMIT) break;
    offset += ZCQL_ROW_LIMIT;
  }
  return out;
}

async function ensureSecurityListForNewIsin(zcql, newIsin, secCode, secName) {
  try {
    const existing = await zcql.executeZCQLQuery(`
      SELECT ROWID FROM Security_List WHERE ISIN = '${esc(newIsin)}' LIMIT 1
    `);
    if (existing?.length) {
      await zcql.executeZCQLQuery(`
        UPDATE Security_List
        SET Security_Code = '${esc(secCode)}', Security_Name = '${esc(secName)}'
        WHERE ISIN = '${esc(newIsin)}'
      `);
      return { action: "updated" };
    }
    await zcql.executeZCQLQuery(`
      INSERT INTO Security_List (Security_Code, ISIN, Security_Name)
      VALUES ('${esc(secCode)}', '${esc(newIsin)}', '${esc(secName)}')
    `);
    return { action: "inserted" };
  } catch (err) {
    console.warn("[MegerFn] Security_List update/insert failed:", err.message);
    return { action: "skipped", error: err.message };
  }
}

async function setJobStatus(zcql, jobName, status) {
  if (!jobName) return;
  try {
    await zcql.executeZCQLQuery(
      `UPDATE Jobs SET status = '${esc(status)}' WHERE jobName = '${esc(jobName)}'`,
    );
  } catch (err) {
    console.error(`[MegerFn] Failed to set status ${status}:`, err.message);
  }
}

module.exports = async (jobRequest, context) => {
  const catalystApp = catalyst.initialize(context);
  const zcql = catalystApp.zcql();
  const stratus = catalystApp.stratus();
  const datastore = catalystApp.datastore();

  let jobName = "";
  const startedAt = Date.now();

  try {
    const params = jobRequest.getAllJobParams();
    jobName = params.jobName || "";
    const mergerJobType =
      String(params.jobType || "").trim() || MERGER_JOB_TYPE_DEFAULT;
    const trackingOn = Boolean(String(jobName || "").trim());
    const oldIsin = String(params.oldIsin || "").trim().toUpperCase();
    const newIsin = String(params.newIsin || "").trim().toUpperCase();
    const secCode = String(params.secCode || "").trim() || newIsin;
    const secName = String(params.secName || "").trim() || `Merged ${newIsin}`;
    const r1 = Number(params.ratio1);
    const r2 = Number(params.ratio2);
    const recordDateIso = String(params.recordDateIso || "").trim();
    const effectiveDateIso =
      String(params.effectiveDateIso || "").trim() || recordDateIso;

    console.log("[MegerFn] Started", {
      jobName,
      mergerJobType,
      jobStatusTracking: trackingOn,
      oldIsin,
      newIsin,
      r1,
      r2,
      recordDateIso,
      effectiveDateIso,
    });

    try {
      await zcql.executeZCQLQuery(
        `INSERT INTO Jobs (jobName, status) VALUES ('${esc(jobName)}', 'RUNNING')`,
      );
    } catch (insertErr) {
      console.warn(
        "[MegerFn] Jobs row insert failed (may already exist):",
        insertErr.message,
      );
      await setJobStatus(zcql, jobName, "RUNNING");
    }

    if (
      !oldIsin ||
      !newIsin ||
      oldIsin === newIsin ||
      !Number.isFinite(r1) ||
      !Number.isFinite(r2) ||
      r1 <= 0 ||
      r2 <= 0 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(recordDateIso)
    ) {
      console.error("[MegerFn] Invalid params");
      await setJobStatus(zcql, jobName, "FAILED");
      context.closeWithFailure();
      return;
    }

    const accountSet = await fetchAccountsForOldIsin(zcql, oldIsin);
    const accounts = Array.from(accountSet);
    console.log(`[MegerFn] Eligible accounts: ${accounts.length}`);

    if (!accounts.length) {
      await setJobStatus(zcql, jobName, "COMPLETED");
      context.closeWithSuccess();
      return;
    }

    const txRows = await fetchTransactionsForIsinAsOnDate({
      zcql,
      isin: oldIsin,
      asOnDateISO: recordDateIso,
    });
    const bonusRows = await fetchAllForIsinAsOnDate({
      zcql,
      table: "Bonus",
      isin: oldIsin,
      dateColumn: "ExDate",
      asOnDateISO: recordDateIso,
    });
    const splitRows = await fetchAllForIsinAsOnDate({
      zcql,
      table: "Split",
      isin: oldIsin,
      dateColumn: "Issue_Date",
      asOnDateISO: recordDateIso,
    });
    const demergerRowsAll = await fetchAllForIsinAsOnDate({
      zcql,
      table: "Demerger_Record",
      isin: oldIsin,
      dateColumn: "TRANDATE",
      asOnDateISO: recordDateIso,
    });
    const priorMergerRowsAll = await fetchAllForIsinAsOnDate({
      zcql,
      table: "Merger",
      isin: oldIsin,
      dateColumn: "TRANDATE",
      asOnDateISO: recordDateIso,
    });

    console.log(
      `[MegerFn] Loaded tx=${txRows.length} bonus=${bonusRows.length} split=${splitRows.length} demerger=${demergerRowsAll.length} priorMerger=${priorMergerRowsAll.length}`,
    );

    const txByAcc = {};
    for (const t of txRows) {
      const acc = t.WS_Account_code;
      if (!acc) continue;
      (txByAcc[acc] ||= []).push(t);
    }

    const bonusByAcc = {};
    for (const b of bonusRows) {
      const acc = b.WS_Account_code;
      if (!acc) continue;
      (bonusByAcc[acc] ||= []).push(b);
    }

    const demergerByAcc = {};
    for (const d of demergerRowsAll) {
      const acc = d.WS_Account_code;
      if (!acc) continue;
      if (String(d.Tran_Type || d.tran_type || "").toUpperCase() !== "DEMERGER") continue;
      (demergerByAcc[acc] ||= []).push(d);
    }

    const priorMergerByAcc = {};
    for (const m of priorMergerRowsAll) {
      const acc = m.WS_Account_code;
      if (!acc) continue;
      (priorMergerByAcc[acc] ||= []).push(m);
    }

    const splits = splitRows.map((s) => ({
      issueDate: s.Issue_Date,
      ratio1: Number(s.Ratio1) || 0,
      ratio2: Number(s.Ratio2) || 0,
      isin: s.ISIN,
    }));

    const mergerInsertRows = [];
    let totalSurvivingLots = 0;
    let totalNewQty = 0;
    let totalCarriedCost = 0;
    let skippedAccounts = 0;
    let skippedZeroLots = 0;
    let skippedCostBasis = 0;

    let trackingFailures = 0;

    for (const accountCode of accounts) {
      if (trackingOn) {
        const prev = await getPerAccountJobStatus(zcql, jobName, accountCode);
        if (prev === "SUCCESS") {
          console.log(
            `[MegerFn] skip ${accountCode} — JobStatusPerAccount already SUCCESS`,
          );
          continue;
        }
        await upsertAccountRowRunning(
          zcql,
          jobName,
          mergerJobType,
          accountCode,
        );
      }

      const tx = txByAcc[accountCode] || [];
      if (!tx.length) {
        skippedAccounts++;
        if (trackingOn) await markAccountSuccess(zcql, jobName, accountCode);
        continue;
      }
      const bonuses = bonusByAcc[accountCode] || [];
      const demergers = demergerByAcc[accountCode] || [];
      const priorMergers = priorMergerByAcc[accountCode] || [];

      let fifo;
      if (trackingOn) {
        try {
          fifo = runFifoForLots(
            tx,
            bonuses,
            splits,
            demergers,
            priorMergers,
            "openLots",
          );
        } catch (err) {
          console.error(`[MegerFn][${accountCode}] FIFO failed:`, err.message);
          await markAccountFailed(zcql, jobName, accountCode, err.message);
          trackingFailures++;
          continue;
        }
      } else {
        fifo = runFifoForLots(
          tx,
          bonuses,
          splits,
          demergers,
          priorMergers,
          "openLots",
        );
      }

      if (!fifo || !Array.isArray(fifo.openLots) || !fifo.openLots.length) {
        skippedAccounts++;
        if (trackingOn) await markAccountSuccess(zcql, jobName, accountCode);
        continue;
      }

      let accountHadMergerRow = false;
      for (const lot of fifo.openLots) {
        const lotQty = Number(lot.qty) || 0;
        if (lotQty <= 0) continue;

        const newQty = Math.floor((lotQty * r1) / r2);
        const lotCost = Number(lot.totalCost) || 0;

        if (newQty <= 0) {
          skippedZeroLots++;
          skippedCostBasis += lotCost;
          continue;
        }

        accountHadMergerRow = true;
        const lotWap = newQty > 0 ? lotCost / newQty : 0;

        mergerInsertRows.push({
          ISIN: newIsin,
          SecurityCode: secCode,
          Security_Name: secName,
          WS_Account_code: accountCode,
          Holding: newQty,
          OldISIN: oldIsin,
          WAP: lotWap.toFixed(6),
          Total_Amount: lotCost.toFixed(6),
          // Preserve the original lot's trade/settlement dates on the new ISIN
          // (so the merged holding shows the same dates as in the old ISIN).
          TRANDATE: lot.originalTrandate || effectiveDateIso,
          SETDATE: lot.originalSetdate || lot.originalTrandate || effectiveDateIso,
          Record_Date: recordDateIso,
          Tran_Type: MERGER_TRAN_TYPE,
          Quantity: newQty,
          HoldingValue: lotCost.toFixed(6),
          Source_Tran_ROWID:
            lot.sourceType === "TXN" ? String(lot.sourceRowId || "") : "",
        });

        totalSurvivingLots++;
        totalNewQty += newQty;
        totalCarriedCost += lotCost;
      }

      if (trackingOn && !accountHadMergerRow) {
        await markAccountSuccess(zcql, jobName, accountCode);
      }
    }

    console.log(
      `[MegerFn] Built ${mergerInsertRows.length} merger rows ` +
        `(skippedAccounts=${skippedAccounts}, skippedZeroLots=${skippedZeroLots}, skippedCostBasis=${skippedCostBasis.toFixed(2)})`,
    );

    if (!mergerInsertRows.length) {
      console.log("[MegerFn] Nothing to insert; closing as COMPLETED.");
      await setJobStatus(
        zcql,
        jobName,
        trackingOn && trackingFailures > 0 ? "FAILED" : "COMPLETED",
      );
      context.closeWithSuccess();
      return;
    }

    const slResult = await ensureSecurityListForNewIsin(zcql, newIsin, secCode, secName);
    console.log("[MegerFn] Security_List:", slResult);

    try {
      await ensureMergerRecordHeader(zcql, {
        newIsin,
        secCode,
        secName,
        oldIsin,
        r1,
        r2,
        effectiveDateIso,
      });
    } catch (recordErr) {
      console.error("[MegerFn] Merger_Record insert failed:", recordErr.message);
      await setJobStatus(zcql, jobName, "FAILED");
      context.closeWithFailure();
      return;
    }

    const bucket = stratus.bucket(STRATUS_BUCKET);
    const timestamp = Date.now();
    const csvFiles = [];

    for (let start = 0; start < mergerInsertRows.length; start += BULK_WRITE_MAX) {
      const chunk = mergerInsertRows.slice(start, start + BULK_WRITE_MAX);
      const idx = Math.floor(start / BULK_WRITE_MAX);
      const fileName = `merger-apply/Merger_${jobName || newIsin}_${timestamp}_part${idx}.csv`;
      const csv = buildMergerCsv(chunk);
      const stream = Readable.from([csv]);

      console.log(
        `[MegerFn] Uploading CSV ${fileName} rows=${chunk.length} bytes=${csv.length}`,
      );
      await bucket.putObject(fileName, stream, {
        overwrite: true,
        contentType: "text/csv",
      });
      csvFiles.push(fileName);
    }

    for (let i = 0; i < csvFiles.length; i++) {
      const fileName = csvFiles[i];
      const bulkWrite = datastore.table("Merger").bulkJob("write");
      const job = await bulkWrite.createJob(
        { bucket_name: STRATUS_BUCKET, object_key: fileName },
        { operation: "insert" },
      );
      console.log(
        `[MegerFn] Created bulk job ${job.job_id} for ${fileName} (${i + 1}/${csvFiles.length})`,
      );
      await pollBulkWriteJob(bulkWrite, job.job_id);
    }

    const accountsAffectedSet = new Set();
    for (const r of mergerInsertRows) {
      const a = String(r.WS_Account_code ?? "").trim();
      if (a) accountsAffectedSet.add(a);
    }
    const accountsAffected = [...accountsAffectedSet].sort((x, y) =>
      x.localeCompare(y),
    );

    if (accountsAffected.length > 0) {
      try {
        await queueRebuildHoldingsJobs(
          catalystApp,
          accountsAffected,
          "MegerFn",
          [oldIsin, newIsin],
        );
        console.log(
          "[MegerFn] Queued RebuildHoldingtable for",
          accountsAffected.length,
          "account(s)",
        );
        if (trackingOn) {
          const okAccounts = new Set(
            accountsAffected.map((a) => String(a || "").trim()).filter(Boolean),
          );
          for (const ac of okAccounts) {
            await markAccountSuccess(zcql, jobName, ac);
          }
        }
      } catch (rbErr) {
        console.error("[MegerFn] Queue holdings rebuild failed:", rbErr);
        console.warn(
          "[MegerFn] Merger rows are persisted but Holdings rebuild was not queued — remediate manually if needed.",
        );
        await setJobStatus(zcql, jobName, "FAILED");
        context.closeWithFailure();
        return;
      }
    }

    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(
      `[MegerFn] Done. accounts=${accounts.length} lots=${totalSurvivingLots} ` +
        `newQty=${totalNewQty} carriedCost=${totalCarriedCost.toFixed(2)} elapsed=${elapsed}s`,
    );
    await setJobStatus(
      zcql,
      jobName,
      trackingOn && trackingFailures > 0 ? "FAILED" : "COMPLETED",
    );
    context.closeWithSuccess();
  } catch (error) {
    console.error("[MegerFn] FATAL:", error);
    await setJobStatus(zcql, jobName, "FAILED");
    context.closeWithFailure();
  }
};
