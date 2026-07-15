"use strict";

/**
 * CalculateHoldingMaster — sliding-window orchestrator for holdings slaves.
 *
 * Dispatches CalculateHoldingWorkers in batches of at most MAX_IN_FLIGHT slaves,
 * polls in-flight job IDs via JOB.getJob(), and re-queues itself when the 15-minute
 * function budget is nearly exhausted (baton-pass).
 *
 * Dispatch state is persisted on Stratus:
 *   transactions-meta/holdings-dispatch-{importStartedAtMs}.json
 *
 * Params (from TempTransactionUpload / prior master run):
 *   source, pairsObjectKey, bucketName, importStartedAtMs
 */

const catalyst = require("zcatalyst-sdk-node");

const SLAVE_TARGET = "CalculateHoldingWorkers";
const SLAVE_JOBPOOL = "UpdateMasters";
const MASTER_TARGET = "CalculateHoldingMaster";
const MASTER_JOBPOOL = "UpdateMasters";
const CHUNK_SIZE = 200;

const JOB_SUBMIT_CONFIG = {
  target_type: "Function",
  job_config: { number_of_retries: 5, retry_interval: 60 * 1000 },
};

/** Max holdings slaves in-flight (pool COMPONENT limit ~15; leave headroom for USCM/CCB). */
const MAX_IN_FLIGHT = 10;

/** Stop dispatch/poll loop this many ms before function timeout; hand off to a fresh master run. */
const REMAINING_TIME_BUFFER_MS = 60_000;

/** Sleep between poll rounds while waiting for in-flight slaves to finish. */
const POLL_WAIT_MS = 5_000;

/** Backoff when submitJob hits COMPONENT concurrency limit. */
const CONCURRENCY_RETRY_MS = 8_000;
const SUBMIT_MAX_RETRIES = 12;

const TERMINAL_SUCCESS = new Set([
  "SUCCESS",
  "SUCCESSFUL",
  "COMPLETED",
  "COMPLETE",
  "SUCCEEDED",
]);

const TERMINAL_FAILURE = new Set([
  "FAILURE",
  "FAILED",
  "ERROR",
  "TIMED_OUT",
  "TIMEOUT",
  "CANCELLED",
  "CANCELED",
  "ABORTED",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getJobParams(jobRequest) {
  try {
    if (jobRequest && typeof jobRequest.getAllJobParams === "function") {
      return jobRequest.getAllJobParams() || {};
    }
  } catch (e) {
    console.warn("CalculateHoldingMaster getJobParams:", e.message);
  }
  return {};
}

function dispatchStateKey(importStartedAtMs) {
  return `transactions-meta/holdings-dispatch-${importStartedAtMs}.json`;
}

function isConcurrencyError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return msg.includes("concurrency limit") || msg.includes("concurrency");
}

function normalizeJobStatus(status) {
  return String(status || "").trim().toUpperCase();
}

function isTerminalSuccess(status) {
  return TERMINAL_SUCCESS.has(normalizeJobStatus(status));
}

function isTerminalFailure(status) {
  return TERMINAL_FAILURE.has(normalizeJobStatus(status));
}

function getRemainingMs(context) {
  if (typeof context.getRemainingExecutionTimeMs === "function") {
    const ms = context.getRemainingExecutionTimeMs();
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return Number.MAX_SAFE_INTEGER;
}

function isStratusNotFound(err) {
  const code = String(err?.code || "").toUpperCase();
  const status = Number(err?.statusCode);
  const msg = String(err?.message || "").toLowerCase();
  return (
    status === 404 ||
    code === "NOT_FOUND" ||
    msg.includes("no such object") ||
    msg.includes("not found")
  );
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

async function readStratusObject(bucket, key) {
  try {
    const raw = await bucket.getObject(key);
    let text = "";
    if (raw != null && typeof raw === "object" && typeof raw.pipe === "function") {
      text = await streamToString(raw);
    } else {
      const s = rawToUtf8(raw);
      text = s == null ? "" : s;
    }
    text = String(text).trim();
    return text || null;
  } catch (err) {
    if (isStratusNotFound(err)) return null;
    throw err;
  }
}

async function writeStratusObject(bucket, key, text) {
  await bucket.putObject(key, Buffer.from(text, "utf8"), {
    overwrite: true,
    contentType: "application/json",
  });
}

async function loadDispatchState(bucket, importStartedAtMs) {
  const key = dispatchStateKey(importStartedAtMs);
  const raw = await readStratusObject(bucket, key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      nextChunk: Number(parsed.nextChunk) || 0,
      totalChunks: Number(parsed.totalChunks) || 0,
      totalPairs: Number(parsed.totalPairs) || 0,
      inFlight: Array.isArray(parsed.inFlight) ? parsed.inFlight : [],
      failedChunks: Array.isArray(parsed.failedChunks) ? parsed.failedChunks : [],
      pairsObjectKey: String(parsed.pairsObjectKey || ""),
      bucketName: String(parsed.bucketName || ""),
      importStartedAtMs: Number(parsed.importStartedAtMs) || importStartedAtMs,
    };
  } catch (err) {
    console.warn(`CalculateHoldingMaster: invalid dispatch state at ${key}:`, err.message);
    return null;
  }
}

async function saveDispatchState(bucket, state) {
  const key = dispatchStateKey(state.importStartedAtMs);
  const payload = {
    nextChunk: state.nextChunk,
    totalChunks: state.totalChunks,
    totalPairs: state.totalPairs,
    inFlight: state.inFlight,
    failedChunks: state.failedChunks,
    pairsObjectKey: state.pairsObjectKey,
    bucketName: state.bucketName,
    importStartedAtMs: state.importStartedAtMs,
    updatedAtMs: Date.now(),
  };
  await writeStratusObject(bucket, key, JSON.stringify(payload));
}

async function refreshInFlight(scheduling, state) {
  if (!state.inFlight.length) return;

  const stillInFlight = [];
  for (const entry of state.inFlight) {
    const chunk = Number(entry.chunk);
    const jobId = String(entry.jobId || "").trim();
    if (!jobId) {
      console.warn(`CalculateHoldingMaster: in-flight chunk ${chunk} missing jobId`);
      state.failedChunks.push(chunk);
      continue;
    }

    try {
      const details = await scheduling.JOB.getJob(jobId);
      const status = details?.job_status || details?.status || "";
      if (isTerminalSuccess(status)) {
        console.log(
          `CalculateHoldingMaster: chunk ${chunk} slave ${jobId} finished (${status})`,
        );
        continue;
      }
      if (isTerminalFailure(status)) {
        console.error(
          `CalculateHoldingMaster: chunk ${chunk} slave ${jobId} failed (${status})`,
        );
        state.failedChunks.push(chunk);
        continue;
      }
      stillInFlight.push({ chunk, jobId });
    } catch (err) {
      console.warn(
        `CalculateHoldingMaster: getJob(${jobId}) for chunk ${chunk} failed: ${err.message}`,
      );
      stillInFlight.push({ chunk, jobId });
    }
  }

  state.inFlight = stillInFlight;
}

async function submitSlaveWithRetry(scheduling, jobMeta) {
  let lastErr = null;
  for (let attempt = 0; attempt < SUBMIT_MAX_RETRIES; attempt++) {
    try {
      return await scheduling.JOB.submitJob(jobMeta);
    } catch (err) {
      lastErr = err;
      if (isConcurrencyError(err) && attempt < SUBMIT_MAX_RETRIES - 1) {
        console.warn(
          `CalculateHoldingMaster: concurrency limit on submit (attempt ${attempt + 1}/${SUBMIT_MAX_RETRIES}), retrying in ${CONCURRENCY_RETRY_MS}ms`,
        );
        await sleep(CONCURRENCY_RETRY_MS);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("submitSlaveWithRetry exhausted retries");
}

async function submitOneChunk(scheduling, state, chunkIndex, importStartedAtMs) {
  const slaveJobName = `CHS_${chunkIndex}_${Date.now()}`.slice(0, 50);
  const chunkStart = chunkIndex * CHUNK_SIZE;

  const submitted = await submitSlaveWithRetry(scheduling, {
    job_name: slaveJobName,
    jobpool_name: SLAVE_JOBPOOL,
    target_name: SLAVE_TARGET,
    ...JOB_SUBMIT_CONFIG,
    params: {
      source: "TxnUpload",
      pairsObjectKey: state.pairsObjectKey,
      bucketName: state.bucketName,
      chunkStart: String(chunkStart),
      chunkCount: String(CHUNK_SIZE),
      importStartedAtMs: String(importStartedAtMs),
      jobName: slaveJobName,
    },
  });

  const jobId = String(submitted?.job_id || "").trim();
  if (!jobId) {
    throw new Error(`submitJob returned no job_id for chunk ${chunkIndex}`);
  }

  state.inFlight.push({ chunk: chunkIndex, jobId });
  console.log(
    `CalculateHoldingMaster: dispatched chunk ${chunkIndex + 1}/${state.totalChunks} ` +
      `(pairs ${chunkStart}..${chunkStart + CHUNK_SIZE - 1}) → ${slaveJobName} jobId=${jobId}`,
  );
}

async function retriggerMaster(scheduling, params) {
  const jobName = `CHM_${Date.now()}`.slice(0, 20);
  await scheduling.JOB.submitJob({
    job_name: jobName,
    jobpool_name: MASTER_JOBPOOL,
    target_name: MASTER_TARGET,
    ...JOB_SUBMIT_CONFIG,
    params: {
      source: params.source || "TxnUpload",
      pairsObjectKey: params.pairsObjectKey,
      bucketName: params.bucketName,
      importStartedAtMs: String(params.importStartedAtMs),
    },
  });
  console.log(
    `CalculateHoldingMaster: baton-pass re-queued (${jobName}); ` +
      `state key=${dispatchStateKey(params.importStartedAtMs)}`,
  );
}

/**
 * @param {import('./types/job').JobRequest} jobRequest
 * @param {import('./types/job').Context} context
 */
module.exports = async (jobRequest, context) => {
  const startedAt = Date.now();
  const catalystApp = catalyst.initialize(context);
  const scheduling = catalystApp.jobScheduling();

  try {
    const params = getJobParams(jobRequest);
    const source = String(params.source ?? "").trim();
    const pairsObjectKey = String(
      params.pairsObjectKey ?? params.pairs_object_key ?? "",
    ).trim();
    const bucketName = String(
      params.bucketName ?? params.bucket_name ?? "client-transaction-files",
    ).trim();
    const importRaw = params.importStartedAtMs ?? params.import_started_at_ms;
    const importStartedAtMs = Number(importRaw);

    if (source !== "TxnUpload") {
      throw new Error(`CalculateHoldingMaster: unsupported source "${source}"`);
    }
    if (!pairsObjectKey) {
      throw new Error("CalculateHoldingMaster: pairsObjectKey is required");
    }
    if (!Number.isFinite(importStartedAtMs) || importStartedAtMs <= 0) {
      throw new Error("CalculateHoldingMaster: importStartedAtMs is required");
    }

    const stratus = catalystApp.stratus();
    const bucket = stratus.bucket(bucketName);

    console.log(
      `CalculateHoldingMaster: bucket=${bucketName} pairsObjectKey=${pairsObjectKey} ` +
        `dispatchState=${dispatchStateKey(importStartedAtMs)}`,
    );

    let state = await loadDispatchState(bucket, importStartedAtMs);

    if (state) {
      if (!state.pairsObjectKey) state.pairsObjectKey = pairsObjectKey;
      if (!state.bucketName) state.bucketName = bucketName;
    }

    if (!state) {
      const raw = await readStratusObject(bucket, pairsObjectKey);
      if (!raw) {
        throw new Error(
          `Pairs manifest not found in Stratus bucket "${bucketName}": ${pairsObjectKey}`,
        );
      }

      let pairs;
      try {
        pairs = JSON.parse(raw);
      } catch (err) {
        throw new Error(`Invalid pairs JSON at ${pairsObjectKey}: ${err.message}`);
      }
      if (!Array.isArray(pairs)) {
        throw new Error(`Pairs manifest must be an array: ${pairsObjectKey}`);
      }

      const totalPairs = pairs.length;
      const totalChunks = Math.ceil(totalPairs / CHUNK_SIZE) || 0;

      state = {
        nextChunk: 0,
        totalChunks,
        totalPairs,
        inFlight: [],
        failedChunks: [],
        pairsObjectKey,
        bucketName,
        importStartedAtMs,
      };

      await saveDispatchState(bucket, state);

      console.log(
        `CalculateHoldingMaster: initialized dispatch for ${totalPairs} pair(s) → ` +
          `${totalChunks} chunk(s) of ${CHUNK_SIZE}; max in-flight=${MAX_IN_FLIGHT}`,
      );
    } else {
      console.log(
        `CalculateHoldingMaster: resumed dispatch state nextChunk=${state.nextChunk}/` +
          `${state.totalChunks}, inFlight=${state.inFlight.length}, failed=${state.failedChunks.length}`,
      );
    }

    let needsRetrigger = false;

    while (true) {
      await refreshInFlight(scheduling, state);

      const allAssigned = state.nextChunk >= state.totalChunks;
      const allDone = allAssigned && state.inFlight.length === 0;

      if (allDone) {
        await saveDispatchState(bucket, state);
        break;
      }

      const remainingMs = getRemainingMs(context);
      if (remainingMs < REMAINING_TIME_BUFFER_MS) {
        needsRetrigger = true;
        await saveDispatchState(bucket, state);
        console.log(
          `CalculateHoldingMaster: ${remainingMs}ms remaining (< ${REMAINING_TIME_BUFFER_MS}ms buffer); ` +
            `baton-pass with nextChunk=${state.nextChunk}/${state.totalChunks}, ` +
            `inFlight=${state.inFlight.length}`,
        );
        break;
      }

      const freeSlots = Math.max(0, MAX_IN_FLIGHT - state.inFlight.length);
      let dispatched = 0;

      while (dispatched < freeSlots && state.nextChunk < state.totalChunks) {
        const chunkIndex = state.nextChunk;
        try {
          await submitOneChunk(scheduling, state, chunkIndex, importStartedAtMs);
          state.nextChunk += 1;
          dispatched += 1;
        } catch (err) {
          if (isConcurrencyError(err)) {
            console.warn(
              `CalculateHoldingMaster: concurrency limit dispatching chunk ${chunkIndex}; will retry after poll wait`,
            );
            break;
          }
          throw err;
        }
      }

      await saveDispatchState(bucket, state);

      if (state.nextChunk >= state.totalChunks && state.inFlight.length === 0) {
        break;
      }

      if (dispatched === 0 && state.nextChunk < state.totalChunks) {
        await sleep(CONCURRENCY_RETRY_MS);
      } else {
        await sleep(POLL_WAIT_MS);
      }
    }

    if (needsRetrigger) {
      await retriggerMaster(scheduling, {
        source,
        pairsObjectKey: state.pairsObjectKey || pairsObjectKey,
        bucketName: state.bucketName || bucketName,
        importStartedAtMs,
      });
      console.log(
        `CalculateHoldingMaster partial run in ${Date.now() - startedAt}ms: ` +
          `nextChunk=${state.nextChunk}/${state.totalChunks}, inFlight=${state.inFlight.length}`,
      );
      context.closeWithSuccess();
      return;
    }

    if (state.failedChunks.length > 0) {
      const uniqueFailed = [...new Set(state.failedChunks)].sort((a, b) => a - b);
      console.error(
        `CalculateHoldingMaster: ${uniqueFailed.length} chunk(s) failed: ${uniqueFailed.join(", ")}`,
      );
      context.closeWithFailure();
      return;
    }

    console.log(
      `CalculateHoldingMaster: all ${state.totalChunks} chunk(s) dispatched and completed in ` +
        `${Date.now() - startedAt}ms (${state.totalPairs} pair(s))`,
    );
    context.closeWithSuccess();
  } catch (error) {
    console.error(
      "CalculateHoldingMaster failed:",
      error?.message || error,
      error?.code ? `(code=${error.code})` : "",
    );
    context.closeWithFailure();
  }
};
