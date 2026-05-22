const { Readable } = require("stream");
const catalyst = require("zcatalyst-sdk-node");

const BATCH = 300;

const esc = (s) => String(s ?? "").replace(/'/g, "''");
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

module.exports = async (jobRequest, context) => {
  const catalystApp = catalyst.initialize(context);
  const zcql = catalystApp.zcql();
  let jobName = "";

  try {
    const params = jobRequest.getAllJobParams();
    const accountCode = params.accountCode;
    const isin = params.isin || "";
    const fromDate = params.fromDate || "";
    const toDate = params.toDate || "";
    jobName = params.jobName;
    const fileName = params.fileName;

    console.log(`ExportCashBal: account=${accountCode}, isin=${isin || "ALL"}, file=${fileName}`);

    await zcql.executeZCQLQuery(
      `INSERT INTO Jobs (jobName, status) VALUES ('${esc(jobName)}', 'RUNNING')`
    );

    let conditions = `Account_Code = '${esc(accountCode)}'`;

    if (isin) {
      conditions += ` AND ISIN = '${esc(isin)}'`;
    }
    if (fromDate) {
      conditions += ` AND Transaction_Date >= '${esc(fromDate)}'`;
    }
    if (toDate) {
      const nextDay = new Date(toDate);
      nextDay.setDate(nextDay.getDate() + 1);
      const nextDayStr = nextDay.toISOString().split("T")[0];
      conditions += ` AND Transaction_Date < '${nextDayStr}'`;
    }

    const baseQuery = `
      SELECT ROWID, Account_Code, Transaction_Date, Settlement_Date, ISIN, Security_Name,
             Transaction_Type, Quantity, Price, Total_Amount, Cash_Balance, STT, Sequence
      FROM Cash_Balance_Per_Transaction
      WHERE ${conditions}
      ORDER BY Sequence ASC
    `;

    const csvLines = [];
    csvLines.push(
      "Tran Date,Set Date,Account Code,ISIN,Security Name,Tran Type,QTY,Rate,STT,Amount,Cash Balance\n"
    );

    let offset = 0;
    let totalRows = 0;

    while (true) {
      const query = baseQuery + ` LIMIT ${BATCH} OFFSET ${offset}`;
      const rows = await zcql.executeZCQLQuery(query);
      if (!rows || rows.length === 0) break;

      for (const r of rows) {
        const row = r.Cash_Balance_Per_Transaction || r;
        const tranType = (row.Transaction_Type || "").trim();

        const line = [
          csvCell((row.Transaction_Date || "").toString().slice(0, 10)),
          csvCell((row.Settlement_Date || "").toString().slice(0, 10)),
          csvCell(row.Account_Code),
          csvCell(row.ISIN),
          csvCell(row.Security_Name),
          csvCell(tranType),
          csvCell(row.Quantity),
          csvCell(row.Price),
          csvCell(row.STT),
          csvCell(row.Total_Amount),
          csvCell(row.Cash_Balance),
        ].join(",");

        csvLines.push(line + "\n");
        totalRows++;
      }

      if (rows.length < BATCH) break;
      offset += BATCH;
    }

    console.log(`ExportCashBal: ${totalRows} row(s) fetched, building CSV...`);

    const csvContent = csvLines.join("");
    const readableStream = Readable.from([csvContent]);

    const stratus = catalystApp.stratus();
    const bucket = stratus.bucket("upload-data-bucket");

    console.log(`Uploading CSV (~${Math.round(csvContent.length / 1024)} KB)`);

    await bucket.putObject(fileName, readableStream, {
      overwrite: true,
      contentType: "text/csv",
    });

    console.log("ExportCashBal: upload complete");

    try {
      await zcql.executeZCQLQuery(
        `UPDATE Jobs SET status = 'COMPLETED' WHERE jobName = '${esc(jobName)}'`
      );
    } catch (statusErr) {
      console.error("Failed to mark job COMPLETED:", statusErr);
    }

    context.closeWithSuccess();
  } catch (error) {
    console.error("ExportCashBal failed:", error);

    try {
      if (jobName) {
        await zcql.executeZCQLQuery(
          `UPDATE Jobs SET status = 'FAILED' WHERE jobName = '${esc(jobName)}'`
        );
      }
    } catch (updateErr) {
      console.error("Failed to mark job FAILED:", updateErr);
    }

    context.closeWithFailure();
  }
};
