"use strict";

/**
 * ExportAllCustomerHoldingData — baton-passed "Export All Clients" holdings CSV.
 *
 * Rewritten from a single monolithic execution (whole CSV in memory, one final
 * putObject) to a checkpointed, self-requeuing job: Catalyst Jobs have a hard
 * 15-minute execution limit, and with thousands of client accounts a single
 * pass no longer fits.
 *
 * Flow:
 *   - First invocation snapshots the work list (clients or actual-code groups)
 *     to Stratus once (`checkpoint.js` manifest), so a moving `clientIds` table
 *     doesn't shift indexes across resumes, and initiates a Stratus multipart
 *     upload for the target file.
 *   - Each entry's CSV rows are appended to an in-memory buffer; once the
 *     buffer reaches MIN_FLUSH_BYTES it's uploaded as a multipart part and the
 *     checkpoint (cursor + upload state) is persisted — cursor only ever
 *     advances in the same save as the bytes it produced, so a crash between
 *     saves just re-does that slice of work rather than duplicating or losing
 *     rows already durably written.
 *   - When remaining execution time drops below TIME_BUFFER_MS, any unflushed
 *     buffer is persisted to a pending-buffer object, the checkpoint is saved,
 *     and the job re-submits itself (baton-pass) with the same params.
 *   - On the last entry, the remaining buffer is flushed as the final part
 *     (no minimum size) and the multipart upload is completed.
 */

const catalyst = require("zcatalyst-sdk-node");
const {
  getAllAccountCodesFromDatabase,
  getAccountActualMapFromDatabase,
  getVirtualToActualMapFromDatabase,
} = require("./allAccountCodes.js");
const { calculateHoldingsSummary } = require("./analyticsController.js");
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

const esc = (s) => String(s ?? "").replace(/'/g, "''");

const CONSOLIDATED_HEADER =
  "GENERATED_AT,AS_ON_DATE,ACCOUNT_CODE,SECURITY_NAME,SECURITY_CODE,ISIN,HOLDING\n";
const SCHEME_HEADER =
  "GENERATED_AT,AS_ON_DATE,CODE,ACTUAL_CODE,SECURITY_NAME,SECURITY_CODE,ISIN,HOLDING,WAP,HOLDING_VALUE,LAST_PRICE,MARKET_VALUE\n";

function csvCell(v) {
  return `"${String(v).replace(/"/g, '""')}"`;
}

function buildConsolidatedRow(generatedAt, reportDate, actualCode, row) {
  return (
    [
      generatedAt,
      reportDate,
      actualCode,
      row.stockName ?? "",
      row.securityCode ?? "",
      row.isin ?? "",
      row.currentHolding ?? "",
    ]
      .map(csvCell)
      .join(",") + "\n"
  );
}

function buildSchemeRow(generatedAt, reportDate, accountCode, actualCode, row) {
  return (
    [
      generatedAt,
      reportDate,
      accountCode,
      actualCode,
      row.stockName ?? "",
      row.securityCode ?? "",
      row.isin ?? "",
      row.currentHolding ?? "",
      row.avgPrice ?? "",
      row.holdingValue ?? "",
      row.lastPrice ?? "",
      row.marketValue ?? "",
    ]
      .map(csvCell)
      .join(",") + "\n"
  );
}

async function ensureJobsRowRunning(zcql, jobName) {
  try {
    await zcql.executeZCQLQuery(
      `INSERT INTO Jobs (jobName, status) VALUES ('${esc(jobName)}', 'RUNNING')`
    );
  } catch (insertErr) {
    try {
      await zcql.executeZCQLQuery(
        `UPDATE Jobs SET status = 'RUNNING' WHERE jobName = '${esc(jobName)}'`
      );
    } catch (upErr) {
      console.warn(`[Jobs] ensure RUNNING failed for ${jobName}:`, upErr.message);
    }
  }
}

/** Consolidated: sum HOLDING per ISIN across a group's virtual codes -> CSV text for that group. */
async function buildConsolidatedGroupCsv({
  catalystApp,
  group,
  asOnDate,
  generatedAt,
  reportDate,
  sharedPriceMap,
}) {
  const { actualCode, virtualCodes } = group;
  const byIsin = new Map();

  for (const virtualCode of virtualCodes) {
    const rows = await calculateHoldingsSummary({
      catalystApp,
      accountCode: virtualCode,
      asOnDate,
      sharedPriceMap,
    });
    if (!Array.isArray(rows)) continue;

    for (const row of rows) {
      const isin = row.isin;
      if (!isin) continue;
      const hold = Number(row.currentHolding) || 0;
      const existing = byIsin.get(isin);
      if (existing) {
        existing.currentHolding += hold;
      } else {
        byIsin.set(isin, {
          isin,
          stockName: row.stockName || isin,
          securityCode: row.securityCode || "",
          currentHolding: hold,
        });
      }
    }
  }

  const merged = [...byIsin.values()].sort((a, b) =>
    (a.stockName || "").localeCompare(b.stockName || "")
  );

  let text = "";
  for (const row of merged) {
    text += buildConsolidatedRow(generatedAt, reportDate, actualCode, row);
  }
  return text;
}

/** Scheme-wise: one client's holdings -> CSV text for that client. */
async function buildSchemeClientCsv({
  catalystApp,
  entry,
  asOnDate,
  generatedAt,
  reportDate,
  sharedPriceMap,
}) {
  const { accountCode, actualCode } = entry;
  const rows = await calculateHoldingsSummary({
    catalystApp,
    accountCode,
    asOnDate,
    sharedPriceMap,
  });
  if (!Array.isArray(rows) || !rows.length) return "";

  let text = "";
  for (const row of rows) {
    text += buildSchemeRow(generatedAt, reportDate, accountCode, actualCode, row);
  }
  return text;
}

/**
 * @param {import("./types/job").JobRequest} jobRequest
 * @param {import("./types/job").Context} context
 */
module.exports = async (jobRequest, context) => {
  const catalystApp = catalyst.initialize(context);
  const zcql = catalystApp.zcql();
  const jobScheduling = catalystApp.jobScheduling();
  const bucket = catalystApp.stratus().bucket("upload-data-bucket");

  let jobName = "";

  try {
    const jobDetails = jobRequest.getAllJobParams();
    const { asOnDate, fileName } = jobDetails;
    jobName = jobDetails.jobName;
    const consolidated = String(jobDetails.mode || "").toLowerCase() === "consolidated";

    console.log(`Export job invocation started: ${jobName}`);

    let checkpoint = await loadCheckpoint(bucket, jobName);
    let manifest;
    let buffer;

    if (!checkpoint) {
      /* ---------------- FIRST INVOCATION ---------------- */
      await ensureJobsRowRunning(zcql, jobName);

      const reportDate = asOnDate || new Date().toISOString().split("T")[0];
      const generatedAt =
        new Date(Date.now() + 5.5 * 60 * 60 * 1000)
          .toISOString()
          .replace("T", " ")
          .slice(0, 19) + " IST";

      const tableName = "clientIds";

      if (consolidated) {
        manifest = await getAccountActualMapFromDatabase(zcql, tableName);
      } else {
        const clientIds = await getAllAccountCodesFromDatabase(zcql, tableName);
        const actualByCode = await getVirtualToActualMapFromDatabase(zcql, tableName);
        manifest = clientIds.map((c) => {
          const accountCode = c.clientIds.WS_Account_code;
          return {
            accountCode,
            actualCode: actualByCode.get(String(accountCode).trim()) || "",
          };
        });
      }

      if (!manifest.length) {
        console.log("No clients found");
        await zcql.executeZCQLQuery(
          `UPDATE Jobs SET status = 'COMPLETED' WHERE jobName = '${esc(jobName)}'`
        );
        context.closeWithSuccess();
        return;
      }

      await saveManifest(bucket, jobName, manifest);

      const initRes = await bucket.initiateMultipartUpload(fileName);
      const uploadId = String(initRes.upload_id);

      checkpoint = {
        mode: consolidated ? "consolidated" : "scheme",
        asOnDate: asOnDate || "",
        reportDate,
        generatedAt,
        fileName,
        cursor: 0,
        uploadId,
        nextPartNumber: 1,
        priceMap: {},
        processedCount: 0,
        errorCount: 0,
      };

      buffer = consolidated ? CONSOLIDATED_HEADER : SCHEME_HEADER;

      console.log(
        `Export job initialized: ${manifest.length} ${consolidated ? "group(s)" : "client(s)"} ` +
          `mode=${checkpoint.mode} uploadId=${uploadId}`
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
        `Export job resumed: cursor=${checkpoint.cursor}/${manifest.length} ` +
          `part=${checkpoint.nextPartNumber} bufferBytes=${Buffer.byteLength(buffer, "utf8")}`
      );
    }

    const consolidatedMode = checkpoint.mode === "consolidated";
    let needsRetrigger = false;

    while (checkpoint.cursor < manifest.length) {
      const entry = manifest[checkpoint.cursor];
      checkpoint.processedCount++;

      try {
        const text = consolidatedMode
          ? await buildConsolidatedGroupCsv({
              catalystApp,
              group: entry,
              asOnDate: checkpoint.asOnDate,
              generatedAt: checkpoint.generatedAt,
              reportDate: checkpoint.reportDate,
              sharedPriceMap: checkpoint.priceMap,
            })
          : await buildSchemeClientCsv({
              catalystApp,
              entry,
              asOnDate: checkpoint.asOnDate,
              generatedAt: checkpoint.generatedAt,
              reportDate: checkpoint.reportDate,
              sharedPriceMap: checkpoint.priceMap,
            });
        buffer += text;
      } catch (entryErr) {
        checkpoint.errorCount++;
        console.error(
          `Error processing ${consolidatedMode ? "group" : "client"} ` +
            `${checkpoint.cursor + 1}/${manifest.length}:`,
          entryErr.message
        );
      }

      checkpoint.cursor++;

      const bufferBytes = Buffer.byteLength(buffer, "utf8");
      const isLastEntry = checkpoint.cursor >= manifest.length;

      if (bufferBytes >= MIN_FLUSH_BYTES || isLastEntry) {
        if (bufferBytes > 0) {
          await bucket.uploadPart(
            checkpoint.fileName,
            checkpoint.uploadId,
            Buffer.from(buffer, "utf8"),
            checkpoint.nextPartNumber
          );
          checkpoint.nextPartNumber++;
          buffer = "";
        }
        await savePendingBuffer(bucket, jobName, "");
        await saveCheckpoint(bucket, jobName, checkpoint);
      }

      if (isLastEntry) break;

      const remainingMs = context.getRemainingExecutionTimeMs();
      if (remainingMs < TIME_BUFFER_MS) {
        needsRetrigger = true;
        await savePendingBuffer(bucket, jobName, buffer);
        await saveCheckpoint(bucket, jobName, checkpoint);
        console.log(
          `Export job: ${remainingMs}ms remaining (< ${TIME_BUFFER_MS}ms buffer); ` +
            `baton-pass at cursor=${checkpoint.cursor}/${manifest.length}`
        );
        break;
      }
    }

    if (needsRetrigger) {
      const submitJobName = `EA_${Date.now()}`.slice(0, 20);
      await jobScheduling.JOB.submitJob({
        job_name: submitJobName,
        jobpool_name: "Export",
        target_name: "ExportAllCustomerHoldingData",
        target_type: "Function",
        params: {
          asOnDate: checkpoint.asOnDate,
          jobName,
          fileName: checkpoint.fileName,
          mode: checkpoint.mode,
        },
      });
      console.log(`Export job baton-passed (${submitJobName})`);
      context.closeWithSuccess();
      return;
    }

    /* ---------------- ALL ENTRIES PROCESSED ---------------- */
    await bucket.completeMultipartUpload(checkpoint.fileName, checkpoint.uploadId);

    console.log(
      `Export job completed: ${checkpoint.processedCount} processed, ` +
        `${checkpoint.errorCount} error(s), ${checkpoint.nextPartNumber - 1} part(s)`
    );

    await deleteExportArtifacts(bucket, jobName);

    try {
      await zcql.executeZCQLQuery(
        `UPDATE Jobs SET status = 'COMPLETED' WHERE jobName = '${esc(jobName)}'`
      );
    } catch (statusErr) {
      console.error(
        "Failed to mark job as COMPLETED (file was uploaded successfully):",
        statusErr
      );
    }
    context.closeWithSuccess();
  } catch (error) {
    console.error("Export job failed:", error);

    if (jobName) {
      try {
        await zcql.executeZCQLQuery(
          `UPDATE Jobs SET status = 'FAILED' WHERE jobName = '${esc(jobName)}'`
        );
      } catch (updateErr) {
        console.error("Failed to update job status to FAILED:", updateErr);
      }
    }
    context.closeWithFailure();
  }
};
