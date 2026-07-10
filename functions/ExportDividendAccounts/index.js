const { Readable } = require("stream");
const catalyst = require("zcatalyst-sdk-node");
const { runFifoEngine } = require("./fifo.js");

const BATCH_SIZE = 270;

/**
 * @param {import("./types/job").JobRequest} jobRequest
 * @param {import("./types/job").Context} context
 */
module.exports = async (jobRequest, context) => {
  const catalystApp = catalyst.initialize(context);
  const zcql = catalystApp.zcql();
  let jobName = "";

  try {
    console.log("[ExportDividend] Job started");

    const jobDetails = jobRequest.getAllJobParams();
    const { isin, exDate, recordDate, rate, paymentDate, fileName } = jobDetails;
    jobName = jobDetails.jobName;
    const rateNum = Number(rate);

    await zcql.executeZCQLQuery(
      `INSERT INTO Jobs (jobName, status) VALUES ('${jobName}', 'PENDING')`
    );

    if (!isin || !recordDate || !paymentDate || !Number.isFinite(rateNum) || rateNum <= 0) {
      console.error("[ExportDividend] Invalid params:", { isin, recordDate, rate, paymentDate });
      await zcql.executeZCQLQuery(
        `UPDATE Jobs SET status = 'FAILED' WHERE jobName = '${jobName}'`
      );
      context.closeWithFailure();
      return;
    }

    const recordDateObj = new Date(recordDate);
    recordDateObj.setUTCHours(0, 0, 0, 0);
    const recordDateISO = recordDateObj.toISOString().split("T")[0];

    const exDateForDisplay =
      exDate && String(exDate).trim()
        ? (() => {
            const d = new Date(exDate);
            d.setUTCHours(0, 0, 0, 0);
            return d.toISOString().split("T")[0];
          })()
        : recordDateISO;

    const paymentDateObj = new Date(paymentDate);
    paymentDateObj.setUTCHours(0, 0, 0, 0);
    const paymentDateISO = paymentDateObj.toISOString().split("T")[0];

    const stratus = catalystApp.stratus();
    const bucket = stratus.bucket("export-app-data");

    /* ================= STEP 1: FIND ACCOUNTS WITH TRANSACTIONS FOR THIS ISIN ================= */
    const accountSet = new Set();
    let holdOffset = 0;

    while (true) {
      const batch = await zcql.executeZCQLQuery(`
        SELECT WS_Account_code
        FROM Transaction
        WHERE ISIN='${isin}'
        LIMIT ${BATCH_SIZE} OFFSET ${holdOffset}
      `);

      if (!batch || batch.length === 0) break;
      batch.forEach((r) => accountSet.add(r.Transaction.WS_Account_code));
      if (batch.length < BATCH_SIZE) break;
      holdOffset += BATCH_SIZE;
    }

    const eligibleAccounts = Array.from(accountSet);

    if (!eligibleAccounts.length) {
      console.log("[ExportDividend] No accounts found with transactions for ISIN:", isin);
      await zcql.executeZCQLQuery(
        `UPDATE Jobs SET status = 'COMPLETED' WHERE jobName = '${jobName}'`
      );
      context.closeWithSuccess();
      return;
    }

    console.log(`[ExportDividend] Found ${eligibleAccounts.length} accounts for ISIN: ${isin}`);

    /* ================= STEP 2: FETCH TX / BONUS / SPLIT ================= */
    const fetchAll = async (table, dateCol) => {
      const out = [];
      let off = 0;
      while (true) {
        const r = await zcql.executeZCQLQuery(`
          SELECT *
          FROM ${table}
          WHERE ISIN='${isin}' AND ${dateCol} <='${recordDateISO}'
          LIMIT ${BATCH_SIZE} OFFSET ${off}
        `);
        if (!r || r.length === 0) break;
        out.push(...r);
        if (r.length < BATCH_SIZE) break;
        off += BATCH_SIZE;
      }
      return out;
    };

    const txRows = await fetchAll("Transaction", "SETDATE");
    const bonusRows = await fetchAll("Bonus", "ExDate");
    const splitRows = await fetchAll("Split", "Issue_Date");

    /* ================= GROUP DATA ================= */
    const txByAcc = {};
    txRows.forEach((r) => {
      const t = r.Transaction;
      (txByAcc[t.WS_Account_code] ||= []).push(t);
    });

    const bonusByAcc = {};
    bonusRows.forEach((r) => {
      const b = r.Bonus;
      (bonusByAcc[b.WS_Account_code] ||= []).push(b);
    });

    const splits = splitRows.map((r) => {
      const s = r.Split;
      return {
        issueDate: s.Issue_Date,
        ratio1: Number(s.Ratio1) || 0,
        ratio2: Number(s.Ratio2) || 0,
        isin: s.ISIN,
      };
    });

    /* ================= STEP 3: FIFO + BUILD CSV ================= */
    const UTF8_BOM = "\uFEFF";
    const csvLines = [];
    csvLines.push(
      UTF8_BOM +
        "ISIN,ACCOUNT_CODE,HOLDING_AS_ON_RECORD_DATE,RATE,EX_DATE,PAYMENT_DATE,DIVIDEND_AMOUNT\n"
    );

    let eligibleCount = 0;

    for (const accountCode of eligibleAccounts) {
      const tx = txByAcc[accountCode] || [];
      if (!tx.length) continue;

      const bonuses = bonusByAcc[accountCode] || [];

      const fifo = runFifoEngine(tx, bonuses, splits, true);
      if (!fifo || fifo.holdings <= 1e-6) continue;

      const holdingAsOnRecordDate = fifo.holdings;
      const dividendAmount = holdingAsOnRecordDate * rateNum;
      const exDateValue = exDateForDisplay || "";

      const line = [
        isin,
        accountCode,
        holdingAsOnRecordDate,
        rateNum,
        exDateValue,
        paymentDateISO,
        dividendAmount,
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(",");

      csvLines.push(line + "\n");
      eligibleCount++;
    }

    console.log(
      `[ExportDividend] ${eligibleAccounts.length} accounts checked, ${eligibleCount} eligible for dividend`
    );

    /* ================= UPLOAD COMPLETE CSV ================= */
    const csvContent = csvLines.join("");
    const readableStream = Readable.from([csvContent]);

    console.log(
      `[ExportDividend] Uploading CSV (${csvLines.length} lines, ~${Math.round(
        csvContent.length / 1024
      )} KB)`
    );

    await bucket.putObject(fileName, readableStream, {
      overwrite: true,
      contentType: "text/csv",
    });

    console.log("[ExportDividend] Job completed successfully");

    try {
      await zcql.executeZCQLQuery(
        `UPDATE Jobs SET status = 'COMPLETED' WHERE jobName = '${jobName}'`
      );
    } catch (statusErr) {
      console.error(
        "[ExportDividend] Failed to mark job as COMPLETED (file was uploaded):",
        statusErr
      );
    }

    context.closeWithSuccess();
  } catch (error) {
    console.error("[ExportDividend] Job failed:", error);

    try {
      await zcql.executeZCQLQuery(
        `UPDATE Jobs SET status = 'FAILED' WHERE jobName = '${jobName}'`
      );
    } catch (updateErr) {
      console.error("[ExportDividend] Failed to update job status to FAILED:", updateErr);
    }

    context.closeWithFailure();
  }
};
