"use strict";

/**
 * UpdateISIN (Catalyst job) — master / orchestrator. Two modes.
 *
 *   mode = "rename" (default, params: old_isin, new_isin, status_key?)
 *     Does NO renaming itself. It opens a Jobs status row and dispatches one
 *     UpdateISINWorker job, which renames old_isin → new_isin across every
 *     ISIN-bearing table in small, timeout-proof batches (and walks the
 *     merger/demerger old + new ISIN columns). See UpdateISINWorker/index.js.
 *
 *   mode = "apply-new" (params: isin, security_code?, security_name?)
 *     Backs the "New ISIN" Apply panel. Does NO updating itself — it opens a Jobs
 *     status row and dispatches one UpdateISINWorker job (phase = "apply-new"),
 *     which syncs Security_Code / Security_Name for the given ISIN across every
 *     relevant table in small, timeout-proof batches (baton-passed). Per column,
 *     per row: skip if already equal, otherwise (NULL, empty, or different) UPDATE.
 *     If a value param is blank/missing, that column is not touched at all.
 */

const catalyst = require("zcatalyst-sdk-node");

const esc = (v) => String(v ?? "").replace(/'/g, "''");

/** Worker that performs the batched rename / apply, and the pool it runs in. */
const WORKER_TARGET = "UpdateISINWorker";
const WORKER_JOBPOOL = "UpdateMasters";

/** Open (or reset) the Jobs row the worker marks SUCCESS when the rename finishes. */
async function ensureJobsRowRunning(zcql, jobName) {
  if (!jobName) return;
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
      console.warn(`[UpdateISIN] ensure Jobs RUNNING failed for ${jobName}:`, upErr.message);
    }
  }
}

async function runRenameMode(app, zcql, params) {
  const oldIsin = String(params.old_isin ?? "").trim();
  const newIsin = String(params.new_isin ?? "").trim();
  const statusKey = String(params.status_key ?? "").trim();

  console.log(`[UpdateISIN/rename] Dispatching worker: "${oldIsin}" → "${newIsin}"`);

  if (!oldIsin || !newIsin) {
    throw new Error("Parameters old_isin and new_isin are required for rename mode");
  }
  if (oldIsin === newIsin) {
    throw new Error("Old and new ISIN must differ");
  }

  await ensureJobsRowRunning(zcql, statusKey);

  const workerJobName = `IW0_${Date.now()}`.slice(0, 20);
  await app.jobScheduling().JOB.submitJob({
    job_name: workerJobName,
    jobpool_name: WORKER_JOBPOOL,
    target_name: WORKER_TARGET,
    target_type: "Function",
    job_config: { number_of_retries: 5, retry_interval: 60 * 1000 },
    params: {
      old_isin: oldIsin,
      new_isin: newIsin,
      status_key: statusKey,
      target_index: "0",
    },
  });

  console.log(`[UpdateISIN/rename] Worker queued (${workerJobName}) for "${oldIsin}" → "${newIsin}"`);
}

async function runApplyNewMode(app, zcql, params) {
  const isin = String(params.isin ?? "").trim();
  const securityCode = String(params.security_code ?? "").trim();
  const securityName = String(params.security_name ?? "").trim();
  const statusKey = String(params.status_key ?? "").trim();

  console.log(
    `[UpdateISIN/apply-new] Dispatching worker: isin="${isin}" code="${securityCode}" name="${securityName}"`
  );

  if (!isin) {
    throw new Error("Parameter isin is required for apply-new mode");
  }
  if (!securityCode && !securityName) {
    throw new Error(
      "At least one of security_code / security_name must be provided for apply-new mode"
    );
  }

  await ensureJobsRowRunning(zcql, statusKey);

  const workerJobName = `IA0_${Date.now()}`.slice(0, 20);
  await app.jobScheduling().JOB.submitJob({
    job_name: workerJobName,
    jobpool_name: WORKER_JOBPOOL,
    target_name: WORKER_TARGET,
    target_type: "Function",
    job_config: { number_of_retries: 5, retry_interval: 60 * 1000 },
    params: {
      phase: "apply-new",
      isin,
      security_code: securityCode,
      security_name: securityName,
      status_key: statusKey,
      apply_index: "0",
    },
  });

  console.log(`[UpdateISIN/apply-new] Worker queued (${workerJobName}) for isin="${isin}"`);
}

/**
 * @param {import("./types/job").JobRequest} jobRequest
 * @param {import("./types/job").Context} context
 */
module.exports = async (jobRequest, context) => {
  const catalystApp = catalyst.initialize(context);
  const zcql = catalystApp.zcql();

  try {
    const params = jobRequest.getAllJobParams();
    const mode = String(params.mode ?? "rename").trim();

    if (mode === "rename") {
      await runRenameMode(catalystApp, zcql, params);
    } else if (mode === "apply-new") {
      await runApplyNewMode(catalystApp, zcql, params);
    } else {
      throw new Error(`Unknown mode: "${mode}" (expected "rename" or "apply-new")`);
    }

    context.closeWithSuccess();
  } catch (err) {
    console.error("[UpdateISIN] Fatal Error:", err?.message || err);
    context.closeWithFailure();
  }
};
