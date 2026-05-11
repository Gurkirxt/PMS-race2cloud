import { runFifoEngine } from "../../util/analytics/transactionHistory/FifoQty.js";
import { PassThrough } from "stream";

const BUCKET_NAME = "client-transaction-files";

const MAX_ZCQL_ROWS = 300;
const esc = (s) => String(s).replace(/'/g, "''");

const isBuy  = (t) => /^BY-|SQB|OPI/i.test(String(t));
const isSell = (t) => /^SL\+|SQS|OPO|NF-/i.test(String(t));

export const uploadTempTransactionFile = async (req, res) => {
  try {
    // 1️⃣ Validate file
    const file = req.files?.file;

    if (!file) {
      return res.status(400).json({
        success: false,
        message: "Transaction CSV file is required"
      });
    }

    if (!file.name.toLowerCase().endsWith(".csv")) {
      return res.status(400).json({
        success: false,
        message: "Only CSV files are allowed"
      });
    }

    const catalystApp = req.catalystApp;
    if (!catalystApp) {
      return res.status(500).json({
        success: false,
        message: "Catalyst not initialized"
      });
    }

    // 2️⃣ Upload file to Stratus
    const bucket = catalystApp.stratus().bucket(BUCKET_NAME);

    const fileName = `transactions/Txn-${Date.now()}-${file.name}`;

    const stream = new PassThrough();

    const uploadPromise = bucket.putObject(fileName, stream, {
      overwrite: true,
      contentType: "text/csv"
    });

    stream.end(file.data);
    await uploadPromise;

    // 3️⃣ Start Bulk Insert Job into Temp_Transaction table
    const bulkJob = await catalystApp
      .datastore()
      .table("Temp_Transaction")
      .bulkJob("write")
      .createJob(
        {
          bucket_name: BUCKET_NAME,
          object_key: fileName
        },
        {
          operation: "insert"
        }
      );

    // 4️⃣ Return response
    return res.status(200).json({
      success: true,
      message: "File uploaded and bulk insert started",
      fileName,
      jobId: bulkJob.job_id,
      status: bulkJob.status
    });

  } catch (error) {
    console.error("Transaction Upload Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to upload transaction file",
      error: error.message
    });
  }
};


const computeBaseHolding = (dbTransactions, bonuses, splits) => {
  const result = runFifoEngine(dbTransactions, bonuses, splits, true);
  return result?.holdings ?? 0;
};

const applyTxn = (holding, txn) => {
  const qty = Math.abs(Number(txn.QTY) || 0);
  if (!qty) return holding;

  if (isBuy(txn.Tran_Type)) {
    holding += qty;
  }

  if (isSell(txn.Tran_Type)) {
    holding -= qty;
  }

  if (holding < 0) holding = 0;

  return holding;
};

const fetchAllTempTransactions = async (zcql) => {
  const allRows = [];
  let offset = 0;

  while (true) {
    const rows = await zcql.executeZCQLQuery(`
      SELECT *
      FROM Temp_Transaction
      ORDER BY ROWID ASC
      LIMIT ${MAX_ZCQL_ROWS} OFFSET ${offset}
    `);

    if (!rows?.length) break;

    rows.forEach((r) => {
      const t = r.Temp_Transaction || r;

      allRows.push({
        WS_Account_code: t.WS_Account_code,
        ISIN: t.ISIN,
        Security_Name: t.Security_Name ?? "",
        Security_code: t.Security_code ?? "",
        Tran_Type: t.Tran_Type,
        QTY: Number(t.QTY) || 0,
      });
    });

    offset += rows.length;
    if (rows.length < MAX_ZCQL_ROWS) break;
  }

  return allRows;
};

const fetchTxnRows = async (zcql, isin, accountCode) => {
  const rows = await zcql.executeZCQLQuery(`
    SELECT *
    FROM Transaction
    WHERE ISIN='${esc(isin)}'
    AND WS_Account_code='${esc(accountCode)}'
    ORDER BY ROWID ASC
  `);

  return rows?.map((r) => r.Transaction || r) || [];
};

const fetchBonusRows = async (zcql, isin, accountCode) => {
  const rows = await zcql.executeZCQLQuery(`
    SELECT *
    FROM Bonus
    WHERE ISIN='${esc(isin)}'
    AND WS_Account_code='${esc(accountCode)}'
  `);

  return rows?.map((r) => r.Bonus || r) || [];
};

const fetchSplitRows = async (zcql, isin) => {
  const rows = await zcql.executeZCQLQuery(`
    SELECT *
    FROM Split
    WHERE ISIN='${esc(isin)}'
  `);

  return rows?.map((r) => r.Split || r) || [];
};

export const loadHolding = async (req, res) => {
  try {
    const zcql = req.catalystApp?.zcql();
    if (!zcql) {
      return res.status(500).json({
        success: false,
        message: "Catalyst not initialized"
      });
    }

    const limit = Math.max(1, Number(req.query.limit) || 20);
    const cursor = req.query.cursor
      ? Number(req.query.cursor)
      : null;

    // 🔥 Build query dynamically
    const whereClause = cursor
      ? `WHERE ROWID > ${cursor}`
      : "";

    const rows = await zcql.executeZCQLQuery(`
      SELECT *
      FROM Temp_Transaction
      ${whereClause}
      ORDER BY ROWID ASC
      LIMIT ${limit}
    `);

    if (!rows?.length) {
      return res.status(200).json({
        success: true,
        data: [],
        nextCursor: null
      });
    }

    const result = [];

    for (const r of rows) {

      const t = r.Temp_Transaction || r;

      const row = {
        ROWID: t.ROWID,
        WS_Account_code: t.WS_Account_code,
        ISIN: t.ISIN,
        Security_Name: t.Security_Name ?? "",
        Security_code: t.Security_code ?? "",
        Tran_Type: t.Tran_Type,
        QTY: Number(t.QTY) || 0,
      };

      const dbTransactions = await fetchTxnRows(
        zcql,
        row.ISIN,
        row.WS_Account_code
      );

      const bonuses = await fetchBonusRows(
        zcql,
        row.ISIN,
        row.WS_Account_code
      );

      const rawSplits = await fetchSplitRows(
        zcql,
        row.ISIN
      );
      const splits = (rawSplits || []).map((s) => ({
        isin: s.ISIN ?? s.isin,
        ratio1: s.Ratio1 ?? s.ratio1,
        ratio2: s.Ratio2 ?? s.ratio2,
      }));

      const baseHolding = computeBaseHolding(
        dbTransactions,
        bonuses,
        splits
      );

      const newQuantity = applyTxn(baseHolding, row);

      result.push({
        WS_Account_code: row.WS_Account_code,
        ISIN: row.ISIN,
        Security_Name: row.Security_Name,
        Tran_Type: row.Tran_Type,
        transactionQty: row.QTY,
        oldQuantity: baseHolding,
        newQuantity,
      });
    }

    const lastRow = rows[rows.length - 1];
    const last = lastRow?.Temp_Transaction || lastRow;
    const nextCursor = last?.ROWID || null;

    return res.status(200).json({
      success: true,
      data: result,
      nextCursor
    });

  } catch (error) {
    console.error("Load Holding Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  } 
};

/**
 * Generate Differential Report (FA vs Custodian): submits job to Export pool.
 * JobName is date-based so we can maintain history (one report per day).
 */
export const startDifferentialReport = async (req, res) => {
  try {
    const catalystApp = req.catalystApp;
    if (!catalystApp) {
      return res.status(500).json({ success: false, message: "Catalyst not initialized" });
    }

    const zcql = catalystApp.zcql();
    const dateStr = new Date().toISOString().split("T")[0].replace(/-/g, "_");
    const jobName = `CR_${dateStr}`;
    const fileName = `temp-files/differential/differential-report-${dateStr}.csv`;

    const existing = await zcql.executeZCQLQuery(
      `SELECT status FROM Jobs WHERE jobName='${esc(jobName)}' LIMIT 1`
    );

    if (existing.length) {
      return res.json({
        success: true,
        jobName,
        fileName,
        status: existing[0].Jobs.status,
        message: "Export job already exists for today",
      });
    }

    const jobScheduling = catalystApp.jobScheduling();
    await jobScheduling.JOB.submitJob({
      job_name: jobName,
      jobpool_name: "Export",
      target_name: "ExportDifferentialReport",
      target_type: "Function",
      params: { jobName, fileName },
    });

    return res.status(200).json({
      success: true,
      jobName,
      fileName,
      status: "PENDING",
      message: "Differential report job started",
    });
  } catch (error) {
    console.error("Differential Report Error:", error);
    return res.status(500).json({
      success: false,
      message: error?.message || "Failed to start differential report job",
    });
  }
};

/**
 * GET /differential-report/status?jobName=...
 * Check the status of a differential report job.
 */
export const getDifferentialReportStatus = async (req, res) => {
  try {
    const catalystApp = req.catalystApp;
    if (!catalystApp) {
      return res.status(500).json({ success: false, message: "Catalyst not initialized" });
    }

    const jobName = req.query.jobName;
    if (!jobName) {
      return res.status(400).json({ success: false, message: "jobName is required" });
    }

    const zcql = catalystApp.zcql();
    const result = await zcql.executeZCQLQuery(
      `SELECT status FROM Jobs WHERE jobName='${esc(jobName)}' LIMIT 1`
    );

    if (!result.length) {
      return res.json({ success: true, jobName, status: "NOT_STARTED" });
    }

    return res.json({
      success: true,
      jobName,
      status: result[0].Jobs.status,
    });
  } catch (error) {
    console.error("Differential Status Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /differential-report/history?limit=5
 * Fetch the last N differential report jobs.
 */
export const getDifferentialReportHistory = async (req, res) => {
  try {
    const catalystApp = req.catalystApp;
    if (!catalystApp) {
      return res.status(500).json({ success: false, message: "Catalyst not initialized" });
    }

    const zcql = catalystApp.zcql();
    const limit = Number(req.query.limit || 5);

    const result = await zcql.executeZCQLQuery(
      `SELECT jobName, status FROM Jobs WHERE jobName LIKE 'CR_*' ORDER BY ROWID DESC LIMIT ${limit}`
    );

    const jobs = result.map((row) => {
      const jobName = row.Jobs.jobName;
      const date = jobName.replace("CR_", "");
      return { jobName, date, status: row.Jobs.status };
    });

    return res.json(jobs);
  } catch (error) {
    console.error("Differential History Error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch history" });
  }
};

/**
 * GET /differential-report/download?jobName=...
 * Generate a pre-signed download URL for the completed report.
 */
export const downloadDifferentialReport = async (req, res) => {
  try {
    const catalystApp = req.catalystApp;
    if (!catalystApp) {
      return res.status(500).json({ success: false, message: "Catalyst not initialized" });
    }

    const jobName = req.query.jobName;
    if (!jobName) {
      return res.status(400).json({ success: false, message: "jobName is required" });
    }

    const zcql = catalystApp.zcql();
    const date = jobName.replace("CR_", "");
    const fileName = `temp-files/differential/differential-report-${date}.csv`;

    const job = await zcql.executeZCQLQuery(
      `SELECT status FROM Jobs WHERE jobName='${esc(jobName)}' LIMIT 1`
    );

    if (!job.length || job[0].Jobs.status !== "COMPLETED") {
      return res.status(400).json({ success: false, status: "NOT_READY", message: "Report not completed yet" });
    }

    const bucket = catalystApp.stratus().bucket("upload-data-bucket");
    const downloadUrl = await bucket.generatePreSignedUrl(fileName, "GET", {
      expiresIn: 3600,
    });

    return res.json({ success: true, status: "READY", fileName, downloadUrl });
  } catch (error) {
    console.error("Differential Download Error:", error);
    return res.status(404).json({ success: false, status: "NOT_FOUND", message: "File not found or not ready yet" });
  }
};


