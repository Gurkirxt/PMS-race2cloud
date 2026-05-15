/**
 * Read materialised `Holdings` — mirrors appsail-nodejs/util/analytics/holdingsFromTable.js
 * (CommonJS for Catalyst function package).
 */

const BATCH = 250;
const HOLDINGS_FIFO_ORDER_BY_SQL = "CREATEDTIME ASC, ROWID ASC";

function escHoldingsSql(s) {
  return String(s ?? "").replace(/'/g, "''");
}

function holdingsDateFilterClause(asOnDate) {
  if (!asOnDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(asOnDate).trim())) return "";
  const nextDay = new Date(asOnDate);
  nextDay.setDate(nextDay.getDate() + 1);
  const cutoff = nextDay.toISOString().split("T")[0];
  return ` AND (SETTLEMENT_DATE < '${escHoldingsSql(cutoff)}' OR TRANSACTION_DATE < '${escHoldingsSql(cutoff)}')`;
}

/**
 * All Holdings rows for an account — same ORDER BY as fifo materialisation.
 */
async function fetchHoldingsRowsPaged(zcql, accountCode, asOnDate, extraSql = "") {
  const clause = holdingsDateFilterClause(asOnDate);
  const rows = [];
  let offset = 0;
  const acc = escHoldingsSql(accountCode);
  while (true) {
    const batch = await zcql.executeZCQLQuery(`
      SELECT ROWID, TRANSACTION_DATE, SETTLEMENT_DATE, TYPE, ISIN,
             QUANTITY, PRICE, TOTAL_AMOUNT, HOLDING, WAP, HOLDING_VALUE, P_L, STATUS,
             CREATEDTIME
      FROM Holdings
      WHERE WS_Account_code = '${acc}'
      ${clause}
      ${extraSql}
      ORDER BY ${HOLDINGS_FIFO_ORDER_BY_SQL}
      LIMIT ${BATCH} OFFSET ${offset}
    `);
    if (!batch || batch.length === 0) break;
    for (const r of batch) rows.push(r.Holdings || r);
    if (batch.length < BATCH) break;
    offset += BATCH;
  }
  return rows;
}

function rollupLastSnapshotByIsin(sortedHoldingsRows) {
  const lastByIsin = new Map();
  for (const h of sortedHoldingsRows) {
    const isin = String(h.ISIN || "").trim();
    if (!isin) continue;
    lastByIsin.set(isin, h);
  }
  const out = [];
  for (const [isin, row] of lastByIsin) {
    const hold = Number(row.HOLDING) || 0;
    if (hold <= 0) continue;
    out.push({ isin, lastRow: row });
  }
  return out;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchSecurityListByIsins(zcql, isins) {
  const map = Object.create(null);
  if (!isins || !isins.length) return map;
  for (const part of chunk(isins, 200)) {
    const inClause = part.map((i) => `'${escHoldingsSql(i)}'`).join(",");
    let offset = 0;
    while (true) {
      const batch = await zcql.executeZCQLQuery(`
        SELECT ISIN, Security_Code, Security_Name FROM Security_List
        WHERE ISIN IN (${inClause})
        ORDER BY ROWID ASC
        LIMIT ${BATCH} OFFSET ${offset}
      `);
      if (!batch || batch.length === 0) break;
      for (const r of batch) {
        const row = r.Security_List || r;
        if (row.ISIN)
          map[String(row.ISIN).trim()] = {
            securityCode: row.Security_Code || "",
            securityName: row.Security_Name || "",
          };
      }
      if (batch.length < BATCH) break;
      offset += BATCH;
    }
  }
  return map;
}

module.exports = {
  escHoldingsSql,
  fetchHoldingsRowsPaged,
  fetchSecurityListByIsins,
  rollupLastSnapshotByIsin,
};
