"use strict";

/**
 * Dividend impact handler for ExportCorpActionReport.
 *
 * Reports how every dividend in a date range affected every client. Source of
 * truth is the APPLIED data, read from two tables. NOTE the `_Record` naming is
 * INVERTED relative to bonus:
 *   1. `Dividend`        — the master list of dividend events (rate + metadata),
 *                          one row per (ISIN, RecordDate). Written by the apply
 *                          job functions/UpdateDividendData/index.js.
 *   2. `Dividend_Record` — the per-account effect, one row per affected account
 *                          per event, keyed (ISIN, WS_Account_code, RecordDate).
 *                          Holding = shares held at record date, Rate = per-share
 *                          rate, Dividend_Amount = cash = round(Holding*Rate, 2),
 *                          all pre-computed and stored by the apply job.
 *
 * SHARES_HELD, RATE and CASH_RECEIVED are read straight off `Dividend_Record` —
 * every value is stored, so (unlike split) there is no holdings diff / FIFO
 * replay and no `Holdings` read. CASH_RECEIVED is GROSS (Holding*Rate, before any
 * TDS/CA tax) — exactly "rate x shares held".
 *
 * Column casing traps: master `Dividend` uses SecurityCode / Security_Name;
 * per-account `Dividend_Record` uses Security_Code. The record-date column is
 * RecordDate on both.
 */

const { buildVirtualToActualMap } = require("../virtualToActual.js");

const MANIFEST_BATCH = 270;
const DIVIDEND_BATCH = 250;

const esc = (s) => String(s ?? "").replace(/'/g, "''");
const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "").trim());

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function round4(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

/**
 * Frozen work list: every dividend whose RecordDate falls in [fromDate, toDate].
 * One manifest entry == one dividend event.
 */
async function buildManifest(zcql, fromDate, toDate) {
  const from = esc(fromDate);
  const to = esc(toDate);
  const events = [];
  let offset = 0;

  while (true) {
    const rows = await zcql.executeZCQLQuery(`
      SELECT SecurityCode, Security_Name, ISIN, Rate, RecordDate, PaymentDate, Dividend_Type
      FROM Dividend
      WHERE RecordDate >= '${from}' AND RecordDate <= '${to}'
      ORDER BY RecordDate ASC, ROWID ASC
      LIMIT ${MANIFEST_BATCH} OFFSET ${offset}
    `);

    if (!rows || rows.length === 0) break;

    for (const r of rows) {
      const d = r.Dividend || r;
      events.push({
        isin: String(d.ISIN ?? "").trim(),
        recordDate: String(d.RecordDate ?? "").slice(0, 10),
        rate: Number(d.Rate),
        securityCode: d.SecurityCode ?? "",
        securityName: d.Security_Name ?? "",
        dividendType: d.Dividend_Type ?? "",
      });
    }

    if (rows.length < MANIFEST_BATCH) break;
    offset += MANIFEST_BATCH;
  }

  return events;
}

/**
 * All CSV rows for ONE dividend event (one row per affected account).
 * Returns "" when the event has no per-account `Dividend_Record` rows.
 */
async function buildEventCsv({ zcql, event, generatedAt, fromDate, toDate, csvCell }) {
  const { isin, recordDate } = event;
  if (!isin || !isIsoDate(recordDate)) return "";

  const eventRate = Number(event.rate);

  /* ---- Read each account's dividend effect directly ----
     One `Dividend_Record` row per affected account per event; Holding, Rate and
     Dividend_Amount are all applied values. Summing defensively in case of any
     duplicate rows. */
  const byAccount = new Map(); // account -> { holding, cash, rate }
  let offset = 0;
  const isinEsc = esc(isin);
  const dateEsc = esc(recordDate);

  while (true) {
    const rows = await zcql.executeZCQLQuery(`
      SELECT WS_Account_code, Holding, Rate, Dividend_Amount
      FROM Dividend_Record
      WHERE ISIN = '${isinEsc}' AND RecordDate = '${dateEsc}'
      ORDER BY ROWID ASC
      LIMIT ${DIVIDEND_BATCH} OFFSET ${offset}
    `);

    if (!rows || rows.length === 0) break;

    for (const r of rows) {
      const d = r.Dividend_Record || r;
      const acc = String(d.WS_Account_code || "").trim();
      if (!acc) continue;

      const holding = Number(d.Holding) || 0;
      const rate = Number.isFinite(Number(d.Rate)) ? Number(d.Rate) : eventRate;
      const cash = Number.isFinite(Number(d.Dividend_Amount))
        ? Number(d.Dividend_Amount)
        : round2(holding * rate);

      const cur = byAccount.get(acc) || { holding: 0, cash: 0, rate };
      cur.holding += holding;
      cur.cash += cash;
      // Keep a representative per-share rate (constant across an event's rows).
      if (!Number.isFinite(cur.rate) && Number.isFinite(rate)) cur.rate = rate;
      byAccount.set(acc, cur);
    }

    if (rows.length < DIVIDEND_BATCH) break;
    offset += DIVIDEND_BATCH;
  }

  if (byAccount.size === 0) return "";

  const accounts = [...byAccount.keys()];
  const virtualToActual = await buildVirtualToActualMap(zcql, accounts);

  let text = "";

  for (const [acc, agg] of byAccount) {
    if (agg.holding <= 0) continue; // not actually a holder
    const actual = virtualToActual.get(acc) || "";
    const rate = Number.isFinite(agg.rate) ? agg.rate : eventRate;

    text +=
      [
        generatedAt,
        fromDate,
        toDate,
        recordDate,
        acc,
        actual,
        isin,
        "DIVIDEND",
        round4(rate),
        round4(agg.holding),
        round2(agg.cash),
      ]
        .map(csvCell)
        .join(",") + "\n";
  }

  return text;
}

module.exports = {
  reportType: "dividend",
  header:
    "GENERATED_AT,FROM_DATE,TO_DATE,RECORD_DATE,VIRTUAL_CODE,ACTUAL_CODE," +
    "ISIN,TYPE,RATE,SHARES_HELD,CASH_RECEIVED\n",
  buildManifest,
  buildEventCsv,
};
