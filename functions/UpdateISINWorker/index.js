"use strict";

/**
 * UpdateISINWorker (Catalyst Job Function) — timeout-proof ISIN renamer.
 *
 * Renames an ISIN (old → new) across EVERY table that stores it, in small
 * batches, so no single invocation exceeds the 15-minute function timeout.
 *
 * How it survives large tables (Transaction ~10–12 lakh rows):
 *   - Self-draining queue: each batch updates rows OUT of the `WHERE col = old`
 *     set, so the remaining work shrinks on its own — no OFFSET, no row counting.
 *   - Baton pass: when the time budget runs low mid-table, the worker re-submits
 *     itself (same params + the current target index) and exits cleanly. A fresh
 *     invocation resumes exactly where this one stopped.
 *
 * Merger / Demerger tables store TWO ISINs per row (an old side and a new side).
 * The renamed ISIN can sit on either side in different rows, so those tables list
 * BOTH columns and each column is drained independently.
 *
 * Required job params (queued by UpdateISIN master):
 *   - old_isin     : ISIN being replaced
 *   - new_isin     : replacement ISIN (caller guarantees it is fresh / unused)
 *   - status_key   : Jobs.jobName row to mark SUCCESS when fully drained
 * Optional:
 *   - target_index : resume point (set by the baton pass; defaults to 0)
 */

const catalyst = require("zcatalyst-sdk-node");

/* ============================== CONFIG ============================== */

/** Job pool the worker re-submits itself into (same pool the masters use). */
const WORKER_JOBPOOL = "UpdateMasters";

/** This function's own target name (used for the baton-pass re-submit). */
const WORKER_TARGET = "UpdateISINWorker";

/** Rows updated per batch. Sized small so each UPDATE returns quickly. */
const BATCH = 300;

/** Stop and hand off before this elapsed time (< the 15-min function cap). */
const TIME_BUDGET_MS = 12 * 60 * 1000;

/* --- Holdings rebuild (runs after the rename fully completes) --- */
/** Rebuild function + its pool (same wiring the merger/demerger apply use). */
const REBUILD_TARGET = "RebuildHoldingtable";
const REBUILD_JOBPOOL = "CorporateActions";
/** Accounts per rebuild job (matches MegerFn's REBUILD_BATCH). */
const REBUILD_ACCOUNTS_PER_JOB = 400;
/** Page size for scanning Holdings to collect the affected accounts. */
const ACCOUNT_SCAN_PAGE = 270;

/**
 * Every table that stores an ISIN, with the exact column(s) to rename.
 * - Plain tables: one column, "ISIN".
 * - Merger / Merger_Record: "ISIN" (new side) + "OldISIN" (old side).
 * - Demerger: "Old_ISIN" + "New_ISIN" (this table has NO plain "ISIN" column).
 * - Demerger_Record: single "ISIN" column.
 */
const ISIN_TARGETS = [
  { table: "Security_List", cols: ["ISIN"] },
  { table: "Transaction", cols: ["ISIN"] },
  { table: "Bonus", cols: ["ISIN"] },
  { table: "Bonus_Record", cols: ["ISIN"] },
  { table: "Split", cols: ["ISIN"] },
  { table: "Dividend", cols: ["ISIN"] },
  { table: "Dividend_Record", cols: ["ISIN"] },
  { table: "Temp_Transaction", cols: ["ISIN"] },
  { table: "Temp_Custodian", cols: ["ISIN"] },
  { table: "Bhav_Copy", cols: ["ISIN"] },
  { table: "Cash_Balance_Per_Transaction", cols: ["ISIN"] },
  { table: "Holdings", cols: ["ISIN"] },
  { table: "Demerger_Record", cols: ["ISIN"] },
  { table: "Merger", cols: ["ISIN", "OldISIN"] },
  { table: "Merger_Record", cols: ["ISIN", "OldISIN"] },
  { table: "Demerger", cols: ["Old_ISIN", "New_ISIN"] },
];

/* ============================== HELPERS ============================== */

const esc = (v) => String(v ?? "").replace(/'/g, "''");

function getAllParams(jobRequest) {
  try {
    if (jobRequest && typeof jobRequest.getAllJobParams === "function") {
      return jobRequest.getAllJobParams() || {};
    }
  } catch (e) {
    console.warn("[UpdateISINWorker] getAllParams:", e.message);
  }
  return {};
}

/** Read up to BATCH ROWIDs that still carry the old ISIN in this column. */
async function fetchOldRowIds(zcql, table, col, oldSql) {
  const rows = await zcql.executeZCQLQuery(
    `SELECT ROWID FROM ${table} WHERE ${col} = '${oldSql}' LIMIT ${BATCH}`,
  );
  const out = [];
  for (const r of rows || []) {
    const v = (r[table] || r).ROWID;
    if (v != null) out.push(v);
  }
  return out;
}

async function finalizeJobsRow(zcql, jobName, status) {
  if (!jobName) return;
  try {
    await zcql.executeZCQLQuery(
      `UPDATE Jobs SET status = '${esc(status)}' WHERE jobName = '${esc(jobName)}'`,
    );
  } catch (e) {
    console.error(`[UpdateISINWorker] finalize Jobs '${jobName}' failed:`, e.message);
  }
}

/** Re-queue this worker to resume at `targetIndex` (the baton pass). */
async function submitContinuation(app, params, targetIndex, startedAt) {
  const jobName = `IW_${targetIndex}_${startedAt}`.slice(0, 20);
  await app.jobScheduling().JOB.submitJob({
    job_name: jobName,
    jobpool_name: WORKER_JOBPOOL,
    target_name: WORKER_TARGET,
    target_type: "Function",
    job_config: { number_of_retries: 5, retry_interval: 60 * 1000 },
    params: {
      old_isin: params.old_isin,
      new_isin: params.new_isin,
      status_key: params.status_key,
      target_index: String(targetIndex),
    },
  });
}

/**
 * Hand off to a fresh worker that runs phase = "rebuild". Done once the rename
 * is fully complete, so the rebuild gets its own clean 15-min budget instead of
 * sharing the rename's.
 */
async function submitRebuildPhase(app, params, startedAt) {
  const jobName = `IWR_${startedAt}`.slice(0, 20);
  await app.jobScheduling().JOB.submitJob({
    job_name: jobName,
    jobpool_name: WORKER_JOBPOOL,
    target_name: WORKER_TARGET,
    target_type: "Function",
    job_config: { number_of_retries: 5, retry_interval: 60 * 1000 },
    params: {
      phase: "rebuild",
      new_isin: params.new_isin,
      status_key: params.status_key,
    },
  });
}

/** Distinct accounts that hold the (now renamed) ISIN — the rebuild scope. */
async function collectAccountsForIsin(zcql, isinSql) {
  const accounts = new Set();
  let offset = 0;
  while (true) {
    const rows = await zcql.executeZCQLQuery(
      `SELECT WS_Account_code FROM Holdings WHERE ISIN = '${isinSql}'
       ORDER BY ROWID ASC LIMIT ${ACCOUNT_SCAN_PAGE} OFFSET ${offset}`,
    );
    if (!rows?.length) break;
    for (const r of rows) {
      const acc = String((r.Holdings || r).WS_Account_code ?? "").trim();
      if (acc) accounts.add(acc);
    }
    if (rows.length < ACCOUNT_SCAN_PAGE) break;
    offset += ACCOUNT_SCAN_PAGE;
  }
  return [...accounts];
}

/**
 * phase = "rebuild": recompute Holdings for the new ISIN across every account
 * that holds it, by dispatching scoped RebuildHoldingtable jobs (batched).
 * Marks the Jobs status row SUCCESS once the rebuild jobs are queued.
 */
async function runRebuildPhase(app, zcql, newIsin, statusKey) {
  const isinSql = esc(newIsin);
  const accounts = await collectAccountsForIsin(zcql, isinSql);

  console.log(`[UpdateISINWorker/rebuild] ${accounts.length} account(s) for "${newIsin}"`);

  if (accounts.length === 0) {
    // Nothing holds it (e.g. only closed positions) — rename already relabelled
    // any rows; there is nothing to recompute.
    await finalizeJobsRow(zcql, statusKey, "SUCCESS");
    return;
  }

  const scheduling = app.jobScheduling();
  for (let i = 0; i < accounts.length; i += REBUILD_ACCOUNTS_PER_JOB) {
    const chunk = accounts.slice(i, i + REBUILD_ACCOUNTS_PER_JOB);
    const jobName = `HRB_${i}_${Date.now()}`.slice(0, 20);
    await scheduling.JOB.submitJob({
      job_name: jobName,
      jobpool_name: REBUILD_JOBPOOL,
      target_name: REBUILD_TARGET,
      target_type: "Function",
      job_config: { number_of_retries: 5, retry_interval: 60 * 1000 },
      params: {
        accountCodesJson: JSON.stringify(chunk),
        isinsJson: JSON.stringify([newIsin]),
        source: "UpdateISIN",
      },
    });
  }

  await finalizeJobsRow(zcql, statusKey, "SUCCESS");
}

/* ============================== ENTRY ============================== */

module.exports = async (jobRequest, context) => {
  const app = catalyst.initialize(context);
  const zcql = app.zcql();
  const startedAt = Date.now();

  try {
    const p = getAllParams(jobRequest);
    const phase = String(p.phase ?? "rename").trim();
    const oldIsin = String(p.old_isin ?? "").trim();
    const newIsin = String(p.new_isin ?? "").trim();
    const statusKey = String(p.status_key ?? "").trim();
    const startIndex = Math.max(0, Number(p.target_index ?? 0) || 0);

    // Phase 2: rebuild Holdings for the new ISIN (own fresh budget).
    if (phase === "rebuild") {
      if (!newIsin) {
        console.error("[UpdateISINWorker/rebuild] new_isin is required.");
        context.closeWithFailure();
        return;
      }
      await runRebuildPhase(app, zcql, newIsin, statusKey);
      context.closeWithSuccess();
      return;
    }

    if (!oldIsin || !newIsin) {
      console.error("[UpdateISINWorker] old_isin and new_isin are required.");
      context.closeWithFailure();
      return;
    }
    if (oldIsin === newIsin) {
      console.error("[UpdateISINWorker] old and new ISIN must differ.");
      context.closeWithFailure();
      return;
    }

    const oldSql = esc(oldIsin);
    const newSql = esc(newIsin);

    console.log(
      `[UpdateISINWorker] "${oldIsin}" → "${newIsin}" | resume at target ${startIndex}`,
    );

    let totalUpdated = 0;

    for (let i = startIndex; i < ISIN_TARGETS.length; i++) {
      const { table, cols } = ISIN_TARGETS[i];

      for (const col of cols) {
        // Drain this column batch-by-batch until no old-ISIN rows remain.
        while (true) {
          // Hand off before the timeout; resume this same target next time.
          if (Date.now() - startedAt > TIME_BUDGET_MS) {
            console.log(
              `[UpdateISINWorker] time budget hit at ${table}.${col} ` +
                `(updated ${totalUpdated} so far) — passing baton at target ${i}.`,
            );
            await submitContinuation(app, p, i, startedAt);
            context.closeWithSuccess();
            return;
          }

          let ids;
          try {
            ids = await fetchOldRowIds(zcql, table, col, oldSql);
          } catch (e) {
            // Column/table not present or query error — log and skip this column.
            console.warn(`[UpdateISINWorker] select ${table}.${col} skipped:`, e.message);
            break;
          }

          if (ids.length === 0) break; // this column is fully renamed

          try {
            await zcql.executeZCQLQuery(
              `UPDATE ${table} SET ${col} = '${newSql}' WHERE ROWID IN (${ids.join(",")})`,
            );
            totalUpdated += ids.length;
          } catch (e) {
            // Break (not continue) so a failing UPDATE can't spin forever.
            console.warn(`[UpdateISINWorker] update ${table}.${col} failed:`, e.message);
            break;
          }
        }

        console.log(`[UpdateISINWorker] drained ${table}.${col}`);
      }
    }

    // Rename fully done. Hand off to the rebuild phase (it marks Jobs SUCCESS),
    // so Holdings is recomputed for the new ISIN from the now-corrected sources.
    console.log(
      `[UpdateISINWorker] rename DONE "${oldIsin}" → "${newIsin}" | ${totalUpdated} row(s) ` +
        `in ${Date.now() - startedAt}ms — dispatching rebuild phase.`,
    );
    await submitRebuildPhase(app, p, startedAt);
    context.closeWithSuccess();
  } catch (err) {
    console.error("[UpdateISINWorker] Fatal:", err?.message || err);
    context.closeWithFailure();
  }
};
