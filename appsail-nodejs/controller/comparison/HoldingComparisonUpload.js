import { PassThrough } from "stream";
import { stratusSignedUrlToString } from "../../util/stratusSignedUrl.js";

const BUCKET_NAME = "client-transaction-files";

/**
 * Stratus object keys produced by `uploadHoldingComparisonFile` look like
 *   holding-comparison/HoldingCmp-<ms>-<originalFileName>
 * The capture groups give us the upload time and the user's original
 * filename without needing a separate tracking table.
 */
const STRATUS_HOLDING_CMP_KEY_PATTERN =
  /^holding-comparison\/HoldingCmp-(\d+)-(.+)$/;

export function parseStratusHoldingComparisonKey(key) {
  if (!key || typeof key !== "string") return null;
  const m = STRATUS_HOLDING_CMP_KEY_PATTERN.exec(key.trim());
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
 * POST /api/comparison/holding-comparison/upload
 * Simple upload: validates a CSV file is present, then stores it as-is in
 * Stratus under the `holding-comparison/` prefix.
 */
export const uploadHoldingComparisonFile = async (req, res) => {
  try {
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

    const objectKey = `holding-comparison/HoldingCmp-${Date.now()}-${file.name}`;

    const bucket = catalystApp.stratus().bucket(BUCKET_NAME);
    const passThrough = new PassThrough();
    const uploadPromise = bucket.putObject(objectKey, passThrough, {
      overwrite: true,
      contentType: "text/csv",
    });
    passThrough.end(file.data);
    await uploadPromise;

    return res.status(200).json({
      success: true,
      message: "Holding comparison file uploaded successfully.",
      key: objectKey,
    });
  } catch (error) {
    console.error("[HoldingComparisonUpload] upload:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to upload holding comparison file",
    });
  }
};

/**
 * GET /api/comparison/holding-comparison/upload-history?limit=&cursor=&search=
 * Lists holding comparison uploads under the `holding-comparison/` prefix,
 * newest first. Metadata is derived from the object key (no separate DB).
 */
export const listHoldingComparisonHistory = async (req, res) => {
  try {
    const catalystApp = req.catalystApp;
    if (!catalystApp) {
      return res
        .status(500)
        .json({ success: false, message: "Catalyst not initialized" });
    }

    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 5));
    const cursor = req.query.cursor ? String(req.query.cursor) : null;
    const search = String(req.query.search || "")
      .trim()
      .toLowerCase();

    const bucket = catalystApp.stratus().bucket(BUCKET_NAME);
    const listOpts = {
      maxKeys: limit,
      prefix: "holding-comparison/",
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
      const parsed = parseStratusHoldingComparisonKey(key);
      if (!parsed) continue;
      if (search && !parsed.originalFileName.toLowerCase().includes(search)) {
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
      ? result.next_continuation_token || result.nextContinuationToken || null
      : null;

    return res.status(200).json({ success: true, items, nextCursor });
  } catch (error) {
    console.error("[HoldingComparisonUpload] listHistory:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to list upload history",
    });
  }
};

/**
 * GET /api/comparison/holding-comparison/upload-history/download?key=…
 * Validates the key shape, then returns a 1-hour Stratus presigned GET URL.
 */
export const downloadHoldingComparisonHistory = async (req, res) => {
  try {
    const catalystApp = req.catalystApp;
    if (!catalystApp) {
      return res
        .status(500)
        .json({ success: false, message: "Catalyst not initialized" });
    }

    const key = String(req.query.key || "").trim();
    if (!key.startsWith("holding-comparison/")) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid object key" });
    }
    const parsed = parseStratusHoldingComparisonKey(key);
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
    console.error("[HoldingComparisonUpload] downloadHistory:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to generate download link",
    });
  }
};
