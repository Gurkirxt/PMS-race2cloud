"use strict";

/**
 * EnrichTransactionSecurity (Catalyst Job Function)
 *
 * After UpdatesSecurity_ClientMasters finishes, backfills Transaction.Security_code
 * and Transaction.Security_Name from Security_List for unique ISINs in this upload.
 *
 * Params:
 *   bucketName, isinsObjectKey  — Stratus JSON array of unique ISINs (from USCM)
 *   importStartedAtMs           — scope UPDATEs to this upload (CREATEDTIME floor)
 *   lastIsin                    — baton-pass cursor ("" on first run)
 *   source                      — expected "TxnUpload"
 *
 * Flow:
 *   1. Load + sort ISINs from Stratus
 *   2. Skip ISINs <= lastIsin
 *   3. Chunk (~100): batch SELECT Security_List WHERE ISIN IN (...)
 *   4. For each ISIN with both code + name: paged UPDATE Transaction (blank fields only)
 *   5. Near timeout (~60s left): submitJob(self, lastIsin) and exit
 */

const catalyst = require("zcatalyst-sdk-node");

const LOG = "[EnrichTransactionSecurity]";
const TARGET_NAME = "EnrichTransactionSecurity";
const JOBPOOL = "UpdateMasters";
const EXPECTED_SOURCE = "TxnUpload";

const ISIN_CHUNK_SIZE = 100;
const UPDATE_ROW_BATCH = 250;
const REMAINING_TIME_BUFFER_MS = 60_000;
const MAX_UPDATE_ROUNDS_PER_ISIN = 500;

const esc = (s) => String(s ?? "").replace(/'/g, "''");

const isValid = (v) =>
  v != null && v !== "" && String(v).toLowerCase() !== "null";

function getJobParams(jobRequest) {
  try {
    if (jobRequest && typeof jobRequest.getAllJobParams === "function") {
      return jobRequest.getAllJobParams() || {};
    }
  } catch (e) {
    console.warn(`${LOG} getAllJobParams:`, e.message);
  }
  return {};
}

function createdTimeFloorFromMs(ms) {
  const d = new Date(ms - 15_000);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}:000`
  );
}

function getRemainingMs(context) {
  if (typeof context.getRemainingExecutionTimeMs === "function") {
    const ms = context.getRemainingExecutionTimeMs();
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return Number.MAX_SAFE_INTEGER;
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

async function readJsonArrayFromStratus(bucket, objectKey) {
  const raw = await bucket.getObject(objectKey);
  let text = "";
  if (raw != null && typeof raw === "object" && typeof raw.pipe === "function") {
    text = await streamToString(raw);
  } else {
    text = rawToUtf8(raw);
  }
  text = String(text || "").trim();
  if (!text) throw new Error(`Empty Stratus object: ${objectKey}`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON at ${objectKey}: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected JSON array at ${objectKey}`);
  }
  return parsed.map((v) => String(v ?? "").trim()).filter(isValid);
}

function blankCodeOrNameClause() {
  return (
    `(Security_code IS NULL OR Security_code = '' OR ` +
    `Security_Name IS NULL OR Security_Name = '')`
  );
}

/**
 * Batch-load Security_Code / Security_Name for a chunk of ISINs.
 * @returns {Map<string, { code: string, name: string }>}
 */
async function fetchSecurityMapForChunk(zcql, isinChunk) {
  const map = new Map();
  if (!isinChunk.length) return map;

  const inList = isinChunk.map((i) => `'${esc(i)}'`).join(",");
  const rows = await zcql.executeZCQLQuery(`
    SELECT ISIN, Security_Code, Security_Name
    FROM Security_List
    WHERE ISIN IN (${inList})
    LIMIT 300
  `);

  for (const r of rows || []) {
    const row = r.Security_List || r;
    const isin = String(row.ISIN ?? "").trim();
    const code = String(row.Security_Code ?? "").trim();
    const name = String(row.Security_Name ?? "").trim();
    if (!isin) continue;
    if (!isValid(code) || !isValid(name)) continue;
    // Prefer first row that has both; skip overwriting with empties.
    if (!map.has(isin)) {
      map.set(isin, { code, name });
    }
  }
  return map;
}

/**
 * UPDATE Transaction rows for one ISIN where code/name are blank.
 * Pages by ROWID to stay under Catalyst ~300-row mutation limits.
 */
async function enrichTransactionForIsin(zcql, isin, code, name, createdFloor) {
  const isinEsc = esc(isin);
  const codeEsc = esc(code);
  const nameEsc = esc(name);
  const dateClause = createdFloor
    ? ` AND CREATEDTIME >= '${esc(createdFloor)}'`
    : "";

  let updated = 0;
  for (let round = 0; round < MAX_UPDATE_ROUNDS_PER_ISIN; round++) {
    const idRows = await zcql.executeZCQLQuery(`
      SELECT ROWID
      FROM Transaction
      WHERE ISIN = '${isinEsc}'
        ${dateClause}
        AND ${blankCodeOrNameClause()}
      LIMIT ${UPDATE_ROW_BATCH}
    `);

    if (!idRows || idRows.length === 0) break;

    const ids = [];
    for (const r of idRows) {
      const row = r.Transaction || r;
      const id = row.ROWID;
      if (id != null && id !== "") ids.push(String(id));
    }
    if (!ids.length) break;

    await zcql.executeZCQLQuery(`
      UPDATE Transaction
      SET Security_code = '${codeEsc}', Security_Name = '${nameEsc}'
      WHERE ROWID IN (${ids.join(",")})
    `);
    updated += ids.length;

    if (idRows.length < UPDATE_ROW_BATCH) break;
  }

  return updated;
}

async function retriggerSelf(catalystApp, params, lastIsin) {
  const scheduling = catalystApp.jobScheduling();
  const jobName = `ETS_${Date.now()}`.slice(0, 20);
  await scheduling.JOB.submitJob({
    job_name: jobName,
    jobpool_name: JOBPOOL,
    target_name: TARGET_NAME,
    target_type: "Function",
    job_config: { number_of_retries: 5, retry_interval: 60 * 1000 },
    params: {
      source: String(params.source || EXPECTED_SOURCE),
      bucketName: String(params.bucketName || ""),
      isinsObjectKey: String(params.isinsObjectKey || ""),
      importStartedAtMs: String(params.importStartedAtMs || ""),
      lastIsin: String(lastIsin || ""),
    },
  });
  console.log(
    `${LOG} Baton-pass queued ${jobName} lastIsin=${lastIsin || "(start)"}`,
  );
}

module.exports = async (jobRequest, context) => {
  const startedAt = Date.now();
  try {
    const params = getJobParams(jobRequest);
    const source = String(params.source ?? "").trim();
    const bucketName = String(
      params.bucketName ?? params.bucket_name ?? "",
    ).trim();
    const isinsObjectKey = String(
      params.isinsObjectKey ?? params.isins_object_key ?? "",
    ).trim();
    const lastIsin = String(params.lastIsin ?? params.last_isin ?? "").trim();
    const importStartedAtMs = (() => {
      const n = Number(params.importStartedAtMs ?? params.import_started_at_ms);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    })();

    if (source && source !== EXPECTED_SOURCE) {
      console.warn(`${LOG} Unexpected source=${source} — continuing anyway`);
    }

    if (!bucketName || !isinsObjectKey) {
      console.error(
        `${LOG} bucketName and isinsObjectKey are required — exiting`,
      );
      context.closeWithFailure();
      return;
    }

    const catalystApp = catalyst.initialize(context);
    const zcql = catalystApp.zcql();
    const bucket = catalystApp.stratus().bucket(bucketName);

    const createdFloor =
      importStartedAtMs > 0 ? createdTimeFloorFromMs(importStartedAtMs) : "";

    console.log(
      `${LOG} bucket=${bucketName} isinsObjectKey=${isinsObjectKey} ` +
        `lastIsin=${lastIsin || "(start)"} createdFloor=${createdFloor || "(none)"}`,
    );

    let isins = await readJsonArrayFromStratus(bucket, isinsObjectKey);
    isins.sort((a, b) => a.localeCompare(b));

    const pending = lastIsin
      ? isins.filter((i) => i > lastIsin)
      : isins;

    console.log(
      `${LOG} totalIsins=${isins.length} pending=${pending.length} ` +
        `(resume after ${lastIsin || "beginning"})`,
    );

    // Free full list reference after slicing pending (pending holds what we need).
    isins = null;

    let processed = 0;
    let skippedNoMaster = 0;
    let rowsUpdated = 0;
    let lastFullyProcessed = lastIsin;

    for (let offset = 0; offset < pending.length; offset += ISIN_CHUNK_SIZE) {
      if (getRemainingMs(context) < REMAINING_TIME_BUFFER_MS) {
        await retriggerSelf(catalystApp, {
          source: EXPECTED_SOURCE,
          bucketName,
          isinsObjectKey,
          importStartedAtMs: importStartedAtMs || "",
        }, lastFullyProcessed);
        console.log(
          `${LOG} Time budget low after ${processed} ISIN(s); baton-pass. ` +
            `elapsed=${Date.now() - startedAt}ms`,
        );
        context.closeWithSuccess();
        return;
      }

      const chunk = pending.slice(offset, offset + ISIN_CHUNK_SIZE);
      const securityMap = await fetchSecurityMapForChunk(zcql, chunk);

      for (const isin of chunk) {
        if (getRemainingMs(context) < REMAINING_TIME_BUFFER_MS) {
          await retriggerSelf(catalystApp, {
            source: EXPECTED_SOURCE,
            bucketName,
            isinsObjectKey,
            importStartedAtMs: importStartedAtMs || "",
          }, lastFullyProcessed);
          console.log(
            `${LOG} Time budget low mid-chunk; baton-pass lastIsin=${lastFullyProcessed}. ` +
              `elapsed=${Date.now() - startedAt}ms`,
          );
          context.closeWithSuccess();
          return;
        }

        const master = securityMap.get(isin);
        if (!master) {
          skippedNoMaster++;
          lastFullyProcessed = isin;
          processed++;
          continue;
        }

        try {
          const n = await enrichTransactionForIsin(
            zcql,
            isin,
            master.code,
            master.name,
            createdFloor,
          );
          rowsUpdated += n;
          if (n > 0) {
            console.log(`${LOG} ${isin}: updated ${n} Transaction row(s)`);
          }
        } catch (err) {
          console.error(`${LOG} ${isin}: UPDATE failed:`, err.message);
        }

        lastFullyProcessed = isin;
        processed++;
      }
    }

    console.log(
      `${LOG} Done. processed=${processed} skippedNoMaster=${skippedNoMaster} ` +
        `rowsUpdated=${rowsUpdated} elapsed=${Date.now() - startedAt}ms`,
    );
    context.closeWithSuccess();
  } catch (err) {
    console.error(`${LOG} error:`, err);
    context.closeWithFailure();
  }
};
