import { runFifoEngine } from "../../util/analytics/transactionHistory/fifo.js";

const ZCQL_ROW_LIMIT = 270;

const parseCatalystTime = (ct) => {
  if (!ct) return 0;
  const fixed = ct.replace(/:(\d{3})$/, ".$1");
  const ms = new Date(fixed).getTime();
  return isNaN(ms) ? 0 : ms;
};

export const getAllSecuritiesISINs = async (req, res) => {
    try {
      if (!req.catalystApp) {
        return res.status(500).json({
          success: false,
          message: "Catalyst app not initialized",
        });
      }
  
      const zcql = req.catalystApp.zcql();
      const LIMIT = 270;
      let offset = 0;
      const securities = [];
  
      while (true) {
        const rows = await zcql.executeZCQLQuery(`
          SELECT ISIN, Security_Code, Security_Name
          FROM Security_List
          WHERE ISIN IS NOT NULL
          LIMIT ${LIMIT} OFFSET ${offset}
        `);
  
        if (!rows || rows.length === 0) break;
  
        rows.forEach((r) => {
          const s = r.Security_List;
          securities.push({
            isin: s.ISIN,
            securityCode: s.Security_Code,
            securityName: s.Security_Name,
          });
        });
  
        offset += LIMIT;
      }
  
      return res.json({ success: true, data: securities });
    } catch (error) {
      console.error(error);
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  };

  export const previewStockDividend = async (req, res) => {
    try {
      if (!req.catalystApp) {
        return res.status(500).json({
          success: false,
          message: "Catalyst app not initialized",
        });
      }

      const { isin, recordDate, rate, paymentDate } = req.body;
      const rateNum = Number(rate);

      if (!Number.isFinite(rateNum) || rateNum <= 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid dividend rate value",
        });
      }
      if(!isin || !recordDate || !paymentDate){
        return res.status(400).json({
          success: false,
          message: "Invalid ISIN, record date or payment date",
        });
      }

      const recordDateObj = new Date(recordDate);
      recordDateObj.setHours(0, 0, 0, 0);
      const recordDateISO = recordDateObj.toISOString().split("T")[0];

      const paymentDateObj = new Date(paymentDate);
      paymentDateObj.setHours(0, 0, 0, 0);
      const paymentDateISO = paymentDateObj.toISOString().split("T")[0];

      const zcql = req.catalystApp.zcql();

      /* ======================================================
         STEP 1: FIND ACCOUNTS WITH TRANSACTIONS FOR THIS ISIN
         ====================================================== */
      const accountSet = new Set();
      let holdOffset = 0;

      while (true) {
        const batch = await zcql.executeZCQLQuery(`
          SELECT WS_Account_code
          FROM Transaction
          WHERE ISIN='${isin}'
          LIMIT ${ZCQL_ROW_LIMIT} OFFSET ${holdOffset}
        `);

        if (!batch || batch.length === 0) break;
        batch.forEach((r) => accountSet.add(r.Transaction.WS_Account_code));
        if (batch.length < ZCQL_ROW_LIMIT) break;
        holdOffset += ZCQL_ROW_LIMIT;
      }

      const eligibleAccounts = Array.from(accountSet);

      if (!eligibleAccounts.length) {
        return res.json({ success: true, data: [] });
      }

      /* ======================================================
         STEP 2: FETCH TRANSACTIONS (<= RECORD DATE)
         ====================================================== */
      const txRows = [];
      const seenTxnRowIds = new Set();
      let txOffset = 0;

      while (true) {
        const batch = await zcql.executeZCQLQuery(`
          SELECT *
          FROM Transaction
          WHERE ISIN='${isin}'
          AND SETDATE <= '${recordDateISO}'
          ORDER BY SETDATE ASC, ROWID ASC
          LIMIT ${ZCQL_ROW_LIMIT} OFFSET ${txOffset}
        `);

        if (!batch || batch.length === 0) break;
        for (const row of batch) {
          const t = row.Transaction || row;
          const rowId = t.ROWID;
          if (rowId != null && seenTxnRowIds.has(rowId)) continue;
          if (rowId != null) seenTxnRowIds.add(rowId);
          txRows.push(row);
        }
        if (batch.length < ZCQL_ROW_LIMIT) break;
        txOffset += ZCQL_ROW_LIMIT;
      }

      /* ======================================================
         STEP 3: FETCH BONUSES (<= RECORD DATE)
         ====================================================== */
      const bonusRows = [];
      let bonusOffset = 0;

      while (true) {
        const batch = await zcql.executeZCQLQuery(`
          SELECT *
          FROM Bonus
          WHERE ISIN='${isin}'
          AND ExDate <= '${recordDateISO}'
          ORDER BY ExDate ASC, ROWID ASC
          LIMIT ${ZCQL_ROW_LIMIT} OFFSET ${bonusOffset}
        `);

        if (!batch || batch.length === 0) break;
        bonusRows.push(...batch);
        if (batch.length < ZCQL_ROW_LIMIT) break;
        bonusOffset += ZCQL_ROW_LIMIT;
      }

      /* ======================================================
         STEP 4: FETCH SPLITS (<= RECORD DATE)
         ====================================================== */
      const splitRows = [];
      let splitOffset = 0;

      while (true) {
        const batch = await zcql.executeZCQLQuery(`
          SELECT *
          FROM Split
          WHERE ISIN='${isin}'
          AND Issue_Date <= '${recordDateISO}'
          ORDER BY Issue_Date ASC, ROWID ASC
          LIMIT ${ZCQL_ROW_LIMIT} OFFSET ${splitOffset}
        `);

        if (!batch || batch.length === 0) break;
        splitRows.push(...batch);
        if (batch.length < ZCQL_ROW_LIMIT) break;
        splitOffset += ZCQL_ROW_LIMIT;
      }

      /* ======================================================
         STEP 5: GROUP DATA BY ACCOUNT
         ====================================================== */
      const txByAccount = {};
      txRows.forEach((r) => {
        const t = r.Transaction;
        (txByAccount[t.WS_Account_code] ||= []).push(t);
      });

      const bonusByAccount = {};
      bonusRows.forEach((r) => {
        const b = r.Bonus;
        (bonusByAccount[b.WS_Account_code] ||= []).push(b);
      });

      const splits = splitRows.map((r) => {
        const s = r.Split;
        return {
          issueDate: s.Issue_Date,
          ratio1: Number(s.Ratio1) || 0,
          ratio2: Number(s.Ratio2) || 0,
          isin: s.ISIN,
        };
      });

      /* ======================================================
         STEP 6: FIFO PREVIEW
         ====================================================== */
      const preview = [];

      for (const accountCode of eligibleAccounts) {
        const transactions = txByAccount[accountCode] || [];
        if (!transactions.length) continue;

        const bonuses = bonusByAccount[accountCode] || [];

        const fifo = runFifoEngine(transactions, bonuses, splits, true);
        if (!fifo || fifo.holdings <= 0) continue;

        const holdingAsOnRecordDate = fifo.holdings;
        const dividendAmount = holdingAsOnRecordDate * rateNum;

        preview.push({
          isin,
          accountCode,
          holdingAsOnRecordDate,
          rate: rateNum,
          paymentDate: paymentDateISO,
          dividendAmount,
        });
      }

      return res.json({ success: true, data: preview });
    } catch (error) {
      console.error("Preview dividend error:", error);
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  };

  /* ======================================================
     APPLY DIVIDEND (BACKGROUND JOB)
     ------------------------------------------------------
     Mirrors the BonusController pattern:
       - Validate inputs.
       - Idempotency check on (ISIN, RecordDate) in Dividend.
       - Reuse / clean up any existing Jobs row for jobName.
       - Submit a Catalyst Job that runs the UpdateDividendData
         function. The function performs all heavy work
         (master insert, per-account FIFO, Dividend_Record
         inserts, Cash_Balance_Per_Transaction credits) and
         updates the Jobs row to COMPLETED / FAILED.
       - Return immediately with { jobName, status: "PENDING" }
         so the React UI can poll /dividend/apply-status.
     ====================================================== */
  export const applyStockDividendMaster = async (req, res) => {
    try {
      if (!req.catalystApp) {
        return res.status(500).json({
          success: false,
          message: "Catalyst app not initialized",
        });
      }

      const {
        isin,
        securityCode,
        securityName,
        rate: rateParam,
        exDate,
        recordDate,
        paymentDate,
        dividendType,
      } = req.body;

      const rate = Number(rateParam);

      if (!Number.isFinite(rate) || rate <= 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid dividend rate value",
        });
      }
      if (
        !isin ||
        !securityCode ||
        !securityName ||
        !recordDate ||
        !paymentDate
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid or missing required fields",
        });
      }

      const normalizeDate = (d) => {
        const dt = new Date(d);
        dt.setHours(0, 0, 0, 0);
        return dt.toISOString().split("T")[0];
      };

      const recordDateISO = normalizeDate(recordDate);
      const exDateISO = (exDate && String(exDate).trim())
        ? normalizeDate(exDate)
        : recordDateISO;
      const paymentDateISO = normalizeDate(paymentDate);

      const catalystApp = req.catalystApp;
      const zcql = catalystApp.zcql();
      const jobScheduling = catalystApp.jobScheduling();

      const existingDiv = await zcql.executeZCQLQuery(`
        SELECT ROWID
        FROM Dividend
        WHERE ISIN='${isin}'
        AND RecordDate='${recordDateISO}'
        LIMIT 1
      `);

      if (existingDiv && existingDiv.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Dividend already exists for this ISIN and Record Date",
        });
      }

      const jobName = `DIV_${isin.slice(-6)}_${recordDateISO}`;

      const existing = await zcql.executeZCQLQuery(
        `SELECT ROWID, status, CREATEDTIME FROM Jobs WHERE jobName = '${jobName}' LIMIT 1`
      );

      if (existing.length) {
        const oldStatus = existing[0].Jobs.status;
        const oldRowId = existing[0].Jobs.ROWID;
        const createdTime = existing[0].Jobs.CREATEDTIME;

        const STALE_TIMEOUT_MS = 60 * 60 * 1000;
        const jobAge = Date.now() - parseCatalystTime(createdTime);
        const isStale = jobAge > STALE_TIMEOUT_MS;

        if ((oldStatus === "PENDING" || oldStatus === "RUNNING") && !isStale) {
          return res.json({
            success: true,
            jobName,
            status: oldStatus,
            message: "Dividend application is already in progress",
          });
        }

        try {
          await zcql.executeZCQLQuery(`DELETE FROM Jobs WHERE ROWID = ${oldRowId}`);
        } catch (delErr) {
          console.error("Error deleting old dividend job:", delErr);
        }
      }

      await jobScheduling.JOB.submitJob({
        job_name: "ApplyDividend",
        jobpool_name: "Export",
        target_name: "UpdateDividendData",
        target_type: "Function",
        params: {
          isin,
          securityCode,
          securityName,
          rate: String(rate),
          exDate: exDateISO,
          recordDate: recordDateISO,
          paymentDate: paymentDateISO,
          dividendType: dividendType || "Final",
          jobName,
        },
      });

      return res.json({
        success: true,
        jobName,
        status: "PENDING",
        message: "Dividend application job started",
      });

    } catch (error) {
      console.error("Apply dividend master error:", error);
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  };

  /* ======================================================
     GET DIVIDEND APPLY JOB STATUS
     Mirrors getBonusApplyStatus exactly (same Jobs table
     contract used by UpdateDividendData function).
     ====================================================== */
  export const getDividendApplyStatus = async (req, res) => {
    try {
      const catalystApp = req.catalystApp;
      const zcql = catalystApp.zcql();

      const { jobName } = req.query;
      if (!jobName) {
        return res.status(400).json({ success: false, message: "jobName is required" });
      }

      const result = await zcql.executeZCQLQuery(
        `SELECT ROWID, status, CREATEDTIME FROM Jobs WHERE jobName = '${jobName}' LIMIT 1`
      );

      if (!result.length) {
        return res.json({ success: true, status: "NOT_STARTED" });
      }

      let status = result[0].Jobs.status;
      const createdTime = result[0].Jobs.CREATEDTIME;

      const STALE_TIMEOUT_MS = 60 * 60 * 1000;
      const jobAge = Date.now() - parseCatalystTime(createdTime);

      if ((status === "PENDING" || status === "RUNNING") && jobAge > STALE_TIMEOUT_MS) {
        try {
          await zcql.executeZCQLQuery(
            `UPDATE Jobs SET status = 'ERROR' WHERE jobName = '${jobName}'`
          );
        } catch (updateErr) {
          console.error("Failed to mark stale dividend job as ERROR:", updateErr);
        }
        status = "ERROR";
      }

      return res.json({ success: true, jobName, status });
    } catch (error) {
      console.error("Error fetching dividend job status:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch dividend job status",
      });
    }
  };
