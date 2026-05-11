"use strict";

/**
 * Lot-level demerger apply — mirrors appsail DemergerController insert logic.
 */

const ZCQL_ROW_LIMIT = 270;

const esc = (s) => String(s ?? "").replace(/'/g, "''");

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
             QUANTITY, PRICE, TOTAL_AMOUNT, HOLDING, WAP, HOLDING_VALUE, STATUS
      FROM Holdings
      WHERE WS_Account_code = '${esc(accountCode)}'
        AND ISIN = '${esc(isin)}'
        AND SETTLEMENT_DATE <= '${esc(recordDateISO)}'
      ORDER BY SETTLEMENT_DATE ASC, ROWID ASC
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
    const sourceRowId = String(row.ROWID || "");

    if (isBuyType(type)) {
      if (qty > 0) {
        queue.push({ qty, price, buyDate, sourceRowId, sourceType: type });
      }
      continue;
    }

    if (upperEq(type, "BONUS")) {
      if (qty > 0) {
        queue.push({ qty, price: 0, buyDate, sourceRowId, sourceType: "BONUS" });
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
        queue.push({ qty, price, buyDate, sourceRowId, sourceType: type });
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
  } = opts;

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

  for (const accountCode of accounts) {
    const rows = await fetchHoldingRowsForPair(zcql, accountCode, oldIsin, recordDateISO);
    if (!rows.length) continue;

    const lots = computeSurvivingLotsFromHoldingRows(rows);
    if (!lots.length) continue;

    const lotRows = buildLotLevelDemergerForAccount({
      accountCode,
      lots,
      oldIsin,
      newIsin,
      r1,
      r2,
      pct,
    });

    if (!lotRows.length) continue;

    for (const lr of lotRows) {
      const sourceRowId = lr.sourceLotRowId
        ? `'${esc(lr.sourceLotRowId)}'`
        : "NULL";

      await zcql.executeZCQLQuery(`
          INSERT INTO Demerger_Record
          (WS_Account_code, TRANDATE, SETDATE, Tran_Type, ISIN,
           Security_Code, Security_Name,
           QTY, PRICE, TOTAL_AMOUNT, HOLDING, WAP, HOLDING_VALUE, PL,
           Source_Tran_ROWID)
          VALUES
          ('${esc(accountCode)}', '${esc(effectiveDateISO)}', '${esc(effectiveDateISO)}', 'DEMERGER',
           '${esc(oldIsin)}',
           '${esc(oldSecurityCode)}', '${esc(oldSecurityName)}',
           ${lr.oldQty}, ${lr.oldWapAfter}, ${lr.oldCostAfter},
           ${lr.oldQty}, ${lr.oldWapAfter}, ${lr.oldCostAfter},
           0,
           ${sourceRowId})
        `);
      lotRowsInserted++;
      affectedAccountsSet.add(accountCode);

      if (lr.newQty > 0) {
        await zcql.executeZCQLQuery(`
            INSERT INTO Demerger_Record
            (WS_Account_code, TRANDATE, SETDATE, Tran_Type, ISIN,
             Security_Code, Security_Name,
             QTY, PRICE, TOTAL_AMOUNT, HOLDING, WAP, HOLDING_VALUE, PL,
             Source_Tran_ROWID)
            VALUES
            ('${esc(accountCode)}', '${esc(effectiveDateISO)}', '${esc(effectiveDateISO)}', 'DEMERGER',
             '${esc(newIsin)}',
             '${esc(newSecurityCode)}', '${esc(newSecurityName)}',
             ${lr.newQty}, ${lr.newWap}, ${lr.newCost},
             ${lr.newQty}, ${lr.newWap}, ${lr.newCost},
             0,
             ${sourceRowId})
          `);
        lotRowsInserted++;
      }
    }
  }

  return {
    accountsAffected: [...affectedAccountsSet].sort((a, b) => a.localeCompare(b)),
    recordsInserted: lotRowsInserted,
  };
}

module.exports = { runDemergerApply };
