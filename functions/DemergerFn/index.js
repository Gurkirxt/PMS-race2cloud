"use strict";

const catalyst = require("zcatalyst-sdk-node");
const { runDemergerApply, DEMERGER_JOB_TYPE_DEFAULT } = require("./demergerApplyCore.js");

const REBUILD_BATCH = 400;

async function queueRebuildHoldingsJobs(catalystApp, accountCodes, source, isins) {
  const uniq = [...new Set(accountCodes)]
    .map((a) => String(a || "").trim())
    .filter(Boolean);
  if (!uniq.length) return;

  /* Scope the rebuild to the ISIN(s) this demerger touched (old + new).
     Without this the downstream RebuildHoldingtable re-derives EVERY ISIN for
     EVERY account, which blows past the 15-min Catalyst timeout on a large book. */
  const scopedIsins = [...new Set(isins || [])]
    .map((i) => String(i || "").trim().toUpperCase())
    .filter(Boolean);

  const scheduling = catalystApp.jobScheduling();
  for (let i = 0; i < uniq.length; i += REBUILD_BATCH) {
    const chunk = uniq.slice(i, i + REBUILD_BATCH);
    const catalystJobName = `H${Date.now()}${i}`.slice(0, 20);
    await scheduling.JOB.submitJob({
      job_name: catalystJobName,
      jobpool_name: "CorporateActions",
      target_name: "RebuildHoldingtable",
      target_type: "Function",
      /* Catalyst Job Pool: retries only on execution failure. Min interval 1m. */
      job_config: {
        number_of_retries: 5,
        retry_interval: 60 * 1000,
      },
      params: {
        accountCodesJson: JSON.stringify(chunk),
        source,
        ...(scopedIsins.length
          ? { isinsJson: JSON.stringify(scopedIsins) }
          : {}),
      },
    });
  }
}

const esc = (v) => String(v ?? "").replace(/'/g, "''");

async function setJobStatus(zcql, jobName, status) {
  if (!jobName) return;
  try {
    await zcql.executeZCQLQuery(
      `UPDATE Jobs SET status = '${esc(status)}' WHERE jobName = '${esc(jobName)}'`,
    );
  } catch (err) {
    console.error(`[DemergerFn] Failed to set status ${status}:`, err.message);
  }
}

module.exports = async (jobRequest, context) => {
  const catalystApp = catalyst.initialize(context);
  const zcql = catalystApp.zcql();

  let jobName = "";
  const startedAt = Date.now();

  try {
    const params = jobRequest.getAllJobParams();
    jobName = String(params.jobName || "").trim();
    const demergerJobType =
      String(params.jobType || "").trim() || DEMERGER_JOB_TYPE_DEFAULT;

    const oldIsin = String(params.oldIsin || "").trim();
    const newIsin = String(params.newIsin || "").trim();
    const oldSecurityCode = String(params.oldSecurityCode || "").trim();
    const oldSecurityName = String(params.oldSecurityName || "").trim();
    const newSecurityCode = String(params.newSecurityCode || "").trim();
    const newSecurityName = String(params.newSecurityName || "").trim();
    const r1 = Number(params.ratio1 ?? params.r1);
    const r2 = Number(params.ratio2 ?? params.r2);
    const pct = Number(params.allocationPct ?? params.allocationToNewPercent);
    const effectiveDateISO = String(params.effectiveDateIso || "").trim();
    const recordDateISO = String(params.recordDateIso || "").trim();

    console.log("[DemergerFn] Started", {
      jobName,
      demergerJobType,
      jobStatusTracking: Boolean(jobName),
      oldIsin,
      newIsin,
      r1,
      r2,
      pct,
      effectiveDateISO,
      recordDateISO,
    });

    try {
      await zcql.executeZCQLQuery(
        `INSERT INTO Jobs (jobName, status) VALUES ('${esc(jobName)}', 'RUNNING')`,
      );
    } catch (insertErr) {
      console.warn(
        "[DemergerFn] Jobs insert failed (may exist):",
        insertErr.message,
      );
      await setJobStatus(zcql, jobName, "RUNNING");
    }

    if (
      !jobName ||
      !oldIsin ||
      !newIsin ||
      oldIsin === newIsin ||
      !oldSecurityCode ||
      !oldSecurityName ||
      !newSecurityCode ||
      !newSecurityName ||
      !Number.isFinite(r1) ||
      r1 <= 0 ||
      !Number.isFinite(r2) ||
      r2 <= 0 ||
      !Number.isFinite(pct) ||
      pct < 0 ||
      pct > 100 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDateISO) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(recordDateISO)
    ) {
      console.error("[DemergerFn] Invalid params");
      await setJobStatus(zcql, jobName, "FAILED");
      context.closeWithFailure();
      return;
    }

    const applyResult = await runDemergerApply(zcql, {
      oldIsin,
      oldSecurityCode,
      oldSecurityName,
      newIsin,
      newSecurityCode,
      newSecurityName,
      r1,
      r2,
      pct,
      effectiveDateISO,
      recordDateISO,
      jobTracking: {
        enabled: Boolean(jobName),
        jobName,
        jobType: demergerJobType,
      },
    });

    console.log("[DemergerFn] Records inserted:", applyResult.recordsInserted);
    if (applyResult.trackingFailures > 0) {
      console.warn(
        `[DemergerFn] ${applyResult.trackingFailures} account(s) FAILED — check JobStatusPerAccount`,
      );
    }

    if (applyResult.accountsAffected.length > 0) {
      try {
        await queueRebuildHoldingsJobs(
          catalystApp,
          applyResult.accountsAffected,
          "DemergerFn",
          [oldIsin, newIsin],
        );
        console.log(
          "[DemergerFn] Queued RebuildHoldingtable for",
          applyResult.accountsAffected.length,
          "account(s)",
        );
      } catch (rbErr) {
        console.error("[DemergerFn] Queue holdings rebuild failed:", rbErr);
        await setJobStatus(zcql, jobName, "FAILED");
        context.closeWithFailure();
        return;
      }
    }

    console.log(`[DemergerFn] Done in ${Date.now() - startedAt}ms`);
    await setJobStatus(
      zcql,
      jobName,
      applyResult.trackingFailures > 0 ? "FAILED" : "COMPLETED",
    );
    context.closeWithSuccess();
  } catch (error) {
    console.error("[DemergerFn] FATAL:", error);
    await setJobStatus(zcql, jobName, "FAILED");
    context.closeWithFailure();
  }
};
