"use strict";

/**
 * UpdatesSecurity_ClientMasters (Catalyst Job Function)
 *
 * Job twin of UpdateSecurity_ClientMaster (event). Reads transaction CSV from Stratus,
 * ensures clientIds + Security_List rows, enriches Transaction from Security_List when
 * master has both Security_Code and Security_Name.
 *
 * Queued from TempTransactionUpload with bucketName + objectKey after bulk import.
 */

const { Readable } = require("stream");
const csv = require("csv-parser");
const catalyst = require("zcatalyst-sdk-node");

const LOG = "[UpdatesSecurity_ClientMasters]";
const ALLOWED_BUCKET = "client-transaction-files";
const ALLOWED_KEY_PREFIX = "transactions/";

const esc = (v) => String(v ?? "").replace(/'/g, "''");

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

function createCsvParser() {
  return csv({
    skipEmptyLines: true,
    mapHeaders: ({ header }) =>
      String(header ?? "").replace(/^\uFEFF/, "").trim(),
  });
}

async function processCsvObjectForMasters(bucket, objectKey, zcql) {
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

  for (const wsAccountCode of accountCodes) {
    await ensureClientIds(zcql, wsAccountCode);
  }
  for (const isin of isins) {
    await ensureSecurityList(zcql, isin);
  }

  await enrichTransactionRowsFromSecurityList(zcql, isins);
}

function hasFilledSecurityMaster(securityCode, securityName) {
  const c = securityCode != null ? String(securityCode).trim() : "";
  const n = securityName != null ? String(securityName).trim() : "";
  return c.length > 0 && n.length > 0;
}

async function fetchSecurityListRow(zcql, isin) {
  const rows = await zcql.executeZCQLQuery(`
    SELECT Security_Code, Security_Name FROM Security_List
    WHERE ISIN = '${esc(isin)}'
    LIMIT 1
  `);
  if (!rows?.length) return null;
  const r = rows[0].Security_List || rows[0];
  return {
    securityCode: r.Security_Code ?? r.security_code,
    securityName: r.Security_Name ?? r.security_name,
  };
}

async function enrichTransactionRowsFromSecurityList(zcql, isins) {
  for (const rawIsin of isins) {
    const isin = String(rawIsin ?? "").trim();
    if (!isValid(isin)) continue;

    let master;
    try {
      master = await fetchSecurityListRow(zcql, isin);
    } catch (e) {
      console.warn(`${LOG} Security_List read failed for ${isin}:`, e.message);
      continue;
    }
    if (
      !master ||
      !hasFilledSecurityMaster(master.securityCode, master.securityName)
    ) {
      continue;
    }

    const codeEsc = esc(String(master.securityCode).trim());
    const nameEsc = esc(String(master.securityName).trim());

    try {
      await zcql.executeZCQLQuery(`
        UPDATE Transaction
        SET
          Security_code = '${codeEsc}',
          Security_Name = '${nameEsc}'
        WHERE ISIN = '${esc(isin)}'
        AND (
          Security_code IS NULL OR Security_code = ''
          OR Security_Name IS NULL OR Security_Name = ''
        )
      `);
      console.log(
        `${LOG} Transaction enriched from Security_List for ISIN:`,
        isin,
      );
    } catch (e) {
      console.warn(
        `${LOG} Transaction enrich failed for ISIN ${isin}:`,
        e.message,
      );
    }
  }
}

async function ensureClientIds(zcql, wsAccountCode) {
  if (!isValid(wsAccountCode)) return;

  const existingClient = await zcql.executeZCQLQuery(`
    SELECT ROWID FROM clientIds
    WHERE WS_Account_code = '${esc(wsAccountCode)}'
  `);

  if (!existingClient.length) {
    try {
      await zcql.executeZCQLQuery(`
        INSERT INTO clientIds (WS_Account_code)
        VALUES ('${esc(wsAccountCode)}')
      `);
    } catch (err) {
      if (String(err?.message || "").includes("Duplicate")) return;
      throw err;
    }
  }
}

async function ensureSecurityList(zcql, isin) {
  if (!isValid(isin)) return;

  const byIsin = await zcql.executeZCQLQuery(`
    SELECT ROWID FROM Security_List
    WHERE ISIN = '${esc(isin)}'
  `);
  if (byIsin.length) return;

  try {
    await zcql.executeZCQLQuery(`
      INSERT INTO Security_List (ISIN)
      VALUES ('${esc(isin)}')
    `);
  } catch (err) {
    if (String(err?.message || "").includes("Duplicate")) return;
    throw err;
  }
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
    const zcql = catalystApp.zcql();
    const bucket = catalystApp.stratus().bucket(bucketName);

    console.log(`${LOG} Processing`, bucketName, objectKey);

    await processCsvObjectForMasters(bucket, objectKey, zcql);

    context.closeWithSuccess();
  } catch (err) {
    console.error(`${LOG} error:`, err);
    context.closeWithFailure();
  }
};
