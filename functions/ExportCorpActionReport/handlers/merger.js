"use strict";

/**
 * Merger impact handler for ExportCorpActionReport.
 *
 * Reports how every merger in a date range affected every client, transaction
 * by transaction. Source of truth is the APPLIED data, read from two tables:
 *   1. `Merger_Record` — the authoritative list of merger events that happened
 *                        (ratio + metadata), one row per (OldISIN, ISIN,
 *                        TRANDATE). Written by the apply job (functions/MegerFn).
 *   2. `Merger`        — the per-lot effect, one row per surviving FIFO lot per
 *                        account (ISIN = new ISIN, OldISIN = pre-merger ISIN).
 *                        Quantity is the post-merger lot quantity and WAP the
 *                        new weighted-average price (lot cost / new qty).
 *
 * Rows are emitted per lot (no per-account aggregation) so each merger
 * transaction is visible individually. Zero-quantity `Merger` rows are marker
 * transactions denoting the old company ceased to exist — they carry no
 * allocation and are excluded from the report.
 *
 * Per-lot rows keep the ORIGINAL lot's TRANDATE (see MegerFn), so they cannot
 * be matched to the event header by date — the (OldISIN, ISIN) pair is the
 * join key instead.
 */

const { buildVirtualToActualMap } = require("../virtualToActual.js");

const MANIFEST_BATCH = 270;
const MERGER_BATCH = 250;

const esc = (s) => String(s ?? "").replace(/'/g, "''");
const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "").trim());

/**
 * Frozen work list: every merger whose TRANDATE (effective date) falls in
 * [fromDate, toDate]. One manifest entry == one merger event.
 */
async function buildManifest(zcql, fromDate, toDate) {
  const from = esc(fromDate);
  const to = esc(toDate);
  const events = [];
  let offset = 0;

  while (true) {
    const rows = await zcql.executeZCQLQuery(`
      SELECT ISIN, OldISIN, Security_Code, Security_Name, Ratio1, Ratio2, TRANDATE, SETDATE
      FROM Merger_Record
      WHERE TRANDATE >= '${from}' AND TRANDATE <= '${to}'
      ORDER BY TRANDATE ASC, ROWID ASC
      LIMIT ${MANIFEST_BATCH} OFFSET ${offset}
    `);

    if (!rows || rows.length === 0) break;

    for (const r of rows) {
      const m = r.Merger_Record || r;
      events.push({
        oldIsin: String(m.OldISIN ?? "").trim(),
        newIsin: String(m.ISIN ?? "").trim(),
        effectiveDate: String(m.TRANDATE ?? "").slice(0, 10),
        ratio1: Number(m.Ratio1),
        ratio2: Number(m.Ratio2),
        securityCode: m.Security_Code ?? "",
        securityName: m.Security_Name ?? "",
      });
    }

    if (rows.length < MANIFEST_BATCH) break;
    offset += MANIFEST_BATCH;
  }

  return events;
}

/**
 * All CSV rows for ONE merger event (one row per surviving lot / transaction).
 * Returns "" when the event has no non-zero per-lot `Merger` rows.
 */
async function buildEventCsv({ zcql, event, generatedAt, fromDate, toDate, csvCell }) {
  const { oldIsin, newIsin, effectiveDate, ratio1, ratio2 } = event;
  if (!oldIsin || !newIsin || !isIsoDate(effectiveDate)) return "";

  const r1 = Number(ratio1);
  const r2 = Number(ratio2);

  /* ---- Read each surviving lot row directly ----
     One `Merger` row per post-merger lot: Quantity = new lot qty, WAP = new
     weighted-average price. Zero-quantity rows are markers that the old
     company no longer exists — skip them. */
  const lots = []; // { acc, quantity, wap, recordDate }
  let offset = 0;
  const oldEsc = esc(oldIsin);
  const newEsc = esc(newIsin);

  while (true) {
    const rows = await zcql.executeZCQLQuery(`
      SELECT WS_Account_code, Quantity, WAP, Record_Date
      FROM Merger
      WHERE OldISIN = '${oldEsc}' AND ISIN = '${newEsc}' AND Tran_Type = 'MERGER'
      ORDER BY ROWID ASC
      LIMIT ${MERGER_BATCH} OFFSET ${offset}
    `);

    if (!rows || rows.length === 0) break;

    for (const r of rows) {
      const m = r.Merger || r;
      const acc = String(m.WS_Account_code || "").trim();
      if (!acc) continue;

      const quantity = Number(m.Quantity) || 0;
      if (quantity <= 0) continue; // zero-value marker row (old company closed out)

      lots.push({
        acc,
        quantity,
        wap: m.WAP ?? "",
        recordDate: String(m.Record_Date ?? "").slice(0, 10),
      });
    }

    if (rows.length < MERGER_BATCH) break;
    offset += MERGER_BATCH;
  }

  if (lots.length === 0) return "";

  const accounts = [...new Set(lots.map((l) => l.acc))];
  const virtualToActual = await buildVirtualToActualMap(zcql, accounts);

  const ratioLabel = `${r1}:${r2}`;
  let text = "";

  for (const lot of lots) {
    const actual = virtualToActual.get(lot.acc) || "";

    text +=
      [
        generatedAt,
        fromDate,
        toDate,
        effectiveDate,
        lot.recordDate,
        lot.acc,
        actual,
        oldIsin,
        newIsin,
        "MERGER",
        ratioLabel,
        lot.quantity,
        lot.wap,
      ]
        .map(csvCell)
        .join(",") + "\n";
  }

  return text;
}

module.exports = {
  reportType: "merger",
  header:
    "GENERATED_AT,FROM_DATE,TO_DATE,EFFECTIVE_DATE,RECORD_DATE,VIRTUAL_CODE,ACTUAL_CODE," +
    "OLD_ISIN,NEW_ISIN,TYPE,MERGER_RATIO,QUANTITY,NEW_WAP\n",
  buildManifest,
  buildEventCsv,
};
