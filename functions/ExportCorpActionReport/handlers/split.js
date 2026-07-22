"use strict";

/**
 * Split impact handler for ExportCorpActionReport.
 *
 * Reports how every split in a date range affected every client. Source of
 * truth is the APPLIED data, read from two tables:
 *   1. `Split`    — the authoritative list of splits that happened (ratio +
 *                   metadata). Same table addStockSplit writes and the
 *                   "All Corporate Actions" export reads.
 *   2. `Holdings` — the per-client effect the rebuild materialised as
 *                   TYPE='SPLIT' rows (TRANSACTION_DATE = the split's
 *                   Issue_Date). HOLDING/WAP on those rows are the running
 *                   post-split balance; the row with the greatest HOLDING for an
 *                   account is its final post-split total (running holdings
 *                   increases across the per-lot SPLIT rows the rebuild emits,
 *                   see functions/RebuildHoldingtable/holdingsRebuildFromSources.js).
 *
 * SHARES_ALLOCATED is read straight off the affected SPLIT transactions. The
 * pre-split lots are treated as gone; a split replaces them with a fresh count.
 * Each SPLIT row is one post-split lot (QUANTITY = new lot qty, TOTAL_AMOUNT =
 * lot cost); summing QUANTITY per account gives the post-split holding:
 *   SHARES_ALLOCATED = sum(QUANTITY) over the account's SPLIT rows
 */

const { buildVirtualToActualMap } = require("../virtualToActual.js");

const MANIFEST_BATCH = 270;
const HOLDINGS_BATCH = 250;

const esc = (s) => String(s ?? "").replace(/'/g, "''");
const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "").trim());

function round4(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

/**
 * Frozen work list: every split whose Issue_Date falls in [fromDate, toDate].
 * One manifest entry == one split event.
 */
async function buildManifest(zcql, fromDate, toDate) {
  const from = esc(fromDate);
  const to = esc(toDate);
  const events = [];
  let offset = 0;

  while (true) {
    const rows = await zcql.executeZCQLQuery(`
      SELECT Security_Code, Security_Name, Ratio1, Ratio2, Issue_Date, ISIN
      FROM Split
      WHERE Issue_Date >= '${from}' AND Issue_Date <= '${to}'
      ORDER BY Issue_Date ASC, ROWID ASC
      LIMIT ${MANIFEST_BATCH} OFFSET ${offset}
    `);

    if (!rows || rows.length === 0) break;

    for (const r of rows) {
      const s = r.Split || r;
      events.push({
        isin: String(s.ISIN ?? "").trim(),
        issueDate: String(s.Issue_Date ?? "").slice(0, 10),
        ratio1: Number(s.Ratio1),
        ratio2: Number(s.Ratio2),
        securityCode: s.Security_Code ?? "",
        securityName: s.Security_Name ?? "",
      });
    }

    if (rows.length < MANIFEST_BATCH) break;
    offset += MANIFEST_BATCH;
  }

  return events;
}

/**
 * All CSV rows for ONE split event (one row per affected account).
 * Returns "" when the split has no applied Holdings rows (e.g. no holders, or
 * the rebuild hasn't materialised the SPLIT rows yet).
 */
async function buildEventCsv({ zcql, event, generatedAt, fromDate, toDate, csvCell }) {
  const { isin, issueDate, ratio1, ratio2 } = event;
  if (!isin || !isIsoDate(issueDate)) return "";

  const r1 = Number(ratio1);
  const r2 = Number(ratio2);
  const multiplier = r2 / r1;
  if (!Number.isFinite(multiplier) || multiplier <= 0) return "";

  /* ---- Sum each account's SPLIT transaction rows directly ----
     One SPLIT row per post-split lot: QUANTITY = new lot qty,
     TOTAL_AMOUNT = lot cost (falls back to QUANTITY * PRICE). Summing is
     order-independent, so we never depend on a running-balance/last row. */
  const byAccount = new Map(); // account -> { qty, cost }
  let offset = 0;
  const isinEsc = esc(isin);
  const dateEsc = esc(issueDate);

  while (true) {
    const rows = await zcql.executeZCQLQuery(`
      SELECT WS_Account_code, QUANTITY, PRICE, TOTAL_AMOUNT
      FROM Holdings
      WHERE ISIN = '${isinEsc}' AND TYPE = 'SPLIT' AND TRANSACTION_DATE = '${dateEsc}'
      ORDER BY CREATEDTIME ASC, ROWID ASC
      LIMIT ${HOLDINGS_BATCH} OFFSET ${offset}
    `);

    if (!rows || rows.length === 0) break;

    for (const r of rows) {
      const h = r.Holdings || r;
      const acc = String(h.WS_Account_code || "").trim();
      if (!acc) continue;
      const qty = Number(h.QUANTITY) || 0;
      let cost = Number(h.TOTAL_AMOUNT);
      if (!Number.isFinite(cost)) cost = qty * (Number(h.PRICE) || 0);
      const cur = byAccount.get(acc) || { qty: 0, cost: 0 };
      cur.qty += qty;
      cur.cost += cost;
      byAccount.set(acc, cur);
    }

    if (rows.length < HOLDINGS_BATCH) break;
    offset += HOLDINGS_BATCH;
  }

  if (byAccount.size === 0) return "";

  const accounts = [...byAccount.keys()];
  const virtualToActual = await buildVirtualToActualMap(zcql, accounts);

  const ratioLabel = `${r1}:${r2}`;
  let text = "";

  for (const [acc, agg] of byAccount) {
    const postQty = agg.qty;
    if (postQty <= 1e-6) continue; // dust / fully-closed

    // Post-split holding for this account. The pre-split lots are treated as
    // gone; this is the fresh quantity the split allocated, summed straight off
    // the SPLIT rows.
    const sharesAllocated = round4(postQty);
    const actual = virtualToActual.get(acc) || "";

    text +=
      [
        generatedAt,
        fromDate,
        toDate,
        issueDate,
        acc,
        actual,
        isin,
        "SPLIT",
        ratioLabel,
        sharesAllocated,
      ]
        .map(csvCell)
        .join(",") + "\n";
  }

  return text;
}

module.exports = {
  reportType: "split",
  header:
    "GENERATED_AT,FROM_DATE,TO_DATE,ISSUE_DATE,VIRTUAL_CODE,ACTUAL_CODE," +
    "ISIN,TYPE,SPLIT_RATIO,SHARES_ALLOCATED\n",
  buildManifest,
  buildEventCsv,
};
