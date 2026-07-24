"use strict";

/**
 * Vendored copy of appsail-nodejs/util/mapVirtualToActualCodes.js
 * (Catalyst functions can't import from the AppSail tree, so each function
 * carries its own copy of shared helpers.)
 *
 * Resolves WS_Account_code (virtual) -> Actual_Code from the `clientIds` table.
 * Uses a batched IN-list (mirrors the ACCOUNT_LOOKUP_BATCH pattern in
 * controller/uploader/DividendUploader.js) so a widely-held corporate action
 * doesn't fire one query per account.
 */

const ACCOUNT_LOOKUP_BATCH = 50;

const esc = (s) => String(s ?? "").replace(/'/g, "''");

/**
 * Build a Map<virtualCode, actualCode> for the given virtual codes.
 * Every requested code is present in the result (empty string when the
 * clientIds table has no Actual_Code mapping for it).
 */
async function buildVirtualToActualMap(zcql, virtualCodes) {
  const map = new Map();

  const unique = [
    ...new Set(
      (virtualCodes || []).map((c) => String(c ?? "").trim()).filter(Boolean),
    ),
  ];
  if (!unique.length) return map;

  for (let i = 0; i < unique.length; i += ACCOUNT_LOOKUP_BATCH) {
    const slice = unique.slice(i, i + ACCOUNT_LOOKUP_BATCH);
    const inList = slice.map((a) => `'${esc(a)}'`).join(",");

    let rows = [];
    try {
      rows = await zcql.executeZCQLQuery(`
        SELECT WS_Account_code, Actual_Code
        FROM clientIds
        WHERE WS_Account_code IN (${inList})
      `);
    } catch (err) {
      console.error("[virtualToActual] batch lookup failed:", err.message);
      // Leave this slice unmapped; codes get an empty Actual_Code below.
    }

    for (const r of rows || []) {
      const row = r.clientIds || r;
      const virtual = String(row.WS_Account_code ?? "").trim();
      if (!virtual) continue;
      const actual = String(row.Actual_Code ?? "").trim();
      // Prefer a non-empty Actual_Code when duplicate virtual codes exist.
      if (!map.has(virtual) || (!map.get(virtual) && actual)) {
        map.set(virtual, actual);
      }
    }
  }

  // Guarantee an entry for every requested code so callers can rely on .get().
  for (const code of unique) {
    if (!map.has(code)) map.set(code, "");
  }

  return map;
}

module.exports = { buildVirtualToActualMap };
