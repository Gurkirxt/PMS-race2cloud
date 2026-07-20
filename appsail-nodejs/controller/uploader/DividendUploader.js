import { fetchHoldingsRowsForAccountIsin } from "../../util/analytics/holdingsFromTable.js";
import { parseCustodianCsv } from "../../util/custodian/parseCustodianCsv.js";

const ZCQL_ROW_LIMIT = 270;
const ACCOUNT_LOOKUP_BATCH = 50;

const parseCatalystTime = (ct) => {
  if (!ct) return 0;
  const fixed = ct.replace(/:(\d{3})$/, ".$1");
  const ms = new Date(fixed).getTime();
  return isNaN(ms) ? 0 : ms;
};

const escSql = (s) => String(s ?? "").replace(/'/g, "''");

/**
 * Round to 2 decimals.
 */
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Read all rows from Dividend_Record for (ISIN, RecordDate) restricted to a
 * given list of account codes. Batches the IN-list to keep the ZCQL query
 * size sane.
 *
 * Returns Map<accountCode, { gross, tds, lastPaidOn, count }>.
 */
const lookupAlreadyReceived = async (
  zcql,
  isin,
  recordDateISO,
  accountCodes,
) => {
  const out = new Map();
  if (!accountCodes.length) return out;

  for (let i = 0; i < accountCodes.length; i += ACCOUNT_LOOKUP_BATCH) {
    const slice = accountCodes.slice(i, i + ACCOUNT_LOOKUP_BATCH);
    const inList = slice.map((a) => `'${escSql(a)}'`).join(",");
    let rows = [];
    try {
      rows = await zcql.executeZCQLQuery(`
        SELECT WS_Account_code, Dividend_Amount, PaymentDate
        FROM Dividend_Record
        WHERE ISIN='${escSql(isin)}'
          AND RecordDate='${recordDateISO}'
          AND WS_Account_code IN (${inList})
      `);
    } catch (err) {
      console.error("lookupAlreadyReceived batch failed:", err.message);
      continue;
    }
    for (const r of rows || []) {
      const d = r.Dividend_Record || r;
      const acc = d.WS_Account_code;
      if (!acc) continue;
      const cur = out.get(acc) || { gross: 0, lastPaidOn: null, count: 0 };
      cur.gross = round2(cur.gross + (Number(d.Dividend_Amount) || 0));
      cur.count += 1;
      const pd = d.PaymentDate;
      if (pd && (!cur.lastPaidOn || String(pd) > String(cur.lastPaidOn))) {
        cur.lastPaidOn = pd;
      }
      out.set(acc, cur);
    }
  }
  return out;
};

/**
 * Check which accounts already have a DIVIDEND row in
 * Cash_Balance_Per_Transaction for (ISIN, RecordDate). Returns Set<accountCode>.
 */
const lookupCashCredited = async (
  zcql,
  isin,
  recordDateISO,
  accountCodes,
) => {
  const out = new Set();
  if (!accountCodes.length) return out;

  for (let i = 0; i < accountCodes.length; i += ACCOUNT_LOOKUP_BATCH) {
    const slice = accountCodes.slice(i, i + ACCOUNT_LOOKUP_BATCH);
    const inList = slice.map((a) => `'${escSql(a)}'`).join(",");
    let rows = [];
    try {
      rows = await zcql.executeZCQLQuery(`
        SELECT Account_Code
        FROM Cash_Balance_Per_Transaction
        WHERE ISIN='${escSql(isin)}'
          AND Transaction_Date='${recordDateISO}'
          AND Transaction_Type='DIVIDEND'
          AND Account_Code IN (${inList})
      `);
    } catch (err) {
      console.error("lookupCashCredited batch failed:", err.message);
      continue;
    }
    for (const r of rows || []) {
      const c = r.Cash_Balance_Per_Transaction || r;
      if (c.Account_Code) out.add(c.Account_Code);
    }
  }
  return out;
};

/**
 * Decide a per-row status badge for the reconciliation grid.
 *
 * Buckets:
 *   already_paid       — already received gross >= file gross AND cash row exists
 *   overpaid           — already received gross > file gross
 *   partial            — 0 < already received gross < file gross
 *   missing_in_system  — in file but FIFO never saw the account
 *   missing_in_file    — FIFO has holding but file row absent
 *   mismatch           — both sides present but holding or gross differs
 *   ready              — both sides match, nothing already paid
 */
const computeStatus = ({
  inFile,
  inSystem,
  holdingDelta,
  grossDelta,
  alreadyReceivedGross,
  fileGross,
  alreadyCreditedCash,
}) => {
  if (!inFile && inSystem) return "missing_in_file";
  if (inFile && !inSystem) return "missing_in_system";

  if (inFile && alreadyReceivedGross > 0) {
    if (alreadyReceivedGross > fileGross + 0.005) return "overpaid";
    if (alreadyReceivedGross + 0.005 < fileGross) return "partial";
    if (alreadyCreditedCash) return "already_paid";
    return "already_paid";
  }

  if (Math.abs(holdingDelta) > 0.0001 || Math.abs(grossDelta) > 0.005) {
    return "mismatch";
  }
  return "ready";
};

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

  /**
   * POST /api/dividend/preview
   *
   * Accepts either:
   *   - JSON body { isin, recordDate, rate, paymentDate }, OR
   *   - multipart/form-data with the same fields plus an optional `file`
   *     custodian CSV (Benefit Collection Report).
   *
   * Always returns the legacy `data` array (FIFO-based) so the existing
   * preview rendering keeps working. When a file is uploaded, it ALSO
   * returns:
   *   - events[]  — file rows grouped by (CARefNo, Rate) with reconciled
   *                 per-account rows merging FIFO + file + already-paid
   *                 history.
   *   - summary   — totals + counts per status bucket.
   *   - warnings  — soft issues like "file has rows for other ISINs".
   */
  export const previewStockDividend = async (req, res) => {
    try {
      if (!req.catalystApp) {
        return res.status(500).json({
          success: false,
          message: "Catalyst app not initialized",
        });
      }

      const { isin, recordDate, rate, paymentDate } = req.body || {};
      const rateNum = Number(rate);

      if (!Number.isFinite(rateNum) || rateNum <= 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid dividend rate value",
        });
      }
      if(!isin || !recordDate || !paymentDate){
        return res.status(400).json({
          success: false,
          message: "Invalid ISIN, record date or payment date",
        });
      }

      const recordDateObj = new Date(recordDate);
      recordDateObj.setUTCHours(0, 0, 0, 0);
      const recordDateISO = recordDateObj.toISOString().split("T")[0];

      const paymentDateObj = new Date(paymentDate);
      paymentDateObj.setUTCHours(0, 0, 0, 0);
      const paymentDateISO = paymentDateObj.toISOString().split("T")[0];

      /* ======================================================
         STEP 0: REQUIRE + PARSE THE CUSTODIAN FILE
         A custodian file is now mandatory — preview without a file is
         disabled so we never silently apply dividends from FIFO alone
         when the custodian's view is the source of truth.
         ====================================================== */
      const warnings = [];
      let fileParsed = null;
      const uploaded = req.files?.file;

      if (!uploaded) {
        return res.status(400).json({
          success: false,
          message:
            "Custodian file is required. Please attach the Benefit " +
            "Collection Report (CSV) before fetching affected accounts.",
        });
      }

      const name = (uploaded.name || "").toLowerCase();
      if (!name.endsWith(".csv")) {
        return res.status(400).json({
          success: false,
          message:
            "Only CSV files are supported. Open the file in Excel and " +
            "use 'Save As → CSV (Comma delimited)' before uploading.",
        });
      }
      try {
        fileParsed = await parseCustodianCsv(uploaded.data);
      } catch (parseErr) {
        return res.status(400).json({
          success: false,
          message: `Failed to parse custodian CSV: ${parseErr.message}`,
        });
      }
      if (!fileParsed.rows.length) {
        warnings.push("Custodian file had headers but no data rows.");
      }

      const zcql = req.catalystApp.zcql();

      /* ======================================================
         STEP 1: FIND ACCOUNTS WITH TRANSACTIONS FOR THIS ISIN
         ====================================================== */
      const accountSet = new Set();
      let holdOffset = 0;

      while (true) {
        const batch = await zcql.executeZCQLQuery(`
          SELECT WS_Account_code
          FROM Transaction
          WHERE ISIN='${isin}'
          LIMIT ${ZCQL_ROW_LIMIT} OFFSET ${holdOffset}
        `);

        if (!batch || batch.length === 0) break;
        batch.forEach((r) => accountSet.add(r.Transaction.WS_Account_code));
        if (batch.length < ZCQL_ROW_LIMIT) break;
        holdOffset += ZCQL_ROW_LIMIT;
      }

      const eligibleAccounts = Array.from(accountSet);
      // We don't early-return on empty FIFO here: the file may carry rows
      // we need to surface as "missing_in_system" for ops to investigate.

      /* ======================================================
         STEP 2: HOLDING AS OF RECORD DATE (read materialised Holdings)
         ------------------------------------------------------
         Read the stored Holdings ledger — the same source of truth as the
         rebuild / upload worker — as of the record date, instead of replaying
         FIFO from the source tables. The last row in FIFO order carries the
         running HOLDING (holding as of that date), and corporate actions
         already applied (incl. demerger/merger) are reflected automatically.
         ====================================================== */
      const preview = [];
      const fifoByAccount = new Map();

      for (const accountCode of eligibleAccounts) {
        const holdingRows = await fetchHoldingsRowsForAccountIsin(
          zcql,
          accountCode,
          isin,
          recordDateISO,
        );
        if (!holdingRows.length) continue;

        const holdingAsOnRecordDate =
          Number(holdingRows[holdingRows.length - 1].HOLDING) || 0;
        if (holdingAsOnRecordDate <= 1e-6) continue;

        const dividendAmount = round2(holdingAsOnRecordDate * rateNum);

        fifoByAccount.set(accountCode, {
          holding: holdingAsOnRecordDate,
          gross: dividendAmount,
        });

        preview.push({
          isin,
          accountCode,
          holdingAsOnRecordDate,
          rate: rateNum,
          paymentDate: paymentDateISO,
          dividendAmount,
        });
      }

      /* ======================================================
         STEP 7: RECONCILIATION (only when a custodian file is present)
         ------------------------------------------------------
         - Filter file rows to current ISIN.
         - Group by (CARefNo, Rate) -> separate "events".
         - Look up "already received" history for the union of accounts.
         - Merge file + FIFO + history into per-account reconciled rows.
         - Compute summary totals per status bucket.
         ====================================================== */
      let events = null;
      let summary = null;

      if (fileParsed) {
        const allFileRows = fileParsed.rows;

        const targetIsinUC = String(isin).toUpperCase();
        const matchingRows = allFileRows.filter(
          (r) => r.isin && r.isin.toUpperCase() === targetIsinUC,
        );
        const otherIsinCount = allFileRows.length - matchingRows.length;
        if (otherIsinCount > 0) {
          warnings.push(
            `Custodian file has ${otherIsinCount} row(s) for other ISINs ` +
              `that were ignored.`,
          );
        }

        // Sanity check: file's record date should match the form's record date.
        const fileRecordDates = new Set(
          matchingRows.map((r) => r.recordDate).filter(Boolean),
        );
        if (
          fileRecordDates.size === 1 &&
          !fileRecordDates.has(recordDateISO)
        ) {
          warnings.push(
            `Custodian file has Record Date ${[...fileRecordDates][0]}, ` +
              `but the form has ${recordDateISO}. Reconciliation uses the ` +
              `form's date.`,
          );
        } else if (fileRecordDates.size > 1) {
          warnings.push(
            `Custodian file has multiple Record Dates: ${[
              ...fileRecordDates,
            ].join(", ")}. Reconciliation uses the form's date.`,
          );
        }

        // Group file rows by (CARefNo + Rate) so multi-event dividends on
        // the same Record Date stay separated.
        const eventsMap = new Map();
        for (const row of matchingRows) {
          const key = `${row.caRef || "-"}|${row.rate}`;
          if (!eventsMap.has(key)) {
            eventsMap.set(key, {
              caRef: row.caRef || null,
              rate: row.rate,
              caType: row.caType || null,
              filePaymentDate: row.paymentDate || null,
              fileExDate: row.exDate || null,
              fileRecordDate: row.recordDate || null,
              rowsByAccount: new Map(),
            });
          }
          const evt = eventsMap.get(key);
          // If a UCC appears twice within the same event (rare), sum amounts.
          const prev = evt.rowsByAccount.get(row.accountCode);
          if (prev) {
            prev.holding += row.holding;
            prev.gross = round2(prev.gross + row.gross);
            prev.tds = round2(prev.tds + row.tds);
            prev.net = round2(prev.net + row.net);
          } else {
            evt.rowsByAccount.set(row.accountCode, { ...row });
          }
        }

        /*
         * Edge case: file had no rows for this ISIN but the system has FIFO
         * holdings. Without this fallback, the renderer would loop over zero
         * events and display nothing — orphaning the FIFO accounts. We emit
         * one synthetic event keyed by the form rate so those FIFO accounts
         * surface as missing_in_file rows the user can investigate.
         */
        if (eventsMap.size === 0 && fifoByAccount.size > 0) {
          eventsMap.set(`-|${rateNum}`, {
            caRef: null,
            rate: rateNum,
            caType: null,
            filePaymentDate: null,
            fileExDate: null,
            fileRecordDate: null,
            rowsByAccount: new Map(),
            synthetic: true,
          });
          warnings.push(
            "Custodian file has no rows for this ISIN. Showing system " +
              "(FIFO) accounts as 'Missing in file' for review.",
          );
        }

        // Union of accounts referenced anywhere (file OR FIFO).
        const accountUnion = new Set();
        for (const evt of eventsMap.values()) {
          for (const acc of evt.rowsByAccount.keys()) accountUnion.add(acc);
        }
        for (const acc of fifoByAccount.keys()) accountUnion.add(acc);
        const accountList = [...accountUnion];

        // Already-received and cash-credited lookups (one query each, batched).
        const [alreadyReceivedMap, cashCreditedSet] = await Promise.all([
          lookupAlreadyReceived(zcql, isin, recordDateISO, accountList),
          lookupCashCredited(zcql, isin, recordDateISO, accountList),
        ]);

        const eventsArr = [];
        const summaryAgg = {
          events: 0,
          accounts: 0,
          ready: 0,
          mismatch: 0,
          partial: 0,
          overpaid: 0,
          alreadyPaid: 0,
          missingInSystem: 0,
          missingInFile: 0,
          totalGrossSys: 0,
          totalGrossFile: 0,
          totalNetFile: 0,
          totalTdsFile: 0,
          totalAlreadyReceived: 0,
          totalToReceiveNet: 0,
          totalToReceiveGross: 0,
        };

        for (const [, evt] of eventsMap) {
          const reconciledRows = [];

          // Per-event union: file accounts ∪ FIFO accounts whose rate matches.
          const evtAccountSet = new Set();
          for (const acc of evt.rowsByAccount.keys()) evtAccountSet.add(acc);
          // Only attribute FIFO to this event if rates match the form rate
          // (single-event case) or if the event rate equals the form rate.
          // Otherwise FIFO holdings are shown only against the event(s)
          // whose Rate equals the form's Rate.
          const fifoAttributesToEvent =
            Math.abs(evt.rate - rateNum) < 0.0001 || eventsMap.size === 1;
          if (fifoAttributesToEvent) {
            for (const acc of fifoByAccount.keys()) evtAccountSet.add(acc);
          }

          const sortedAccounts = [...evtAccountSet].sort();

          for (const accountCode of sortedAccounts) {
            const fileRow = evt.rowsByAccount.get(accountCode);
            const fifoRow = fifoAttributesToEvent
              ? fifoByAccount.get(accountCode)
              : undefined;

            const inFile = !!fileRow;
            const inSystem = !!fifoRow;

            const holdingFile = inFile ? fileRow.holding : null;
            const holdingSys = inSystem ? fifoRow.holding : null;
            const holdingDelta =
              inFile && inSystem ? holdingFile - holdingSys : 0;

            const grossFile = inFile ? fileRow.gross : null;
            // System gross uses file rate if attributed to this event;
            // otherwise it's the form rate.
            const grossSys =
              inSystem && fifoRow
                ? round2(holdingSys * evt.rate)
                : null;
            const grossDelta =
              inFile && inSystem ? round2(grossFile - grossSys) : 0;

            const tdsFile = inFile ? fileRow.tds : null;
            const netFile = inFile ? fileRow.net : null;

            const alreadyHist = alreadyReceivedMap.get(accountCode);
            const alreadyReceivedGross = alreadyHist ? alreadyHist.gross : 0;
            const lastPaidOn = alreadyHist ? alreadyHist.lastPaidOn : null;
            const alreadyCreditedCash = cashCreditedSet.has(accountCode);

            const baseForToReceive = inFile ? grossFile : grossSys || 0;
            const toReceiveGross = round2(
              Math.max(0, baseForToReceive - alreadyReceivedGross),
            );
            const toReceiveNet =
              inFile && netFile != null
                ? round2(
                    Math.max(
                      0,
                      netFile - alreadyReceivedGross,
                    ),
                  )
                : toReceiveGross;

            const status = computeStatus({
              inFile,
              inSystem,
              holdingDelta,
              grossDelta,
              alreadyReceivedGross,
              fileGross: grossFile || 0,
              alreadyCreditedCash,
            });

            reconciledRows.push({
              accountCode,
              clientName: fileRow ? fileRow.clientName : null,
              inFile,
              inSystem,
              holdingSys,
              holdingFile,
              holdingDelta,
              rateSys: rateNum,
              rateFile: inFile ? fileRow.rate : null,
              grossSys,
              grossFile,
              grossDelta,
              tdsFile,
              netFile,
              alreadyReceivedGross,
              alreadyCreditedCash,
              lastPaidOn,
              toReceiveGross,
              toReceiveNet,
              status,
            });

            // Summary aggregation
            summaryAgg.totalGrossSys += grossSys || 0;
            summaryAgg.totalGrossFile += grossFile || 0;
            summaryAgg.totalNetFile += netFile || 0;
            summaryAgg.totalTdsFile += tdsFile || 0;
            summaryAgg.totalAlreadyReceived += alreadyReceivedGross || 0;
            summaryAgg.totalToReceiveNet += toReceiveNet || 0;
            summaryAgg.totalToReceiveGross += toReceiveGross || 0;
            switch (status) {
              case "ready": summaryAgg.ready++; break;
              case "mismatch": summaryAgg.mismatch++; break;
              case "partial": summaryAgg.partial++; break;
              case "overpaid": summaryAgg.overpaid++; break;
              case "already_paid": summaryAgg.alreadyPaid++; break;
              case "missing_in_system": summaryAgg.missingInSystem++; break;
              case "missing_in_file": summaryAgg.missingInFile++; break;
              default: break;
            }
          }

          eventsArr.push({
            caRef: evt.caRef,
            rate: evt.rate,
            caType: evt.caType,
            filePaymentDate: evt.filePaymentDate,
            fileExDate: evt.fileExDate,
            fileRecordDate: evt.fileRecordDate,
            isin,
            recordDate: recordDateISO,
            paymentDate: paymentDateISO,
            rowCount: reconciledRows.length,
            rows: reconciledRows,
          });
        }

        // Round summary totals to 2 decimals.
        summaryAgg.totalGrossSys = round2(summaryAgg.totalGrossSys);
        summaryAgg.totalGrossFile = round2(summaryAgg.totalGrossFile);
        summaryAgg.totalNetFile = round2(summaryAgg.totalNetFile);
        summaryAgg.totalTdsFile = round2(summaryAgg.totalTdsFile);
        summaryAgg.totalAlreadyReceived = round2(
          summaryAgg.totalAlreadyReceived,
        );
        summaryAgg.totalToReceiveNet = round2(summaryAgg.totalToReceiveNet);
        summaryAgg.totalToReceiveGross = round2(summaryAgg.totalToReceiveGross);
        summaryAgg.events = eventsArr.length;
        summaryAgg.accounts = accountList.length;

        events = eventsArr;
        summary = summaryAgg;
      }

      const response = { success: true, data: preview };
      if (events) response.events = events;
      if (summary) response.summary = summary;
      if (warnings.length) response.warnings = warnings;
      return res.json(response);
    } catch (error) {
      console.error("Preview dividend error:", error);
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  };

  /* ======================================================
     APPLY DIVIDEND (BACKGROUND JOB)
     ------------------------------------------------------
     Mirrors the BonusController pattern:
       - Validate inputs.
       - Idempotency check on (ISIN, RecordDate) in Dividend.
       - Reuse / clean up any existing Jobs row for jobName.
       - Submit a Catalyst Job that runs the UpdateDividendData
         function. The function performs all heavy work
         (master insert, per-account FIFO, Dividend_Record
         inserts, Cash_Balance_Per_Transaction credits) and
         updates the Jobs row to COMPLETED / FAILED.
       - Return immediately with { jobName, status: "PENDING" }
         so the React UI can poll /dividend/apply-status.
     ====================================================== */
  export const applyStockDividendMaster = async (req, res) => {
    try {
      if (!req.catalystApp) {
        return res.status(500).json({
          success: false,
          message: "Catalyst app not initialized",
        });
      }

      const {
        isin,
        securityCode,
        securityName,
        rate: rateParam,
        exDate,
        recordDate,
        paymentDate,
        dividendType,
        accountCodes,    // optional allow-list (string[] or comma-separated)
        applyMode,       // optional: "matched" | "all" | "system" (audit only)
      } = req.body;

      const rate = Number(rateParam);

      /*
       * Normalise accountCodes to a clean string[].
       * Accepts JSON arrays (preferred) or a comma-separated string for
       * cURL/manual testing. Empty / undefined => no filter (full universe).
       */
      let accountCodesArr = null;
      if (Array.isArray(accountCodes)) {
        accountCodesArr = accountCodes
          .map((s) => String(s || "").trim())
          .filter(Boolean);
      } else if (typeof accountCodes === "string" && accountCodes.trim()) {
        accountCodesArr = accountCodes
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }

      if (!Number.isFinite(rate) || rate <= 0) {
        return res.status(400).json({
          success: false,
          message: "Invalid dividend rate value",
        });
      }
      if (
        !isin ||
        !securityCode ||
        !securityName ||
        !recordDate ||
        !paymentDate
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid or missing required fields",
        });
      }

      const normalizeDate = (d) => {
        const dt = new Date(d);
        dt.setUTCHours(0, 0, 0, 0);
        return dt.toISOString().split("T")[0];
      };

      const recordDateISO = normalizeDate(recordDate);
      const exDateISO = (exDate && String(exDate).trim())
        ? normalizeDate(exDate)
        : recordDateISO;
      const paymentDateISO = normalizeDate(paymentDate);

      const catalystApp = req.catalystApp;
      const zcql = catalystApp.zcql();
      const jobScheduling = catalystApp.jobScheduling();

      const existingDiv = await zcql.executeZCQLQuery(`
        SELECT ROWID
        FROM Dividend
        WHERE ISIN='${isin}'
        AND RecordDate='${recordDateISO}'
        LIMIT 1
      `);

      if (existingDiv && existingDiv.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Dividend already exists for this ISIN and Record Date",
        });
      }

      const jobName = `DIV_${isin.slice(-6)}_${recordDateISO}`;

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
            message: "Dividend application is already in progress",
          });
        }

        try {
          await zcql.executeZCQLQuery(`DELETE FROM Jobs WHERE ROWID = ${oldRowId}`);
        } catch (delErr) {
          console.error("Error deleting old dividend job:", delErr);
        }
      }

      /*
       * Pass the optional accountCodes allow-list to the job as a JSON
       * string. UpdateDividendData parses it back; when present the job
       * filters its eligible-accounts loop to this set.
       */
      const jobParams = {
        isin,
        securityCode,
        securityName,
        rate: String(rate),
        exDate: exDateISO,
        recordDate: recordDateISO,
        paymentDate: paymentDateISO,
        dividendType: dividendType || "Final",
        jobName,
      };
      if (accountCodesArr && accountCodesArr.length) {
        jobParams.accountCodesJson = JSON.stringify(accountCodesArr);
        jobParams.applyMode = applyMode || "matched";
      } else {
        jobParams.applyMode = applyMode || "system";
      }

      await jobScheduling.JOB.submitJob({
        job_name: "ApplyDividend",
        jobpool_name: "CorporateActions",
        target_name: "UpdateDividendData",
        target_type: "Function",
        params: jobParams,
      });

      return res.json({
        success: true,
        jobName,
        status: "PENDING",
        message: "Dividend application job started",
      });

    } catch (error) {
      console.error("Apply dividend master error:", error);
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  };

  /* ======================================================
     GET DIVIDEND APPLY JOB STATUS
     Mirrors getBonusApplyStatus exactly (same Jobs table
     contract used by UpdateDividendData function).
     ====================================================== */
  export const getDividendApplyStatus = async (req, res) => {
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
          console.error("Failed to mark stale dividend job as ERROR:", updateErr);
        }
        status = "ERROR";
      }

      return res.json({ success: true, jobName, status });
    } catch (error) {
      console.error("Error fetching dividend job status:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch dividend job status",
      });
    }
  };
