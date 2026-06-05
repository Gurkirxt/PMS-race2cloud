const esc = (s) => String(s ?? "").replace(/'/g, "''");
const SECURITY_LIST_BATCH = 270;

/**
 * GET /api/security/list
 * All securities from Security_List (deduped by ISIN, sorted by name) — used to
 * populate the Security Name and ISIN search dropdowns. Security_List only.
 */
export const getSecurityList = async (req, res) => {
  try {
    const zcql = req.catalystApp.zcql();
    const raw = [];
    let offset = 0;

    while (true) {
      const rows = await zcql.executeZCQLQuery(`
        SELECT ISIN, Security_Code, Security_Name
        FROM Security_List
        WHERE ISIN IS NOT NULL
        ORDER BY ISIN ASC, ROWID ASC
        LIMIT ${SECURITY_LIST_BATCH} OFFSET ${offset}
      `);

      if (!rows?.length) break;

      for (const r of rows) {
        const s = r.Security_List || r;
        const isin = String(s.ISIN ?? "").trim();
        if (!isin) continue;
        raw.push({
          isin,
          securityCode: String(s.Security_Code ?? "").trim(),
          securityName: String(s.Security_Name ?? "").trim(),
        });
      }

      if (rows.length < SECURITY_LIST_BATCH) break;
      offset += SECURITY_LIST_BATCH;
    }

    const seen = new Set();
    const data = [];
    for (const row of raw) {
      if (seen.has(row.isin)) continue;
      seen.add(row.isin);
      data.push(row);
    }

    data.sort((a, b) =>
      (a.securityName || a.isin).localeCompare(b.securityName || b.isin),
    );

    return res.json({ data });
  } catch (error) {
    console.error("Security list fetch error:", error);
    res.status(500).json({
      message: "Failed to fetch security list",
      error: error.message,
    });
  }
};

/**
 * GET /api/security/details?isin=...
 * Full record for one ISIN — every column Security_List carries, returned as-is
 * so the UI can render it dynamically. Security_List only.
 */
export const getSecurityDetails = async (req, res) => {
  try {
    const zcql = req.catalystApp.zcql();
    const isin = (req.query.isin || "").trim();

    if (!isin) {
      return res.status(400).json({ message: "isin is required" });
    }

    const rows = await zcql.executeZCQLQuery(
      `SELECT * FROM Security_List WHERE ISIN = '${esc(isin)}'`,
    );

    const records = (rows || []).map((r) => r.Security_List || r);

    if (records.length === 0) {
      return res.status(404).json({
        message: "No security found for the given ISIN",
        data: null,
        records: [],
        count: 0,
      });
    }

    return res.json({
      data: records[0],
      records,
      count: records.length,
    });
  } catch (error) {
    console.error("Security details fetch error:", error);
    res.status(500).json({
      message: "Failed to fetch security details",
      error: error.message,
    });
  }
};
