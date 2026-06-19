"use strict";

/**
 * Lot-level demerger apply — mirrors appsail DemergerController insert logic.
 */

const ZCQL_ROW_LIMIT = 270;

const esc = (s) => String(s ?? "").replace(/'/g, "''");

/** Written to JobStatusPerAccount.jobType when tracking is enabled. */
const DEMERGER_JOB_TYPE_DEFAULT = "DEMERGER_APPLY";

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
    console.warn("[DemergerFn][JobStatusPerAccount] read failed:", e.message);
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
        `[DemergerFn][JobStatusPerAccount] upsert RUNNING failed ${accountCode}:`,
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
    console.warn(`[DemergerFn][JobStatusPerAccount] SUCCESS failed ${accountCode}:`, e.message);
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
    console.warn(`[DemergerFn][JobStatusPerAccount] FAILED failed ${accountCode}:`, e.message);
  }
}

async function ensureDemergerHeader(zcql, headerOpts) {
  const {
    oldIsin,
    oldSecurityCode,
    oldSecurityName,
    newIsin,
    newSecurityCode,
    newSecurityName,
    r1,
    r2,
    pct,
    effectiveDateISO,
    recordDateISO,
  } = headerOpts;

  const existing = await zcql.executeZCQLQuery(`
    SELECT ROWID FROM Demerger
    WHERE Old_ISIN = '${esc(oldIsin)}' AND New_ISIN = '${esc(newIsin)}'
      AND Record_Date = '${esc(recordDateISO)}'
    LIMIT 1
  `);
  if (existing?.length) {
    console.log("[DemergerFn] Demerger header exists — skip INSERT (retry)");
    return;
  }

  await zcql.executeZCQLQuery(`
      INSERT INTO Demerger
      (Old_ISIN, Old_Security_Code, Old_Security_Name,
       New_ISIN, New_Security_Code, New_Security_Name,
       Ratio1, Ratio2, Effective_Date, Record_Date, Allocation_To_New_Pct)
      VALUES
      ('${esc(oldIsin)}', '${esc(oldSecurityCode)}', '${esc(oldSecurityName)}',
       '${esc(newIsin)}', '${esc(newSecurityCode)}', '${esc(newSecurityName)}',
       ${r1}, ${r2}, '${esc(effectiveDateISO)}', '${esc(recordDateISO)}', ${pct})
    `);
}

const round = (n, d = 2) => {
  const f = Math.pow(10, d);
  return Math.round(Number(n || 0) * f) / f;
};

const isBuyType = (t) => /^BY-|SQB|OPI/i.test(String(t || ""));
const isSellType = (t) => /^SL\+|SQS|OPO|NF-/i.test(String(t || ""));
const upperEq = (a, b) => String(a || "").trim().toUpperCase() === b;

async function fetchAccountsHoldingIsin(zcql, isin) {
  const accounts = new Set();
  let offset = 0;
  while (true) {
    const batch = await zcql.executeZCQLQuery(`
      SELECT WS_Account_code FROM Holdings
      WHERE ISIN = '${esc(isin)}'
      ORDER BY ROWID ASC
      LIMIT ${ZCQL_ROW_LIMIT} OFFSET ${offset}
    `);
    if (!batch || batch.length === 0) break;
    for (const r of batch) {
      const h = r.Holdings || r;
      const code = String(h.WS_Account_code ?? "").trim();
      if (code) accounts.add(code);
    }
    if (batch.length < ZCQL_ROW_LIMIT) break;
    offset += ZCQL_ROW_LIMIT;
  }
  return [...accounts].sort((a, b) => a.localeCompare(b));
}

async function fetchHoldingRowsForPair(zcql, accountCode, isin, recordDateISO) {
  const rows = [];
  let offset = 0;
  while (true) {
    const batch = await zcql.executeZCQLQuery(`
      SELECT ROWID, TRANSACTION_DATE, SETTLEMENT_DATE, TYPE, ISIN,
             QUANTITY, PRICE, TOTAL_AMOUNT, HOLDING, WAP, HOLDING_VALUE, STATUS, CREATEDTIME
      FROM Holdings
      WHERE WS_Account_code = '${esc(accountCode)}'
        AND ISIN = '${esc(isin)}'
        AND SETTLEMENT_DATE <= '${esc(recordDateISO)}'
      ORDER BY CREATEDTIME ASC, ROWID ASC
      LIMIT ${ZCQL_ROW_LIMIT} OFFSET ${offset}
    `);
    if (!batch || batch.length === 0) break;
    for (const r of batch) rows.push(r.Holdings || r);
    if (batch.length < ZCQL_ROW_LIMIT) break;
    offset += ZCQL_ROW_LIMIT;
  }
  return rows;
}

function computeSurvivingLotsFromHoldingRows(rows) {
  let queue = [];
  let lastReplaceEventKey = null;

  for (const row of rows) {
    const type = String(row.TYPE || "").trim();
    const qty = Number(row.QUANTITY || 0);
    const price = Number(row.PRICE || 0);
    const buyDate = row.TRANSACTION_DATE || row.SETTLEMENT_DATE || null;
    const setDate = row.SETTLEMENT_DATE || row.TRANSACTION_DATE || null;
    const sourceRowId = String(row.ROWID || "");

    if (isBuyType(type)) {
      if (qty > 0) {
        queue.push({ qty, price, buyDate, setDate, sourceRowId, sourceType: type });
      }
      continue;
    }

    if (upperEq(type, "BONUS")) {
      if (qty > 0) {
        queue.push({ qty, price: 0, buyDate, setDate, sourceRowId, sourceType: "BONUS" });
      }
      continue;
    }

    if (isSellType(type)) {
      let remaining = qty;
      while (remaining > 0 && queue.length) {
        const lot = queue[0];
        const used = Math.min(lot.qty, remaining);
        lot.qty -= used;
        remaining -= used;
        if (lot.qty <= 0) queue.shift();
      }
      continue;
    }

    if (upperEq(type, "SPLIT") || upperEq(type, "MERGER") || upperEq(type, "DEMERGER")) {
      const eventKey = `${buyDate}|${type}`;
      if (lastReplaceEventKey !== eventKey) {
        queue = [];
        lastReplaceEventKey = eventKey;
      }
      if (qty > 0) {
        queue.push({ qty, price, buyDate, setDate, sourceRowId, sourceType: type });
      }
      continue;
    }
  }

  return queue.filter((lot) => lot.qty > 0);
}

function buildLotLevelDemergerForAccount({
  accountCode,
  lots,
  oldIsin,
  newIsin,
  r1,
  r2,
  pct,
}) {
  const out = [];
  for (const lot of lots) {
    const Q1 = Number(lot.qty) || 0;
    if (Q1 <= 0) continue;

    const lotPrice = Number(lot.price) || 0;
    const lotCost = Q1 * lotPrice;

    const Q2 = Math.floor((Q1 * r1) / r2);
    const newCost = lotCost * (pct / 100);
    const oldCost = lotCost - newCost;

    const oldWapAfter = Q1 > 0 ? oldCost / Q1 : 0;
    const newWap = Q2 > 0 ? newCost / Q2 : 0;

    out.push({
      accountCode,
      oldIsin,
      sourceLotRowId: lot.sourceRowId,
      sourceLotDate: lot.buyDate,
      sourceLotSetDate: lot.setDate,
      sourceLotType: lot.sourceType,
      oldQty: Q1,
      oldWapBefore: round(lotPrice, 4),
      oldWapAfter: round(oldWapAfter, 4),
      oldCostAfter: round(oldCost, 2),
      newIsin,
      newQty: Q2,
      newWap: round(newWap, 4),
      newCost: round(newCost, 2),
    });
  }
  return out;
}

async function runDemergerApply(zcql, opts) {
  const {
    oldIsin,
    oldSecurityCode,
    oldSecurityName,
    newIsin,
    newSecurityCode,
    newSecurityName,
    r1,
    r2,
    pct,
    effectiveDateISO,
    recordDateISO,
    jobTracking,
  } = opts;

  const tracking =
    jobTracking &&
    jobTracking.enabled &&
    String(jobTracking.jobName || "").trim();
  const trackJobName = tracking ? String(jobTracking.jobName).trim() : "";
  const trackJobType =
    String(jobTracking?.jobType || "").trim() || DEMERGER_JOB_TYPE_DEFAULT;

  await ensureDemergerHeader(zcql, {
    oldIsin,
    oldSecurityCode,
    oldSecurityName,
    newIsin,
    newSecurityCode,
    newSecurityName,
    r1,
    r2,
    pct,
    effectiveDateISO,
    recordDateISO,
  });

  try {
    await zcql.executeZCQLQuery(`
        INSERT INTO Security_List
        (Security_Code, ISIN, Security_Name)
        VALUES
        ('${esc(newSecurityCode)}', '${esc(newIsin)}', '${esc(newSecurityName)}')
      `);
  } catch (secErr) {
    console.warn("[DemergerFn] Security_List insert skipped:", secErr.message);
  }

  const accounts = await fetchAccountsHoldingIsin(zcql, oldIsin);
  let lotRowsInserted = 0;
  const affectedAccountsSet = new Set();
  let trackingFailures = 0;

  for (const accountCode of accounts) {
    if (tracking) {
      const prev = await getPerAccountJobStatus(zcql, trackJobName, accountCode);
      if (prev === "SUCCESS") {
        console.log(
          `[DemergerFn] skip ${accountCode} — JobStatusPerAccount already SUCCESS`,
        );
        continue;
      }
      await upsertAccountRowRunning(
        zcql,
        trackJobName,
        trackJobType,
        accountCode,
      );
    }

    try {
      const rows = await fetchHoldingRowsForPair(
        zcql,
        accountCode,
        oldIsin,
        recordDateISO,
      );
      if (!rows.length) {
        if (tracking) await markAccountSuccess(zcql, trackJobName, accountCode);
        continue;
      }

      const lots = computeSurvivingLotsFromHoldingRows(rows);
      if (!lots.length) {
        if (tracking) await markAccountSuccess(zcql, trackJobName, accountCode);
        continue;
      }

      const lotRows = buildLotLevelDemergerForAccount({
        accountCode,
        lots,
        oldIsin,
        newIsin,
        r1,
        r2,
        pct,
      });

      if (!lotRows.length) {
        if (tracking) await markAccountSuccess(zcql, trackJobName, accountCode);
        continue;
      }

      for (const lr of lotRows) {
        const sourceRowId = lr.sourceLotRowId
          ? `'${esc(lr.sourceLotRowId)}'`
          : "NULL";

        // Preserve the original lot's trade date on the demerger rows (old +
        // new ISIN); only the Tran_Type becomes DEMERGER. The corporate-action
        // record date is stored separately in Record_Date (→ Holdings.CA_DATE
        // on rebuild), so FIFO ordering still anchors on the record date.
        const lotTranDate =
          String(lr.sourceLotDate || effectiveDateISO).slice(0, 10) ||
          effectiveDateISO;
        const lotSetDate =
          String(lr.sourceLotSetDate || lr.sourceLotDate || effectiveDateISO).slice(0, 10) ||
          effectiveDateISO;

        await zcql.executeZCQLQuery(`
          INSERT INTO Demerger_Record
          (WS_Account_code, TRANDATE, SETDATE, Tran_Type, ISIN,
           Security_Code, Security_Name,
           QTY, PRICE, TOTAL_AMOUNT, HOLDING, WAP, HOLDING_VALUE, PL,
           Source_Tran_ROWID, Record_Date)
          VALUES
          ('${esc(accountCode)}', '${esc(lotTranDate)}', '${esc(lotSetDate)}', 'DEMERGER',
           '${esc(oldIsin)}',
           '${esc(oldSecurityCode)}', '${esc(oldSecurityName)}',
           ${lr.oldQty}, ${lr.oldWapAfter}, ${lr.oldCostAfter},
           ${lr.oldQty}, ${lr.oldWapAfter}, ${lr.oldCostAfter},
           0,
           ${sourceRowId}, '${esc(recordDateISO)}')
        `);
        lotRowsInserted++;
        affectedAccountsSet.add(accountCode);

        if (lr.newQty > 0) {
          await zcql.executeZCQLQuery(`
            INSERT INTO Demerger_Record
            (WS_Account_code, TRANDATE, SETDATE, Tran_Type, ISIN,
             Security_Code, Security_Name,
             QTY, PRICE, TOTAL_AMOUNT, HOLDING, WAP, HOLDING_VALUE, PL,
             Source_Tran_ROWID, Record_Date)
            VALUES
            ('${esc(accountCode)}', '${esc(lotTranDate)}', '${esc(lotSetDate)}', 'DEMERGER',
             '${esc(newIsin)}',
             '${esc(newSecurityCode)}', '${esc(newSecurityName)}',
             ${lr.newQty}, ${lr.newWap}, ${lr.newCost},
             ${lr.newQty}, ${lr.newWap}, ${lr.newCost},
             0,
             ${sourceRowId}, '${esc(recordDateISO)}')
          `);
          lotRowsInserted++;
        }
      }

      if (tracking) await markAccountSuccess(zcql, trackJobName, accountCode);
    } catch (acctErr) {
      console.error(`[DemergerFn][${accountCode}] apply failed:`, acctErr.message);
      if (tracking) {
        await markAccountFailed(zcql, trackJobName, accountCode, acctErr.message);
      }
      trackingFailures++;
    }
  }

  return {
    accountsAffected: [...affectedAccountsSet].sort((a, b) => a.localeCompare(b)),
    recordsInserted: lotRowsInserted,
    trackingFailures,
  };
}

module.exports = { runDemergerApply, DEMERGER_JOB_TYPE_DEFAULT };
