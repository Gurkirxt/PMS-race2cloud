const { Readable } = require("stream");
const catalyst = require("zcatalyst-sdk-node");

const esc = (s) => String(s ?? "").replace(/'/g, "''");

/** yyyy-mm-dd -> yyyy/mm/dd for CSV DATE column */
function formatDateSlash(yyyyMmDd) {
  const parts = String(yyyyMmDd || "").split("-");
  if (parts.length !== 3) return String(yyyyMmDd);
  return `${parts[0]}/${parts[1]}/${parts[2]}`;
}

function csvCell(v) {
  const s = String(v ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function nextDayIso(asOnDate) {
  const nextDay = new Date(asOnDate);
  nextDay.setDate(nextDay.getDate() + 1);
  return nextDay.toISOString().split("T")[0];
}

/**
 * Distinct Account_Code with at least one passbook row where Transaction_Date is on or before
 * the selected as-on date (encoded as Transaction_Date < day after as-on).
 * Keyset pagination — avoids OFFSET loops that never terminate if OFFSET is ignored.
 */
async function getDistinctAccountCodesFromCash(zcql, asOnDate) {
  const nextDayStr = nextDayIso(asOnDate);
  const BATCH = 300;
  const MAX_PAGES = 50000;
  const codes = [];
  let lastCode = "";

  for (let page = 0; page < MAX_PAGES; page++) {
    const afterClause =
      lastCode === "" ? "" : `AND Account_Code > '${esc(lastCode)}'`;

    const rows = await zcql.executeZCQLQuery(`
      SELECT DISTINCT Account_Code
      FROM Cash_Balance_Per_Transaction
      WHERE Transaction_Date < '${nextDayStr}'
        ${afterClause}
      ORDER BY Account_Code ASC
      LIMIT ${BATCH}
    `);

    if (!rows || rows.length === 0) break;

    let pageMax = "";
    for (const r of rows) {
      const row = r.Cash_Balance_Per_Transaction || r;
      const code = (row.Account_Code || "").toString().trim();
      if (!code) continue;
      codes.push(code);
      if (code > pageMax) pageMax = code;
    }

    if (pageMax === "" || pageMax === lastCode) break;
    lastCode = pageMax;
    if (rows.length < BATCH) break;
  }

  return codes;
}

/**
 * Closing cash as on date — stored Cash_Balance on the latest Sequence row
 * before the as-on cutoff (same as Cash Balance passbook UI).
 */
async function storedClosingForAccount(zcql, accountCode, asOnDate) {
  const nextDayStr = nextDayIso(asOnDate);
  const rows = await zcql.executeZCQLQuery(`
    SELECT Cash_Balance FROM Cash_Balance_Per_Transaction
    WHERE Account_Code = '${esc(accountCode)}'
      AND Transaction_Date < '${nextDayStr}'
    ORDER BY Sequence DESC
    LIMIT 1
  `);

  if (!rows || rows.length === 0) {
    return { balance: 0 };
  }

  const row = rows[0].Cash_Balance_Per_Transaction || rows[0];
  return { balance: Number(row.Cash_Balance) || 0 };
}

/**
 * All-clients cash snapshot → CSV (DATE, ACCOUNT CODE, CASH BALANCE).
 * Per account: stored Cash_Balance on latest Sequence before as-on (Cash Balance page logic).
 * DATE column is always the job as-on date (yyyy/mm/dd) on every row.
 * Accounts: every distinct Account_Code that has any passbook row before that cutoff.
 * @param {import("./types/job").JobRequest} jobRequest
 * @param {import("./types/job").Context} context
 */
module.exports = async (jobRequest, context) => {
  const catalystApp = catalyst.initialize(context);
  const zcql = catalystApp.zcql();
  let jobName = "";

  try {
    const params = jobRequest.getAllJobParams();
    const asOnDate = params.asOnDate;
    const fileName = params.fileName;
    jobName = params.jobName;

    if (!asOnDate || !/^\d{4}-\d{2}-\d{2}$/.test(asOnDate)) {
      throw new Error("Invalid asOnDate");
    }

    const dateCol = formatDateSlash(asOnDate);

    console.log(`ExportCashBalance (all clients): asOnDate=${asOnDate}, file=${fileName}`);

    const stratus = catalystApp.stratus();
    const bucket = stratus.bucket("upload-data-bucket");

    await zcql.executeZCQLQuery(
      `INSERT INTO Jobs (jobName, status) VALUES ('${esc(jobName)}', 'PENDING')`
    );

    const accountCodes = await getDistinctAccountCodesFromCash(zcql, asOnDate);

    const lines = [];
    lines.push("DATE,ACCOUNT CODE,CASH BALANCE\n");

    for (const accountCode of accountCodes) {
      try {
        const { balance } = await storedClosingForAccount(
          zcql,
          accountCode,
          asOnDate
        );
        const balStr = (Number(balance) || 0).toFixed(2);
        lines.push([dateCol, accountCode, balStr].map(csvCell).join(",") + "\n");
      } catch (rowErr) {
        console.error(`Cash balance error for ${accountCode}:`, rowErr);
        lines.push([dateCol, accountCode, "0.00"].map(csvCell).join(",") + "\n");
      }
    }

    const csvContent = lines.join("");
    await bucket.putObject(fileName, Readable.from([csvContent]), {
      overwrite: true,
      contentType: "text/csv",
    });

    await zcql.executeZCQLQuery(
      `UPDATE Jobs SET status = 'COMPLETED' WHERE jobName = '${esc(jobName)}'`
    );

    console.log(`ExportCashBalance (all clients) completed, rows=${accountCodes.length}`);
    context.closeWithSuccess();
  } catch (error) {
    console.error("ExportCashBalance (all clients) failed:", error);
    try {
      if (jobName) {
        await zcql.executeZCQLQuery(
          `UPDATE Jobs SET status = 'FAILED' WHERE jobName = '${esc(jobName)}'`
        );
      }
    } catch (e) {
      console.error("Failed to mark job FAILED:", e);
    }
    context.closeWithFailure();
  }
};
