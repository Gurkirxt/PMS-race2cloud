import { escHoldingsSql } from "./holdingsFromTable.js";

const CLIENT_IDS_BATCH = 270;

/**
 * Resolve every virtual code (`WS_Account_code`) that maps to a given
 * `Actual_Code`. Holdings are stored scheme-wise (per virtual code), so a
 * consolidated report has to expand the actual code into its virtual codes
 * first, then sum across them.
 */
export async function fetchVirtualCodesByActual(zcql, actualCode) {
  const acc = escHoldingsSql(actualCode);
  const seen = new Set();
  const out = [];
  let offset = 0;

  while (true) {
    const batch = await zcql.executeZCQLQuery(
      `SELECT WS_Account_code FROM clientIds WHERE Actual_Code = '${acc}' LIMIT ${CLIENT_IDS_BATCH} OFFSET ${offset}`,
    );
    if (!batch?.length) break;

    for (const r of batch) {
      const row = r.clientIds || r;
      const code = String(row.WS_Account_code ?? "").trim();
      if (code && !seen.has(code)) {
        seen.add(code);
        out.push(code);
      }
    }

    if (batch.length < CLIENT_IDS_BATCH) break;
    offset += CLIENT_IDS_BATCH;
  }

  return out;
}

/**
 * Merge several per-scheme holding summaries (each the output of
 * `calculateHoldingsSummary`) into one consolidated set, summing the holding
 * quantity per ISIN. Value/price columns (WAP, holding value, last price,
 * market value, P&L) are intentionally dropped — consolidated reports carry the
 * total holding only.
 */
export function consolidateSummaries(summaries) {
  const byIsin = new Map();

  for (const rows of summaries) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const isin = row.isin;
      if (!isin) continue;

      const hold = Number(row.currentHolding) || 0;
      const existing = byIsin.get(isin);
      if (existing) {
        existing.currentHolding += hold;
      } else {
        byIsin.set(isin, {
          isin,
          stockName: row.stockName || isin,
          securityCode: row.securityCode || "",
          currentHolding: hold,
        });
      }
    }
  }

  return Array.from(byIsin.values()).sort((a, b) =>
    (a.stockName || "").localeCompare(b.stockName || ""),
  );
}
