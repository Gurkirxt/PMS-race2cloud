import { PassThrough } from "stream";
import { calculateHoldingsSummary } from "./analyticsController.js";
import { reportTimestamp } from "../../../util/reportTimestamp.js";

export const exportDataPerAccount = async (req, res) => {
  try {
    /* ---------------- VALIDATION ---------------- */
    const { accountCode, asOnDate } = req.query;

    if (!accountCode) {
      return res.status(400).json({
        message: "accountCode is required for single client export",
      });
    }

    // Report date stamped on every row. Blank As On Date → today (matches the
    // pricing fallback in calculateHoldingsSummary).
    const reportDate = asOnDate || new Date().toISOString().split("T")[0];
    // When this report was generated (IST), stamped on every row.
    const generatedAt = reportTimestamp();

    /* ---------------- INIT ---------------- */
    const catalystApp = req.catalystApp;
    const stratus = catalystApp.stratus();
    const bucket = stratus.bucket("upload-data-bucket");
    const bucketDetails = await bucket.getDetails();

    /* ---------------- CREATE STREAM ---------------- */
    const csvStream = new PassThrough();
    const fileName = `holding-export-${accountCode}-${Date.now()}.csv`;

    const uploadPromise = bucket.putObject(fileName, csvStream, {
      overwrite: true,
      contentType: "text/csv",
    });

    /* ---------------- CSV HEADER ---------------- */
    csvStream.write(
      "GENERATED_AT,AS_ON_DATE,ACCOUNT_CODE,SECURITY_NAME,SECURITY_CODE,ISIN,HOLDING,WAP,HOLDING_VALUE,LAST_PRICE,MARKET_VALUE\n"
    );

    /* ---------------- FETCH DATA (SINGLE CLIENT) ---------------- */
    console.log(`Exporting holdings for accountCode: ${accountCode}`);

    const rows = await calculateHoldingsSummary({
      catalystApp,
      accountCode,
      asOnDate,
    });

    if (!Array.isArray(rows) || !rows.length) {
      csvStream.end();
      await uploadPromise;

      return res.status(404).json({
        message: `No holdings data found for accountCode ${accountCode}`,
      });
    }

    /* ---------------- WRITE CSV ROWS ---------------- */
    for (const row of rows) {
      const line = [
        generatedAt,
        reportDate,
        accountCode,
        row.stockName ?? "",
        row.securityCode ?? "",
        row.isin ?? "",
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

    /* ---------------- CLOSE STREAM ---------------- */
    csvStream.end();
    await uploadPromise;
    const downloadUrl = await bucket.generatePreSignedUrl(fileName, "GET", {
      expiresIn: 3600, // 1 hour
    });

    return res.status(200).json({
      message: "Single client export successful",
      downloadUrl: downloadUrl,
    });
  } catch (error) {
    console.error("Single client export error:", error);
    return res.status(500).json({
      message: "Internal Server Error",
      error: error.message,
    });
  }
};
