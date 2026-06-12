import {
  escSql,
  fetchAccountsForIsin,
  fifoLotsForIsinOnRecordDate,
} from "../util/merger/mergerEngine.js";

/**
 * Calendar date for DB (no timezone shift). HTML date inputs send yyyy-mm-dd — must not use
 * new Date(s).toISOString() or setHours+toISOString (1 Apr → 31 Mar in IST, etc.).
 */
function toIsoDate(d) {
  if (d == null || d === "") return null;
  const s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normalizeBodyOldIsins(oldCompanies) {
  if (!Array.isArray(oldCompanies)) return [];
  const out = [];
  const seen = new Set();
  for (const c of oldCompanies) {
    const isin = String(c?.isin ?? "")
      .trim()
      .toUpperCase();
    if (!isin || seen.has(isin)) continue;
    seen.add(isin);
    out.push(isin);
  }
  return out;
}

/** Read merge-into fields from JSON (camelCase + common Catalyst-style keys). */
function mergeIntoNewCompanyFields(body) {
  const mic = body?.mergeIntoNewCompany;
  if (!mic || typeof mic !== "object") {
    return { isin: "", securityCode: "", securityName: "" };
  }
  const isin = String(mic.isin ?? mic.ISIN ?? "").trim().toUpperCase();
  const securityCode = String(
    mic.securityCode ?? mic.Security_Code ?? mic.security_code ?? "",
  ).trim();
  const securityName = String(
    mic.securityName ?? mic.Security_Name ?? mic.security_name ?? "",
  ).trim();
  return { isin, securityCode, securityName };
}

/**
 * Lot-level merger preview. One row per surviving FIFO lot (after replay of
 * Transactions / Bonuses / Splits / prior Demergers / prior Mergers up to recordDate).
 *
 * Per-lot rounding mirrors the apply path (functions/MegerFn):
 *   newQty = floor(lotQty × ratio1 ÷ ratio2)
 *   newWAP = lotCost / newQty   (full lot cost preserved on surviving shares)
 *   lots that round to newQty <= 0 are flagged willSkip:true (cost basis lost on apply).
 *
 * @returns {{ ok: true, recordISO, newIsin, oldIsins, r1, r2, preview, meta }
 *          | { ok: false, status: number, body: object }}
 */
async function computeMergerPreview(zcql, body) {
  const { recordDateIso, ratio1, ratio2, oldCompanies } = body || {};
  const r1 = Number(ratio1);
  const r2 = Number(ratio2);
  const recordISO = toIsoDate(recordDateIso);
  const oldIsins = normalizeBodyOldIsins(oldCompanies);
  const { isin: newIsin } = mergeIntoNewCompanyFields(body);

  if (!recordISO) {
    return { ok: false, status: 400, body: { success: false, message: "recordDateIso is required (yyyy-mm-dd)." } };
  }
  if (oldIsins.length !== 1) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        message: "Exactly one old ISIN is required (select or type one security).",
      },
    };
  }
  if (!newIsin) {
    return { ok: false, status: 400, body: { success: false, message: "mergeIntoNewCompany.isin is required." } };
  }
  if (oldIsins[0] === newIsin) {
    return { ok: false, status: 400, body: { success: false, message: "New ISIN must differ from old ISIN." } };
  }
  if (!Number.isFinite(r1) || !Number.isFinite(r2) || r1 <= 0 || r2 <= 0) {
    return {
      ok: false,
      status: 400,
      body: { success: false, message: "ratio1 and ratio2 must be positive numbers." },
    };
  }

  const oldIsin = oldIsins[0];
  const accountSet = await fetchAccountsForIsin(zcql, oldIsin);
  const eligibleAccounts = Array.from(accountSet);
  if (!eligibleAccounts.length) {
    return {
      ok: true,
      recordISO,
      newIsin,
      oldIsins,
      r1,
      r2,
      preview: [],
      meta: {
        recordDateIso: recordISO,
        newIsin,
        oldIsins,
        message: "No accounts with transactions on this old ISIN.",
        accountsAffected: 0,
        survivingLots: 0,
        skippedZeroLots: 0,
        totalNewShares: 0,
        totalCarriedCost: 0,
        skippedCostBasis: 0,
      },
    };
  }

  const lotsForAccount = await fifoLotsForIsinOnRecordDate(zcql, oldIsin, recordISO);
  const preview = [];

  let accountsAffected = 0;
  let survivingLots = 0;
  let skippedZeroLots = 0;
  let totalNewShares = 0;
  let totalCarriedCost = 0;
  let skippedCostBasis = 0;

  for (const accountCode of eligibleAccounts) {
    const openLots = lotsForAccount(accountCode);
    if (!openLots.length) continue;
    accountsAffected += 1;

    for (const lot of openLots) {
      const lotQty = Number(lot.qty) || 0;
      if (lotQty <= 0) continue;
      const lotCost = Number(lot.totalCost) || 0;
      const lotCostPerShare = Number(lot.costPerShare) || 0;

      const newQty = Math.floor((lotQty * r1) / r2);
      const willSkip = newQty <= 0;
      const newWAP = newQty > 0 ? lotCost / newQty : 0;

      if (willSkip) {
        skippedZeroLots += 1;
        skippedCostBasis += lotCost;
      } else {
        survivingLots += 1;
        totalNewShares += newQty;
        totalCarriedCost += lotCost;
      }

      preview.push({
        accountCode,
        oldIsin,
        newIsin,
        ratio1: r1,
        ratio2: r2,
        sourceType: lot.sourceType,
        sourceRowId: lot.sourceRowId,
        lotTrandate: lot.originalTrandate,
        lotQty,
        lotCostPerShare,
        lotCost,
        newQty,
        newWAP,
        willSkip,
      });
    }
  }

  return {
    ok: true,
    recordISO,
    newIsin,
    oldIsins,
    r1,
    r2,
    preview,
    meta: {
      recordDateIso: recordISO,
      newIsin,
      oldIsins,
      accountsAffected,
      survivingLots,
      skippedZeroLots,
      totalNewShares,
      totalCarriedCost,
      skippedCostBasis,
      note:
        "Lot-level: one row per surviving FIFO lot. newQty = floor(lotQty × ratio1 ÷ ratio2). " +
        "Lots with newQty <= 0 are flagged willSkip:true and will not be persisted on apply.",
    },
  };
}

/**
 * POST /api/merger/preview
 * Body: { recordDateIso, ratio1, ratio2, oldCompanies: [{ isin }], mergeIntoNewCompany: { isin, securityName?, securityCode? } }
 * Exactly one old ISIN. Response is **lot-level**: one row per surviving FIFO lot.
 *   - newQty = floor(lotQty × ratio1 ÷ ratio2) (per-lot floor, matches apply)
 *   - newWAP = lotCost ÷ newQty when newQty > 0 (full lot cost preserved)
 *   - willSkip:true when newQty == 0 (cost basis lost on apply, flagged to user)
 */
export const previewMerger = async (req, res) => {
  try {
    if (!req.catalystApp) {
      return res.status(500).json({ success: false, message: "Catalyst app not initialized" });
    }
    const zcql = req.catalystApp.zcql();
    const result = await computeMergerPreview(zcql, req.body);
    if (!result.ok) {
      return res.status(result.status).json(result.body);
    }
    return res.json({
      success: true,
      data: result.preview,
      meta: result.meta,
    });
  } catch (error) {
    console.error("[previewMerger]", error);
    return res.status(500).json({ success: false, message: error.message || "Merger preview failed" });
  }
};

/* =====================================================================
   APPLY (lot-level, background job)
   --------------------------------------------------------------------
   POST /api/merger/apply
     - Validates the merger inputs (same shape as preview).
     - Generates a deterministic jobName from the inputs (idempotency key)
       so the same merger can't be queued twice while one is running.
     - Submits the MegerFn Catalyst function which does the heavy
       lot-level work (FIFO replay → surviving lots → bulk-insert into
       Merger via Stratus + bulkJob), then rebuilds the Holdings table for
       every affected WS_Account_code (same FIFO materialiser as DemergerFn).
     - Responds immediately with { jobName, status: "PENDING" }.

   GET /api/merger/apply-status?jobName=...
     - Reads the Jobs row to surface progress to the React poller.
   ===================================================================== */

const MERGER_STALE_TIMEOUT_MS = 60 * 60 * 1000;

const parseCatalystTime = (ct) => {
  if (!ct) return 0;
  const fixed = String(ct).replace(/:(\d{3})$/, ".$1");
  const ms = new Date(fixed).getTime();
  return Number.isNaN(ms) ? 0 : ms;
};

/** Short, human-readable jobName under the Catalyst 50-char limit. */
function buildMergerJobName(oldIsin, newIsin, recordDateIso) {
  const trim = (s, n) => String(s || "").replace(/[^A-Za-z0-9]/g, "").slice(-n);
  const date = String(recordDateIso || "").replace(/[^\d]/g, "");
  return `MRG_${trim(oldIsin, 6)}_${trim(newIsin, 6)}_${date}`;
}

export const applyMerger = async (req, res) => {
  try {
    if (!req.catalystApp) {
      return res
        .status(500)
        .json({ success: false, message: "Catalyst app not initialized" });
    }

    const zcql = req.catalystApp.zcql();
    const jobScheduling = req.catalystApp.jobScheduling();

    const mic = mergeIntoNewCompanyFields(req.body);
    const newIsin = mic.isin;
    const secCode = mic.securityCode || newIsin;
    const secName = mic.securityName || `Merged ${newIsin}`;

    const oldIsins = normalizeBodyOldIsins(req.body?.oldCompanies);
    const recordISO = toIsoDate(req.body?.recordDateIso);
    const effectiveISO = toIsoDate(req.body?.effectiveDateIso) || recordISO;
    const r1 = Number(req.body?.ratio1);
    const r2 = Number(req.body?.ratio2);

    if (!recordISO) {
      return res.status(400).json({
        success: false,
        message: "recordDateIso is required (yyyy-mm-dd).",
      });
    }
    if (oldIsins.length !== 1) {
      return res.status(400).json({
        success: false,
        message:
          "Exactly one old ISIN is required (select or type one security).",
      });
    }
    if (!newIsin) {
      return res.status(400).json({
        success: false,
        message: "mergeIntoNewCompany.isin is required.",
      });
    }
    if (oldIsins[0] === newIsin) {
      return res
        .status(400)
        .json({ success: false, message: "New ISIN must differ from old ISIN." });
    }
    if (!Number.isFinite(r1) || !Number.isFinite(r2) || r1 <= 0 || r2 <= 0) {
      return res.status(400).json({
        success: false,
        message: "ratio1 and ratio2 must be positive numbers.",
      });
    }

    const oldIsin = oldIsins[0];
    const jobName = buildMergerJobName(oldIsin, newIsin, recordISO);

    const existing = await zcql.executeZCQLQuery(
      `SELECT ROWID, status, CREATEDTIME FROM Jobs WHERE jobName = '${escSql(jobName)}' LIMIT 1`,
    );

    if (existing?.length) {
      const oldStatus = existing[0].Jobs.status;
      const oldRowId = existing[0].Jobs.ROWID;
      const createdTime = existing[0].Jobs.CREATEDTIME;
      const jobAge = Date.now() - parseCatalystTime(createdTime);
      const isStale = jobAge > MERGER_STALE_TIMEOUT_MS;

      if (
        (oldStatus === "PENDING" || oldStatus === "RUNNING") &&
        !isStale
      ) {
        return res.json({
          success: true,
          jobName,
          status: oldStatus,
          message: "Merger application is already in progress",
        });
      }

      try {
        await zcql.executeZCQLQuery(`DELETE FROM Jobs WHERE ROWID = ${oldRowId}`);
      } catch (delErr) {
        console.error("[applyMerger] Error deleting old job row:", delErr);
      }
    }

    await jobScheduling.JOB.submitJob({
      job_name: "ApplyMerger",
      jobpool_name: "CorporateActions",
      target_name: "MegerFn",
      target_type: "Function",
      /* Catalyst Job Pool: retries only run when execution fails. Min interval 1m. */
      job_config: {
        number_of_retries: 5,
        retry_interval: 60 * 1000,
      },
      params: {
        jobName,
        oldIsin,
        newIsin,
        secCode,
        secName,
        ratio1: String(r1),
        ratio2: String(r2),
        recordDateIso: recordISO,
        effectiveDateIso: effectiveISO,
      },
    });

    return res.json({
      success: true,
      jobName,
      status: "PENDING",
      message: "Merger application job started",
    });
  } catch (error) {
    console.error("[applyMerger]", error);
    return res
      .status(500)
      .json({ success: false, message: error.message || "Merger apply failed" });
  }
};

export const getMergerApplyStatus = async (req, res) => {
  try {
    if (!req.catalystApp) {
      return res
        .status(500)
        .json({ success: false, message: "Catalyst app not initialized" });
    }
    const zcql = req.catalystApp.zcql();

    const { jobName } = req.query;
    if (!jobName) {
      return res
        .status(400)
        .json({ success: false, message: "jobName is required" });
    }

    const result = await zcql.executeZCQLQuery(
      `SELECT ROWID, status, CREATEDTIME FROM Jobs WHERE jobName = '${escSql(String(jobName))}' LIMIT 1`,
    );

    if (!result?.length) {
      return res.json({ success: true, status: "NOT_STARTED" });
    }

    let status = result[0].Jobs.status;
    const createdTime = result[0].Jobs.CREATEDTIME;
    const jobAge = Date.now() - parseCatalystTime(createdTime);

    if (
      (status === "PENDING" || status === "RUNNING") &&
      jobAge > MERGER_STALE_TIMEOUT_MS
    ) {
      try {
        await zcql.executeZCQLQuery(
          `UPDATE Jobs SET status = 'ERROR' WHERE jobName = '${escSql(String(jobName))}'`,
        );
        status = "ERROR";
      } catch (updateErr) {
        console.error("[getMergerApplyStatus] Stale-mark failed:", updateErr);
      }
    }

    return res.json({ success: true, status });
  } catch (error) {
    console.error("[getMergerApplyStatus]", error);
    return res
      .status(500)
      .json({ success: false, message: error.message || "Status check failed" });
  }
};
