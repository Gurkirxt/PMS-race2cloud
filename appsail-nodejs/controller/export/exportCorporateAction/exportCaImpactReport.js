// appsail-nodejs/controller/export/exportCorporateAction/exportCaImpactReport.js
//
// Corporate-action impact report — per-client impact across ALL ISINs for one
// action type over a date range. Mirrors the async job pattern in
// exportHolding/ExportAllHolding.js (submit job → poll status → signed-URL
// download); the heavy work runs in the baton-passing Catalyst function
// `ExportCorpActionReport` (functions/ExportCorpActionReport).
//
// Generalized by a `type` query param so bonus/dividend/merger/demerger reports
// reuse these exact endpoints once their handlers are registered in the function.

const BUCKET_NAME = "upload-data-bucket";
const STALE_TIMEOUT_MS = 60 * 60 * 1000;

// Report types that have a handler registered in the Catalyst function's
// handlers/ registry. Keep in sync as new handlers are added.
const SUPPORTED_TYPES = new Set(["split", "bonus", "dividend", "merger", "demerger"]);

const parseCatalystTime = (ct) => {
  if (!ct) return 0;
  // Catalyst CREATEDTIME is an IST (UTC+05:30) wall-clock string like
  // "2026-06-19 17:41:28:675". Parse explicitly as IST so the AppSail server's
  // own timezone (UTC) doesn't shift it +5:30.
  const iso = String(ct).trim().replace(" ", "T").replace(/:(\d{3})$/, ".$1");
  const ms = new Date(`${iso}+05:30`).getTime();
  return isNaN(ms) ? 0 : ms;
};

const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "").trim());

/** Query param → yyyy-mm-dd; returns null when not a valid date. */
function toIsoDateParam(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (isIsoDate(s)) return s;
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().split("T")[0];
}

const esc = (s) => String(s ?? "").replace(/'/g, "''");

const normType = (t) => String(t || "").trim().toLowerCase();

/** Stable job key (Jobs row + Stratus artifact prefix) for a (type, from, to). */
const jobNameFor = (type, from, to) =>
  `CARPT_${normType(type).toUpperCase()}_${from}_${to}`;

/** Output CSV object key on the bucket. */
const fileNameFor = (type, from, to) =>
  `ca-impact-${normType(type)}-${from}_${to}.csv`;

/** Resolve + validate the common (type, fromISO, toISO) inputs from the query. */
function resolveParams(req) {
  const type = normType(req.query.type);
  if (!type) return { error: "type is required" };
  if (!SUPPORTED_TYPES.has(type)) {
    return {
      error: `Unsupported report type '${type}'. Supported: ${[...SUPPORTED_TYPES].join(", ")}`,
    };
  }

  const fromISO = toIsoDateParam(req.query.fromDate);
  const toISO = toIsoDateParam(req.query.toDate);
  if (!fromISO || !toISO) {
    return { error: "fromDate and toDate are required and must be valid dates (yyyy-mm-dd)" };
  }
  if (fromISO > toISO) {
    return { error: "fromDate must be less than or equal to toDate" };
  }

  return { type, fromISO, toISO };
}

/* ============================================================
   START — submit (or reuse) the report job
   ============================================================ */
export const startCaImpactReport = async (req, res) => {
  try {
    if (!req.catalystApp) {
      return res.status(500).json({ success: false, message: "Catalyst not initialized" });
    }

    const { type, fromISO, toISO, error } = resolveParams(req);
    if (error) return res.status(400).json({ success: false, message: error });

    const catalystApp = req.catalystApp;
    const zcql = catalystApp.zcql();
    const jobScheduling = catalystApp.jobScheduling();

    const jobName = jobNameFor(type, fromISO, toISO);
    const fileName = fileNameFor(type, fromISO, toISO);

    const existing = await zcql.executeZCQLQuery(
      `SELECT ROWID, status, CREATEDTIME FROM Jobs WHERE jobName = '${esc(jobName)}' LIMIT 1`,
    );

    if (existing.length) {
      const oldStatus = existing[0].Jobs.status;
      const oldRowId = existing[0].Jobs.ROWID;
      const createdTime = existing[0].Jobs.CREATEDTIME;
      const isStale = Date.now() - parseCatalystTime(createdTime) > STALE_TIMEOUT_MS;

      // Still running and not stale → don't launch a duplicate.
      if ((oldStatus === "PENDING" || oldStatus === "RUNNING") && !isStale) {
        return res.json({
          success: true,
          jobName,
          fileName,
          type,
          fromDate: fromISO,
          toDate: toISO,
          status: oldStatus,
          message: "Report is already being generated for this type and date range",
        });
      }

      // COMPLETED / FAILED / stale → clear the old job, output file, and baton
      // artifacts so a fresh run starts clean.
      try {
        await zcql.executeZCQLQuery(`DELETE FROM Jobs WHERE ROWID = ${oldRowId}`);
      } catch (delErr) {
        console.error("CA report: error deleting old job:", delErr);
      }
      try {
        const bucket = catalystApp.stratus().bucket(BUCKET_NAME);
        const keys = [
          fileName,
          `exports-meta/${jobName}-manifest.json`,
          `exports-meta/${jobName}-checkpoint.json`,
          `exports-meta/${jobName}-pending.csv`,
        ];
        for (const key of keys) {
          try {
            await bucket.deleteObject(key);
          } catch (_) {
            /* object may not exist */
          }
        }
      } catch (stratusErr) {
        console.error("CA report: error clearing old artifacts:", stratusErr);
      }
    }

    await jobScheduling.JOB.submitJob({
      job_name: "CorpActReport",
      jobpool_name: "Export",
      target_name: "ExportCorpActionReport",
      target_type: "Function",
      params: {
        reportType: type,
        fromDate: fromISO,
        toDate: toISO,
        jobName,
        fileName,
      },
    });

    return res.json({
      success: true,
      jobName,
      fileName,
      type,
      fromDate: fromISO,
      toDate: toISO,
      status: "PENDING",
      message: "Report generation started",
    });
  } catch (err) {
    console.error("START CA IMPACT REPORT ERROR:", err);
    return res.status(500).json({ success: false, message: err.message || "Internal server error" });
  }
};

/* ============================================================
   STATUS — poll the Jobs row
   ============================================================ */
export const getCaImpactStatus = async (req, res) => {
  try {
    if (!req.catalystApp) {
      return res.status(500).json({ success: false, message: "Catalyst not initialized" });
    }

    const { type, fromISO, toISO, error } = resolveParams(req);
    if (error) return res.status(400).json({ success: false, message: error });

    const zcql = req.catalystApp.zcql();
    const jobName = jobNameFor(type, fromISO, toISO);

    const result = await zcql.executeZCQLQuery(
      `SELECT ROWID, status, CREATEDTIME FROM Jobs WHERE jobName = '${esc(jobName)}' LIMIT 1`,
    );

    if (!result.length) {
      return res.json({ success: true, jobName, status: "NOT_STARTED" });
    }

    let status = result[0].Jobs.status;
    const createdTime = result[0].Jobs.CREATEDTIME;

    if (
      (status === "PENDING" || status === "RUNNING") &&
      Date.now() - parseCatalystTime(createdTime) > STALE_TIMEOUT_MS
    ) {
      try {
        await zcql.executeZCQLQuery(
          `UPDATE Jobs SET status = 'ERROR' WHERE jobName = '${esc(jobName)}'`,
        );
      } catch (updateErr) {
        console.error("CA report: failed to mark stale job as ERROR:", updateErr);
      }
      status = "ERROR";
    }

    return res.json({ success: true, jobName, status });
  } catch (err) {
    console.error("CA IMPACT REPORT STATUS ERROR:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch report status" });
  }
};

/* ============================================================
   HISTORY — last N jobs for a given report type
   ============================================================ */
export const getCaImpactHistory = async (req, res) => {
  try {
    if (!req.catalystApp) {
      return res.status(500).json([]);
    }

    const type = normType(req.query.type);
    if (!SUPPORTED_TYPES.has(type)) {
      return res.status(400).json([]);
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 20);
    const zcql = req.catalystApp.zcql();
    const prefix = `CARPT_${type.toUpperCase()}_`;

    const rows = await zcql.executeZCQLQuery(
      `SELECT jobName, status, CREATEDTIME FROM Jobs WHERE jobName LIKE '${esc(prefix)}*' ORDER BY ROWID DESC LIMIT ${limit}`
    );

    const now = Date.now();
    const jobs = [];

    for (const row of rows) {
      const jobName = row.Jobs.jobName;
      let status = row.Jobs.status;
      const createdAtMs = parseCatalystTime(row.Jobs.CREATEDTIME);

      // jobName shape: CARPT_<TYPE>_<fromISO>_<toISO>
      const rest = jobName.startsWith(prefix) ? jobName.slice(prefix.length) : jobName;
      const [fromDate = "", toDate = ""] = rest.split("_");

      if ((status === "PENDING" || status === "RUNNING") && now - createdAtMs > STALE_TIMEOUT_MS) {
        try {
          await zcql.executeZCQLQuery(
            `UPDATE Jobs SET status = 'ERROR' WHERE jobName = '${esc(jobName)}'`
          );
        } catch (updateErr) {
          console.error(`Failed to mark stale job ${jobName} as ERROR:`, updateErr);
        }
        status = "ERROR";
      }

      jobs.push({
        jobName,
        fromDate,
        toDate,
        status,
        createdAt: createdAtMs > 0 ? new Date(createdAtMs).toISOString() : new Date().toISOString(),
      });
    }

    return res.json(jobs);
  } catch (err) {
    console.error("CA IMPACT REPORT HISTORY ERROR:", err);
    return res.status(500).json([]);
  }
};

/* ============================================================
   DOWNLOAD — signed URL once COMPLETED
   ============================================================ */
export const downloadCaImpactReport = async (req, res) => {
  try {
    if (!req.catalystApp) {
      return res.status(500).json({ success: false, message: "Catalyst not initialized" });
    }

    const { type, fromISO, toISO, error } = resolveParams(req);
    if (error) return res.status(400).json({ success: false, message: error });

    const catalystApp = req.catalystApp;
    const zcql = catalystApp.zcql();

    const jobName = jobNameFor(type, fromISO, toISO);
    const fileName = fileNameFor(type, fromISO, toISO);

    const job = await zcql.executeZCQLQuery(
      `SELECT status FROM Jobs WHERE jobName = '${esc(jobName)}' LIMIT 1`,
    );

    const jobStatus = job.length ? job[0].Jobs.status : null;

    if (jobStatus === "NO_DATA") {
      return res.json({
        success: true,
        status: "NO_DATA",
        message: "No corporate action records found for the selected period",
      });
    }

    if (jobStatus !== "COMPLETED") {
      return res.status(400).json({
        success: false,
        status: "NOT_READY",
        message: "Report not completed yet",
      });
    }

    const bucket = catalystApp.stratus().bucket(BUCKET_NAME);

    // Belt-and-suspenders: a job row can be stuck as COMPLETED from before the
    // NO_DATA status existed (or any other case where the file never got
    // written), which would otherwise hand back a presigned URL for an object
    // that 404s. Confirm the object exists first so the UI can fall back to
    // the "no data" message instead of a dead link.
    const exists = await bucket.headObject(fileName, { throwErr: false });
    if (!exists) {
      return res.json({
        success: true,
        status: "NO_DATA",
        message: "No corporate action records found for the selected period",
      });
    }

    const downloadUrl = await bucket.generatePreSignedUrl(fileName, "GET", {
      expiresIn: 3600,
    });

    return res.json({ success: true, status: "READY", fileName, downloadUrl });
  } catch (err) {
    console.error("CA IMPACT REPORT DOWNLOAD ERROR:", err);
    return res.status(404).json({
      success: false,
      status: "NOT_FOUND",
      message: "File not found or not ready yet",
    });
  }
};
