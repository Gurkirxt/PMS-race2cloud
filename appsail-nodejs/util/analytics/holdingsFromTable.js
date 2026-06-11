/** Read materialised Holding rows — same ledger as CalculateHoldingPerAccount / catalyst rebuild. */

const BATCH = 250;

/**
 * SQL fragment: order rows as they were emitted by FIFO sequential INSERT
 * (`CalculateHoldingPerAccount`, `RebuildHoldingtable`). Use wherever you read `Holdings`
 * timeline so `HOLDING` behaves as a running balance top → bottom.
 */
export const HOLDINGS_FIFO_ORDER_BY_SQL = "CREATEDTIME ASC, ROWID ASC";

export function escHoldingsSql(s) {
  return String(s ?? "").replace(/'/g, "''");
}

/** Mirrors analytics transaction date cutoff (exclusive next-day). */
export function holdingsDateFilterClause(asOnDate) {
  if (!asOnDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(asOnDate).trim()))
    return "";
  const nextDay = new Date(asOnDate);
  nextDay.setDate(nextDay.getDate() + 1);
  const cutoff = nextDay.toISOString().split("T")[0];
  return ` AND (SETTLEMENT_DATE < '${escHoldingsSql(cutoff)}' OR TRANSACTION_DATE < '${escHoldingsSql(cutoff)}')`;
}

export function isHoldingsBuyType(type) {
  return /^BY-|SQB|OPI/i.test(String(type || ""));
}

export function isHoldingsSellType(type) {
  return /^SL[+-]|SQS|OPO|NF-/i.test(String(type || "").trim());
}

/**
 * The date a Holdings row should be filtered on for an as-on-date view.
 * Mirrors the rebuild job's `getEffectiveDate`: buys (BY-/SQB/OPI) settle on
 * SETTLEMENT_DATE, everything else takes effect on TRANSACTION_DATE.
 */
export function holdingsEffectiveDate(row) {
  const setD = String(row.SETTLEMENT_DATE || "").slice(0, 10);
  const txD = String(row.TRANSACTION_DATE || "").slice(0, 10);
  return isHoldingsBuyType(row.TYPE) ? setD || txD : txD || setD;
}

/**
 * Pagination / sort alignment with FIFO interleaving (same-day merge order).
 */
export function holdingsTypePriority(type) {
  const t = String(type || "").trim().toUpperCase();
  if (t === "SPLIT") return 1;
  if (t === "BONUS") return 2;
  if (t === "DIV+" || t === "DIV") return 3;
  if (t === "DEMERGER") return 4;
  if (t === "MERGER") return 5;
  return 0;
}

/**
 * All Holdings rows for an account (optional extra AND clause).
 * Sorted by **`CREATEDTIME` then `ROWID`** — same sequence as Catalyst FIFO emit / insert
 * order from `RebuildHoldingtable` so `HOLDING`/`WAP`/etc. columns read as a correct
 * running ledger top → bottom. (Sorting by transaction date alone reorders snapshots and
 * breaks running-balance intuition.)
 */
export async function fetchHoldingsRowsPaged(zcql, accountCode, asOnDate, extraSql = "") {
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

  // Refine the loose SQL date clause (which ORs both dates): buy rows must
  // respect SETTLEMENT_DATE, others TRANSACTION_DATE — same as the rebuild job.
  // Without this, a not-yet-settled buy (e.g. OPI) leaks in via its trade date.
  const trimmed = String(asOnDate ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const nextDay = new Date(trimmed);
    nextDay.setDate(nextDay.getDate() + 1);
    const cutoff = nextDay.toISOString().split("T")[0];
    return rows.filter((r) => {
      const d = holdingsEffectiveDate(r);
      return !d || d < cutoff;
    });
  }

  return rows;
}

/** One ISIN only — fifo materialisation order (same ORDER BY as `fetchHoldingsRowsPaged`). */
export async function fetchHoldingsRowsForAccountIsin(
  zcql,
  accountCode,
  isin,
  asOnDate,
) {
  const isinTrim = String(isin ?? "").trim();
  if (!isinTrim) return [];
  const extra = ` AND ISIN = '${escHoldingsSql(isinTrim)}' `;
  return fetchHoldingsRowsPaged(zcql, accountCode, asOnDate, extra);
}

/** DISTINCT ISIN from Holdings for an account (for security dropdown / Bhav lists). */
export async function fetchDistinctHoldingsIsins(zcql, accountCode, asOnDate) {
  const clause = holdingsDateFilterClause(asOnDate);
  const isins = new Set();
  let offset = 0;
  const acc = escHoldingsSql(accountCode);
  while (true) {
    const batch = await zcql.executeZCQLQuery(`
      SELECT ISIN FROM Holdings
      WHERE WS_Account_code = '${acc}'
        AND ISIN IS NOT NULL AND ISIN != ''
      ${clause}
      ORDER BY ROWID ASC
      LIMIT ${BATCH} OFFSET ${offset}
    `);
    if (!batch || batch.length === 0) break;
    for (const r of batch) {
      const isin = (r.Holdings || r)?.ISIN;
      if (isin) isins.add(String(isin).trim());
    }
    if (batch.length < BATCH) break;
    offset += BATCH;
  }
  return [...isins];
}

/**
 * Map Catalyst Security_List rows to ISIN metadata.
 */
export async function fetchSecurityListByIsins(zcql, isins) {
  const map = Object.create(null);
  if (!isins || !isins.length) return map;
  const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };
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

/**
 * Last materialised snapshot per ISIN.
 * Rows should follow fifo materialisation order (`HOLDINGS_FIFO_ORDER_BY_SQL`). Only keeps ISIN
 * whose latest row has final HOLDING > 0.
 */
export function rollupLastSnapshotByIsin(sortedHoldingsRows) {
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
    out.push({
      isin,
      lastRow: row,
    });
  }
  return out;
}

/** Map Holdings row → TransactionPage / fifo timeline element shape (append-only fields safe for JSON). */
export function mapHoldingsRowToStockHistoryDto(h, isinFromQuery) {
  const plRaw = h.P_L;
  const plNum = plRaw === null || plRaw === undefined || plRaw === "" ? null : Number(plRaw);

  let isActive = true;
  const st = h.STATUS;
  if (typeof st === "boolean") isActive = st;
  else if (String(st).toLowerCase() === "false") isActive = false;

  const txD = String(h.TRANSACTION_DATE || "").slice(0, 10);
  const setD = String(h.SETTLEMENT_DATE || "").slice(0, 10);

  return {
    rowId: h.ROWID != null ? String(h.ROWID) : null,
    createdTime:
      h.CREATEDTIME != null && String(h.CREATEDTIME).trim() !== ""
        ? String(h.CREATEDTIME).trim()
        : null,
    trandate: txD || setD || null,
    originalTrandate: txD || setD || null,
    setdate: setD || txD || null,
    tranType: String(h.TYPE || "").trim() || "",
    qty: Number(h.QUANTITY) || 0,
    price: Number(h.PRICE) || 0,
    netAmount: Number(h.TOTAL_AMOUNT) || 0,
    holdings: Number(h.HOLDING) || 0,
    costOfHoldings: Number(h.HOLDING_VALUE) || 0,
    averageCostOfHoldings: Number(h.WAP) || 0,
    profitLoss: Number.isFinite(plNum) ? plNum : null,
    isActive,
    isin: String(h.ISIN || isinFromQuery || "").trim(),
  };
}
