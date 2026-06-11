const { Readable } = require("stream");
const {
  getAllAccountCodesFromDatabase,
  getAccountActualMapFromDatabase,
} = require("./allAccountCodes.js");
const { calculateHoldingsSummary } = require("./analyticsController.js");
const catalyst = require("zcatalyst-sdk-node");

/**
 * @param {import("./types/job").JobRequest} jobRequest
 * @param {import("./types/job").Context} context
 */
module.exports = async (jobRequest, context) => {
  const catalystApp = catalyst.initialize(context);
  const zcql = catalystApp.zcql();
  let jobName = "";
  try {
    console.log("Export job started");

    const jobDetails = jobRequest.getAllJobParams();
    const { asOnDate, fileName } = jobDetails;
    jobName = jobDetails.jobName;
    const consolidated =
      String(jobDetails.mode || "").toLowerCase() === "consolidated";

    // Report date stamped on every row. exportAllData always passes a concrete
    // asOnDate, but default to today defensively.
    const reportDate = asOnDate || new Date().toISOString().split("T")[0];

    const stratus = catalystApp.stratus();
    const bucket = stratus.bucket("upload-data-bucket");

    const tableName = "clientIds";

    await zcql.executeZCQLQuery(
      `INSERT INTO Jobs (jobName, status) VALUES ('${jobName}', 'PENDING')`
    );

    /* ---------------- BUILD CSV IN MEMORY ---------------- */
    const csvLines = [];
    let count = 0;
    let errorCount = 0;
    const sharedPriceMap = {};

    if (consolidated) {
      /* ===== CONSOLIDATED: one block per Actual Code, HOLDING only ===== */
      const groups = await getAccountActualMapFromDatabase(zcql, tableName);

      if (!groups.length) {
        console.log("No clients found");
        await zcql.executeZCQLQuery(
          `UPDATE Jobs SET status = 'COMPLETED' WHERE jobName = '${jobName}'`
        );
        context.closeWithSuccess();
        return;
      }

      csvLines.push(
        "AS_ON_DATE,ACCOUNT_CODE,SECURITY_NAME,SECURITY_CODE,ISIN,HOLDING\n"
      );

      for (const group of groups) {
        const { actualCode, virtualCodes } = group;

        try {
          console.log(
            `Processing actual code ${count + 1}/${groups.length} : ${actualCode} (${virtualCodes.length} schemes)`
          );

          // Sum holding per ISIN across the actual code's virtual codes.
          const byIsin = new Map();
          for (const virtualCode of virtualCodes) {
            const rows = await calculateHoldingsSummary({
              catalystApp,
              accountCode: virtualCode,
              asOnDate,
              sharedPriceMap,
            });
            if (!Array.isArray(rows)) continue;

            for (const row of rows) {
              const isin = row.isin;
              if (!isin) continue;
              const hold = Number(row.currentHolding) || 0;
              const existing = byIsin.get(isin);
              if (existing) {
                existing.currentHolding += hold;
              } else {
                byIsin.set(isin, {
                  isin,
                  stockName: row.stockName || isin,
                  securityCode: row.securityCode || "",
                  currentHolding: hold,
                });
              }
            }
          }

          const merged = [...byIsin.values()].sort((a, b) =>
            (a.stockName || "").localeCompare(b.stockName || "")
          );

          for (const row of merged) {
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

            csvLines.push(line + "\n");
          }

          count++;
        } catch (groupErr) {
          errorCount++;
          console.error(
            `Error processing actual code ${actualCode} (${errorCount} errors so far):`,
            groupErr
          );
          count++;
        }
      }

      console.log(`Processed ${count} actual codes, ${errorCount} had errors`);
    } else {
      /* ===== SCHEME-WISE: one block per virtual code (original) ===== */
      const clientIds = await getAllAccountCodesFromDatabase(zcql, tableName);

      if (!clientIds.length) {
        console.log("No clients found");
        await zcql.executeZCQLQuery(
          `UPDATE Jobs SET status = 'COMPLETED' WHERE jobName = '${jobName}'`
        );
        context.closeWithSuccess();
        return;
      }

      csvLines.push(
        "AS_ON_DATE,ACCOUNT_CODE,SECURITY_NAME,SECURITY_CODE,ISIN,HOLDING,WAP,HOLDING_VALUE,LAST_PRICE,MARKET_VALUE\n"
      );

      for (const client of clientIds) {
        const accountCode = client.clientIds.WS_Account_code;

        try {
          console.log(
            `Processing client ${count + 1}/${clientIds.length} : ${accountCode}`
          );

          const rows = await calculateHoldingsSummary({
            catalystApp,
            accountCode,
            asOnDate,
            sharedPriceMap,
          });

          if (!Array.isArray(rows) || !rows.length) {
            count++;
            continue;
          }

          for (const row of rows) {
            const line = [
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

            csvLines.push(line + "\n");
          }

          count++;
        } catch (clientErr) {
          errorCount++;
          console.error(
            `Error processing client ${accountCode} (${errorCount} errors so far):`,
            clientErr
          );
          count++;
        }
      }

      console.log(`Processed ${count} clients, ${errorCount} had errors`);
    }

    /* ---------------- UPLOAD COMPLETE CSV ---------------- */
    const csvContent = csvLines.join("");
    const readableStream = Readable.from([csvContent]);

    console.log(
      `Uploading CSV (${csvLines.length} lines, ~${Math.round(csvContent.length / 1024)} KB)`
    );

    await bucket.putObject(fileName, readableStream, {
      overwrite: true,
      contentType: "text/csv",
    });

    console.log("Export job completed successfully");

    try {
      await zcql.executeZCQLQuery(
        `UPDATE Jobs SET status = 'COMPLETED' WHERE jobName = '${jobName}'`
      );
    } catch (statusErr) {
      console.error(
        "Failed to mark job as COMPLETED (file was uploaded successfully):",
        statusErr
      );
    }
    context.closeWithSuccess();
  } catch (error) {
    console.error("Export job failed:", error);

    try {
      await zcql.executeZCQLQuery(
        `UPDATE Jobs SET status = 'FAILED' WHERE jobName = '${jobName}'`
      );
    } catch (updateErr) {
      console.error("Failed to update job status to FAILED:", updateErr);
    }
    context.closeWithFailure();
  }
};
