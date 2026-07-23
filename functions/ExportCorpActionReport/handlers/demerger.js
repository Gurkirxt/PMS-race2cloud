"use strict";

/**
 * Demerger impact handler for ExportCorpActionReport.
 *
 * Reports how every demerger in a date range affected every client, transaction
 * by transaction. Source of truth is the APPLIED data, read from two tables:
 *   1. `Demerger`        — the authoritative list of demerger events (ratio,
 *                          allocation % + metadata), one row per
 *                          (Old_ISIN, New_ISIN, Record_Date). Written by the
 *                          apply job (functions/DemergerFn).
 *   2. `Demerger_Record` — the per-lot effect: TWO rows per surviving lot —
 *                          an old-ISIN row (always; quantity unchanged, cost
 *                          reduced by the carve-out) and a new-ISIN row (only
 *                          when the allocated qty rounds above 0).
 *
 * Unlike a merger, BOTH companies continue to exist after a demerger, so each
 * CSV row shows both sides of one lot: old quantity / WAP / holding value AND
 * new quantity / WAP / holding value. An old-side row with no new-side partner
 * (allocation rounded to 0 shares) is still real — it is emitted with the NEW_*
 * columns zeroed, never dropped.
 *
 * Per-lot rows keep the ORIGINAL lot's TRANDATE (see DemergerFn), so the event
 * join key is Record_Date (stamped on every per-lot row), and the two sides of
 * one lot are paired by (WS_Account_code, Source_Tran_ROWID, TRANDATE).
 */

const { buildVirtualToActualMap } = require("../virtualToActual.js");

const MANIFEST_BATCH = 270;
const RECORD_BATCH = 250;

const esc = (s) => String(s ?? "").replace(/'/g, "''");
const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "").trim());

/**
 * Frozen work list: every demerger whose Record_Date falls in [fromDate,
 * toDate]. One manifest entry == one demerger event. Record_Date (not
 * Effective_Date) is the operative event date — it is the apply job's
 * idempotency key and the value stamped on every Demerger_Record row.
 */
async function buildManifest(zcql, fromDate, toDate) {
  const from = esc(fromDate);
  const to = esc(toDate);
  const events = [];
  let offset = 0;

  while (true) {
    const rows = await zcql.executeZCQLQuery(`
      SELECT Old_ISIN, New_ISIN, Ratio1, Ratio2, Effective_Date, Record_Date, Allocation_To_New_Pct
      FROM Demerger
      WHERE Record_Date >= '${from}' AND Record_Date <= '${to}'
      ORDER BY Record_Date ASC, ROWID ASC
      LIMIT ${MANIFEST_BATCH} OFFSET ${offset}
    `);

    if (!rows || rows.length === 0) break;

    for (const r of rows) {
      const d = r.Demerger || r;
      events.push({
        oldIsin: String(d.Old_ISIN ?? "").trim(),
        newIsin: String(d.New_ISIN ?? "").trim(),
        recordDate: String(d.Record_Date ?? "").slice(0, 10),
        effectiveDate: String(d.Effective_Date ?? "").slice(0, 10),
        ratio1: Number(d.Ratio1),
        ratio2: Number(d.Ratio2),
        allocationToNewPct: Number(d.Allocation_To_New_Pct) || 0,
      });
    }

    if (rows.length < MANIFEST_BATCH) break;
    offset += MANIFEST_BATCH;
  }

  return events;
}

/**
 * All CSV rows for ONE demerger event (one row per surviving lot, both sides
 * combined). Returns "" when the event has no usable per-lot rows.
 */
async function buildEventCsv({ zcql, event, generatedAt, fromDate, toDate, csvCell }) {
  const { oldIsin, newIsin, recordDate, effectiveDate, ratio1, ratio2, allocationToNewPct } =
    event;
  if (!oldIsin || !newIsin || !isIsoDate(recordDate)) return "";

  const r1 = Number(ratio1);
  const r2 = Number(ratio2);

  /* ---- Read both sides' per-lot rows in one paginated scan ----
     Old-side and new-side rows of the same lot share WS_Account_code,
     Source_Tran_ROWID and TRANDATE; ROWID order keeps same-key lots
     deterministic. */
  const oldRows = []; // { acc, key, qty, wap, holdingValue }
  const newRows = [];
  let offset = 0;
  const oldEsc = esc(oldIsin);
  const newEsc = esc(newIsin);
  const dateEsc = esc(recordDate);

  while (true) {
    const rows = await zcql.executeZCQLQuery(`
      SELECT WS_Account_code, ISIN, QTY, WAP, HOLDING_VALUE, TRANDATE, Source_Tran_ROWID
      FROM Demerger_Record
      WHERE Record_Date = '${dateEsc}' AND Tran_Type = 'DEMERGER'
        AND (ISIN = '${oldEsc}' OR ISIN = '${newEsc}')
      ORDER BY ROWID ASC
      LIMIT ${RECORD_BATCH} OFFSET ${offset}
    `);

    if (!rows || rows.length === 0) break;

    for (const r of rows) {
      const d = r.Demerger_Record || r;
      const acc = String(d.WS_Account_code || "").trim();
      if (!acc) continue;

      const side = {
        acc,
        key: `${acc}|${String(d.Source_Tran_ROWID ?? "").trim()}|${String(d.TRANDATE ?? "").slice(0, 10)}`,
        qty: Number(d.QTY) || 0,
        wap: d.WAP ?? "",
        holdingValue: d.HOLDING_VALUE ?? "",
      };

      const isin = String(d.ISIN ?? "").trim();
      if (isin === oldIsin) oldRows.push(side);
      else if (isin === newIsin) newRows.push(side);
    }

    if (rows.length < RECORD_BATCH) break;
    offset += RECORD_BATCH;
  }

  if (oldRows.length === 0 && newRows.length === 0) return "";

  /* ---- Pair the two sides per lot ----
     Old rows queue up under their pairing key; each new row shifts its partner
     off the matching queue. Old rows left unpaired had 0 new shares allocated;
     new rows with no old partner shouldn't exist (defensive: emit with zeroed
     old side). */
  const oldByKey = new Map(); // key -> queue of old-side rows
  for (const o of oldRows) {
    const q = oldByKey.get(o.key) || [];
    q.push(o);
    oldByKey.set(o.key, q);
  }

  const lots = []; // { acc, old, new }
  for (const n of newRows) {
    const q = oldByKey.get(n.key);
    const o = q && q.length ? q.shift() : null;
    lots.push({ acc: n.acc, old: o, new: n });
  }
  for (const q of oldByKey.values()) {
    for (const o of q) lots.push({ acc: o.acc, old: o, new: null });
  }

  const accounts = [...new Set(lots.map((l) => l.acc))];
  const virtualToActual = await buildVirtualToActualMap(zcql, accounts);

  const ratioLabel = `${r1}:${r2}`;
  let text = "";

  for (const lot of lots) {
    const oldQty = lot.old ? lot.old.qty : 0;
    const newQty = lot.new ? lot.new.qty : 0;
    if (oldQty <= 0 && newQty <= 0) continue; // zero-value marker / legacy row

    const actual = virtualToActual.get(lot.acc) || "";

    text +=
      [
        generatedAt,
        fromDate,
        toDate,
        recordDate,
        effectiveDate,
        lot.acc,
        actual,
        oldIsin,
        newIsin,
        "DEMERGER",
        ratioLabel,
        allocationToNewPct,
        oldQty,
        lot.old ? lot.old.wap : 0,
        lot.old ? lot.old.holdingValue : 0,
        newQty,
        lot.new ? lot.new.wap : 0,
        lot.new ? lot.new.holdingValue : 0,
      ]
        .map(csvCell)
        .join(",") + "\n";
  }

  return text;
}

module.exports = {
  reportType: "demerger",
  header:
    "GENERATED_AT,FROM_DATE,TO_DATE,RECORD_DATE,EFFECTIVE_DATE,VIRTUAL_CODE,ACTUAL_CODE," +
    "OLD_ISIN,NEW_ISIN,TYPE,DEMERGER_RATIO,ALLOCATION_TO_NEW_PCT," +
    "OLD_QUANTITY,OLD_WAP,OLD_HOLDING_VALUE,NEW_QUANTITY,NEW_WAP,NEW_HOLDING_VALUE\n",
  buildManifest,
  buildEventCsv,
};
