"use strict";

/**
 * UpdatesSecurity_ClientMasters (Catalyst Job Function)
 *
 * Job twin of UpdateSecurity_ClientMaster (event). Reads transaction CSV from Stratus,
 * collects unique BROKERACID / SYMBOLCODE via Sets (file duplicates collapsed), writes
 * those lists to Stratus JSON (source of truth), drops the Sets from memory, then
 * bulk-inserts stubs into clientIds (WS_Account_code) and Security_List (ISIN only)
 * using the arrays reloaded from those JSON files.
 * Catalyst bulk write skips rows that violate unique constraints.
 *
 * Transaction enrich is queued after masters via EnrichTransactionSecurity
 * (reads unique-isins JSON from Stratus).
 *
 * Queued from TempTransactionUpload with bucketName + objectKey + importStartedAtMs
 * after bulk import.
 *
 * Stratus meta keys (same stamp):
 *   transactions-meta/unique-accounts-{stamp}.json
 *   transactions-meta/unique-isins-{stamp}.json
 */

const { Readable } = require("stream");
const csv = require("csv-parser");
const catalyst = require("zcatalyst-sdk-node");

const LOG = "[UpdatesSecurity_ClientMasters]";
const ALLOWED_BUCKET = "client-transaction-files";
const ALLOWED_KEY_PREFIX = "transactions/";
const META_KEY_PREFIX = "transactions-meta/";

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_WAIT_MS = 10 * 60 * 1000;

const isValid = (v) =>
  v != null && v !== "" && String(v).toLowerCase() !== "null";

function isAllowedBucket(bucketName) {
  return (
    typeof bucketName === "string" &&
    bucketName.toLowerCase() === ALLOWED_BUCKET.toLowerCase()
  );
}

function isAllowedObjectKey(key) {
  if (!key || typeof key !== "string") return false;
  const lower = key.toLowerCase();
  if (!lower.endsWith(".csv")) return false;
  return lower.startsWith(ALLOWED_KEY_PREFIX.toLowerCase());
}

function getCell(row, ...candidates) {
  const keys = Object.keys(row);
  for (const name of candidates) {
    if (!name) continue;
    if (row[name] !== undefined && String(row[name]).trim() !== "") {
      const s = String(row[name]).trim();
      if (s.toLowerCase() !== "null") return s;
    }
    const lower = name.toLowerCase();
    for (const k of keys) {
      if (k.toLowerCase() === lower && String(row[k]).trim() !== "") {
        const s = String(row[k]).trim();
        if (s.toLowerCase() !== "null") return s;
      }
    }
  }
  return "";
}

function rawToUtf8(raw) {
  if (raw == null) return "";
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  if (typeof raw === "string") return raw;
  return String(raw);
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function createCsvParser() {
  return csv({
    skipEmptyLines: true,
    mapHeaders: ({ header }) =>
      String(header ?? "").replace(/^\uFEFF/, "").trim(),
  });
}

function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build a one-column CSV for Catalyst bulk insert.
 * @param {string} headerColumn Table column name (must match Data Store schema).
 * @param {Iterable<string>} values Unique stub values.
 */
function buildSingleColumnCsv(headerColumn, values) {
  const lines = [headerColumn];
  for (const v of values) {
    lines.push(csvCell(v));
  }
  return lines.join("\n");
}

async function writeJsonToStratus(bucket, objectKey, value) {
  await bucket.putObject(objectKey, Buffer.from(JSON.stringify(value), "utf8"), {
    overwrite: true,
    contentType: "application/json",
  });
  console.log(`${LOG} Wrote Stratus JSON → ${objectKey}`);
}

async function readJsonArrayFromStratus(bucket, objectKey) {
  const raw = await bucket.getObject(objectKey);
  let text = "";
  if (raw != null && typeof raw === "object" && typeof raw.pipe === "function") {
    text = await streamToString(raw);
  } else {
    text = rawToUtf8(raw);
  }
  text = String(text || "").trim();
  if (!text) {
    throw new Error(`Empty Stratus object: ${objectKey}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Invalid JSON at ${objectKey}: ${err.message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected JSON array at ${objectKey}`);
  }
  return parsed.map((v) => String(v ?? "").trim()).filter(isValid);
}

async function pollBulkWriteJob(bulkWrite, jobId) {
  const start = Date.now();
  while (Date.now() - start < POLL_MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const res = await bulkWrite.getStatus(jobId);
      const st = String(res.status || "").toUpperCase();
      console.log(`${LOG} Bulk write ${jobId} status: ${st}`);
      if (st === "COMPLETED" || st === "COMPLETE" || st === "SUCCESS") {
        return res;
      }
      if (st === "FAILED" || st === "FAILURE" || st === "ERROR") {
        throw new Error(
          `Bulk write job ${jobId} failed: ${JSON.stringify(res)}`,
        );
      }
    } catch (err) {
      if (String(err?.message || "").includes("failed")) throw err;
      console.warn(`${LOG} Error polling bulk job ${jobId}:`, err.message);
    }
  }
  throw new Error(
    `Bulk write job ${jobId} timed out after ${POLL_MAX_WAIT_MS}ms`,
  );
}

/**
 * Upload a stub CSV to Stratus and bulk-insert into a Data Store table.
 * Unique columns (WS_Account_code / ISIN): existing rows are skipped by Catalyst.
 */
async function bulkInsertStubs({
  catalystApp,
  bucket,
  bucketName,
  tableName,
  headerColumn,
  values,
  objectKeySuffix,
}) {
  const list = [...values].filter(isValid);
  if (!list.length) {
    console.log(`${LOG} No values to bulk-insert into ${tableName}`);
    return;
  }

  const objectKey = `${META_KEY_PREFIX}masters-bulk-${tableName}-${objectKeySuffix}.csv`;
  const csvBody = buildSingleColumnCsv(headerColumn, list);

  await bucket.putObject(objectKey, Buffer.from(csvBody, "utf8"), {
    overwrite: true,
    contentType: "text/csv",
  });
  console.log(
    `${LOG} Uploaded ${list.length} stub row(s) for ${tableName} → ${objectKey}`,
  );

  const bulkWrite = catalystApp.datastore().table(tableName).bulkJob("write");
  const job = await bulkWrite.createJob(
    { bucket_name: bucketName, object_key: objectKey },
    { operation: "insert" },
  );
  const jobId = job?.job_id || job?.id;
  if (!jobId) {
    throw new Error(
      `bulkJob createJob for ${tableName} returned no job_id: ${JSON.stringify(job)}`,
    );
  }
  console.log(`${LOG} Created bulk insert job ${jobId} for ${tableName}`);
  await pollBulkWriteJob(bulkWrite, jobId);
  console.log(`${LOG} Bulk insert into ${tableName} completed (${list.length} unique value(s))`);
}

async function collectUniqueFromTxnCsv(bucket, objectKey) {
  const accountCodes = new Set();
  const isins = new Set();
  let dataRowCount = 0;

  const mergeRow = (row) => {
    const wsAccountCode = getCell(
      row,
      "BROKERACID",
      "brokeracid",
      "WS_Account_code",
      "ws_account_code",
    );
    const isin = getCell(row, "SYMBOLCODE", "symbolcode", "ISIN", "isin");
    if (isValid(wsAccountCode)) accountCodes.add(wsAccountCode);
    if (isValid(isin)) isins.add(isin);
  };

  const raw = await bucket.getObject(objectKey);
  let inputStream;
  if (raw != null && typeof raw === "object" && typeof raw.pipe === "function") {
    inputStream = raw;
  } else if (Buffer.isBuffer(raw)) {
    inputStream = Readable.from(raw);
  } else {
    inputStream = Readable.from([rawToUtf8(raw)], { encoding: "utf8" });
  }

  await new Promise((resolve, reject) => {
    const parser = createCsvParser();
    inputStream
      .pipe(parser)
      .on("data", (row) => {
        dataRowCount++;
        mergeRow(row);
      })
      .on("end", resolve)
      .on("error", reject);
  });

  if (dataRowCount === 0) {
    console.warn(`${LOG} No data rows in CSV (or empty file):`, objectKey);
  }

  console.log(
    `${LOG} Parsed`,
    objectKey,
    `dataRows=${dataRowCount} uniqueAccountCodes=${accountCodes.size} uniqueIsins=${isins.size}`,
  );

  return { accountCodes, isins };
}

/**
 * Persist unique lists to Stratus, free Sets, reload from files, bulk-insert masters,
 * then queue EnrichTransactionSecurity with the unique-isins Stratus key.
 */
async function processCsvObjectForMasters(
  catalystApp,
  bucket,
  bucketName,
  objectKey,
  importStartedAtMs,
) {
  let { accountCodes, isins } = await collectUniqueFromTxnCsv(
    bucket,
    objectKey,
  );

  const stamp = `${Date.now()}`;
  const accountsObjectKey = `${META_KEY_PREFIX}unique-accounts-${stamp}.json`;
  const isinsObjectKey = `${META_KEY_PREFIX}unique-isins-${stamp}.json`;

  const accountsArr = [...accountCodes].filter(isValid);
  const isinsArr = [...isins].filter(isValid);

  // Drop Sets ASAP so they do not hold function memory during Stratus I/O + bulk jobs.
  accountCodes.clear();
  isins.clear();
  accountCodes = null;
  isins = null;

  await writeJsonToStratus(bucket, accountsObjectKey, accountsArr);
  await writeJsonToStratus(bucket, isinsObjectKey, isinsArr);

  // Drop local arrays; reload from Stratus as the source of truth for inserts.
  accountsArr.length = 0;
  isinsArr.length = 0;

  const accountsFromFile = await readJsonArrayFromStratus(bucket, accountsObjectKey);
  const isinsFromFile = await readJsonArrayFromStratus(bucket, isinsObjectKey);

  console.log(
    `${LOG} Reloaded from Stratus: accounts=${accountsFromFile.length} isins=${isinsFromFile.length}`,
  );

  await bulkInsertStubs({
    catalystApp,
    bucket,
    bucketName,
    tableName: "clientIds",
    headerColumn: "WS_Account_code",
    values: accountsFromFile,
    objectKeySuffix: stamp,
  });

  await bulkInsertStubs({
    catalystApp,
    bucket,
    bucketName,
    tableName: "Security_List",
    headerColumn: "ISIN",
    values: isinsFromFile,
    objectKeySuffix: stamp,
  });

  console.log(
    `${LOG} Masters done. accountsObjectKey=${accountsObjectKey} isinsObjectKey=${isinsObjectKey}`,
  );

  // Queue enrich after masters exist (Security_List stubs + any existing code/name).
  try {
    const scheduling = catalystApp.jobScheduling();
    const enrichJobName = `ETS_${Date.now()}`.slice(0, 20);
    await scheduling.JOB.submitJob({
      job_name: enrichJobName,
      jobpool_name: "UpdateMasters",
      target_name: "EnrichTransactionSecurity",
      target_type: "Function",
      job_config: { number_of_retries: 5, retry_interval: 60 * 1000 },
      params: {
        source: "TxnUpload",
        bucketName,
        isinsObjectKey,
        importStartedAtMs: String(importStartedAtMs || ""),
        lastIsin: "",
      },
    });
    console.log(
      `${LOG} Queued EnrichTransactionSecurity (${enrichJobName}) isinsObjectKey=${isinsObjectKey}`,
    );
  } catch (enrichErr) {
    console.error(
      `${LOG} Failed to queue EnrichTransactionSecurity:`,
      enrichErr.message,
    );
  }

  return { accountsObjectKey, isinsObjectKey, stamp };
}

function parseJobParams(jobRequest) {
  try {
    if (jobRequest && typeof jobRequest.getAllJobParams === "function") {
      return jobRequest.getAllJobParams() || {};
    }
  } catch (e) {
    console.warn(`${LOG} getAllJobParams:`, e.message);
  }
  return {};
}

module.exports = async (jobRequest, context) => {
  try {
    const params = parseJobParams(jobRequest);
    const bucketName = String(
      params.bucketName ?? params.bucket_name ?? ALLOWED_BUCKET,
    ).trim();
    const objectKey = String(
      params.objectKey ?? params.object_key ?? "",
    ).trim();
    const importStartedAtMs = String(
      params.importStartedAtMs ?? params.import_started_at_ms ?? "",
    ).trim();

    if (!objectKey || !isAllowedObjectKey(objectKey)) {
      console.warn(`${LOG} Missing or invalid objectKey:`, objectKey);
      context.closeWithSuccess();
      return;
    }

    if (!isAllowedBucket(bucketName)) {
      console.warn(`${LOG} Bucket not allowed:`, bucketName);
      context.closeWithSuccess();
      return;
    }

    const catalystApp = catalyst.initialize(context);
    const bucket = catalystApp.stratus().bucket(bucketName);

    console.log(
      `${LOG} Processing`,
      bucketName,
      objectKey,
      `importStartedAtMs=${importStartedAtMs || "(none)"}`,
    );

    await processCsvObjectForMasters(
      catalystApp,
      bucket,
      bucketName,
      objectKey,
      importStartedAtMs,
    );

    context.closeWithSuccess();
  } catch (err) {
    console.error(`${LOG} error:`, err);
    context.closeWithFailure();
  }
};
