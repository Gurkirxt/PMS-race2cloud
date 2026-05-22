const BATCH = 300;

const esc = (s) => String(s ?? "").replace(/'/g, "''");

/** Maps a ZCQL row to API/UI fields — stored DB values only (no balance recompute). */
function mapPassbookRow(r) {
  const row = r.Cash_Balance_Per_Transaction || r;
  return {
    ROWID: row.ROWID,
    Account_Code: row.Account_Code,
    Transaction_Date: (row.Transaction_Date || "").toString().slice(0, 10),
    Settlement_Date: (row.Settlement_Date || "").toString().slice(0, 10),
    ISIN: row.ISIN,
    Security_Name: row.Security_Name,
    Transaction_Type: row.Transaction_Type || "",
    Quantity: row.Quantity,
    Price: row.Price,
    Total_Amount: row.Total_Amount,
    Cash_Balance:
      row.Cash_Balance != null && row.Cash_Balance !== ""
        ? Number(row.Cash_Balance)
        : null,
    STT: row.STT,
    Sequence: row.Sequence,
  };
}

export const getIsinList = async (req, res) => {
  try {
    const zcql = req.catalystApp.zcql();
    const accountCode = (req.query.accountCode || "").trim();
    if (!accountCode) return res.status(400).json({ message: "accountCode is required" });

    const isinMap = new Map();
    let offset = 0;

    while (true) {
      const rows = await zcql.executeZCQLQuery(
        `SELECT ISIN, Security_Name FROM Cash_Balance_Per_Transaction WHERE Account_Code = '${esc(accountCode)}' AND ISIN IS NOT NULL LIMIT ${BATCH} OFFSET ${offset}`,
      );
      if (!rows || rows.length === 0) break;
      for (const r of rows) {
        const row = r.Cash_Balance_Per_Transaction || r;
        const isin = (row.ISIN || "").trim();
        const name = (row.Security_Name || "").trim();
        if (isin && !isinMap.has(isin)) {
          isinMap.set(isin, name);
        }
      }
      if (rows.length < BATCH) break;
      offset += BATCH;
    }

    const data = Array.from(isinMap.entries())
      .map(([isin, name]) => ({ isin, name: name || isin }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return res.json({ data });
  } catch (error) {
    console.error("ISIN list fetch error:", error);
    res.status(500).json({ message: "Failed to fetch ISIN list", error: error.message });
  }
};

/**
 * Cash passbook — reads Cash_Balance_Per_Transaction as stored by Cal_CB_Per_TNX
 * (and dividend apply). No running-balance recompute; UI matches ZCQL on the table.
 */
export const getCashPassbook = async (req, res) => {
  try {
    const zcql = req.catalystApp.zcql();

    const {
      accountCode: accountCodeRaw,
      page = "1",
      pageSize = "25",
      fromDate,
      toDate,
      search,
      isin,
      tranType,
    } = req.query;

    const accountCode = (accountCodeRaw || "").trim();
    if (!accountCode) {
      return res.status(400).json({ message: "accountCode is required" });
    }

    const pg = Math.max(1, parseInt(page, 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 25));

    let conditions = `Account_Code = '${esc(accountCode)}'`;

    if (fromDate && /^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
      conditions += ` AND Transaction_Date >= '${fromDate}'`;
    }

    if (toDate && /^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
      const nextDay = new Date(toDate);
      nextDay.setDate(nextDay.getDate() + 1);
      const nextDayStr = nextDay.toISOString().split("T")[0];
      conditions += ` AND Transaction_Date < '${nextDayStr}'`;
    }

    if (isin && isin.trim()) {
      conditions += ` AND ISIN = '${esc(isin.trim())}'`;
    } else if (search && search.trim()) {
      const s = esc(search.trim());
      conditions += ` AND (ISIN LIKE '%${s}%' OR Security_Name LIKE '%${s}%')`;
    }

    if (tranType && tranType.trim()) {
      const types = tranType
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (types.length === 1) {
        conditions += ` AND Transaction_Type = '${esc(types[0])}'`;
      } else if (types.length > 1) {
        const inList = types.map((t) => `'${esc(t)}'`).join(", ");
        conditions += ` AND Transaction_Type IN (${inList})`;
      }
    }

    const countResult = await zcql.executeZCQLQuery(
      `SELECT COUNT(ROWID) FROM Cash_Balance_Per_Transaction WHERE ${conditions}`,
    );
    const countRow = countResult?.[0]?.Cash_Balance_Per_Transaction || countResult?.[0] || {};
    const totalCount = Number(
      countRow["COUNT(ROWID)"] ?? countRow.cnt ?? countRow["count"] ?? Object.values(countRow)[0] ?? 0,
    );

    const totalPages = Math.max(1, Math.ceil(totalCount / size));
    const pgClamped = Math.min(pg, totalPages);
    const offset = (pgClamped - 1) * size;

    if (totalCount === 0) {
      return res.json({
        data: [],
        totalCount: 0,
        page: 1,
        pageSize: size,
        totalPages: 1,
      });
    }

    const dataRows = await zcql.executeZCQLQuery(
      `SELECT ROWID, Account_Code, Transaction_Date, Settlement_Date, ISIN, Security_Name,
              Transaction_Type, Quantity, Price, Total_Amount, Cash_Balance, STT, Sequence
       FROM Cash_Balance_Per_Transaction
       WHERE ${conditions}
       ORDER BY Sequence DESC
       LIMIT ${offset}, ${size}`,
    );

    const data = (dataRows || []).map(mapPassbookRow);

    return res.json({
      data,
      totalCount,
      page: pgClamped,
      pageSize: size,
      totalPages,
    });
  } catch (error) {
    console.error("Cash passbook fetch error:", error);
    res.status(500).json({
      message: "Failed to fetch cash passbook",
      error: error.message,
    });
  }
};
