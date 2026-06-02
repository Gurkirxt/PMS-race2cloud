/**
 * CalculateHoldingMaster (Catalyst Job Function) — fan-out orchestrator
 *
 * Does NO database work. Its only job is to take the full list of
 * (account, ISIN) pairs touched by a transaction CSV upload and dispatch it as
 * many parallel slave jobs, so no single slave exceeds the 15-minute function
 * timeout.
 *
 * Required job params (queued by AppSail TempTransactionUpload):
 *   - `source`           = "TxnUpload"
 *   - `pairsObjectKey`   = Stratus key of the JSON manifest: [[acc, isin], ...]
 *   - `bucketName`       = Stratus bucket holding the manifest
 *   - `importStartedAtMs`= epoch ms; forwarded verbatim to each slave
 *
 * Per run:
 *   1. Read the manifest from Stratus (validates it is readable + counts pairs).
 *   2. Split [0, total) into chunks of CHUNK_SIZE.
 *   3. submitJob one `CalculateHoldingWorkers` slave per chunk, passing only
 *      { pairsObjectKey, bucketName, chunkStart, chunkCount, importStartedAtMs }.
 *      Each slave re-reads the manifest and processes only its slice.
 *
 * Slaves run in parallel (subject to job-pool capacity / memory). The slave
 * params stay tiny (a key + two numbers), so Catalyst's job-param size cap is
 * never a factor regardless of upload size.
 */

const catalyst = require("zcatalyst-sdk-node");

/* ============================== CONFIG ============================== */

/** Pairs per slave job. Sized so one slave finishes well under the 15-min cap. */
const CHUNK_SIZE = 200;

/** Slave function name (the per-pair worker). */
const SLAVE_TARGET = "CalculateHoldingWorkers";

/** Job pool the slaves are dispatched into. */
const SLAVE_JOBPOOL = "UpdateMasters";

/** Only this source is processed; anything else is a no-op. */
const HOLDINGS_UPLOAD_SOURCE = "TxnUpload";

/** Default bucket if the param is missing. */
const DEFAULT_META_BUCKET = "client-transaction-files";

/* ============================== HELPERS ============================== */

function getAllParams(jobRequest) {
  try {
    if (jobRequest && typeof jobRequest.getAllJobParams === "function") {
      return jobRequest.getAllJobParams() || {};
    }
  } catch (e) {
    console.warn("getAllParams:", e.message);
  }
  return {};
}

function rawToUtf8(raw) {
  if (raw == null) return "";
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  if (typeof raw === "string") return raw;
  return null;
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readStratusObjectAsString(app, bucketName, objectKey) {
  const bucket = app.stratus().bucket(bucketName);
  const raw = await bucket.getObject(objectKey);
  if (raw != null && typeof raw === "object" && typeof raw.pipe === "function") {
    return await streamToString(raw);
  }
  const s = rawToUtf8(raw);
  return s == null ? "" : s;
}

/* ============================== ENTRY ============================== */

module.exports = async (jobRequest, context) => {
  const app = catalyst.initialize(context);
  const startedAt = Date.now();

  try {
    const p = getAllParams(jobRequest);
    const source = String(p.source ?? "").trim();
    const pairsObjectKey = String(p.pairsObjectKey ?? p.pairs_object_key ?? "").trim();
    const bucketName =
      String(p.bucketName ?? p.bucket_name ?? "").trim() || DEFAULT_META_BUCKET;
    const importStartedAtMs = String(p.importStartedAtMs ?? p.import_started_at_ms ?? "").trim();

    if (source !== HOLDINGS_UPLOAD_SOURCE) {
      console.warn(
        `CalculateHoldingMaster: ignoring invocation — source must be "${HOLDINGS_UPLOAD_SOURCE}".`,
      );
      context.closeWithSuccess();
      return;
    }
    if (!pairsObjectKey) {
      console.warn("CalculateHoldingMaster: pairsObjectKey missing — nothing to do.");
      context.closeWithSuccess();
      return;
    }
    if (!importStartedAtMs) {
      console.warn("CalculateHoldingMaster: importStartedAtMs missing — nothing to do.");
      context.closeWithSuccess();
      return;
    }

    // 1. Read manifest (validates readability + gives authoritative count).
    let text = "";
    try {
      text = await readStratusObjectAsString(app, bucketName, pairsObjectKey);
    } catch (e) {
      console.error(
        `CalculateHoldingMaster: failed to read ${bucketName}/${pairsObjectKey}:`,
        e.message,
      );
      context.closeWithFailure();
      return;
    }

    let arr;
    try {
      arr = JSON.parse(text);
    } catch (e) {
      console.error(
        `CalculateHoldingMaster: invalid JSON manifest ${pairsObjectKey}:`,
        e.message,
      );
      context.closeWithFailure();
      return;
    }

    const total = Array.isArray(arr) ? arr.length : 0;
    if (total === 0) {
      console.warn("CalculateHoldingMaster: manifest has 0 pairs — nothing to dispatch.");
      context.closeWithSuccess();
      return;
    }

    const totalChunks = Math.ceil(total / CHUNK_SIZE);
    console.log(
      `CalculateHoldingMaster: ${total} pair(s) -> ${totalChunks} slave(s) ` +
        `of up to ${CHUNK_SIZE} | bucket=${bucketName} key=${pairsObjectKey} | ` +
        `importStartedAtMs=${importStartedAtMs}`,
    );

    // 2 + 3. Dispatch one slave per chunk.
    const scheduling = app.jobScheduling();
    let dispatched = 0;
    let failedDispatch = 0;

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const chunkStart = chunkIndex * CHUNK_SIZE;
      const chunkCount = Math.min(CHUNK_SIZE, total - chunkStart);
      const slaveJobName = `CHS_${chunkIndex}_${startedAt}`.slice(0, 20);

      try {
        await scheduling.JOB.submitJob({
          job_name: slaveJobName,
          jobpool_name: SLAVE_JOBPOOL,
          target_name: SLAVE_TARGET,
          target_type: "Function",
          job_config: {
            number_of_retries: 5,
            retry_interval: 60 * 1000,
          },
          params: {
            source: HOLDINGS_UPLOAD_SOURCE,
            pairsObjectKey,
            bucketName,
            chunkStart: String(chunkStart),
            chunkCount: String(chunkCount),
            importStartedAtMs,
          },
        });
        dispatched++;
      } catch (err) {
        failedDispatch++;
        console.error(
          `CalculateHoldingMaster: failed to dispatch slave ${chunkIndex + 1}/${totalChunks} ` +
            `[${chunkStart}, ${chunkStart + chunkCount}):`,
          err.message,
        );
      }
    }

    console.log(
      `CalculateHoldingMaster done in ${Date.now() - startedAt}ms: ` +
        `dispatched ${dispatched}/${totalChunks} slave(s), ${failedDispatch} dispatch failure(s).`,
    );

    if (failedDispatch > 0) {
      // Surface the partial dispatch so the pool retries the master; already-queued
      // slaves are idempotent at the "no new txns" level (they only append unseen rows).
      context.closeWithFailure();
      return;
    }
    context.closeWithSuccess();
  } catch (err) {
    console.error("CalculateHoldingMaster failed:", err);
    context.closeWithFailure();
  }
};
