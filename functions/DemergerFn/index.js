"use strict";

const catalyst = require("zcatalyst-sdk-node");
const { runDemergerApply } = require("./demergerApplyCore.js");
const {
  rebuildHoldingsForAccountList,
} = require("./holdingsRebuildFromSources.js");

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
    });

    console.log("[DemergerFn] Records inserted:", applyResult.recordsInserted);

    if (applyResult.accountsAffected.length > 0) {
      try {
        const rebuildCounters = await rebuildHoldingsForAccountList(
          zcql,
          applyResult.accountsAffected,
          null,
        );
        console.log("[DemergerFn] Holdings rebuild:", rebuildCounters);
      } catch (rbErr) {
        console.error("[DemergerFn] Holdings rebuild failed:", rbErr);
        await setJobStatus(zcql, jobName, "FAILED");
        context.closeWithFailure();
        return;
      }
    }

    console.log(`[DemergerFn] Done in ${Date.now() - startedAt}ms`);
    await setJobStatus(zcql, jobName, "COMPLETED");
    context.closeWithSuccess();
  } catch (error) {
    console.error("[DemergerFn] FATAL:", error);
    await setJobStatus(zcql, jobName, "FAILED");
    context.closeWithFailure();
  }
};
