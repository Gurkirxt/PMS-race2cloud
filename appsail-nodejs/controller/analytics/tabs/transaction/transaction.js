// Re-enable merger/demerger in transaction list: uncomment imports below + blocks ~307–361 + switch cases ~400–407.
// import { fetchDemergerRecordsForAccount } from "../../../../util/analytics/transactionHistory/demergers.js";
// import { fetchMergerRecordsForAccount } from "../../../../util/analytics/transactionHistory/mergers.js";

/** Cash credits add (|amount| − STT); debits subtract (|amount| + STT). */
export const applyCashEffect = (balance, tranType, amount, stt = 0) => {
  const amt = Math.abs(Number(amount)) || 0;
  const sttVal = Math.abs(Number(stt)) || 0;

  if (
    tranType === "CS+" ||
    tranType === "SL+" ||
    tranType === "DIO" ||
    tranType === "DI0" ||
    tranType === "CSI" ||
    tranType === "DIS" ||
    tranType === "IN1" ||
    tranType === "OI1" ||
    tranType === "SQS" ||
    tranType === "DI1" ||
    tranType === "IN+" ||
    tranType === "DIV+"
  ) {
    return balance + amt - sttVal;
  }

  if (
    tranType === "BY-" ||
    tranType === "MGF" ||
    tranType === "TDO" ||
    tranType === "TDI" ||
    tranType === "E22" ||
    tranType === "E01" ||
    tranType === "CUS" ||
    tranType === "E23" ||
    tranType === "CS-" ||
    tranType === "MGE" ||
    tranType === "E10" ||
    tranType === "PRF" ||
    tranType === "NF-" ||
    tranType === "SQB"
  ) {
    return balance - amt - sttVal;
  }

  return balance;
};

const escSql = (s) => s.replace(/'/g, "''");

export const getPaginatedTransactions = async (req, res) => {
  try {
    const app = req.catalystApp;
    if (!app) {
      return res.status(500).json({ message: "Catalyst app missing" });
    }

    const zcql = app.zcql();
    const limit = Math.max(parseInt(req.query.limit, 10) || 20, 1);

    /* ================= CURSOR ================= */
    const lastDate = (req.query.lastDate || "").trim() || null;
    const lastPriority =
      req.query.lastPriority != null
        ? parseInt(String(req.query.lastPriority), 10)
        : null;
    const lastRowId =
      req.query.lastRowId != null
        ? String(req.query.lastRowId)
        : null;

    const direction = req.query.direction === "prev" ? "prev" : "next";

    const hasCursor =
      lastDate &&
      lastPriority != null &&
      !Number.isNaN(lastPriority) &&
      lastRowId != null;

    /* ================= FILTERS ================= */
    const accountCode = (req.query.accountCode || "").trim();
    const rawAsOnDate = (req.query.asOnDate || "").trim();
    const securityNameFilter = (req.query.securityName || "").trim();

    if (!accountCode) {
      return res.status(200).json({
        data: [],
        nextCursor: null,
        prevCursor: null,
        hasNext: false,
        hasPrev: false,
      });
    }

    const normalizeDate = (d) => {
      if (!d) return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(d)) {
        const [dd, mm, yyyy] = d.split("/");
        return `${yyyy}-${mm}-${dd}`;
      }
      return null;
    };

    const asOnDate = normalizeDate(rawAsOnDate);

    /* ================= FETCH TRANSACTIONS ================= */

    const tranParts = ["WS_Account_code = '" + escSql(accountCode) + "'"];
    if (securityNameFilter) {
      tranParts.push("Security_Name = '" + escSql(securityNameFilter) + "'");
    }
    if (asOnDate) {
      const nextDay = new Date(asOnDate);
      nextDay.setDate(nextDay.getDate() + 1);
      const nextDayStr = nextDay.toISOString().split("T")[0];
      // tranParts.push("SETDATE < '" + nextDayStr + "'");
      tranParts.push("TRANDATE < '" + nextDayStr + "'");
    }

    // const tranQuery = "SELECT ROWID, SETDATE, executionPriority, Tran_Type, Security_Name, Security_code, ISIN, QTY, NETRATE, Net_Amount, STT FROM Transaction WHERE " + tranParts.join(" AND ") + " ORDER BY SETDATE ASC, executionPriority ASC, ROWID ASC";
    // const tranQuery = "SELECT ROWID, TRANDATE, executionPriority, Tran_Type, Security_Name, Security_code, ISIN, QTY, NETRATE, Net_Amount, STT FROM Transaction WHERE " + tranParts.join(" AND ") + " ORDER BY TRANDATE ASC, executionPriority ASC, ROWID ASC";
    const BATCH_SIZE = 300;  // or 270 to match other controllers; stay within ZCQL limit
    const tranQuery = "SELECT ROWID, TRANDATE, SETDATE, executionPriority, Tran_Type, Security_Name, Security_code, ISIN, QTY, NETRATE, Net_Amount, STT FROM Transaction WHERE " + tranParts.join(" AND ") + " ORDER BY TRANDATE ASC, executionPriority ASC, ROWID ASC";

    let transactionRaw = [];
    let txnOffset = 0;
    try {
      while (true) {
        const batchQuery = tranQuery + ` LIMIT ${BATCH_SIZE} OFFSET ${txnOffset}`;
        const batch = await zcql.executeZCQLQuery(batchQuery);
        if (!batch || batch.length === 0) break;
        transactionRaw.push(...batch);
        if (batch.length < BATCH_SIZE) break;
        txnOffset += BATCH_SIZE;
      }
    } catch (e) {
      console.error("Error fetching transactions", e);
    }
    // console.log("[DEBUG] Transaction rows:", (transactionRaw || []).length);

    const transactionRows = (transactionRaw || []).map(row => {
      const t = row.Transaction || row;
      const trandate = t.TRANDATE || t.Trandate || null;
      const setdate = t.SETDATE || t.Setdate || null;
      return {
        rowId: "TX-" + t.ROWID,
        // `date` = TRANDATE for sort + cursor pagination only (not a separate “Date” column in UI)
        date: trandate,
        trandate,
        setdate,
        executionPriority: Number(t.executionPriority || 0) || 0,
        type: t.Tran_Type,
        securityName: t.Security_Name,
        securityCode: t.Security_code,
        isin: t.ISIN,
        quantity: Number(t.QTY) || 0,
        price: Number(t.NETRATE) || 0,
        totalAmount: Number(t.Net_Amount) || 0,
        stt: Number(t.STT || t.Stt || 0) || 0
      };
    });

    /* ================= RESOLVE ISINs FOR CORPORATE ACTIONS ================= */
    // Use ISIN to match corporate actions (not Security_Name, because names differ across tables)
    let isinsForCorpActions = [];

    if (securityNameFilter) {
      // Extract ISINs from the transactions we already fetched
      const isinSet = new Set();
      for (const t of transactionRows) {
        if (t.isin) isinSet.add(t.isin);
      }
      isinsForCorpActions = Array.from(isinSet);
    } else {
      // Fetch all ISINs for this account
      try {
        const isinRows = await zcql.executeZCQLQuery(
          "SELECT DISTINCT ISIN FROM Transaction WHERE WS_Account_code = '" + escSql(accountCode) + "' AND ISIN IS NOT NULL"
        );
        isinsForCorpActions = (isinRows || [])
          .map(r => (r.Transaction || r).ISIN)
          .filter(Boolean);
      } catch (e) {
        console.error("Error fetching ISINs", e);
      }
    }
    // console.log("[DEBUG] ISINs for corp actions:", isinsForCorpActions);

    /* ================= FETCH DIVIDENDS ================= */
    // Dividend table columns: SecurityCode, Security_Name, ISIN, Rate, ExDate, ...
    // NO WS_Account_code column => filter by ISIN

    let dividendRows = [];
    if (isinsForCorpActions.length > 0) {
      const quotedIsins = isinsForCorpActions.map(i => "'" + escSql(i) + "'").join(", ");
      const divParts = ["ISIN IN (" + quotedIsins + ")"];
      if (asOnDate) {
        divParts.push("ExDate <= '" + asOnDate + "'");
      }

      const divQuery = "SELECT ROWID, Security_Name, ISIN, ExDate, Rate FROM Dividend WHERE " + divParts.join(" AND ") + " ORDER BY ExDate ASC, ROWID ASC";
      // console.log("[DEBUG] Dividend query:", divQuery);

      let dividendRaw = [];
      try {
        dividendRaw = await zcql.executeZCQLQuery(divQuery);
      } catch (e) { console.error("Error fetching dividends", e); }
      // console.log("[DEBUG] Dividend rows:", (dividendRaw || []).length);

      dividendRows = (dividendRaw || []).map(row => {
        const d = row.Dividend || row;
        const ev = d.ExDate || null;
        return {
          rowId: "DIV-" + d.ROWID,
          date: ev,
          trandate: ev,
          setdate: ev,
          executionPriority: 5,
          type: "DIV+",
          securityName: d.Security_Name,
          securityCode: null,
          isin: d.ISIN,
          quantity: 0,
          price: Number(d.Rate) || 0,
          totalAmount: Number(d.Rate) || 0,
          stt: 0
        };
      });
    }

    /* ================= FETCH BONUS ================= */
    // Bonus table columns: SecurityCode, SecurityName, BonusShare, ExDate, ..., WS_Account_code, ISIN
    // HAS WS_Account_code => filter by account + ISIN

    let bonusRows = [];
    if (isinsForCorpActions.length > 0) {
      const quotedIsins = isinsForCorpActions.map(i => "'" + escSql(i) + "'").join(", ");
      const bonusParts = [
        "WS_Account_code = '" + escSql(accountCode) + "'",
        "ISIN IN (" + quotedIsins + ")"
      ];
      if (asOnDate) {
        bonusParts.push("ExDate <= '" + asOnDate + "'");
      }

      const bonusQuery = "SELECT ROWID, SecurityName, ISIN, ExDate, BonusShare FROM Bonus WHERE " + bonusParts.join(" AND ") + " ORDER BY ExDate ASC, ROWID ASC";
      // console.log("[DEBUG] Bonus query:", bonusQuery);

      let bonusRaw = [];
      try {
        bonusRaw = await zcql.executeZCQLQuery(bonusQuery);
      } catch (e) { console.error("Error fetching bonus", e); }
      // console.log("[DEBUG] Bonus rows:", (bonusRaw || []).length);

      bonusRows = (bonusRaw || []).map(row => {
        const b = row.Bonus || row;
        const ev = b.ExDate || null;
        return {
          rowId: "BON-" + b.ROWID,
          date: ev,
          trandate: ev,
          setdate: ev,
          executionPriority: 2,
          type: "BONUS",
          securityName: b.SecurityName,
          securityCode: null,
          isin: b.ISIN,
          quantity: Number(b.BonusShare) || 0,
          price: 0,
          totalAmount: 0,
          stt: 0
        };
      });
    }

    /* ================= FETCH SPLIT ================= */
    // Split table columns: Security_Code, Security_Name, Ratio1, Ratio2, Issue_Date, ISIN
    // NO WS_Account_code => filter by ISIN

    let splitRows = [];
    if (isinsForCorpActions.length > 0) {
      const quotedIsins = isinsForCorpActions.map(i => "'" + escSql(i) + "'").join(", ");
      const splitParts = ["ISIN IN (" + quotedIsins + ")"];
      if (asOnDate) {
        splitParts.push("Issue_Date <= '" + asOnDate + "'");
      }

      const splitQuery = "SELECT ROWID, Security_Name, ISIN, Issue_Date, Ratio1, Ratio2 FROM Split WHERE " + splitParts.join(" AND ") + " ORDER BY Issue_Date ASC, ROWID ASC";
      // console.log("[DEBUG] Split query:", splitQuery);

      let splitRaw = [];
      try {
        splitRaw = await zcql.executeZCQLQuery(splitQuery);
      } catch (e) { console.error("Error fetching split", e); }
      // console.log("[DEBUG] Split rows:", (splitRaw || []).length);

      splitRows = (splitRaw || []).map(row => {
        const s = row.Split || row;
        const r1 = Number(s.Ratio1) || 1;
        const r2 = Number(s.Ratio2) || 1;
        const ev = s.Issue_Date || null;
        return {
          rowId: "SPL-" + s.ROWID,
          date: ev,
          trandate: ev,
          setdate: ev,
          executionPriority: 1,
          type: "SPLIT",
          securityName: s.Security_Name,
          securityCode: null,
          isin: s.ISIN,
          quantity: 0,
          price: 0,
          totalAmount: 0,
          stt: 0,
          ratio1: r1,
          ratio2: r2,
          ratio: `${r1}:${r2}`
        };
      });
    }

    /* ================= FETCH DEMERGER_RECORD (disabled) ================= */
    let demergerRows = [];
    /*
    try {
      const demRaw = await fetchDemergerRecordsForAccount({
        zcql,
        accountCode,
        asOnDate,
      });
      demergerRows = (demRaw || []).map((d) => ({
        rowId: "DMG-" + d.ROWID,
        date: d.TRANDATE,
        executionPriority: 3,
        type: "DEMERGER",
        securityName: d.Security_Name,
        securityCode: d.Security_Code,
        isin: d.ISIN,
        quantity: Number(d.QTY) || 0,
        price: Number(d.PRICE) || 0,
        totalAmount: Number(d.TOTAL_AMOUNT) || 0,
        stt: 0,
        holdingAfter: Number(d.HOLDING) || Number(d.QTY) || 0,
      }));
    } catch (e) {
      console.error("Error fetching demerger records", e);
    }
    */

    /* ================= FETCH MERGER (disabled) ================= */
    let mergerRows = [];
    /*
    try {
      const mrgRaw = await fetchMergerRecordsForAccount({
        zcql,
        accountCode,
        asOnDate,
      });
      mergerRows = (mrgRaw || []).map((m) => ({
        rowId: "MRG-" + m.ROWID,
        date: m.TRANDATE,
        executionPriority: 4,
        type: "MERGER",
        securityName: m.Security_Name,
        securityCode: m.SecurityCode,
        isin: m.ISIN,
        quantity: Number(m.Quantity) || Number(m.Holding) || 0,
        price: Number(m.WAP) || 0,
        totalAmount: Number(m.Total_Amount) || 0,
        stt: 0,
        holdingAfter: Number(m.Holding) || Number(m.Quantity) || 0,
      }));
    } catch (e) {
      console.error("Error fetching merger records", e);
    }
    */

    /* ================= MERGE & SORT ================= */

    let allRows = [].concat(transactionRows, dividendRows, bonusRows, splitRows, demergerRows, mergerRows);
    // console.log("[DEBUG] Merged total:", allRows.length, "(Tx:", transactionRows.length, "Div:", dividendRows.length, "Bon:", bonusRows.length, "Spl:", splitRows.length, ")");

    allRows.sort((a, b) => {
      const dA = new Date(a.date).getTime();
      const dB = new Date(b.date).getTime();
      if (dA !== dB) return dA - dB;
      if (a.executionPriority !== b.executionPriority) return a.executionPriority - b.executionPriority;
      return String(a.rowId).localeCompare(String(b.rowId));
    });

    /* ================= RUNNING HOLDING PER ISIN (for SPLIT quantity) ================= */
    const isSellType = (type) => /^SL\+|SQS|OPO|NF-/.test(String(type || ""));
    const runningHoldingByIsin = Object.create(null);

    for (const row of allRows) {
      const isin = row.isin;
      if (!isin) continue;

      const holding = runningHoldingByIsin[isin] ?? 0;

      switch (row.type) {
        case "BONUS":
          runningHoldingByIsin[isin] = holding + (Number(row.quantity) || 0);
          break;
        case "SPLIT": {
          const r1 = Number(row.ratio1) || 1;
          const r2 = Number(row.ratio2) || 1;
          const newHolding = (holding * r2) / r1;
          row.quantity = newHolding;
          runningHoldingByIsin[isin] = newHolding;
          break;
        }
        case "DIV+":
          break;
        /* Re-enable with demerger/merger fetch above
        case "DEMERGER":
          runningHoldingByIsin[isin] = Number(row.holdingAfter) || holding;
          break;
        case "MERGER":
          runningHoldingByIsin[isin] = Number(row.holdingAfter) || holding;
          break;
        */
        default:
          // Transaction: buy adds, sell subtracts
          const qty = Math.abs(Number(row.quantity) || 0);
          runningHoldingByIsin[isin] = isSellType(row.type) ? holding - qty : holding + qty;
          break;
      }
    }

    /* ================= RUNNING BALANCE ================= */

    let runningBalance = 0;
    const transactions = allRows.map(t => {
      runningBalance = applyCashEffect(runningBalance, t.type, t.totalAmount, t.stt);
      return Object.assign({}, t, { cashBalance: runningBalance });
    });

    /* ================= CURSOR-BASED PAGINATION ================= */

    let startIdx = 0;

    if (hasCursor) {
      const cursorIdx = transactions.findIndex(t =>
        t.date === lastDate &&
        t.executionPriority === lastPriority &&
        t.rowId === lastRowId
      );

      if (cursorIdx !== -1) {
        if (direction === "next") {
          startIdx = cursorIdx + 1;
        } else {
          startIdx = Math.max(0, cursorIdx - limit);
        }
      }
    }

    const paginated = transactions.slice(startIdx, startIdx + limit);

    const hasNextPage = (startIdx + limit) < transactions.length;
    const hasPrevPage = startIdx > 0;

    const firstRow = paginated[0];
    const lastRow = paginated[paginated.length - 1];

    const prevCursorObj = firstRow ? {
      lastDate: firstRow.date,
      lastPriority: firstRow.executionPriority,
      lastRowId: firstRow.rowId,
    } : null;

    const nextCursorObj = lastRow ? {
      lastDate: lastRow.date,
      lastPriority: lastRow.executionPriority,
      lastRowId: lastRow.rowId,
    } : null;

    return res.status(200).json({
      data: paginated,
      nextCursor: nextCursorObj,
      prevCursor: prevCursorObj,
      hasNext: hasNextPage,
      hasPrev: hasPrevPage,
    });

  } catch (err) {
    console.error("[getPaginatedTransactions]", err);
    return res.status(500).json({
      message: "Failed to fetch transactions",
      error: err.message,
    });
  }
};

export const getSecurityNameOptions = async (req, res) => {
  try {
    const app = req.catalystApp;
    if (!app) {
      return res.status(500).json({ message: "Catalyst app missing" });
    }

    const zcql = app.zcql();

    const rawSearch = (req.query.search || "").trim();
    const accountCode = (req.query.accountCode || "").trim();
    const safe = escSql(rawSearch);

    const clauses = [];
    if (accountCode) {
      clauses.push("WS_Account_code = '" + escSql(accountCode) + "'");
    }
    if (safe) {
      clauses.push("Security_Name LIKE '*" + safe + "*'");
    }

    const whereSql = clauses.length ? "WHERE " + clauses.join(" AND ") : "";

    const fetchLimit = 300;
    let offset = 0;
    const securityNameSet = new Set();

    while (true) {
      const query = "SELECT DISTINCT Security_Name FROM Transaction " + whereSql + " ORDER BY Security_Name ASC LIMIT " + offset + ", " + fetchLimit;
      const rows = await zcql.executeZCQLQuery(query);

      if (!rows || !rows.length) break;

      for (const r of rows) {
        const row = r.Transaction || r;
        if (row.Security_Name) {
          securityNameSet.add(row.Security_Name);
        }
      }

      if (rows.length < fetchLimit) break;
      offset += fetchLimit;
    }

    return res.status(200).json({
      data: Array.from(securityNameSet),
    });
  } catch (err) {
    console.error("[getSecurityNameOptions]", err);
    return res.status(500).json({
      message: "Failed to fetch security names",
      error: err.message,
    });
  }
};