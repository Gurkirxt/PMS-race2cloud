import { buildVirtualToActualMap } from "../util/mapVirtualToActualCodes.js";

const ZCQL_ROW_LIMIT = 270;
const HOLDINGS_BATCH  = 250;

const parseCatalystTime = (ct) => {
  if (!ct) return 0;
  const fixed = ct.replace(/:(\d{3})$/, ".$1");
  const ms = new Date(fixed).getTime();
  return isNaN(ms) ? 0 : ms;
};

/* ======================================================
   GET ALL SECURITIES
   ====================================================== */
export const getAllSecuritiesISINs = async (req, res) => {
  try {
    if (!req.catalystApp) {
      return res.status(500).json({
        success: false,
        message: "Catalyst app not initialized",
      });
    }

    const zcql = req.catalystApp.zcql();
    const LIMIT = 270;
    let offset = 0;
    const securities = [];

    while (true) {
      const rows = await zcql.executeZCQLQuery(`
        SELECT ISIN, Security_Code, Security_Name
        FROM Security_List
        WHERE ISIN IS NOT NULL
        LIMIT ${LIMIT} OFFSET ${offset}
      `);

      if (!rows || rows.length === 0) break;

      rows.forEach((r) => {
        const s = r.Security_List;
        securities.push({
          isin: s.ISIN,
          securityCode: s.Security_Code,
          securityName: s.Security_Name,
        });
      });

      offset += LIMIT;
    }

    return res.json({ success: true, data: securities });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/* ======================================================
   PREVIEW BONUS (HOLDINGS TABLE – DATE AWARE)
   ====================================================== */
export const previewStockBonus = async (req, res) => {
  try {
    if (!req.catalystApp) {
      return res.status(500).json({
        success: false,
        message: "Catalyst app not initialized",
      });
    }

    const { isin, ratio1, ratio2, exDate } = req.body;

    const r1 = Number(ratio1);
    const r2 = Number(ratio2);

    if (!isin || !exDate || !Number.isFinite(r1) || !Number.isFinite(r2) || r1 <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid ISIN, ratio or date",
      });
    }

    const exDateObj = new Date(exDate);
    exDateObj.setHours(0, 0, 0, 0);
    const exDateISO = exDateObj.toISOString().split("T")[0];

    // cutoff = day AFTER exDate for the date filter
    const cutoffObj = new Date(exDateISO);
    cutoffObj.setDate(cutoffObj.getDate() + 1);
    const cutoff = cutoffObj.toISOString().split("T")[0];

    const zcql = req.catalystApp.zcql();

    /* ======================================================
       STEP 1: READ Holdings AS OF exDate
       Fetch all Holdings rows for this ISIN with date filter.
       Walk in FIFO order (CREATEDTIME ASC, ROWID ASC) and keep
       updating per account — last row per account = state on exDate.
       ====================================================== */
    const latestByAccount = new Map(); // accountCode → last Holdings row
    let offset = 0;

    while (true) {
      const batch = await zcql.executeZCQLQuery(`
        SELECT WS_Account_code, HOLDING, WAP, HOLDING_VALUE,
               SETTLEMENT_DATE, TRANSACTION_DATE
        FROM Holdings
        WHERE ISIN = '${isin}'
          AND (SETTLEMENT_DATE < '${cutoff}' OR TRANSACTION_DATE < '${cutoff}')
        ORDER BY CREATEDTIME ASC, ROWID ASC
        LIMIT ${HOLDINGS_BATCH} OFFSET ${offset}
      `);

      if (!batch || batch.length === 0) break;

      for (const row of batch) {
        const h = row.Holdings || row;
        const acc = String(h.WS_Account_code || "").trim();
        if (!acc) continue;
        latestByAccount.set(acc, h); // last row per account wins
      }

      if (batch.length < HOLDINGS_BATCH) break;
      offset += HOLDINGS_BATCH;
    }

    if (latestByAccount.size === 0) {
      return res.json({ success: true, data: [] });
    }

    /* ======================================================
       STEP 2: CALCULATE BONUS PREVIEW (simple arithmetic)
       Holdings table already has HOLDING, WAP, HOLDING_VALUE
       computed by FIFO. No need to re-run FIFO engine.
       ====================================================== */
    const virtualToActual = await buildVirtualToActualMap(
      zcql,
      [...latestByAccount.keys()],
    );
    const preview = [];

    for (const [accountCode, h] of latestByAccount) {
      const currentHolding = Number(h.HOLDING) || 0;
      if (currentHolding <= 0) continue; // fully sold before exDate

      const holdingValue = Number(h.HOLDING_VALUE) || 0;
      const currentWAP   = Number(h.WAP) || 0;

      // Bonus shares = floor(currentHolding × ratio1 / ratio2)
      const bonusShares = Math.floor((currentHolding * r1) / r2);
      if (bonusShares <= 0) continue;

      const newHolding = currentHolding + bonusShares;

      // Cost is unchanged — more shares at same total cost → WAP goes down
      const newWAP = newHolding > 0
        ? Math.round((holdingValue / newHolding) * 100) / 100
        : 0;

      preview.push({
        isin,
        accountCode, // WS_Account_code (virtual)
        actualCode: virtualToActual.get(accountCode) || "",
        currentHolding,
        currentWAP,
        holdingValue,
        bonusShares,
        newHolding,
        newWAP,
        delta: bonusShares,
      });
    }

    return res.json({ success: true, data: preview });
  } catch (error) {
    console.error("Preview bonus error:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/* ======================================================
   APPLY BONUS (BACKGROUND JOB)
   ====================================================== */
export const applyStockBonus = async (req, res) => {
  try {
    if (!req.catalystApp) {
      return res.status(500).json({
        success: false,
        message: "Catalyst app not initialized",
      });
    }

    const {
      isin,
      ratio1,
      ratio2,
      exDate,
      securityCode: bodySecurityCode,
      securityName: bodySecurityName,
    } = req.body;

    const r1 = Number(ratio1);
    const r2 = Number(ratio2);

    if (!isin || !exDate || !Number.isFinite(r1) || !Number.isFinite(r2) || r1 <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid input values",
      });
    }

    const exDateObj = new Date(exDate);
    exDateObj.setHours(0, 0, 0, 0);
    const exDateISO = exDateObj.toISOString().split("T")[0];

    const catalystApp = req.catalystApp;
    const zcql = catalystApp.zcql();
    const jobScheduling = catalystApp.jobScheduling();

    const jobName = `BON_${isin.slice(-6)}_${exDateISO}`;

    const existing = await zcql.executeZCQLQuery(
      `SELECT ROWID, status, CREATEDTIME FROM Jobs WHERE jobName = '${jobName}' LIMIT 1`
    );

    if (existing.length) {
      const oldStatus = existing[0].Jobs.status;
      const oldRowId = existing[0].Jobs.ROWID;
      const createdTime = existing[0].Jobs.CREATEDTIME;

      const STALE_TIMEOUT_MS = 60 * 60 * 1000;
      const jobAge = Date.now() - parseCatalystTime(createdTime);
      const isStale = jobAge > STALE_TIMEOUT_MS;

      if ((oldStatus === "PENDING" || oldStatus === "RUNNING") && !isStale) {
        return res.json({
          success: true,
          jobName,
          status: oldStatus,
          message: "Bonus application is already in progress",
        });
      }

      try {
        await zcql.executeZCQLQuery(`DELETE FROM Jobs WHERE ROWID = ${oldRowId}`);
      } catch (delErr) {
        console.error("Error deleting old bonus job:", delErr);
      }
    }

    await jobScheduling.JOB.submitJob({
      job_name: "ApplyBonus",
      jobpool_name: "CorporateActions",
      target_name: "UpdateBonusTable",
      target_type: "Function",
      /* Catalyst Job Pool: retries only run when execution fails. Min interval 1m. */
      job_config: {
        number_of_retries: 5,
        retry_interval: 60 * 1000,
      },
      params: {
        isin,
        ratio1: String(r1),
        ratio2: String(r2),
        exDate: exDateISO,
        secCode: bodySecurityCode || "",
        secName: bodySecurityName || "",
        jobName,
      },
    });

    return res.json({
      success: true,
      jobName,
      status: "PENDING",
      message: "Bonus application job started",
    });
  } catch (error) {
    console.error("Apply bonus error:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/* ======================================================
   GET BONUS APPLY JOB STATUS
   ====================================================== */
export const getBonusApplyStatus = async (req, res) => {
  try {
    const catalystApp = req.catalystApp;
    const zcql = catalystApp.zcql();

    const { jobName } = req.query;
    if (!jobName) {
      return res.status(400).json({ success: false, message: "jobName is required" });
    }

    const result = await zcql.executeZCQLQuery(
      `SELECT ROWID, status, CREATEDTIME FROM Jobs WHERE jobName = '${jobName}' LIMIT 1`
    );

    if (!result.length) {
      return res.json({ success: true, status: "NOT_STARTED" });
    }

    let status = result[0].Jobs.status;
    const createdTime = result[0].Jobs.CREATEDTIME;

    const STALE_TIMEOUT_MS = 60 * 60 * 1000;
    const jobAge = Date.now() - parseCatalystTime(createdTime);

    if ((status === "PENDING" || status === "RUNNING") && jobAge > STALE_TIMEOUT_MS) {
      try {
        await zcql.executeZCQLQuery(
          `UPDATE Jobs SET status = 'ERROR' WHERE jobName = '${jobName}'`
        );
      } catch (updateErr) {
        console.error("Failed to mark stale bonus job as ERROR:", updateErr);
      }
      status = "ERROR";
    }

    return res.json({ success: true, jobName, status });
  } catch (error) {
    console.error("Error fetching bonus job status:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch bonus job status",
    });
  }
};
