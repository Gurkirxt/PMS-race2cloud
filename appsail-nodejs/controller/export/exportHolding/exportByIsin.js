import { PassThrough } from "stream";
import { calculateHoldingsByIsin } from "../../analytics/tabs/holding/AnalyticsControllers.js";
import { reportTimestamp } from "../../../util/reportTimestamp.js";

/**
 * GET /api/export/export-by-isin?isin=...&asOnDate=...
 *
 * Same cross-account ISIN report as Analytics Holding → ISIN mode:
 * one row per virtual account holding the ISIN, with Actual Code + qty/WAP/values.
 */
export const exportHoldingsByIsin = async (req, res) => {
  try {
    const isin = String(req.query.isin ?? "").trim();
    const asOnDate = req.query.asOnDate;

    if (!isin) {
      return res.status(400).json({ message: "isin is required for ISIN export" });
    }

    const reportDate = asOnDate || new Date().toISOString().split("T")[0];
    const generatedAt = reportTimestamp();

    const catalystApp = req.catalystApp;
    if (!catalystApp) {
      return res.status(500).json({ message: "Catalyst app not initialized" });
    }

    const rows = await calculateHoldingsByIsin({
      catalystApp,
      isin,
      asOnDate,
    });

    if (!Array.isArray(rows) || !rows.length) {
      return res.status(404).json({
        message: `No accounts hold ISIN ${isin}`,
      });
    }

    const stratus = catalystApp.stratus();
    const bucket = stratus.bucket("upload-data-bucket");
    const csvStream = new PassThrough();
    const safeIsin = isin.replace(/[^A-Za-z0-9_-]/g, "_");
    const fileName = `holding-isin-${safeIsin}-${Date.now()}.csv`;

    const uploadPromise = bucket.putObject(fileName, csvStream, {
      overwrite: true,
      contentType: "text/csv",
    });

    csvStream.write(
      "GENERATED_AT,AS_ON_DATE,VIRTUAL_CODE,ACTUAL_CODE,SECURITY_NAME,SECURITY_CODE,ISIN,QUANTITY,WAP,HOLDING_VALUE,LAST_PRICE,MARKET_VALUE\n",
    );

    for (const row of rows) {
      const line = [
        generatedAt,
        reportDate,
        row.virtualCode ?? "",
        row.actualCode ?? "",
        row.stockName ?? "",
        row.securityCode ?? "",
        row.isin ?? isin,
        row.currentHolding ?? "",
        row.avgPrice ?? "",
        row.holdingValue ?? "",
        row.lastPrice ?? "",
        row.marketValue ?? "",
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
      message: "ISIN holdings export successful",
      downloadUrl,
    });
  } catch (error) {
    console.error("ISIN holdings export error:", error);
    return res.status(500).json({
      message: "Internal Server Error",
      error: error.message,
    });
  }
};
