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
    const zcql = catalystApp.zcql();
    const stratus = catalystApp.stratus();
    const bucket = stratus.bucket("upload-data-bucket");
    const bucketDetails = await bucket.getDetails();

    /* ---------------- ACTUAL_CODE LOOKUP ---------------- */
    // Map the CODE (WS_Account_code) to its Actual_Code from clientIds. Blank
    // when there is no row or the mapping is empty (no fallback to the code).
    let actualCode = "";
    try {
      const escAcc = String(accountCode).replace(/'/g, "''");
      const mapRows = await zcql.executeZCQLQuery(
        `SELECT Actual_Code FROM clientIds WHERE WS_Account_code = '${escAcc}' LIMIT 1`
      );
      const mapRow = mapRows?.[0]?.clientIds || mapRows?.[0];
      actualCode = String(mapRow?.Actual_Code ?? "").trim();
    } catch (lookupErr) {
      console.error(
        `Actual_Code lookup failed for ${accountCode}:`,
        lookupErr.message
      );
    }

    /* ---------------- CREATE STREAM ---------------- */
    const csvStream = new PassThrough();
    const fileName = `holding-export-${accountCode}-${Date.now()}.csv`;

    const uploadPromise = bucket.putObject(fileName, csvStream, {
      overwrite: true,
      contentType: "text/csv",
    });

    /* ---------------- CSV HEADER ---------------- */
    csvStream.write(
      "GENERATED_AT,AS_ON_DATE,CODE,ACTUAL_CODE,SECURITY_NAME,SECURITY_CODE,ISIN,HOLDING,WAP,HOLDING_VALUE,LAST_PRICE,MARKET_VALUE\n"
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
        actualCode,
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
