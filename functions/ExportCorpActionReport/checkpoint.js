"use strict";

/**
 * Stratus-backed checkpoint helpers for the baton-passed ExportCorpActionReport
 * job — same pattern as functions/ExportAllCustomerHoldingData/checkpoint.js.
 *
 * Per jobName (e.g. "CARPT_SPLIT_2026-01-01_2026-03-31") this keeps three
 * objects on the `upload-data-bucket` under exports-meta/:
 *   - <jobName>-manifest.json    snapshot of the corporate-action event work
 *                                list, taken once on the first invocation so a
 *                                moving source table doesn't shift indexes mid-run
 *   - <jobName>-checkpoint.json  cursor into the manifest + multipart upload
 *                                state (uploadId, nextPartNumber)
 *   - <jobName>-pending.csv      CSV bytes accumulated but not yet big enough
 *                                to flush as a multipart part (<5MB)
 */

const META_PREFIX = "exports-meta";

const manifestKeyFor = (jobName) => `${META_PREFIX}/${jobName}-manifest.json`;
const checkpointKeyFor = (jobName) => `${META_PREFIX}/${jobName}-checkpoint.json`;
const pendingBufferKeyFor = (jobName) => `${META_PREFIX}/${jobName}-pending.csv`;

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

async function readStratusObject(bucket, key) {
  try {
    const raw = await bucket.getObject(key);
    if (raw != null && typeof raw === "object" && typeof raw.pipe === "function") {
      return await streamToString(raw);
    }
    const s = rawToUtf8(raw);
    return s == null ? "" : s;
  } catch (err) {
    if (isStratusNotFound(err)) return null;
    throw err;
  }
}

async function writeStratusObject(bucket, key, text, contentType) {
  await bucket.putObject(key, Buffer.from(text, "utf8"), {
    overwrite: true,
    contentType: contentType || "application/json",
  });
}

async function deleteStratusObjectSafe(bucket, key) {
  try {
    await bucket.deleteObject(key);
  } catch (err) {
    if (!isStratusNotFound(err)) {
      console.warn(`Failed to delete Stratus object ${key}:`, err.message);
    }
  }
}

async function loadManifest(bucket, jobName) {
  const raw = await readStratusObject(bucket, manifestKeyFor(jobName));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.warn(`Invalid manifest JSON for ${jobName}:`, err.message);
    return null;
  }
}

async function saveManifest(bucket, jobName, entries) {
  await writeStratusObject(bucket, manifestKeyFor(jobName), JSON.stringify(entries));
}

async function loadCheckpoint(bucket, jobName) {
  const raw = await readStratusObject(bucket, checkpointKeyFor(jobName));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    console.warn(`Invalid checkpoint JSON for ${jobName}:`, err.message);
    return null;
  }
}

async function saveCheckpoint(bucket, jobName, state) {
  const payload = { ...state, updatedAtMs: Date.now() };
  await writeStratusObject(bucket, checkpointKeyFor(jobName), JSON.stringify(payload));
}

async function loadPendingBuffer(bucket, jobName) {
  const raw = await readStratusObject(bucket, pendingBufferKeyFor(jobName));
  return raw || "";
}

async function savePendingBuffer(bucket, jobName, text) {
  if (!text) {
    await deleteStratusObjectSafe(bucket, pendingBufferKeyFor(jobName));
    return;
  }
  await writeStratusObject(bucket, pendingBufferKeyFor(jobName), text, "text/csv");
}

async function deleteExportArtifacts(bucket, jobName) {
  await deleteStratusObjectSafe(bucket, manifestKeyFor(jobName));
  await deleteStratusObjectSafe(bucket, checkpointKeyFor(jobName));
  await deleteStratusObjectSafe(bucket, pendingBufferKeyFor(jobName));
}

module.exports = {
  manifestKeyFor,
  checkpointKeyFor,
  pendingBufferKeyFor,
  loadManifest,
  saveManifest,
  loadCheckpoint,
  saveCheckpoint,
  loadPendingBuffer,
  savePendingBuffer,
  deleteExportArtifacts,
};
