const CLIENT_IDS_BATCH = 270;

/**
 * Resolve Actual_Code for one virtual code (WS_Account_code).
 * Mirrors the working lookup in exportSingleClientHolding.js.
 */
async function lookupActualForVirtual(zcql, virtualCode) {
  const esc = String(virtualCode ?? "").replace(/'/g, "''");
  if (!esc) return "";

  const rows = await zcql.executeZCQLQuery(
    `SELECT Actual_Code FROM clientIds WHERE WS_Account_code = '${esc}' LIMIT 5`,
  );
  if (!rows?.length) return "";

  // Prefer the first non-empty Actual_Code if duplicate clientIds rows exist.
  for (const r of rows) {
    const row = r.clientIds || r;
    const actual = String(row?.Actual_Code ?? "").trim();
    if (actual) return actual;
  }
  return "";
}

/**
 * Build WS_Account_code (virtual) → Actual_Code map from clientIds.
 * When `virtualCodes` is provided, looks up only those codes (reliable + fast).
 * Otherwise pages the full clientIds table.
 */
export async function buildVirtualToActualMap(zcql, virtualCodes = null) {
  const map = new Map();

  if (Array.isArray(virtualCodes) && virtualCodes.length > 0) {
    const unique = [
      ...new Set(
        virtualCodes.map((c) => String(c ?? "").trim()).filter(Boolean),
      ),
    ];
    for (const code of unique) {
      try {
        const actual = await lookupActualForVirtual(zcql, code);
        map.set(code, actual);
      } catch (err) {
        console.error(
          `[mapVirtualToActualCodes] lookup failed for ${code}:`,
          err.message,
        );
        map.set(code, "");
      }
    }
    return map;
  }

  let offset = 0;
  while (true) {
    const batch = await zcql.executeZCQLQuery(
      `SELECT WS_Account_code, Actual_Code FROM clientIds LIMIT ${CLIENT_IDS_BATCH} OFFSET ${offset}`,
    );
    if (!batch?.length) break;

    for (const r of batch) {
      const row = r.clientIds || r;
      const virtual = String(row.WS_Account_code ?? "").trim();
      if (!virtual) continue;
      const actual = String(row.Actual_Code ?? "").trim();
      // Prefer non-empty Actual_Code when duplicate virtual codes exist.
      if (!map.has(virtual) || (!map.get(virtual) && actual)) {
        map.set(virtual, actual);
      }
    }

    if (batch.length < CLIENT_IDS_BATCH) break;
    offset += CLIENT_IDS_BATCH;
  }

  return map;
}
