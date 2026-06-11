import { PassThrough } from "stream";
import { calculateHoldingsSummary } from "./analyticsController.js";
import {
  fetchVirtualCodesByActual,
  consolidateSummaries,
} from "../../../util/analytics/consolidatedHoldings.js";

/**
 * GET /api/export/export-consolidated?actualCode=...&asOnDate=...
 *
 * Consolidated holdings for a single Actual Code. Holdings are stored
 * scheme-wise (per virtual code), so we expand the actual code into its virtual
 * codes, sum the holding per ISIN across them, and emit one row per ISIN.
 * Only the total holding is reported — no WAP / holding value / last price /
 * market value / P&L.
 */
export const exportConsolidatedPerActual = async (req, res) => {
  try {
    const { actualCode, asOnDate } = req.query;

    if (!actualCode) {
      return res.status(400).json({
        message: "actualCode is required for consolidated export",
      });
    }

    const reportDate = asOnDate || new Date().toISOString().split("T")[0];

    const catalystApp = req.catalystApp;
    const zcql = catalystApp.zcql();

    /* ---------------- RESOLVE VIRTUAL CODES ---------------- */
    const virtualCodes = await fetchVirtualCodesByActual(zcql, actualCode);
    if (!virtualCodes.length) {
      return res.status(404).json({
        message: `No virtual codes mapped to actual code ${actualCode}`,
      });
    }

    /* ---------------- FETCH & CONSOLIDATE ---------------- */
    const summaries = [];
    for (const virtualCode of virtualCodes) {
      const rows = await calculateHoldingsSummary({
        catalystApp,
        accountCode: virtualCode,
        asOnDate,
      });
      summaries.push(rows);
    }
    const consolidated = consolidateSummaries(summaries);

    /* ---------------- INIT STREAM ---------------- */
    const stratus = catalystApp.stratus();
    const bucket = stratus.bucket("upload-data-bucket");

    const csvStream = new PassThrough();
    const fileName = `holding-consolidated-${actualCode}-${Date.now()}.csv`;

    const uploadPromise = bucket.putObject(fileName, csvStream, {
      overwrite: true,
      contentType: "text/csv",
    });

    /* ---------------- CSV HEADER (HOLDING ONLY) ---------------- */
    csvStream.write(
      "AS_ON_DATE,ACCOUNT_CODE,SECURITY_NAME,SECURITY_CODE,ISIN,HOLDING\n",
    );

    if (!consolidated.length) {
      csvStream.end();
      await uploadPromise;
      return res.status(404).json({
        message: `No holdings data found for actual code ${actualCode}`,
      });
    }

    /* ---------------- WRITE ROWS ---------------- */
    for (const row of consolidated) {
      const line = [
        reportDate,
        actualCode,
        row.stockName ?? "",
        row.securityCode ?? "",
        row.isin ?? "",
        row.currentHolding ?? "",
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(",");

      csvStream.write(line + "\n");
    }

    csvStream.end();
    await uploadPromise;

    const downloadUrl = await bucket.generatePreSignedUrl(fileName, "GET", {
      expiresIn: 3600,
    });

    return res.status(200).json({
      message: "Consolidated export successful",
      downloadUrl,
    });
  } catch (error) {
    console.error("Consolidated export error:", error);
    return res.status(500).json({
      message: "Internal Server Error",
      error: error.message,
    });
  }
};
