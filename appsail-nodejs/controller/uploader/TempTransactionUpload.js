import csv from "csv-parser";
import { PassThrough, Readable } from "stream";

import { stratusSignedUrlToString } from "../../util/stratusSignedUrl.js";

const BUCKET_NAME = "client-transaction-files";
const TABLE_NAME = "Transaction";

/** Poll Catalyst Datastore bulk write (same pattern as `functions/MegerFn/index.js`). */
const BULK_POLL_INTERVAL_MS = 3000;
const BULK_POLL_MAX_WAIT_MS = 45 * 60 * 1000;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function escSql(s) {
  return String(s ?? "").replace(/'/g, "''");
}

async function ensureJobsRow(zcql, jobName, status) {
  try {
    await zcql.executeZCQLQuery(`
      INSERT INTO Jobs (jobName, status) VALUES ('${escSql(jobName)}', '${escSql(status)}')
    `);
  } catch {
    try {
      await zcql.executeZCQLQuery(`
        UPDATE Jobs SET status = '${escSql(status)}' WHERE jobName = '${escSql(jobName)}'
      `);
    } catch (e2) {
      console.warn(
        `[TempTransactionUpload] Jobs upsert failed for ${jobName}:`,
        e2.message,
      );
    }
  }
}

async function updateJobsStatus(zcql, jobName, status) {
  try {
    await zcql.executeZCQLQuery(`
      UPDATE Jobs SET status = '${escSql(status)}' WHERE jobName = '${escSql(jobName)}'
    `);
  } catch (e) {
    console.warn(
      `[TempTransactionUpload] Jobs status update failed for ${jobName}:`,
      e.message,
    );
  }
}

async function pollTransactionBulkWriteJob(bulkWrite, jobId) {
  const start = Date.now();
  while (Date.now() - start < BULK_POLL_MAX_WAIT_MS) {
    await sleep(BULK_POLL_INTERVAL_MS);
    try {
      const res = await bulkWrite.getStatus(jobId);
      const st = String(res?.status || "").toUpperCase();
      if (st === "COMPLETED") return res;
      if (st === "FAILED") {
        throw new Error(
          `Bulk write job ${jobId} failed: ${JSON.stringify(res)}`,
        );
      }
    } catch (err) {
      if (String(err?.message || "").includes("failed")) throw err;
      console.error(`[TempTransactionUpload] poll bulk ${jobId}:`, err);
    }
  }
  throw new Error(
    `Bulk write job ${jobId} timed out after ${BULK_POLL_MAX_WAIT_MS}ms`,
  );
}

/**
 * Bank / broker export: row-1 headers — exact count (26), order, spelling, and case.
 * Three literal `filler` headers after BankRef match the broker file; first two map by position to NETRATE / Net_Amount.
 * SETDATEFLAG, MKTRATE, and the third `filler` are layout-only (not inserted).
 */
const EXPECTED_HEADERS_IN_ORDER = [
  "Broker Code",
  "BROKERACID",
  "SYMBOLCODE",
  "EXCHG",
  "TRANSTYPE",
  "DATEPUR_ACQUI",
  "SETDATE",
  "QUANTITY",
  "RATE",
  "BROKERAGEPERSHARE",
  "SERVICETAX",
  "SETDATEFLAG",
  "MKTRATE",
  "CASHSYMBOLCODE",
  "TRANEXPENSE",
  "ACCRUEDINTEREST",
  "BLOCKID",
  "TRANSREF",
  "Description",
  "Cheque number",
  "CHQDETAIL",
  "BankRef",
  "filler",
  "filler",
  "filler",
  "CashSetdate",
];

/** 0-based column indices of literal `filler` in the template (first two → DB, third dropped). */
const FILLER_TEMPLATE_INDICES = EXPECTED_HEADERS_IN_ORDER.map((h, i) =>
  h === "filler" ? i : -1,
).filter((i) => i >= 0);

/**
 * CSV header (exact) → Transaction column name(s) for bulk insert.
 * String or string[] (duplicated value). Unmapped columns (SETDATEFLAG, MKTRATE, third filler) dropped in rewrite.
 */
const HEADER_MAP = {
  "Broker Code": ["WS_client_id", "BROKERCODE"],
  BROKERACID: "WS_Account_code",
  SYMBOLCODE: "ISIN",
  EXCHG: "EXCHG",
  TRANSTYPE: "Tran_Type",
  DATEPUR_ACQUI: "TRANDATE",
  SETDATE: "SETDATE",
  QUANTITY: "QTY",
  RATE: "RATE",
  BROKERAGEPERSHARE: "BROKERAGE",
  SERVICETAX: "SERVICETAX",
  CASHSYMBOLCODE: "Security_code",
  TRANEXPENSE: "STT",
  ACCRUEDINTEREST: "ACCRUEDINTEREST",
  BLOCKID: "PORTFOLIOID",
  TRANSREF: "Txn_Ref_No",
  Description: ["Security_Name", "Tran_Desc"],
  "Cheque number": "CHEQUENO",
  CHQDETAIL: "CHEQUEDTL",
  BankRef: "BANKACID",
  CashSetdate: "PAYMENTDATE",
};

/**
 * @param {string} raw Header cell from row 1 (trimmed).
 * @param {number} columnIndex 0-based column index (must match validated template order).
 * @returns {string | string[] | null} null = omit from bulk CSV.
 */
function mapSourceColumnToTargets(raw, columnIndex) {
  if (Object.prototype.hasOwnProperty.call(HEADER_MAP, raw)) {
    return HEADER_MAP[raw];
  }
  if (raw !== "filler") return null;
  const ord = FILLER_TEMPLATE_INDICES.indexOf(columnIndex);
  if (ord === 0) return "NETRATE";
  if (ord === 1) return "Net_Amount";
  return null;
}

/** Must be yyyy-mm-dd when the cell is not blank / null / 0-like. */
const REQUIRED_DATE_COLUMNS = ["DATEPUR_ACQUI", "SETDATE"];

/** If non-empty, value must be yyyy-mm-dd. */
const OPTIONAL_DATE_COLUMNS = ["CashSetdate"];

function stripBom(text) {
  if (text.charCodeAt(0) === 0xfeff) {
    return text.slice(1);
  }
  return text;
}

function getCell(row, columnName) {
  const key = Object.keys(row).find((k) => k.trim() === columnName);
  if (!key) return undefined;
  const v = row[key];
  if (v == null) return "";
  return String(v).trim();
}

function getFirstLineText(fileBuffer) {
  const text = stripBom(fileBuffer.toString("utf8"));
  const nl = text.search(/\r?\n/);
  return nl === -1 ? text : text.slice(0, nl);
}

/** Tab if the header line contains tabs; otherwise comma. */
function detectSeparator(firstLine) {
  return (firstLine.match(/\t/g) || []).length > 0 ? "\t" : ",";
}

function splitHeaderCells(firstLine, separator) {
  return firstLine
    .split(separator)
    .map((c) => c.trim().replace(/^\uFEFF/, "").trim());
}

/**
 * Row 1 must match EXPECTED_HEADERS_IN_ORDER exactly: same count, same order, same spelling/case.
 */
function validateExpectedHeaderOrder(fileBuffer) {
  const firstLine = getFirstLineText(fileBuffer);
  const separator = detectSeparator(firstLine);
  const cells = splitHeaderCells(firstLine, separator);
  const expected = EXPECTED_HEADERS_IN_ORDER;

  if (cells.length !== expected.length) {
    return {
      code: "WRONG_COLUMN_ORDER",
      kind: "COUNT",
      message: `Column order / count is wrong. Row 1 must have exactly ${expected.length} columns in the official template order; your file has ${cells.length}. Do not add, remove, or reorder columns.`,
      expectedCount: expected.length,
      actualCount: cells.length,
      expectedHeaders: [...expected],
      hint: "Restore the header row to match the template: same positions left-to-right.",
    };
  }

  const mismatches = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== expected[i]) {
      mismatches.push({
        columnIndex: i + 1,
        expected: expected[i],
        actual: cells[i],
      });
    }
  }

  if (mismatches.length > 0) {
    return {
      code: "WRONG_COLUMN_ORDER",
      kind: "ORDER_OR_NAME",
      message:
        "Column order is wrong (or a header name/spelling does not match the template). Row 1 headers must appear in the exact same order as the official list — shifting any column left or right will fail.",
      mismatches,
      expectedHeaders: [...expected],
      hint: `Check column position(s): ${mismatches.map((m) => m.columnIndex).join(", ")}. Expected vs actual is listed below.`,
    };
  }

  return null;
}

function isValidYyyyMmDd(value) {
  const s = String(value ?? "").trim();
  if (!ISO_DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(s + "T00:00:00");
  return (
    dt.getFullYear() === y &&
    dt.getMonth() + 1 === m &&
    dt.getDate() === d
  );
}

/** Missing date in CSV: empty, numeric 0, or common null tokens (case-insensitive). */
function isAbsentDateValue(value) {
  if (value === undefined) return true;
  const s = String(value).trim();
  if (s === "") return true;
  if (s === "0") return true;
  const lower = s.toLowerCase();
  return lower === "null" || lower === "na" || lower === "n/a" || s === "-";
}

function targetsForHeader(mapped) {
  return Array.isArray(mapped) ? mapped : [mapped];
}

/**
 * Rewrites CSV for bulk insert: maps template headers to Transaction column names;
 * one source column can fill multiple DB columns. Unmapped template columns (e.g. SETDATEFLAG, MKTRATE, third filler) dropped.
 */
function normalizeCsvForBulkUpload(fileBuffer) {
  const text = stripBom(fileBuffer.toString("utf8"));
  const lines = text.split(/\r?\n/);
  if (!lines.length) return fileBuffer;

  const firstLine = lines[0] ?? "";
  const separator = detectSeparator(firstLine);
  const splitLine = (line) =>
    line.split(separator).map((c) => c.trim().replace(/^\uFEFF/, ""));

  const originalHeaders = splitLine(lines[0]);
  const headerMappings = [];
  for (let i = 0; i < originalHeaders.length; i++) {
    const raw = originalHeaders[i];
    const mapped = mapSourceColumnToTargets(raw, i);
    if (mapped) {
      headerMappings.push({ idx: i, targets: targetsForHeader(mapped) });
    }
  }

  const newHeaders = headerMappings.flatMap((m) => m.targets);
  const outSep = ",";
  const newLines = [newHeaders.join(outSep)];

  for (let r = 1; r < lines.length; r++) {
    const line = lines[r];
    if (!line.trim()) continue;
    const cells = splitLine(line);
    const outCells = [];
    for (const m of headerMappings) {
      const v = m.idx < cells.length ? cells[m.idx] : "";
      for (let t = 0; t < m.targets.length; t++) {
        outCells.push(v);
      }
    }
    newLines.push(outCells.join(outSep));
  }

  return Buffer.from(newLines.join("\n"), "utf8");
}

/** Max distinct (BROKERACID, SYMBOLCODE) pairs collected from one CSV for scoped Holdings job. */
const MAX_HOLDINGS_SCOPE_PAIRS = 25000;

/** Soft cap on serialized pairsJson for Catalyst job params (~1MB safety). */
const MAX_PAIRS_JSON_CHARS = 900000;

/** First N data rows parsed for date-format checks before upload. */
const SAMPLE_DATA_ROW_COUNT = 3;

/**
 * Parses the first SAMPLE_DATA_ROW_COUNT data rows from the CSV buffer.
 */
function parseTempTransactionSampleRows(fileBuffer) {
  return new Promise((resolve, reject) => {
    const text = stripBom(fileBuffer.toString("utf8"));
    const firstLine = getFirstLineText(fileBuffer);
    const separator = detectSeparator(firstLine);
    const rows = [];
    const source = Readable.from(text);
    const parser = csv({ separator });
    let settled = false;

    const settle = (err, result) => {
      if (settled) return;
      settled = true;
      source.removeAllListeners();
      parser.removeAllListeners();
      try {
        source.destroy();
        parser.destroy();
      } catch {
        /* ignore */
      }
      if (err) {
        reject(err);
        return;
      }
      resolve(result);
    };

    parser.on("data", (row) => {
      rows.push(row);
      if (rows.length >= SAMPLE_DATA_ROW_COUNT) {
        settle(null, rows);
      }
    });

    parser.on("end", () => settle(null, rows));
    parser.on("error", (e) => settle(e));
    source.on("error", (e) => settle(e));

    source.pipe(parser);
  });
}

/**
 * Reads every data row; collects unique (BROKERACID, SYMBOLCODE) for scoped Holdings rebuild.
 */
function extractDistinctBrokerAccountIsinPairsFromCsv(fileBuffer) {
  return new Promise((resolve, reject) => {
    const text = stripBom(fileBuffer.toString("utf8"));
    const firstLine = getFirstLineText(fileBuffer);
    const separator = detectSeparator(firstLine);
    const seen = new Set();
    const pairs = [];
    let truncated = false;
    const source = Readable.from(text);
    const parser = csv({ separator });
    let settled = false;

    const settle = (err, result) => {
      if (settled) return;
      settled = true;
      source.removeAllListeners();
      parser.removeAllListeners();
      try {
        source.destroy();
        parser.destroy();
      } catch {
        /* ignore */
      }
      if (err) {
        reject(err);
        return;
      }
      resolve(result);
    };

    parser.on("data", (row) => {
      const acc = String(getCell(row, "BROKERACID") ?? "").trim();
      const isin = String(getCell(row, "SYMBOLCODE") ?? "").trim();
      if (!acc || !isin) return;
      const key = `${acc}\t${isin}`;
      if (seen.has(key)) return;
      seen.add(key);
      pairs.push([acc, isin]);
      if (pairs.length >= MAX_HOLDINGS_SCOPE_PAIRS) {
        truncated = true;
      }
    });

    parser.on("end", () => settle(null, { pairs, truncated }));
    parser.on("error", (e) => settle(e));
    source.on("error", (e) => settle(e));

    source.pipe(parser);
  });
}

/**
 * POST /api/transaction-uploader/upload-temp-file
 * 1. Validates row 1 matches EXPECTED_HEADERS_IN_ORDER (26 columns, count + order + exact names).
 * 2. Validates the CSV parses and has at least one data row.
 * 3. Validates date columns on the first 3 data rows (blank / 0 / null allowed when empty).
 * 4. Rewrites CSV: maps template headers to Transaction columns (HEADER_MAP), tab → comma, trim cells.
 * 5. Uploads rewritten CSV to Stratus bucket client-transaction-files under transactions/.
 * 6. Inserts `Jobs` (RUNNING), runs Datastore bulk write → `Transaction`, polls to completion,
 *    then sets `Jobs` to COMPLETED (or FAILED). `jobName` is `TxnCsv_<ms>` matching `TxnUpload-<ms>-` in objectKey.
 * 7. Queues `UpdatesSecurity_ClientMasters`, `CalculateHoldingsPerAccount`, and `Cal_CB_Append_TxnUpload`
 *    (incremental cash passbook) on UpdateMasters. Full passbook rebuild: `Cal_CB_Per_TNX` (manual only).
 */
export const uploadTempTransaction = async (req, res) => {
  let pipelineJobName = null;
  let zcqlForJob = null;

  try {
    /* ─── 1. VALIDATE REQUEST ─────────────────────────────────────── */
    const catalystApp = req.catalystApp;
    if (!catalystApp) {
      return res.status(500).json({
        success: false,
        message: "Catalyst not initialized",
      });
    }

    const file = req.files?.file;

    if (!file) {
      return res.status(400).json({
        success: false,
        message: "CSV file is required. Send it as form-data with key 'file'.",
      });
    }

    if (!file.name.toLowerCase().endsWith(".csv")) {
      return res.status(400).json({
        success: false,
        message: "Only CSV files are allowed",
      });
    }

    const orderErr = validateExpectedHeaderOrder(file.data);
    if (orderErr) {
      return res.status(400).json({
        success: false,
        ...orderErr,
      });
    }

    /* ─── 1b. PARSE CSV + DATE CHECK (before Stratus — must pass to continue) ─ */
    let sampleRows;
    try {
      sampleRows = await parseTempTransactionSampleRows(file.data);
    } catch (parseErr) {
      console.error(
        `[TempTransactionUpload] CSV parse error [${new Date().toISOString()}]:`,
        parseErr
      );
      return res.status(400).json({
        success: false,
        message: "Could not read the CSV file. Check the file and try again.",
      });
    }

    if (sampleRows.length === 0) {
      return res.status(400).json({
        success: false,
        message:
          "The CSV has no data rows. Add at least one data row before uploading.",
      });
    }

    for (let i = 0; i < sampleRows.length; i++) {
      const fileLineNumber = i + 2;
      const invalidDateFields = [];

      for (const col of REQUIRED_DATE_COLUMNS) {
        const v = getCell(sampleRows[i], col);
        if (!isAbsentDateValue(v) && !isValidYyyyMmDd(v)) {
          invalidDateFields.push(col);
        }
      }

      for (const col of OPTIONAL_DATE_COLUMNS) {
        const v = getCell(sampleRows[i], col);
        if (!isAbsentDateValue(v) && !isValidYyyyMmDd(v)) {
          invalidDateFields.push(col);
        }
      }

      if (invalidDateFields.length > 0) {
        return res.status(400).json({
          success: false,
          code: "INVALID_DATE_FORMAT",
          message: `Date format is invalid. Parsed the first ${SAMPLE_DATA_ROW_COUNT} data rows: problem in data row ${i + 1} of ${SAMPLE_DATA_ROW_COUNT} (CSV line ${fileLineNumber}). Columns must be yyyy-mm-dd: ${invalidDateFields.join(", ")}.`,
          fields: invalidDateFields,
          row: fileLineNumber,
          dataRowIndex: i + 1,
          headerNamesToFix: invalidDateFields,
          sampleRowsValidated: SAMPLE_DATA_ROW_COUNT,
          hint: "Use yyyy-mm-dd only (example: 2025-04-06). Empty dates: leave blank, 0, or null. Fix the file and re-upload — nothing was imported.",
        });
      }
    }

    /* ─── 1c. DISTINCT (BROKERACID, SYMBOLCODE) FOR SCOPED HOLDINGS JOB ─ */
    let scopePairsResult = { pairs: [], truncated: false };
    try {
      scopePairsResult = await extractDistinctBrokerAccountIsinPairsFromCsv(
        file.data,
      );
    } catch (pairErr) {
      console.error(
        `[TempTransactionUpload] pair-list CSV parse [${new Date().toISOString()}]:`,
        pairErr,
      );
      return res.status(400).json({
        success: false,
        message:
          "Could not scan the CSV for broker account / ISIN pairs. Check the file and try again.",
      });
    }

    /* ─── 2. NORMALIZE CSV & UPLOAD TO STRATUS ───────────────────── */
    const rewrittenCsv = normalizeCsvForBulkUpload(file.data);

    const uploadMs = Date.now();
    const objectKey = `transactions/TxnUpload-${uploadMs}-${file.name}`;
    pipelineJobName = `TxnCsv_${uploadMs}`.slice(0, 48);

    const bucket = catalystApp.stratus().bucket(BUCKET_NAME);

    const passThrough = new PassThrough();
    const uploadPromise = bucket.putObject(objectKey, passThrough, {
      overwrite: true,
      contentType: "text/csv",
    });

    passThrough.end(rewrittenCsv);
    await uploadPromise;

    /* ─── 3. Jobs row + bulk write → Transaction (poll to completion) ─ */
    zcqlForJob = catalystApp.zcql();
    await ensureJobsRow(zcqlForJob, pipelineJobName, "RUNNING");

    const datastore = catalystApp.datastore();
    const bulkWrite = datastore.table(TABLE_NAME).bulkJob("write");

    let bulkJob;
    try {
      bulkJob = await bulkWrite.createJob(
        {
          bucket_name: BUCKET_NAME,
          object_key: objectKey,
        },
        {
          operation: "insert",
        },
      );
    } catch (bulkCreateErr) {
      await updateJobsStatus(zcqlForJob, pipelineJobName, "FAILED");
      throw bulkCreateErr;
    }

    try {
      await pollTransactionBulkWriteJob(bulkWrite, bulkJob.job_id);
    } catch (pollErr) {
      await updateJobsStatus(zcqlForJob, pipelineJobName, "FAILED");
      throw pollErr;
    }

    await updateJobsStatus(zcqlForJob, pipelineJobName, "COMPLETED");

    /* Masters sync (clientIds / Security_List) from uploaded CSV on Stratus. */
    let mastersQueueJobName = null;
    let mastersJobSkipped = false;

    try {
      const jobSchedulingForMasters = catalystApp.jobScheduling();
      mastersQueueJobName = `USCM_${Date.now()}`.slice(0, 20);
      await jobSchedulingForMasters.JOB.submitJob({
        job_name: mastersQueueJobName,
        jobpool_name: "UpdateMasters",
        target_name: "UpdatesSecurity_ClientMasters",
        target_type: "Function",
        job_config: {
          number_of_retries: 5,
          retry_interval: 60 * 1000,
        },
        params: {
          source: "TxnUpload",
          bucketName: BUCKET_NAME,
          objectKey,
        },
      });
    } catch (mastersErr) {
      mastersJobSkipped = true;
      console.error(
        "[TempTransactionUpload] Failed to queue UpdatesSecurity_ClientMasters:",
        mastersErr,
      );
    }

    /* Serialize distinct pairs for scoped Holdings job (Catalyst param size cap). */
    let pairsForJob = scopePairsResult.pairs;
    let holdingsPairsJsonTruncated = false;
    let pairsJson = JSON.stringify(pairsForJob);
    if (pairsJson.length > MAX_PAIRS_JSON_CHARS) {
      holdingsPairsJsonTruncated = true;
      while (
        pairsForJob.length > 1 &&
        JSON.stringify(pairsForJob).length > MAX_PAIRS_JSON_CHARS
      ) {
        pairsForJob = pairsForJob.slice(
          0,
          Math.max(1, Math.floor(pairsForJob.length * 0.85)),
        );
      }
      pairsJson = JSON.stringify(pairsForJob);
      console.warn(
        `[TempTransactionUpload] pairsJson trimmed to ${pairsForJob.length} pair(s) (param size cap ${MAX_PAIRS_JSON_CHARS})`,
      );
    }

    const accountCodesForCash = [
      ...new Set(pairsForJob.map(([acc]) => String(acc ?? "").trim()).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));

    let accountCodesJson = JSON.stringify(accountCodesForCash);
    let cashAccountCodesJsonTruncated = false;
    if (accountCodesJson.length > MAX_PAIRS_JSON_CHARS) {
      cashAccountCodesJsonTruncated = true;
      let trimmed = accountCodesForCash;
      while (
        trimmed.length > 1 &&
        JSON.stringify(trimmed).length > MAX_PAIRS_JSON_CHARS
      ) {
        trimmed = trimmed.slice(
          0,
          Math.max(1, Math.floor(trimmed.length * 0.85)),
        );
      }
      accountCodesJson = JSON.stringify(trimmed);
      console.warn(
        `[TempTransactionUpload] accountCodesJson trimmed to ${trimmed.length} account(s) (param size cap ${MAX_PAIRS_JSON_CHARS})`,
      );
    }

    /* Holdings + incremental cash passbook: queue on UpdateMasters when CSV has pairs. */
    let holdingsQueueJobName = null;
    let holdingsJobSkipped = false;
    let cashPassbookQueueJobName = null;
    let cashPassbookJobSkipped = false;

    if (pairsForJob.length === 0) {
      holdingsJobSkipped = true;
      cashPassbookJobSkipped = true;
      console.warn(
        "[TempTransactionUpload] No BROKERACID/SYMBOLCODE pairs in CSV — skipping Holdings and Cal_CB_Append_TxnUpload jobs.",
      );
    } else {
      const jobScheduling = catalystApp.jobScheduling();

      try {
        holdingsQueueJobName = `CHPA_${Date.now()}`.slice(0, 20);
        await jobScheduling.JOB.submitJob({
          job_name: holdingsQueueJobName,
          jobpool_name: "UpdateMasters",
          target_name: "CalculateHoldingsPerAccount",
          target_type: "Function",
          job_config: {
            number_of_retries: 5,
            retry_interval: 60 * 1000,
          },
          params: {
            source: "TxnUpload",
            pairsJson,
            importStartedAtMs: String(uploadMs),
          },
        });
      } catch (holdingsErr) {
        console.error(
          "[TempTransactionUpload] Failed to queue CalculateHoldingsPerAccount:",
          holdingsErr,
        );
      }

      try {
        cashPassbookQueueJobName = `CCB_${Date.now()}`.slice(0, 20);
        await jobScheduling.JOB.submitJob({
          job_name: cashPassbookQueueJobName,
          jobpool_name: "UpdateMasters",
          target_name: "Cal_CB_Append_TxnUpload",
          target_type: "Function",
          job_config: {
            number_of_retries: 5,
            retry_interval: 60 * 1000,
          },
          params: {
            source: "TxnUpload",
            accountCodesJson,
            importStartedAtMs: String(uploadMs),
          },
        });
      } catch (cashErr) {
        cashPassbookJobSkipped = true;
        console.error(
          "[TempTransactionUpload] Failed to queue Cal_CB_Append_TxnUpload:",
          cashErr,
        );
      }
    }

    const jobsQueued =
      !mastersJobSkipped || !holdingsJobSkipped || !cashPassbookJobSkipped;
    const jobsMessage = !jobsQueued
      ? "Transaction bulk import finished and Jobs is COMPLETED. Follow-up jobs were not queued."
      : "Transaction bulk import finished and Jobs is COMPLETED. Masters, holdings, and/or incremental cash passbook jobs were queued as applicable.";

    /* ─── 4. RESPOND ──────────────────────────────────────────────── */
    return res.status(200).json({
      success: true,
      message: jobsMessage,
      pipelineJobName,
      mastersQueueJobName,
      mastersJobSkipped,
      holdingsQueueJobName,
      holdingsJobSkipped,
      holdingsDistinctPairs: pairsForJob.length,
      holdingsPairsTruncated: scopePairsResult.truncated,
      holdingsPairsJsonTruncated,
      cashPassbookQueueJobName,
      cashPassbookJobSkipped,
      cashPassbookDistinctAccounts: accountCodesForCash.length,
      cashAccountCodesJsonTruncated,
      fileName: file.name,
      objectKey,
      bucket: BUCKET_NAME,
      table: TABLE_NAME,
      bulkJobId: bulkJob.job_id,
      bulkJobStatus: "COMPLETED",
    });
  } catch (error) {
    console.error(`[TempTransactionUpload] [Error] [${new Date().toISOString()}] :`, error);

    if (pipelineJobName && zcqlForJob) {
      await updateJobsStatus(zcqlForJob, pipelineJobName, "FAILED");
    }

    return res.status(500).json({
      success: false,
      message: "Failed to upload file or complete bulk insert into Transaction",
      error: error.message,
      ...(pipelineJobName ? { pipelineJobName } : {}),
    });
  }
};

/* ──────────────────────── UPLOAD HISTORY ──────────────────────── */

/**
 * Stratus object keys produced by `uploadTempTransaction` look like
 *   transactions/TxnUpload-<ms>-<originalFileName>
 * (older keys may use `Txn-<ms>-...`). The capture groups give us the
 * upload time and the user's original filename without needing a separate
 * tracking table.
 */
const STRATUS_TXN_KEY_PATTERN =
  /^transactions\/Txn(?:Upload)?-(\d+)-(.+)$/;

export function parseStratusTransactionUploadKey(key) {
  if (!key || typeof key !== "string") return null;
  const m = STRATUS_TXN_KEY_PATTERN.exec(key.trim());
  if (!m) return null;
  const uploadedAtMs = Number(m[1]);
  if (!Number.isFinite(uploadedAtMs)) return null;
  return {
    originalFileName: m[2],
    uploadedAtIso: new Date(uploadedAtMs).toISOString(),
    uploadedAtMs,
  };
}

/**
 * GET /api/transaction-uploader/upload-history?limit=&cursor=&search=
 * Lists transaction uploads under the `transactions/` prefix, newest first.
 * Returns minimal metadata derived from the object key (no separate DB).
 */
export const listUploadHistory = async (req, res) => {
  try {
    const catalystApp = req.catalystApp;
    if (!catalystApp) {
      return res
        .status(500)
        .json({ success: false, message: "Catalyst not initialized" });
    }

    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 5));
    const cursor = req.query.cursor ? String(req.query.cursor) : null;
    const search = String(req.query.search || "").trim().toLowerCase();

    const bucket = catalystApp.stratus().bucket(BUCKET_NAME);
    const listOpts = {
      maxKeys: limit,
      prefix: "transactions/",
      orderBy: "desc",
    };
    if (cursor) listOpts.continuationToken = cursor;

    const result = await bucket.listPagedObjects(listOpts);

    // The SDK can return either StratusObject instances (metadata on
    // `keyDetails`) or plain objects with the fields at the top level.
    // Normalize both shapes here.
    const rawContents = result.contents || [];
    const items = [];

    for (const entry of rawContents) {
      const o =
        entry &&
        typeof entry === "object" &&
        "keyDetails" in entry &&
        entry.keyDetails
          ? entry.keyDetails
          : entry;
      const key = o.key;
      if (!key || typeof key !== "string") continue;

      if (o.key_type && o.key_type !== "file") continue;
      const parsed = parseStratusTransactionUploadKey(key);
      if (!parsed) continue;
      if (
        search &&
        !parsed.originalFileName.toLowerCase().includes(search)
      ) {
        continue;
      }
      items.push({
        key,
        originalFileName: parsed.originalFileName,
        uploadedAt: parsed.uploadedAtIso,
        uploadedAtMs: parsed.uploadedAtMs,
        sizeBytes: Number(o.size) || 0,
        contentType: o.content_type || "text/csv",
        lastModified: o.last_modified ?? null,
      });
    }

    items.sort((a, b) => b.uploadedAtMs - a.uploadedAtMs);

    const truncated =
      result.truncated === true ||
      String(result.truncated || "").toLowerCase() === "true";
    const nextCursor = truncated
      ? result.next_continuation_token ||
        result.nextContinuationToken ||
        null
      : null;

    return res.status(200).json({ success: true, items, nextCursor });
  } catch (error) {
    console.error("[TempTransactionUpload] listUploadHistory:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to list upload history",
    });
  }
};

/**
 * GET /api/transaction-uploader/upload-history/download?key=…
 * Validates the key shape, then returns a 1-hour Stratus presigned GET URL.
 */
export const downloadUploadHistory = async (req, res) => {
  try {
    const catalystApp = req.catalystApp;
    if (!catalystApp) {
      return res
        .status(500)
        .json({ success: false, message: "Catalyst not initialized" });
    }

    const key = String(req.query.key || "").trim();
    if (!key.startsWith("transactions/")) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid object key" });
    }
    const parsed = parseStratusTransactionUploadKey(key);
    if (!parsed) {
      return res.status(400).json({
        success: false,
        message: "Unsupported upload key format",
      });
    }

    const bucket = catalystApp.stratus().bucket(BUCKET_NAME);
    const rawUrl = await bucket.generatePreSignedUrl(key, "GET", {
      expiresIn: 3600,
    });
    const downloadUrl = stratusSignedUrlToString(rawUrl);
    if (!downloadUrl) {
      return res.status(500).json({
        success: false,
        message: "Could not generate download URL",
      });
    }

    return res.status(200).json({
      success: true,
      downloadUrl,
      expiresAtIso: new Date(Date.now() + 3600 * 1000).toISOString(),
      fileName: parsed.originalFileName,
      key,
    });
  } catch (error) {
    console.error(
      "[TempTransactionUpload] downloadUploadHistory:",
      error
    );
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to generate download link",
    });
  }
};
