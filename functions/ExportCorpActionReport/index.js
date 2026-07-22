"use strict";

/**
 * ExportCorpActionReport — baton-passed "corporate-action impact" CSV report.
 *
 * Generates a per-client impact report across ALL ISINs for ONE corporate-action
 * type over a date range (e.g. "how did every split in this window affect every
 * client"). Modeled on ExportAllCustomerHoldingData's baton-passing pattern so it
 * survives the 15-minute Catalyst Job execution limit.
 *
 * This driver is TYPE-AGNOSTIC. The per-type logic lives in handlers/<type>.js
 * (selected via the `reportType` job param). Each handler provides:
 *   - header         CSV header line
 *   - buildManifest  frozen work list (array of "event" objects) for the range
 *   - buildEventCsv  all CSV rows for ONE event (processed atomically)
 *
 * Flow:
 *   - First invocation snapshots the manifest to Stratus once (so a moving
 *     source table doesn't shift indexes across resumes) and initiates a
 *     multipart upload for the target file.
 *   - Each event's CSV rows are appended to an in-memory buffer; once it reaches
 *     MIN_FLUSH_BYTES (or on the last event) the buffer is uploaded as a
 *     multipart part and the checkpoint (cursor + upload state) is persisted.
 *     Cursor only advances in the same save as the bytes it produced, so a crash
 *     between saves re-does that slice rather than duplicating/losing rows.
 *   - When remaining execution time drops below TIME_BUFFER_MS, the unflushed
 *     buffer is persisted and the job re-submits itself (baton-pass). This only
 *     happens BETWEEN events, so an event's rows are never split across a
 *     baton-pass.
 *   - On the last event the remaining buffer is flushed as the final part and
 *     the multipart upload is completed.
 */

const catalyst = require("zcatalyst-sdk-node");
const { getHandler } = require("./handlers");
const {
  loadManifest,
  saveManifest,
  loadCheckpoint,
  saveCheckpoint,
  loadPendingBuffer,
  savePendingBuffer,
  deleteExportArtifacts,
} = require("./checkpoint.js");

/** Stratus multipart requires >=5MB for all non-final parts; keep headroom above that. */
const MIN_FLUSH_BYTES = 8 * 1024 * 1024;

/** Stop processing and baton-pass this many ms before the 15-min Job limit. */
const TIME_BUFFER_MS = 90_000;

const BUCKET_NAME = "upload-data-bucket";

const esc = (s) => String(s ?? "").replace(/'/g, "''");

function csvCell(v) {
  return `"${String(v).replace(/"/g, '""')}"`;
}

function istTimestamp() {
  return (
    new Date(Date.now() + 5.5 * 60 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19) + " IST"
  );
}

async function setJobStatus(zcql, jobName, status) {
  await zcql.executeZCQLQuery(
    `UPDATE Jobs SET status = '${status}' WHERE jobName = '${esc(jobName)}'`,
  );
}

async function ensureJobsRowRunning(zcql, jobName) {
  try {
    await zcql.executeZCQLQuery(
      `INSERT INTO Jobs (jobName, status) VALUES ('${esc(jobName)}', 'RUNNING')`,
    );
  } catch (insertErr) {
    try {
      await zcql.executeZCQLQuery(
        `UPDATE Jobs SET status = 'RUNNING' WHERE jobName = '${esc(jobName)}'`,
      );
    } catch (upErr) {
      console.warn(`[Jobs] ensure RUNNING failed for ${jobName}:`, upErr.message);
    }
  }
}

/**
 * @param {import("./types/job").JobRequest} jobRequest
 * @param {import("./types/job").Context} context
 */
module.exports = async (jobRequest, context) => {
  const catalystApp = catalyst.initialize(context);
  const zcql = catalystApp.zcql();
  const jobScheduling = catalystApp.jobScheduling();
  const bucket = catalystApp.stratus().bucket(BUCKET_NAME);

  let jobName = "";

  try {
    const params = jobRequest.getAllJobParams();
    const { reportType, fromDate, toDate, fileName } = params;
    jobName = params.jobName;

    console.log(
      `CA impact report invocation started: ${jobName} ` +
        `(type=${reportType} ${fromDate}..${toDate})`,
    );

    const handler = getHandler(reportType);
    if (!handler) {
      console.error(`Unknown reportType '${reportType}' — no handler registered`);
      if (jobName) {
        try {
          await setJobStatus(zcql, jobName, "FAILED");
        } catch (_) {}
      }
      context.closeWithFailure();
      return;
    }

    let checkpoint = await loadCheckpoint(bucket, jobName);
    let manifest;
    let buffer;

    if (!checkpoint) {
      /* ---------------- FIRST INVOCATION ---------------- */
      await ensureJobsRowRunning(zcql, jobName);

      manifest = await handler.buildManifest(zcql, fromDate, toDate);

      if (!manifest.length) {
        // No file/multipart upload is created for an empty manifest, so this
        // must stay distinguishable from COMPLETED — otherwise the download
        // endpoint would generate a presigned URL for an object that was
        // never written.
        console.log("No corporate-action events found in range");
        await setJobStatus(zcql, jobName, "NO_DATA");
        context.closeWithSuccess();
        return;
      }

      await saveManifest(bucket, jobName, manifest);

      const initRes = await bucket.initiateMultipartUpload(fileName);
      const uploadId = String(initRes.upload_id);

      checkpoint = {
        reportType: String(reportType).toLowerCase(),
        fromDate: fromDate || "",
        toDate: toDate || "",
        generatedAt: istTimestamp(),
        fileName,
        cursor: 0,
        uploadId,
        nextPartNumber: 1,
        processedCount: 0,
        errorCount: 0,
      };

      buffer = handler.header;

      console.log(
        `CA impact report initialized: ${manifest.length} event(s) ` +
          `type=${checkpoint.reportType} uploadId=${uploadId}`,
      );
    } else {
      /* ---------------- RESUME ---------------- */
      await ensureJobsRowRunning(zcql, jobName);

      manifest = await loadManifest(bucket, jobName);
      if (!manifest) {
        throw new Error(`Manifest missing for job ${jobName} but checkpoint exists`);
      }
      buffer = await loadPendingBuffer(bucket, jobName);

      console.log(
        `CA impact report resumed: cursor=${checkpoint.cursor}/${manifest.length} ` +
          `part=${checkpoint.nextPartNumber} bufferBytes=${Buffer.byteLength(buffer, "utf8")}`,
      );
    }

    let needsRetrigger = false;

    while (checkpoint.cursor < manifest.length) {
      const event = manifest[checkpoint.cursor];
      checkpoint.processedCount++;

      try {
        const text = await handler.buildEventCsv({
          zcql,
          event,
          generatedAt: checkpoint.generatedAt,
          fromDate: checkpoint.fromDate,
          toDate: checkpoint.toDate,
          csvCell,
        });
        buffer += text;
      } catch (eventErr) {
        checkpoint.errorCount++;
        console.error(
          `Error processing event ${checkpoint.cursor + 1}/${manifest.length}:`,
          eventErr.message,
        );
      }

      checkpoint.cursor++;

      const bufferBytes = Buffer.byteLength(buffer, "utf8");
      const isLastEvent = checkpoint.cursor >= manifest.length;

      if (bufferBytes >= MIN_FLUSH_BYTES || isLastEvent) {
        if (bufferBytes > 0) {
          await bucket.uploadPart(
            checkpoint.fileName,
            checkpoint.uploadId,
            Buffer.from(buffer, "utf8"),
            checkpoint.nextPartNumber,
          );
          checkpoint.nextPartNumber++;
          buffer = "";
        }
        await savePendingBuffer(bucket, jobName, "");
        await saveCheckpoint(bucket, jobName, checkpoint);
      }

      if (isLastEvent) break;

      const remainingMs = context.getRemainingExecutionTimeMs();
      if (remainingMs < TIME_BUFFER_MS) {
        needsRetrigger = true;
        await savePendingBuffer(bucket, jobName, buffer);
        await saveCheckpoint(bucket, jobName, checkpoint);
        console.log(
          `CA impact report: ${remainingMs}ms remaining (< ${TIME_BUFFER_MS}ms buffer); ` +
            `baton-pass at cursor=${checkpoint.cursor}/${manifest.length}`,
        );
        break;
      }
    }

    if (needsRetrigger) {
      const submitJobName = `CAR_${Date.now()}`.slice(0, 20);
      await jobScheduling.JOB.submitJob({
        job_name: submitJobName,
        jobpool_name: "Export",
        target_name: "ExportCorpActionReport",
        target_type: "Function",
        params: {
          reportType: checkpoint.reportType,
          fromDate: checkpoint.fromDate,
          toDate: checkpoint.toDate,
          jobName,
          fileName: checkpoint.fileName,
        },
      });
      console.log(`CA impact report baton-passed (${submitJobName})`);
      context.closeWithSuccess();
      return;
    }

    /* ---------------- ALL EVENTS PROCESSED ---------------- */
    await bucket.completeMultipartUpload(checkpoint.fileName, checkpoint.uploadId);

    console.log(
      `CA impact report completed: ${checkpoint.processedCount} event(s), ` +
        `${checkpoint.errorCount} error(s), ${checkpoint.nextPartNumber - 1} part(s)`,
    );

    await deleteExportArtifacts(bucket, jobName);

    try {
      await setJobStatus(zcql, jobName, "COMPLETED");
    } catch (statusErr) {
      console.error(
        "Failed to mark job as COMPLETED (file was uploaded successfully):",
        statusErr,
      );
    }
    context.closeWithSuccess();
  } catch (error) {
    console.error("CA impact report job failed:", error);

    if (jobName) {
      try {
        await setJobStatus(zcql, jobName, "FAILED");
      } catch (updateErr) {
        console.error("Failed to update job status to FAILED:", updateErr);
      }
    }
    context.closeWithFailure();
  }
};
