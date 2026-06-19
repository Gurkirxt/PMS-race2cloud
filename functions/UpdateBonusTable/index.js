const catalyst = require("zcatalyst-sdk-node");
const { runFifoEngine } = require("./fifo.js");

const ZCQL_ROW_LIMIT = 270;
const REBUILD_BATCH = 400;

/** Written to JobStatusPerAccount.jobType (override via params.jobType). */
const BONUS_JOB_TYPE_DEFAULT = "BONUS_APPLY";

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
    console.warn("[UpdateBonusTable][JobStatusPerAccount] read failed:", e.message);
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
        `[UpdateBonusTable][JobStatusPerAccount] upsert RUNNING failed ${accountCode}:`,
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
    console.warn(
      `[UpdateBonusTable][JobStatusPerAccount] SUCCESS failed ${accountCode}:`,
      e.message,
    );
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
    console.warn(
      `[UpdateBonusTable][JobStatusPerAccount] FAILED failed ${accountCode}:`,
      e.message,
    );
  }
}

/** Skip INSERT on retry if row already exists for this corporate-action key. */
async function bonusRowExists(zcql, isin, accountCode, exDateISO) {
  try {
    const rows = await zcql.executeZCQLQuery(`
      SELECT ROWID FROM Bonus
      WHERE ISIN = '${esc(isin)}'
        AND WS_Account_code = '${esc(accountCode)}'
        AND ExDate = '${esc(exDateISO)}'
      LIMIT 1
    `);
    return Boolean(rows?.length);
  } catch (e) {
    console.warn(`[UpdateBonusTable] bonusRowExists check failed:`, e.message);
    return false;
  }
}

async function ensureBonusRecord(zcql, { secCode, secName, isin, r1, r2, exDateISO }) {
  const existing = await zcql.executeZCQLQuery(`
    SELECT ROWID FROM Bonus_Record
    WHERE ISIN = '${esc(isin)}' AND ExDate = '${esc(exDateISO)}'
    LIMIT 1
  `);
  if (existing?.length) {
    console.log("[UpdateBonusTable] Bonus_Record already exists — skip INSERT (retry)");
    return;
  }
  await zcql.executeZCQLQuery(`
      INSERT INTO Bonus_Record
      (
        SecurityCode,
        SecurityName,
        ISIN,
        Ratio1,
        Ratio2,
        ExDate
      )
      VALUES
      (
        '${(secCode || "").replace(/'/g, "''")}',
        '${(secName || "").replace(/'/g, "''")}',
        '${esc(isin)}',
        ${r1},
        ${r2},
        '${esc(exDateISO)}'
      )
    `);
}

async function queueRebuildHoldingsJobs(catalystApp, accountCodes, source, isins) {
  const uniq = [...new Set(accountCodes)]
    .map((a) => String(a || "").trim())
    .filter(Boolean);
  if (!uniq.length) return;

  // Scope the rebuild to the affected ISIN(s) so each account only rebuilds
  // those ISIN(s) instead of its full holding set.
  const scopedIsins = [...new Set(isins || [])]
    .map((i) => String(i || "").trim())
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
        isinsJson: JSON.stringify(scopedIsins),
        source,
      },
    });
  }
}
/**
 * @param {import("./types/job").JobRequest} jobRequest
 * @param {import("./types/job").Context} context
 */
module.exports = async (jobRequest, context) => {
  const catalystApp = catalyst.initialize(context);
  const zcql = catalystApp.zcql();
  let jobName = "";

  try {
    console.log("Bonus apply job started");

    const params = jobRequest.getAllJobParams();
    const { isin, exDate, secCode, secName } = params;
    const r1 = Number(params.ratio1);
    const r2 = Number(params.ratio2);
    jobName = params.jobName;
    const bonusJobType =
      String(params.jobType || "").trim() || BONUS_JOB_TYPE_DEFAULT;
    const trackingOn = Boolean(String(jobName || "").trim());
    // Recompute mode: a split was uploaded on/after this bonus's ex-date, so the
    // previously stored BonusShare was sized on the pre-split holding and is now
    // stale. In this mode an existing Bonus row is OVERWRITTEN (not skipped) with
    // a freshly sized count. The split row already exists in the DB by the time
    // this runs, so the FIFO holding below is post-split.
    const recompute =
      String(params.recompute || "").trim().toLowerCase() === "true";

    try {
      await zcql.executeZCQLQuery(
        `INSERT INTO Jobs (jobName, status) VALUES ('${esc(jobName)}', 'PENDING')`,
      );
    } catch (insertJobErr) {
      await zcql.executeZCQLQuery(
        `UPDATE Jobs SET status = 'PENDING' WHERE jobName = '${esc(jobName)}'`,
      );
    }

    const exDateISO = exDate;

    console.log("[UpdateBonusTable]", {
      jobName,
      bonusJobType,
      jobStatusTracking: trackingOn,
      isin,
    });

    /* ======================================================
       STEP 1: FIND ACCOUNTS WITH TRANSACTIONS FOR THIS ISIN
       ====================================================== */
    const accountSet = new Set();
    let holdOffset = 0;

    while (true) {
      const batch = await zcql.executeZCQLQuery(`
        SELECT WS_Account_code
        FROM Transaction
        WHERE ISIN='${esc(isin)}'
        LIMIT ${ZCQL_ROW_LIMIT} OFFSET ${holdOffset}
      `);

      if (!batch || batch.length === 0) break;
      batch.forEach((r) => accountSet.add(r.Transaction.WS_Account_code));
      if (batch.length < ZCQL_ROW_LIMIT) break;
      holdOffset += ZCQL_ROW_LIMIT;
    }

    const eligibleAccounts = Array.from(accountSet);

    if (!eligibleAccounts.length) {
      console.log("No eligible accounts found");
      await zcql.executeZCQLQuery(
        `UPDATE Jobs SET status = 'COMPLETED' WHERE jobName = '${esc(jobName)}'`,
      );
      context.closeWithSuccess();
      return;
    }

    /* ======================================================

    STEP 2: FETCH TX / BONUS / SPLIT (ROWID dedupe — matches preview API)
       ====================================================== */
    const fetchAllDeduped = async (table, dateCol, operator, orderBySql) => {
      const out = [];
      const seenRowIds = new Set();
      let off = 0;
      while (true) {
        const r = await zcql.executeZCQLQuery(`
          SELECT *
          FROM ${table}
          WHERE ISIN='${esc(isin)}' AND ${dateCol} ${operator} '${esc(exDateISO)}'
          ORDER BY ${orderBySql}
          LIMIT ${ZCQL_ROW_LIMIT} OFFSET ${off}
        `);
        if (!r || r.length === 0) break;
        for (const row of r) {
          const rec = row[table] || row.Transaction || row.Bonus || row.Split || row;
          const rowId = rec.ROWID;
          if (rowId != null && seenRowIds.has(rowId)) continue;
          if (rowId != null) seenRowIds.add(rowId);
          out.push(row);
        }
        if (r.length < ZCQL_ROW_LIMIT) break;
        off += ZCQL_ROW_LIMIT;
      }
      return out;
    };

    const txRows = await fetchAllDeduped(
      "Transaction",
      "SETDATE",
      "<=",
      "SETDATE ASC, ROWID ASC"
    );
    const bonusRows = await fetchAllDeduped(
      "Bonus",
      "ExDate",
      "<=",
      "ExDate ASC, ROWID ASC"
    );
    const splitRows = await fetchAllDeduped(
      "Split",
      "Issue_Date",
      "<=",
      "Issue_Date ASC, ROWID ASC"
    );

    const txByAcc = {};
    txRows.forEach((r) => {
      const t = r.Transaction;
      (txByAcc[t.WS_Account_code] ||= []).push(t);
    });

    const bonusByAcc = {};
    bonusRows.forEach((r) => {
      const b = r.Bonus;
      (bonusByAcc[b.WS_Account_code] ||= []).push(b);
    });

    const splits = splitRows.map((r) => {
      const s = r.Split;
      return {
        issueDate: s.Issue_Date,
        ratio1: Number(s.Ratio1) || 0,
        ratio2: Number(s.Ratio2) || 0,
        isin: s.ISIN,
      };
    });

    /* ======================================================
       STEP 3: FIFO + INSERT BONUS (one per eligible account)
       ====================================================== */
    let inserted = 0;
    let errorCount = 0;
    const accountsRebuild = [];

    for (const accountCode of eligibleAccounts) {
      if (trackingOn) {
        const prev = await getPerAccountJobStatus(zcql, jobName, accountCode);
        if (prev === "SUCCESS") {
          console.log(
            `[UpdateBonusTable] skip ${accountCode} — JobStatusPerAccount already SUCCESS`,
          );
          continue;
        }
        await upsertAccountRowRunning(
          zcql,
          jobName,
          bonusJobType,
          accountCode,
        );
      }

      try {
        const tx = txByAcc[accountCode] || [];
        if (!tx.length) {
          if (trackingOn) await markAccountSuccess(zcql, jobName, accountCode);
          continue;
        }

        // Size this bonus on the holding BEFORE this bonus is added. Exclude any
        // Bonus row sharing this ex-date (only present on recompute, where the
        // stale row already exists) so the FIFO basis is the post-split holding,
        // not post-split + stale-bonus.
        const bonuses = (bonusByAcc[accountCode] || []).filter(
          (b) => String(b.ExDate || b.exDate || "").slice(0, 10) !== exDateISO,
        );

        const fifo = runFifoEngine(tx, bonuses, splits, true);
        if (!fifo || fifo.holdings <= 0) {
          if (trackingOn) await markAccountSuccess(zcql, jobName, accountCode);
          continue;
        }

        const bonusShares = Math.floor((fifo.holdings * r1) / r2);
        if (bonusShares <= 0) {
          if (trackingOn) await markAccountSuccess(zcql, jobName, accountCode);
          continue;
        }

        if (await bonusRowExists(zcql, isin, accountCode, exDateISO)) {
          if (recompute) {
            // Split-driven re-size: overwrite the stale (pre-split) BonusShare.
            await zcql.executeZCQLQuery(`
              UPDATE Bonus
              SET BonusShare = ${bonusShares}
              WHERE ISIN = '${esc(isin)}'
                AND WS_Account_code = '${esc(accountCode)}'
                AND ExDate = '${esc(exDateISO)}'
            `);
            console.log(
              `[UpdateBonusTable] Bonus recomputed for ${accountCode}: ${bonusShares} shares (post-split)`,
            );
          } else {
            console.log(
              `[UpdateBonusTable] Bonus row already present for ${accountCode} — idempotent`,
            );
          }
          if (trackingOn) await markAccountSuccess(zcql, jobName, accountCode);
          accountsRebuild.push(accountCode);
          inserted++;
          continue;
        }

        await zcql.executeZCQLQuery(`
          INSERT INTO Bonus
          (
            ISIN,
            SecurityCode,
            SecurityName,
            WS_Account_code,
            BonusShare,
            ExDate
          )
          VALUES
          (
            '${esc(isin)}',
            '${(secCode || "").replace(/'/g, "''")}',
            '${(secName || "").replace(/'/g, "''")}',
            '${esc(accountCode)}',
            ${bonusShares},
            '${esc(exDateISO)}'
          )
        `);

        inserted++;
        accountsRebuild.push(accountCode);
        console.log(`Bonus applied for ${accountCode}: ${bonusShares} shares`);

        if (trackingOn) await markAccountSuccess(zcql, jobName, accountCode);
      } catch (accountErr) {
        errorCount++;
        console.error(`Error applying bonus for ${accountCode}:`, accountErr);
        if (trackingOn) {
          await markAccountFailed(
            zcql,
            jobName,
            accountCode,
            accountErr.message,
          );
        }
      }
    }

    /* ======================================================
       STEP 4: BONUS_RECORD (master record, idempotent)
       ====================================================== */
    if (inserted > 0) {
      try {
        await ensureBonusRecord(zcql, {
          secCode,
          secName,
          isin,
          r1,
          r2,
          exDateISO,
        });
      } catch (recordErr) {
        console.error("Error inserting Bonus_Record:", recordErr);
      }
    }

    console.log(`Bonus job completed: ${inserted} accounts updated, ${errorCount} errors`);

    if (accountsRebuild.length > 0) {
      try {
        await queueRebuildHoldingsJobs(
          catalystApp,
          accountsRebuild,
          "UpdateBonusTable",
          [isin],
        );
        console.log(
          `Queued RebuildHoldingtable for ${accountsRebuild.length} account(s)`,
        );
      } catch (rebuildErr) {
        console.error("Failed to queue RebuildHoldingtable:", rebuildErr);
        await zcql.executeZCQLQuery(
          `UPDATE Jobs SET status = 'FAILED' WHERE jobName = '${esc(jobName)}'`,
        );
        context.closeWithFailure();
        return;
      }
    }

    if (trackingOn && errorCount > 0) {
      await zcql.executeZCQLQuery(
        `UPDATE Jobs SET status = 'FAILED' WHERE jobName = '${esc(jobName)}'`,
      );
      context.closeWithFailure();
      return;
    }

    await zcql.executeZCQLQuery(
      `UPDATE Jobs SET status = 'COMPLETED' WHERE jobName = '${esc(jobName)}'`,
    );
    context.closeWithSuccess();
  } catch (error) {
    console.error("Bonus apply job failed:", error);

    try {
      await zcql.executeZCQLQuery(
        `UPDATE Jobs SET status = 'FAILED' WHERE jobName = '${esc(jobName)}'`,
      );
    } catch (updateErr) {
      console.error("Failed to update job status to FAILED:", updateErr);
    }
    context.closeWithFailure();
  }
};
