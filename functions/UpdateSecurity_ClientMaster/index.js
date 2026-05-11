"use strict";

const { Readable } = require("stream");
const csv = require("csv-parser");
const catalyst = require("zcatalyst-sdk-node");

const esc = (v) => String(v ?? "").replace(/'/g, "''");

const isValid = (v) =>
  v != null && v !== "" && String(v).toLowerCase() !== "null";

/** Only process transaction CSV uploads landing in this single bucket + prefix. */
const ALLOWED_BUCKET = "client-transaction-files";
const ALLOWED_KEY_PREFIX = "transactions/";

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

function parseRawEvent(event) {
  let raw;
  if (event != null && typeof event.getRawData === "function") {
    raw = event.getRawData();
  }
  if (raw === undefined || raw === null) {
    raw = event?.data ?? event?.payload ?? event;
  }

  if (raw && typeof raw === "object" && raw === event) {
    const hasStratusShape =
      raw.bucket_details != null ||
      raw.bucket_name != null ||
      raw.object_details != null;
    if (!hasStratusShape && raw.body != null) {
      raw = raw.body;
    }
  }

  if (Buffer.isBuffer(raw)) {
    raw = raw.toString("utf8");
  }
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw && typeof raw === "object" ? raw : null;
}

/** Collect nested objects Catalyst may wrap the Stratus payload in. */
function payloadRoots(raw) {
  const out = [];
  const seen = new Set();
  const push = (o) => {
    if (!o || typeof o !== "object" || seen.has(o)) return;
    seen.add(o);
    out.push(o);
  };
  push(raw);
  const unwrapKeys = [
    "data",
    "payload",
    "body",
    "event",
    "message",
    "context",
    "stratus",
    "details",
    "record",
    "records",
  ];
  const firstPass = [...out];
  for (const r of firstPass) {
    for (const k of unwrapKeys) {
      const v = r[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        push(v);
      }
    }
    if (Array.isArray(r.records)) {
      for (const rec of r.records) {
        if (rec && typeof rec === "object") push(rec);
      }
    }
    if (Array.isArray(r.events)) {
      for (const ev of r.events) {
        if (ev && typeof ev === "object") push(ev);
        if (ev?.data && typeof ev.data === "object") push(ev.data);
      }
    }
  }
  return out;
}

function objectKeyFromEntry(o) {
  if (o == null) return null;
  if (typeof o === "string") return o;
  if (typeof o !== "object") return null;
  const key =
    o.key ??
    o.Key ??
    o.object_key ??
    o.objectKey ??
    o.name ??
    o.Name;
  if (key != null && String(key).trim() !== "") return String(key);
  if (o.object && typeof o.object === "object") {
    return objectKeyFromEntry(o.object);
  }
  if (o.object_details?.[0]) {
    return objectKeyFromEntry(o.object_details[0]);
  }
  return null;
}

function normalizeObjectList(list) {
  if (list == null) return [];
  if (Array.isArray(list)) return list;
  if (typeof list === "object") return [list];
  return [];
}

/**
 * Stratus object-created payload: bucket_details.bucket_name + object_details[].key
 * (plus Catalyst wrappers / alternate property names.)
 */
function extractBucketAndKeys(raw) {
  const seeds = Array.isArray(raw)
    ? raw.filter((x) => x && typeof x === "object")
    : [raw];

  for (const seed of seeds) {
    if (!seed || typeof seed !== "object") continue;
    for (const r of payloadRoots(seed)) {
      const bucket =
        r.bucket_details?.bucket_name ??
        r.bucket_details?.bucketName ??
        r.bucket_name ??
        r.bucketName ??
        null;

      const list = normalizeObjectList(
        r.object_details ??
          r.objectDetails ??
          r.objects ??
          r.object_list ??
          r.objectList,
      );

      const keys = [];
      for (const o of list) {
        const k = objectKeyFromEntry(o);
        if (k) keys.push(k);
      }

      if (bucket && keys.length) {
        return [{ bucket: String(bucket), keys }];
      }
    }
  }

  return [];
}

function summarizePayloadForLog(raw) {
  try {
    if (!raw || typeof raw !== "object") {
      return String(raw);
    }
    const s = JSON.stringify(raw);
    return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
  } catch {
    return "[unserializable]";
  }
}

/** Case-insensitive header lookup on csv-parser row objects. */
function getCell(row, ...candidates) {
  const keys = Object.keys(row);
  for (const name of candidates) {
    if (!name) continue;
    if (
      row[name] !== undefined &&
      String(row[name]).trim() !== ""
    ) {
      const s = String(row[name]).trim();
      if (s.toLowerCase() !== "null") return s;
    }
    const lower = name.toLowerCase();
    for (const k of keys) {
      if (
        k.toLowerCase() === lower &&
        String(row[k]).trim() !== ""
      ) {
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
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
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

/**
 * Stream CSV via csv-parser (handles quoted commas/newlines). Accumulate unique
 * accountCodes + ISINs as Sets, then flush with ensure*.
 *
 * Transaction CSV → masters mapping (strict):
 *   - clientIds.WS_Account_code ← BROKERACID | WS_Account_code (same value; bulk rewrite renames header)
 *   - Security_List.ISIN        ← SYMBOLCODE | ISIN
 *
 * No Security_Code / Security_Name / WS_client_id is ever inserted from this flow.
 */
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
    console.warn(
      "[UpdateSecurity_ClientMaster] No data rows in CSV (or empty file):",
      objectKey,
    );
  }

  console.log(
    "[UpdateSecurity_ClientMaster] Parsed",
    objectKey,
    `dataRows=${dataRowCount} uniqueAccountCodes=${accountCodes.size} uniqueIsins=${isins.size}`,
  );

  for (const wsAccountCode of accountCodes) {
    await ensureClientIds(zcql, wsAccountCode);
  }
  for (const isin of isins) {
    await ensureSecurityList(zcql, isin);
  }
}

/**
 * Insert into clientIds with ONLY WS_Account_code (from BROKERACID or pre-rewritten WS_Account_code).
 * Transaction CSV does not carry a separate client id, so WS_client_id is intentionally
 * left untouched. Existing rows are not modified.
 */
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

/**
 * Insert into Security_List with ONLY ISIN (from SYMBOLCODE or pre-rewritten ISIN column).
 * Transaction CSV does not carry security_code / security_name, so those columns are
 * intentionally left untouched on insert. Existing rows (matched by ISIN) are not modified.
 */
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

module.exports = async (event, context) => {
  try {
    const raw = parseRawEvent(event);
    if (!raw) {
      console.warn(
        "[UpdateSecurity_ClientMaster] Missing or invalid event payload",
      );
      context.closeWithSuccess();
      return;
    }

    const jobs = extractBucketAndKeys(raw);
    if (!jobs.length) {
      console.warn(
        "[UpdateSecurity_ClientMaster] No bucket/object_details in payload. Raw:",
        summarizePayloadForLog(raw),
      );
      context.closeWithSuccess();
      return;
    }

    const catalystApp = catalyst.initialize(context);
    const zcql = catalystApp.zcql();

    for (const { bucket, keys } of jobs) {
      if (!isAllowedBucket(bucket)) {
        console.log(
          "[UpdateSecurity_ClientMaster] Skip bucket (not allowed):",
          bucket,
        );
        continue;
      }

      const stratusBucket = catalystApp.stratus().bucket(bucket);
      for (const objectKey of keys) {
        if (!isAllowedObjectKey(objectKey)) {
          console.log(
            "[UpdateSecurity_ClientMaster] Skip object (not allowed path):",
            objectKey,
          );
          continue;
        }

        console.log(
          "[UpdateSecurity_ClientMaster] Processing",
          bucket,
          objectKey,
        );

        await processCsvObjectForMasters(stratusBucket, objectKey, zcql);
      }
    }

    context.closeWithSuccess();

  } catch (err) {
    console.error("UpdateSecurity_ClientMaster error:", err);
    context.closeWithFailure();
  }
};

/*
 * =============================================================================
 * COMMENTED OUT — Purana flow: RAW_DATA.events[].data + executionPriority.
 * Ab Stratus object event se CSV read karke clientIds / Security_List update.
 * Zarurat ho to neeche map + Transaction UPDATE wapas use karo (e.g. CSV Tran_Type).
 * =============================================================================
 *
 * // Tran_Type -> executionPriority
 * const EXECUTION_PRIORITY_MAP = {
 *   "CS-": 0, "NF-": 0,
 *   "CS+": 1, "CSI": 1, "CUS": 1, "MGE": 1, "MGF": 1, "SQB": 1, "SQS": 1, "PRF": 1,
 *   "BY-": 2, "IN+": 2, "IN1": 2, "TDI": 2, "DI1": 2, "OI1": 2, "OPI": 2, "OPO": 2,
 *   "E01": 2, "E10": 2, "E22": 2, "E23": 2,
 *   "SL+": 3, "TDO": 3, "DIO": 3, "RD0": 3,
 * };
 *
 * const getExecutionPriority = (tranType) => {
 *   if (!isValid(tranType)) return null;
 *   const key = String(tranType).trim().toUpperCase();
 *   return EXECUTION_PRIORITY_MAP[key] ?? null;
 * };
 *
 * // --- events-based client/security + priority (purana) ---
 * // const RAW_DATA = event.getRawData();
 * // const events = RAW_DATA?.events || [];
 * // const processedTranTypes = new Set();
 * //
 * // for (const ev of events) {
 * //   const d = ev?.data || {};
 * //   const wsClientId = d.WS_client_id ?? d.ws_client_id;
 * //   const wsAccountCode = d.WS_Account_code ?? d.ws_account_code;
 * //   const securityCode = d.Security_code ?? d.Security_Code;
 * //   const isin = d.ISIN ?? d.isin;
 * //   const securityName = d.Security_Name ?? d.security_name;
 * //   const tranType = d.Tran_Type ?? d.tran_type;
 * //
 * //   if (isValid(wsClientId) && isValid(wsAccountCode)) { ... INSERT clientIds ... }
 * //   if (isValid(securityCode) || isValid(isin)) { ... INSERT Security_List ... }
 * //
 * //   if (isValid(tranType)) {
 * //     const typeKey = String(tranType).trim().toUpperCase();
 * //     const priority = getExecutionPriority(typeKey);
 * //     if (priority !== null && !processedTranTypes.has(typeKey)) {
 * //       let hasMore = true;
 * //       while (hasMore) {
 * //         const rows = await zcql.executeZCQLQuery(`
 * //           SELECT ROWID FROM Transaction
 * //           WHERE Tran_Type = '${esc(typeKey)}'
 * //           AND executionPriority IS NULL
 * //           LIMIT 300
 * //         `);
 * //         if (!rows || rows.length === 0) { hasMore = false; break; }
 * //         for (const row of rows) {
 * //           const rowId = row.Transaction.ROWID;
 * //           await zcql.executeZCQLQuery(`
 * //             UPDATE Transaction
 * //             SET executionPriority = ${priority}
 * //             WHERE ROWID = '${rowId}'
 * //           `);
 * //         }
 * //       }
 * //       processedTranTypes.add(typeKey);
 * //     }
 * //   }
 * // }
 *
 * =============================================================================
 */
