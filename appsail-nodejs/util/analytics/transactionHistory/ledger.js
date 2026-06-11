/**
 * Raw transaction ledger straight from the `Transaction` table (as uploaded) —
 * NOT the FIFO-materialised `Holdings` table. Corporate actions (BONUS / SPLIT /
 * MERGER / DEMERGER) are sourced separately from Holdings by the controller and
 * merged in; this file only deals with the uploaded trade ledger.
 */

const esc = (s) => String(s ?? "").replace(/'/g, "''");
const BATCH = 250;

const isBuyType = (type) => /^BY-|SQB|OPI/i.test(String(type || ""));

/** Buy → settlement date (SETDATE); Sell → trade date (TRANDATE). Matches RebuildHoldingtable. */
const getEffectiveDate = (r) => {
  const setDate = r.SETDATE || r.setdate;
  const tradeDate = r.TRANDATE || r.trandate;
  return isBuyType(r.Tran_Type || r.tranType)
    ? setDate || tradeDate
    : tradeDate || setDate;
};

const nextDayCutoff = (asOnDate) => {
  if (!asOnDate || !/^\d{4}-\d{2}-\d{2}$/.test(asOnDate)) return null;
  const nextDay = new Date(asOnDate);
  nextDay.setDate(nextDay.getDate() + 1);
  return nextDay.toISOString().split("T")[0];
};

/**
 * Uploaded trades for an account (optional ISIN + as-on cutoff).
 * Returns normalised rows ready for the transaction tab.
 */
export async function fetchTransactionLedgerRows(zcql, { accountCode, isin, asOnDate }) {
  const acc = esc(accountCode);
  const isinClause = isin ? ` AND ISIN = '${esc(isin)}'` : "";
  const cutoff = nextDayCutoff(asOnDate);
  const dateClause = cutoff
    ? ` AND (TRANDATE < '${cutoff}' OR SETDATE < '${cutoff}')`
    : "";

  const rows = [];
  const seen = new Set();
  let offset = 0;

  while (true) {
    try {
      const batch = await zcql.executeZCQLQuery(`
        SELECT SETDATE, TRANDATE, Tran_Type, Security_Name, Security_code,
               QTY, NETRATE, Net_Amount, ISIN, ROWID
        FROM Transaction
        WHERE WS_Account_code = '${acc}'
        ${isinClause}
        ${dateClause}
        ORDER BY TRANDATE ASC, ROWID ASC
        LIMIT ${BATCH} OFFSET ${offset}
      `);
      if (!batch || batch.length === 0) break;
      for (const row of batch) {
        const r = row.Transaction || row;
        if (r.ROWID && seen.has(r.ROWID)) continue;
        if (r.ROWID) seen.add(r.ROWID);
        rows.push(r);
      }
      if (batch.length < BATCH) break;
      offset += BATCH;
    } catch (err) {
      console.error(
        `fetchTransactionLedgerRows[${accountCode}] offset=${offset}:`,
        err.message,
      );
      break;
    }
  }

  const inWindow = cutoff
    ? rows.filter((r) => {
        const d = getEffectiveDate(r);
        return !d || d < cutoff;
      })
    : rows;

  return inWindow.map((r) => ({
    rowId: `T-${r.ROWID}`,
    trandate: String(r.TRANDATE || "").trim().slice(0, 10) || null,
    setdate: String(r.SETDATE || "").trim().slice(0, 10) || null,
    type: String(r.Tran_Type || "").trim(),
    securityName: String(r.Security_Name || "").trim(),
    securityCode: String(r.Security_code || "").trim(),
    isin: String(r.ISIN || "").trim() || null,
    quantity: Number(r.QTY) || 0,
    price: Number(r.NETRATE) || 0,
    totalAmount: Number(r.Net_Amount) || 0,
  }));
}

/** Distinct ISINs (+ name) present in the uploaded ledger for an account. */
export async function fetchLedgerIsinMeta(zcql, { accountCode, asOnDate }) {
  const rows = await fetchTransactionLedgerRows(zcql, { accountCode, asOnDate });
  const byIsin = new Map();
  for (const r of rows) {
    if (!r.isin) continue;
    if (!byIsin.has(r.isin)) {
      byIsin.set(r.isin, { isin: r.isin, securityName: r.securityName || "" });
    } else if (!byIsin.get(r.isin).securityName && r.securityName) {
      byIsin.get(r.isin).securityName = r.securityName;
    }
  }
  return byIsin;
}
