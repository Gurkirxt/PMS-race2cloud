exports.getAllAccountCodesFromDatabase = async (zcql, tableName) => {
  try {
    let offset = 0;
    let limit = 270;
    let hasNext = true;

    const rawRows = [];
    while (hasNext) {
      const query = `SELECT WS_Account_code FROM ${tableName} LIMIT ${limit} OFFSET ${offset}`;
      const result = await zcql.executeZCQLQuery(query);
      rawRows.push(...result);
      offset = offset + limit;
      if (result.length <= 0) {
        hasNext = false;
      }
    }

    // Deduplicate by WS_Account_code (table may have multiple rows per account)
    const seen = new Set();
    const cliendIds = [];
    for (const row of rawRows) {
      const r = row.clientIds || row;
      const code = (r.WS_Account_code ?? "").toString().trim();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      cliendIds.push({ clientIds: { WS_Account_code: code } });
    }

    return cliendIds.sort((a, b) =>
      (a.clientIds.WS_Account_code || "").localeCompare(
        b.clientIds.WS_Account_code || "",
      ),
    );
  } catch (error) {
    console.error("Error fetching account codes:", error);
    throw error;
  }
};

/**
 * Actual_Code -> [virtual codes] grouping for the consolidated all-clients
 * export. Holdings are stored scheme-wise (per virtual code); consolidated rows
 * sum each ISIN across the virtual codes that share an actual code.
 */
exports.getAccountActualMapFromDatabase = async (zcql, tableName) => {
  let offset = 0;
  const limit = 270;
  let hasNext = true;
  const rawRows = [];

  while (hasNext) {
    const query = `SELECT WS_Account_code, Actual_Code FROM ${tableName} LIMIT ${limit} OFFSET ${offset}`;
    const result = await zcql.executeZCQLQuery(query);
    rawRows.push(...result);
    offset = offset + limit;
    if (result.length <= 0) {
      hasNext = false;
    }
  }

  // actualCode -> [virtualCode]; fall back to the virtual code itself when
  // Actual_Code is blank so no account is dropped.
  const map = new Map();
  const seenVirtual = new Set();
  for (const row of rawRows) {
    const r = row.clientIds || row;
    const virtual = (r.WS_Account_code ?? "").toString().trim();
    if (!virtual || seenVirtual.has(virtual)) continue;
    seenVirtual.add(virtual);

    const actual = (r.Actual_Code ?? "").toString().trim() || virtual;
    if (!map.has(actual)) map.set(actual, []);
    map.get(actual).push(virtual);
  }

  return [...map.entries()]
    .map(([actualCode, virtualCodes]) => ({ actualCode, virtualCodes }))
    .sort((a, b) => (a.actualCode || "").localeCompare(b.actualCode || ""));
};

/**
 * WS_Account_code -> Actual_Code lookup for the scheme-wise holdings export's
 * ACTUAL_CODE column. Unlike getAccountActualMapFromDatabase, this does NOT
 * fall back to the virtual code when Actual_Code is blank — a code with no
 * mapping is left out of the map so the export renders an empty cell.
 * First mapping wins if a virtual code appears more than once.
 */
exports.getVirtualToActualMapFromDatabase = async (zcql, tableName) => {
  let offset = 0;
  const limit = 270;
  let hasNext = true;
  const map = new Map();

  while (hasNext) {
    const query = `SELECT WS_Account_code, Actual_Code FROM ${tableName} LIMIT ${limit} OFFSET ${offset}`;
    const result = await zcql.executeZCQLQuery(query);
    if (!result.length) break;

    for (const row of result) {
      const r = row.clientIds || row;
      const virtual = (r.WS_Account_code ?? "").toString().trim();
      if (!virtual || map.has(virtual)) continue;

      const actual = (r.Actual_Code ?? "").toString().trim();
      if (actual) map.set(virtual, actual);
    }

    offset = offset + limit;
    if (result.length < limit) hasNext = false;
  }

  return map;
};
