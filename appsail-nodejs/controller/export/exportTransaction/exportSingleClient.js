import { PassThrough } from "stream";
import { applyCashEffect } from "../../analytics/tabs/transaction/transaction.js";

const escSql = (s) => s.replace(/'/g, "''");

export const exportTransactionPerAccount = async (req, res) => {
  try {
    /* ================= VALIDATION ================= */
    const { accountCode, asOnDate, securityName } = req.query;

    if (!accountCode) {
      return res.status(400).json({
        message: "accountCode is required for transaction export",
      });
    }

    /* ================= INIT ================= */
    const catalystApp = req.catalystApp;
    const zcql = catalystApp.zcql();

    const stratus = catalystApp.stratus();
    const bucket = stratus.bucket("export-app-data");

    /* ================= CREATE CSV STREAM ================= */
    const csvStream = new PassThrough();
    const fileName = `transaction-export-${accountCode}-${Date.now()}.csv`;

    const uploadPromise = bucket.putObject(fileName, csvStream, {
      overwrite: true,
      contentType: "text/csv",
    });

    /* ================= CSV HEADER ================= */
    csvStream.write(
      "DATE,TYPE,SECURITY_NAME,SECURITY_CODE,ISIN,QUANTITY,PRICE,TOTAL_AMOUNT,STT,CASH_BALANCE\n",
    );

    /* ================= FETCH TRANSACTIONS ================= */
    const tranParts = ["WS_Account_code = '" + escSql(accountCode) + "'"];
    if (securityName) {
      tranParts.push("Security_Name = '" + escSql(securityName) + "'");
    }
    if (asOnDate) {
      const nextDay = new Date(asOnDate);
      nextDay.setDate(nextDay.getDate() + 1);
      const nextDayStr = nextDay.toISOString().split("T")[0];
      tranParts.push("TRANDATE < '" + nextDayStr + "'");
    }

    const BATCH_SIZE = 300;
    let transactionRows = [];
    let offset = 0;

    while (true) {
      const rows = await zcql.executeZCQLQuery(
        "SELECT ROWID, TRANDATE, executionPriority, Tran_Type, Security_Name, Security_code, ISIN, QTY, NETRATE, Net_Amount, STT FROM Transaction WHERE " +
        tranParts.join(" AND ") +
        " ORDER BY TRANDATE ASC, executionPriority ASC, ROWID ASC LIMIT " + offset + ", " + BATCH_SIZE
      );

      if (!rows || !rows.length) break;

      for (const r of rows) {
        const t = r.Transaction || r;
        transactionRows.push({
          rowId: "TX-" + t.ROWID,
          date: t.TRANDATE || t.Trandate || null,
          executionPriority: Number(t.executionPriority || 0) || 0,
          type: t.Tran_Type,
          securityName: t.Security_Name,
          securityCode: t.Security_code,
          isin: t.ISIN,
          quantity: Number(t.QTY) || 0,
          price: Number(t.NETRATE) || 0,
          totalAmount: Number(t.Net_Amount) || 0,
          stt: Number(t.STT || t.Stt || 0) || 0
        });
      }

      if (rows.length < BATCH_SIZE) break;
      offset += BATCH_SIZE;
    }

    /* ================= RESOLVE ISINs FOR CORPORATE ACTIONS ================= */
    let isinsForCorpActions = [];

    if (securityName) {
      const isinSet = new Set();
      for (const t of transactionRows) {
        if (t.isin) isinSet.add(t.isin);
      }
      isinsForCorpActions = Array.from(isinSet);
      console.log("[EXPORT DEBUG] ISINs from securityName filter:", isinsForCorpActions);
    } else {
      try {
        const isinQuery = "SELECT DISTINCT ISIN FROM Transaction WHERE WS_Account_code = '" + escSql(accountCode) + "' AND ISIN IS NOT NULL";
        console.log("[EXPORT DEBUG] ISIN query:", isinQuery);
        const isinRows = await zcql.executeZCQLQuery(isinQuery);
        console.log("[EXPORT DEBUG] ISIN raw result count:", (isinRows || []).length);
        isinsForCorpActions = (isinRows || [])
          .map(r => (r.Transaction || r).ISIN)
          .filter(Boolean);
      } catch (e) {
        console.error("[EXPORT DEBUG] ERROR fetching ISINs:", e);
      }
    }
    console.log("[EXPORT DEBUG] Final ISINs for corp actions:", isinsForCorpActions.length, isinsForCorpActions.slice(0, 5));

    /* ================= FETCH DIVIDENDS ================= */
    let dividendRows = [];
    if (isinsForCorpActions.length > 0) {
      const quotedIsins = isinsForCorpActions.map(i => "'" + escSql(i) + "'").join(", ");
      const divParts = ["ISIN IN (" + quotedIsins + ")"];
      if (asOnDate) {
        divParts.push("ExDate <= '" + asOnDate + "'");
      }
      const divQuery = "SELECT ROWID, Security_Name, ISIN, ExDate, Rate FROM Dividend WHERE " + divParts.join(" AND ") + " ORDER BY ExDate ASC, ROWID ASC";
      console.log("[EXPORT DEBUG] Dividend query:", divQuery);

      try {
        const dividendRaw = await zcql.executeZCQLQuery(divQuery);
        console.log("[EXPORT DEBUG] Dividend rows:", (dividendRaw || []).length);
        dividendRows = (dividendRaw || []).map(row => {
          const d = row.Dividend || row;
          return {
            rowId: "DIV-" + d.ROWID,
            date: d.ExDate,
            executionPriority: -1,
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
      } catch (e) { console.error("[EXPORT DEBUG] ERROR fetching dividends:", e); }
    } else {
      console.log("[EXPORT DEBUG] Skipping Dividend fetch — no ISINs");
    }

    /* ================= FETCH BONUS ================= */
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
      console.log("[EXPORT DEBUG] Bonus query:", bonusQuery);

      try {
        const bonusRaw = await zcql.executeZCQLQuery(bonusQuery);
        console.log("[EXPORT DEBUG] Bonus rows:", (bonusRaw || []).length);
        bonusRows = (bonusRaw || []).map(row => {
          const b = row.Bonus || row;
          return {
            rowId: "BON-" + b.ROWID,
            date: b.ExDate,
            executionPriority: -2,
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
      } catch (e) { console.error("[EXPORT DEBUG] ERROR fetching bonus:", e); }
    } else {
      console.log("[EXPORT DEBUG] Skipping Bonus fetch — no ISINs");
    }

    /* ================= FETCH SPLIT ================= */
    let splitRows = [];
    if (isinsForCorpActions.length > 0) {
      const quotedIsins = isinsForCorpActions.map(i => "'" + escSql(i) + "'").join(", ");
      const splitParts = ["ISIN IN (" + quotedIsins + ")"];
      if (asOnDate) {
        splitParts.push("Issue_Date <= '" + asOnDate + "'");
      }
      const splitQuery = "SELECT ROWID, Security_Name, ISIN, Issue_Date, Ratio1, Ratio2 FROM Split WHERE " + splitParts.join(" AND ") + " ORDER BY Issue_Date ASC, ROWID ASC";
      console.log("[EXPORT DEBUG] Split query:", splitQuery);

      try {
        const splitRaw = await zcql.executeZCQLQuery(splitQuery);
        console.log("[EXPORT DEBUG] Split rows:", (splitRaw || []).length);
        splitRows = (splitRaw || []).map(row => {
          const s = row.Split || row;
          return {
            rowId: "SPL-" + s.ROWID,
            date: s.Issue_Date,
            executionPriority: -3,
            type: "SPLIT",
            securityName: s.Security_Name,
            securityCode: null,
            isin: s.ISIN,
            quantity: 0,
            price: 0,
            totalAmount: 0,
            stt: 0
          };
        });
      } catch (e) { console.error("[EXPORT DEBUG] ERROR fetching split:", e); }
    } else {
      console.log("[EXPORT DEBUG] Skipping Split fetch — no ISINs");
    }

    /* ================= MERGE & SORT ================= */
    let allRows = [].concat(transactionRows, dividendRows, bonusRows, splitRows);

    allRows.sort((a, b) => {
      const dA = new Date(a.date).getTime();
      const dB = new Date(b.date).getTime();
      if (dA !== dB) return dA - dB;
      if (a.executionPriority !== b.executionPriority) return a.executionPriority - b.executionPriority;
      return String(a.rowId).localeCompare(String(b.rowId));
    });

    /* ================= WRITE CSV WITH RUNNING BALANCE ================= */
    let runningBalance = 0;
    let totalExported = 0;

    for (const t of allRows) {
      runningBalance = applyCashEffect(runningBalance, t.type, t.totalAmount, t.stt);

      const line = [
        t.date,
        t.type,
        t.securityName,
        t.securityCode || "",
        t.isin || "",
        t.quantity,
        t.price,
        t.totalAmount,
        t.stt,
        runningBalance,
      ]
        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
        .join(",");

      csvStream.write(line + "\n");
      totalExported++;
    }

    if (totalExported === 0) {
      csvStream.end();
      await uploadPromise;
      return res.status(404).json({
        message: `No transactions found for accountCode ${accountCode}`,
      });
    }

    csvStream.end();
    await uploadPromise;

    const downloadUrl = await bucket.generatePreSignedUrl(fileName, "GET", {
      expiresIn: 3600,
    });

    return res.status(200).json({
      message: "Transaction export successful",
      downloadUrl,
    });
  } catch (error) {
    console.error("Transaction export error:", error);
    return res.status(500).json({
      message: "Internal Server Error",
      error: error.message,
    });
  }
};
