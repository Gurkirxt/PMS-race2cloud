/**
 * Demerger controller — lot-level (line-by-line) implementation.
 *
 * Source of truth for surviving lots is the materialized `Holdings` table
 * (normally maintained by `functions/CalculateHoldingPerAccount`). We walk Holdings rows
 * for each (account, oldIsin) pair to derive each surviving FIFO lot, then
 * compute per-lot demerger math:
 *
 *   For each surviving lot:
 *     oldRetainedQty   = lot.qty                                  (unchanged)
 *     oldRetainedCost  = lot.qty * lot.price * (1 - pct/100)
 *     oldRetainedWAP   = oldRetainedCost / lot.qty
 *     newQty           = floor(lot.qty * r1 / r2)
 *     newCost          = lot.qty * lot.price * (pct/100)
 *     newWAP           = newCost / newQty
 *
 * Apply step writes:
 *   1 row in `Demerger`        (header — single row per demerger event)
 *   1 row in `Security_List`   (idempotent — new ISIN registered)
 *   N×2 rows in `Demerger_Record` (per surviving lot: old-side + new-side)
 *
 * Each Demerger_Record row carries `Source_Tran_ROWID` linking back to the
 * source Holdings ROWID — enables traceability + lossless re-computation.
 *
 * APPLY queues background job `DemergerFn`: inserts Demerger / Security_List /
 * Demerger_Record then queues `RebuildHoldingtable` for affected accounts so
 * Holdings is refreshed (`functions/RebuildHoldingtable/`).
 */

import { HOLDINGS_FIFO_ORDER_BY_SQL } from "../../util/analytics/holdingsFromTable.js";

const ZCQL_ROW_LIMIT = 270;

const escSql = (s) => String(s ?? "").replace(/'/g, "''");

const round = (n, d = 2) => {
  const f = Math.pow(10, d);
  return Math.round(Number(n || 0) * f) / f;
};

const isBuyType = (t) => /^BY-|SQB|OPI/i.test(String(t || ""));
const isSellType = (t) => /^SL\+|SQS|OPO|NF-/i.test(String(t || ""));
const upperEq = (a, b) => String(a || "").trim().toUpperCase() === b;

/* ====================================================================
   FETCH: distinct accounts holding the old ISIN (from Holdings)
   ==================================================================== */
async function fetchAccountsHoldingIsin(zcql, isin) {
  const accounts = new Set();
  let offset = 0;
  while (true) {
    const batch = await zcql.executeZCQLQuery(`
      SELECT WS_Account_code FROM Holdings
      WHERE ISIN = '${escSql(isin)}'
      ORDER BY ROWID ASC
      LIMIT ${ZCQL_ROW_LIMIT} OFFSET ${offset}
    `);
    if (!batch || batch.length === 0) break;
    for (const r of batch) {
      const h = r.Holdings || r;
      const code = String(h.WS_Account_code ?? "").trim();
      if (code) accounts.add(code);
    }
    if (batch.length < ZCQL_ROW_LIMIT) break;
    offset += ZCQL_ROW_LIMIT;
  }
  return [...accounts].sort((a, b) => a.localeCompare(b));
}

/* ====================================================================
   FETCH: all Holdings rows for one (account, ISIN) ≤ recordDate
   ==================================================================== */
async function fetchHoldingRowsForPair(zcql, accountCode, isin, recordDateISO) {
  const rows = [];
  let offset = 0;
  while (true) {
    const batch = await zcql.executeZCQLQuery(`
      SELECT ROWID, TRANSACTION_DATE, SETTLEMENT_DATE, TYPE, ISIN,
             QUANTITY, PRICE, TOTAL_AMOUNT, HOLDING, WAP, HOLDING_VALUE, STATUS, CREATEDTIME
      FROM Holdings
      WHERE WS_Account_code = '${escSql(accountCode)}'
        AND ISIN = '${escSql(isin)}'
        AND SETTLEMENT_DATE <= '${recordDateISO}'
      ORDER BY ${HOLDINGS_FIFO_ORDER_BY_SQL}
      LIMIT ${ZCQL_ROW_LIMIT} OFFSET ${offset}
    `);
    if (!batch || batch.length === 0) break;
    for (const r of batch) rows.push(r.Holdings || r);
    if (batch.length < ZCQL_ROW_LIMIT) break;
    offset += ZCQL_ROW_LIMIT;
  }
  return rows;
}

/* ====================================================================
   MINI-FIFO over Holdings rows → surviving lots
   --------------------------------------------------------------------
   Each Holdings row represents one FIFO event already materialized.
   We walk rows in **`CREATEDTIME` / fifo materialisation order** (same as
   `HOLDINGS_FIFO_ORDER_BY_SQL`) to derive each surviving lot's surviving qty
   (Holdings rows alone do not carry surviving-qty after partial sells).
   ==================================================================== */
function computeSurvivingLotsFromHoldingRows(rows) {
  let queue = []; // { qty, price, buyDate, sourceRowId, sourceType }
  let lastReplaceEventKey = null;

  for (const row of rows) {
    const type = String(row.TYPE || "").trim();
    const qty = Number(row.QUANTITY || 0);
    const price = Number(row.PRICE || 0);
    const buyDate = row.TRANSACTION_DATE || row.SETTLEMENT_DATE || null;
    const sourceRowId = String(row.ROWID || "");

    if (isBuyType(type)) {
      if (qty > 0) {
        queue.push({ qty, price, buyDate, sourceRowId, sourceType: type });
      }
      continue;
    }

    if (upperEq(type, "BONUS")) {
      if (qty > 0) {
        queue.push({ qty, price: 0, buyDate, sourceRowId, sourceType: "BONUS" });
      }
      continue;
    }

    if (isSellType(type)) {
      let remaining = qty;
      while (remaining > 0 && queue.length) {
        const lot = queue[0];
        const used = Math.min(lot.qty, remaining);
        lot.qty -= used;
        remaining -= used;
        if (lot.qty <= 0) queue.shift();
      }
      continue;
    }

    if (upperEq(type, "SPLIT") || upperEq(type, "MERGER") || upperEq(type, "DEMERGER")) {
      // SPLIT / MERGER / DEMERGER each produce one Holdings row per resulting lot.
      // The first row of a new event wipes the prior queue; subsequent rows of the
      // SAME event are added additively (one per resulting lot).
      const eventKey = `${buyDate}|${type}`;
      if (lastReplaceEventKey !== eventKey) {
        queue = [];
        lastReplaceEventKey = eventKey;
      }
      if (qty > 0) {
        queue.push({ qty, price, buyDate, sourceRowId, sourceType: type });
      }
      continue;
    }
    // Other types (e.g. DIV+) have no holding effect — ignore.
  }

  return queue.filter((lot) => lot.qty > 0);
}

/* ====================================================================
   LOT-LEVEL DEMERGER MATH for one account
   ==================================================================== */
function buildLotLevelDemergerForAccount({
  accountCode,
  lots,
  oldIsin,
  newIsin,
  r1,
  r2,
  pct,
}) {
  const out = [];
  for (const lot of lots) {
    const Q1 = Number(lot.qty) || 0;
    if (Q1 <= 0) continue;

    const lotPrice = Number(lot.price) || 0;
    const lotCost = Q1 * lotPrice;

    const Q2 = Math.floor((Q1 * r1) / r2);
    const newCost = lotCost * (pct / 100);
    const oldCost = lotCost - newCost;

    const oldWapAfter = Q1 > 0 ? oldCost / Q1 : 0;
    const newWap = Q2 > 0 ? newCost / Q2 : 0;

    out.push({
      accountCode,
      oldIsin,
      sourceLotRowId: lot.sourceRowId,
      sourceLotDate: lot.buyDate,
      sourceLotType: lot.sourceType,
      oldQty: Q1,
      oldWapBefore: round(lotPrice, 4),
      oldWapAfter: round(oldWapAfter, 4),
      oldCostAfter: round(oldCost, 2),
      newIsin,
      newQty: Q2,
      newWap: round(newWap, 4),
      newCost: round(newCost, 2),
    });
  }
  return out;
}

/* ====================================================================
   INPUT VALIDATION (shared by preview + apply)
   ==================================================================== */
function validateDemergerInputs(body, requireApplyFields) {
  const {
    oldIsin,
    newIsin,
    ratio1,
    ratio2,
    effectiveDate,
    recordDate,
    allocationToNewPercent,
  } = body;

  const r1 = Number(ratio1);
  const r2 = Number(ratio2);
  const pct = Number(allocationToNewPercent);

  if (
    !oldIsin ||
    !newIsin ||
    oldIsin === newIsin ||
    !effectiveDate ||
    !recordDate ||
    !Number.isFinite(r1) || r1 <= 0 ||
    !Number.isFinite(r2) || r2 <= 0 ||
    !Number.isFinite(pct) || pct < 0 || pct > 100
  ) {
    return { error: "Invalid input: check ISINs, ratio, dates and allocation %" };
  }

  if (requireApplyFields) {
    const { oldSecurityCode, oldSecurityName, newSecurityCode, newSecurityName } = body;
    if (!oldSecurityCode || !oldSecurityName || !newSecurityCode || !newSecurityName) {
      return { error: "Missing required fields (security code/name)" };
    }
  }

  return {
    r1,
    r2,
    pct,
    effectiveDateISO: new Date(effectiveDate).toISOString().split("T")[0],
    recordDateISO: new Date(recordDate).toISOString().split("T")[0],
  };
}

/* ====================================================================
   PREVIEW (lot-level)
   ==================================================================== */
export const previewDemerger = async (req, res) => {
  try {
    if (!req.catalystApp) {
      return res.status(500).json({
        success: false,
        message: "Catalyst app not initialized",
      });
    }

    const v = validateDemergerInputs(req.body, false);
    if (v.error) return res.status(400).json({ success: false, message: v.error });

    const { oldIsin, newIsin } = req.body;
    const { r1, r2, pct, recordDateISO } = v;
    const zcql = req.catalystApp.zcql();

    const accounts = await fetchAccountsHoldingIsin(zcql, oldIsin);
    if (!accounts.length) return res.json({ success: true, data: [] });

    const preview = [];
    let accountsWithSurvivingLots = 0;
    let totalLots = 0;

    for (const accountCode of accounts) {
      const rows = await fetchHoldingRowsForPair(zcql, accountCode, oldIsin, recordDateISO);
      if (!rows.length) continue;

      const lots = computeSurvivingLotsFromHoldingRows(rows);
      if (!lots.length) continue;

      const accountPreview = buildLotLevelDemergerForAccount({
        accountCode,
        lots,
        oldIsin,
        newIsin,
        r1,
        r2,
        pct,
      });

      if (accountPreview.length) {
        accountsWithSurvivingLots++;
        totalLots += accountPreview.length;
        preview.push(...accountPreview);
      }
    }

    return res.json({
      success: true,
      data: preview,
      summary: {
        accounts: accountsWithSurvivingLots,
        lots: totalLots,
      },
    });
  } catch (error) {
    console.error("Preview demerger error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const DEMERGER_STALE_TIMEOUT_MS = 60 * 60 * 1000;

const parseCatalystTime = (ct) => {
  if (!ct) return 0;
  const fixed = String(ct).replace(/:(\d{3})$/, ".$1");
  const ms = new Date(fixed).getTime();
  return Number.isNaN(ms) ? 0 : ms;
};

/** Deterministic jobName under Catalyst ~50-char limit (matches merger pattern). */
function buildDemergerJobName(oldIsin, newIsin, recordDateIso) {
  const trim = (s, n) => String(s || "").replace(/[^A-Za-z0-9]/g, "").slice(-n);
  const date = String(recordDateIso || "").replace(/[^\d]/g, "");
  return `DMG_${trim(oldIsin, 6)}_${trim(newIsin, 6)}_${date}`;
}

/* ====================================================================
   APPLY → queue Catalyst job `DemergerFn`
   ==================================================================== */
export const applyDemerger = async (req, res) => {
  try {
    if (!req.catalystApp) {
      return res.status(500).json({
        success: false,
        message: "Catalyst app not initialized",
      });
    }

    const v = validateDemergerInputs(req.body, true);
    if (v.error) return res.status(400).json({ success: false, message: v.error });

    const {
      oldIsin,
      oldSecurityCode,
      oldSecurityName,
      newIsin,
      newSecurityCode,
      newSecurityName,
    } = req.body;
    const { r1, r2, pct, effectiveDateISO, recordDateISO } = v;

    const zcql = req.catalystApp.zcql();
    const jobScheduling = req.catalystApp.jobScheduling();

    const jobName = buildDemergerJobName(oldIsin, newIsin, recordDateISO);

    const existing = await zcql.executeZCQLQuery(`
      SELECT ROWID, status, CREATEDTIME FROM Jobs WHERE jobName = '${escSql(jobName)}' LIMIT 1
    `);

    if (existing?.length) {
      const oldStatus = existing[0].Jobs.status;
      const oldRowId = existing[0].Jobs.ROWID;
      const createdTime = existing[0].Jobs.CREATEDTIME;
      const jobAge = Date.now() - parseCatalystTime(createdTime);
      const isStale = jobAge > DEMERGER_STALE_TIMEOUT_MS;

      if (
        (oldStatus === "PENDING" || oldStatus === "RUNNING") &&
        !isStale
      ) {
        return res.json({
          success: true,
          jobName,
          status: oldStatus,
          message: "Demerger application is already in progress",
        });
      }

      try {
        await zcql.executeZCQLQuery(`DELETE FROM Jobs WHERE ROWID = ${oldRowId}`);
      } catch (delErr) {
        console.error("[applyDemerger] Error deleting old job row:", delErr);
      }
    }

    await jobScheduling.JOB.submitJob({
      job_name: "ApplyDemerger",
      jobpool_name: "CorporateActions",
      target_name: "DemergerFn",
      target_type: "Function",
      /* Catalyst Job Pool: retries only run when execution fails. Min interval 1m. */
      job_config: {
        number_of_retries: 5,
        retry_interval: 60 * 1000,
      },
      params: {
        jobName,
        oldIsin,
        oldSecurityCode,
        oldSecurityName,
        newIsin,
        newSecurityCode,
        newSecurityName,
        ratio1: String(r1),
        ratio2: String(r2),
        allocationPct: String(pct),
        effectiveDateIso: effectiveDateISO,
        recordDateIso: recordDateISO,
      },
    });

    return res.json({
      success: true,
      jobName,
      status: "PENDING",
      message: "Demerger application job started",
    });
  } catch (error) {
    console.error("Error in applyDemerger:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to queue demerger apply",
    });
  }
};

export const getDemergerApplyStatus = async (req, res) => {
  try {
    if (!req.catalystApp) {
      return res.status(500).json({
        success: false,
        message: "Catalyst app not initialized",
      });
    }
    const zcql = req.catalystApp.zcql();

    const { jobName } = req.query;
    if (!jobName) {
      return res.status(400).json({
        success: false,
        message: "jobName is required",
      });
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
      jobAge > DEMERGER_STALE_TIMEOUT_MS
    ) {
      try {
        await zcql.executeZCQLQuery(
          `UPDATE Jobs SET status = 'ERROR' WHERE jobName = '${escSql(String(jobName))}'`,
        );
        status = "ERROR";
      } catch (updateErr) {
        console.error("[getDemergerApplyStatus] Stale-mark failed:", updateErr);
      }
    }

    return res.json({ success: true, status });
  } catch (error) {
    console.error("[getDemergerApplyStatus]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Status check failed",
    });
  }
};
