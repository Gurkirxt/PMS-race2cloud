"use strict";

/**
 * Bonus impact handler for ExportCorpActionReport.
 *
 * Reports how every bonus in a date range affected every client. Source of
 * truth is the APPLIED data, read from two tables:
 *   1. `Bonus_Record` — the authoritative list of bonus events that happened
 *                       (ratio + metadata), one row per (ISIN, ExDate). Written
 *                       by the apply job (functions/UpdateBonusTable).
 *   2. `Bonus`        — the per-account effect, one row per affected account per
 *                       event, keyed (ISIN, WS_Account_code, ExDate). BonusShare
 *                       is the already-applied absolute count of bonus shares
 *                       granted (floor(holding * Ratio1 / Ratio2)).
 *
 * SHARES_ALLOCATED is read straight off the per-account `Bonus` table — the
 * count is stored directly, so (unlike split) there is no before/after holdings
 * diff and no `Holdings` read. Bonus shares are always allocated at zero cost,
 * so the count is non-negative.
 */

const { buildVirtualToActualMap } = require("../virtualToActual.js");

const MANIFEST_BATCH = 270;
const BONUS_BATCH = 250;

const esc = (s) => String(s ?? "").replace(/'/g, "''");
const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "").trim());

/**
 * Frozen work list: every bonus whose ExDate falls in [fromDate, toDate].
 * One manifest entry == one bonus event.
 */
async function buildManifest(zcql, fromDate, toDate) {
  const from = esc(fromDate);
  const to = esc(toDate);
  const events = [];
  let offset = 0;

  while (true) {
    const rows = await zcql.executeZCQLQuery(`
      SELECT SecurityCode, SecurityName, Ratio1, Ratio2, ExDate, ISIN
      FROM Bonus_Record
      WHERE ExDate >= '${from}' AND ExDate <= '${to}'
      ORDER BY ExDate ASC, ROWID ASC
      LIMIT ${MANIFEST_BATCH} OFFSET ${offset}
    `);

    if (!rows || rows.length === 0) break;

    for (const r of rows) {
      const b = r.Bonus_Record || r;
      events.push({
        isin: String(b.ISIN ?? "").trim(),
        exDate: String(b.ExDate ?? "").slice(0, 10),
        ratio1: Number(b.Ratio1),
        ratio2: Number(b.Ratio2),
        securityCode: b.SecurityCode ?? "",
        securityName: b.SecurityName ?? "",
      });
    }

    if (rows.length < MANIFEST_BATCH) break;
    offset += MANIFEST_BATCH;
  }

  return events;
}

/**
 * All CSV rows for ONE bonus event (one row per affected account).
 * Returns "" when the event has no per-account `Bonus` rows.
 */
async function buildEventCsv({ zcql, event, generatedAt, fromDate, toDate, csvCell }) {
  const { isin, exDate, ratio1, ratio2 } = event;
  if (!isin || !isIsoDate(exDate)) return "";

  const r1 = Number(ratio1);
  const r2 = Number(ratio2);

  /* ---- Read each account's allocated bonus shares directly ----
     One `Bonus` row per affected account per event; BonusShare is the applied
     count. Summing defensively in case of any duplicate rows. */
  const byAccount = new Map(); // account -> shares allocated
  let offset = 0;
  const isinEsc = esc(isin);
  const dateEsc = esc(exDate);

  while (true) {
    const rows = await zcql.executeZCQLQuery(`
      SELECT WS_Account_code, BonusShare
      FROM Bonus
      WHERE ISIN = '${isinEsc}' AND ExDate = '${dateEsc}'
      ORDER BY ROWID ASC
      LIMIT ${BONUS_BATCH} OFFSET ${offset}
    `);

    if (!rows || rows.length === 0) break;

    for (const r of rows) {
      const b = r.Bonus || r;
      const acc = String(b.WS_Account_code || "").trim();
      if (!acc) continue;
      const shares = Number(b.BonusShare) || 0;
      byAccount.set(acc, (byAccount.get(acc) || 0) + shares);
    }

    if (rows.length < BONUS_BATCH) break;
    offset += BONUS_BATCH;
  }

  if (byAccount.size === 0) return "";

  const accounts = [...byAccount.keys()];
  const virtualToActual = await buildVirtualToActualMap(zcql, accounts);

  const ratioLabel = `${r1}:${r2}`;
  let text = "";

  for (const [acc, sharesAllocated] of byAccount) {
    if (sharesAllocated <= 0) continue; // no shares allocated / dust
    const actual = virtualToActual.get(acc) || "";

    text +=
      [
        generatedAt,
        fromDate,
        toDate,
        exDate,
        acc,
        actual,
        isin,
        "BONUS",
        ratioLabel,
        sharesAllocated,
      ]
        .map(csvCell)
        .join(",") + "\n";
  }

  return text;
}

module.exports = {
  reportType: "bonus",
  header:
    "GENERATED_AT,FROM_DATE,TO_DATE,EX_DATE,VIRTUAL_CODE,ACTUAL_CODE," +
    "ISIN,TYPE,BONUS_RATIO,SHARES_ALLOCATED\n",
  buildManifest,
  buildEventCsv,
};
