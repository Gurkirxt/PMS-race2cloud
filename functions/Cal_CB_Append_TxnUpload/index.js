/**
 * Cal_CB_Append_TxnUpload: Incremental cash passbook append after transaction CSV upload.
 *
 * - Discovers affected accounts ITSELF from the Transaction table
 *   (CREATEDTIME >= importStartedAtMs), paged with a keyset cursor on
 *   WS_Account_code — so it works for any number of accounts (past the 300-row
 *   query limit) and needs no account list in the job params (~5000-char limit).
 * - Per account: appends new Transaction rows from this import only. Before
 *   appending it deletes any cash rows this import already wrote for the account
 *   (idempotent — safe to re-run after a mid-account crash).
 * - Continues Cash_Balance / Sequence from the last passbook row per account.
 * - Self-re-triggers with lastAccount=<cursor> when near the function time limit,
 *   resuming exactly where it stopped.
 * - Queued from TempTransactionUpload with source=TxnUpload, importStartedAtMs, lastAccount="".
 *
 * Full rebuild: use Cal_CB_Per_TNX (manual / cron).
 */

const catalyst = require("zcatalyst-sdk-node");

const BATCH_SIZE = 300;
const CASH_UPLOAD_SOURCE = "TxnUpload";

/** Stop and re-trigger once a run has used this much wall-clock (function cap ~15 min). */
const TIME_BUDGET_MS = 13 * 60 * 1000;

/** Max distinct accounts pulled per keyset page (ZCQL row cap). */
const ACCOUNT_PAGE_SIZE = 300;

const CASH_ADD = [
  "CS+",
  "SL+",
  "CSI",
  "IN1",
  "IN+",
  "DIO",
  "DI0",
  "DI1",
  "OI1",
  "DIS",
  "SQS",
];
const CASH_SUBTRACT = [
  "BY-",
  "CS-",
  "MGF",
  "E22",
  "E01",
  "CUS",
  "E23",
  "MGE",
  "E10",
  "PRF",
  "NF-",
  "SQB",
  "TDO",
  "TDI",
];

const esc = (s) => String(s ?? "").replace(/'/g, "''");

function getJobParams(jobRequest) {
  try {
    if (jobRequest && typeof jobRequest.getAllJobParams === "function") {
      return jobRequest.getAllJobParams() || {};
    }
  } catch (e) {
    console.warn("getJobParams:", e.message);
  }
  return {};
}

function getJobSource(jobRequest) {
  return String(getJobParams(jobRequest).source ?? "").trim();
}

function parseImportStartedAtMs(jobRequest) {
  const p = getJobParams(jobRequest);
  const raw = p.importStartedAtMs ?? p.import_started_at_ms;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function createdTimeFloorFromMs(ms) {
  const d = new Date(ms - 15_000);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}:000`
  );
}

function parseLastAccount(jobRequest) {
  const p = getJobParams(jobRequest);
  return String(p.lastAccount ?? p.last_account ?? "").trim();
}

/**
 * Next page of distinct accounts touched by this import, in sorted order,
 * strictly after `cursor`. Keyset pagination — `WS_Account_code > cursor` walks
 * the same order `ORDER BY ... ASC` defines, so no account is skipped/repeated
 * regardless of the codes' shape, and it pages past the 300-row query cap.
 */
async function fetchNextAccountsPage(zcql, createdFloor, cursor) {
  const rows = await zcql.executeZCQLQuery(`
    SELECT DISTINCT WS_Account_code
    FROM Transaction
    WHERE CREATEDTIME >= '${createdFloor}'
      AND WS_Account_code > '${esc(cursor)}'
    ORDER BY WS_Account_code ASC
    LIMIT ${ACCOUNT_PAGE_SIZE}
  `);
  if (!rows || rows.length === 0) return [];
  const out = [];
  for (const row of rows) {
    const t = row.Transaction || row;
    const acc = String(t.WS_Account_code ?? "").trim();
    if (acc) out.push(acc);
  }
  return out;
}

function sortCashEvents(allEvents) {
  allEvents.sort((a, b) => {
    const dA = new Date(a.impactDate).getTime();
    const dB = new Date(b.impactDate).getTime();
    if (dA !== dB) return dA - dB;
    if (a.isInflow !== b.isInflow) return a.isInflow ? -1 : 1;
    if (a.executionPriority !== b.executionPriority) {
      return a.executionPriority - b.executionPriority;
    }
    return String(a.rowId).localeCompare(String(b.rowId));
  });
}

function mapInflow(t) {
  return {
    rowId: t.ROWID,
    trandate: t.TRANDATE || t.Setdate || "",
    setdate: t.SETDATE || t.Setdate || t.TRANDATE || "",
    executionPriority: Number(t.executionPriority) ?? 999,
    type: t.Tran_Type || "",
    securityName: t.Security_Name || "",
    netAmount: Number(t.Net_Amount) || 0,
    impactDate: (t.SETDATE || t.Setdate || t.TRANDATE || "").toString().slice(0, 10),
    isInflow: true,
    qty: Number(t.QTY) || 0,
    price: Number(t.NETRATE) || 0,
    isin: String(t.ISIN ?? "").trim() || "",
    stt: Number(t.STT || t.Stt) || 0,
  };
}

function mapOutflow(t) {
  return {
    rowId: t.ROWID,
    trandate: t.TRANDATE || t.Setdate || "",
    setdate: t.SETDATE || t.Setdate || t.TRANDATE || "",
    executionPriority: Number(t.executionPriority) ?? 999,
    type: t.Tran_Type || "",
    securityName: t.Security_Name || "",
    netAmount: Number(t.Net_Amount) || 0,
    impactDate: (t.TRANDATE || t.Trandate || t.Setdate || "").toString().slice(0, 10),
    isInflow: false,
    qty: Number(t.QTY) || 0,
    price: Number(t.NETRATE) || 0,
    isin: String(t.ISIN ?? "").trim() || "",
    stt: Number(t.STT || t.Stt) || 0,
  };
}

async function fetchBatched(zcql, baseQuery, mapper) {
  const rows = [];
  let offset = 0;
  while (true) {
    const query = baseQuery + ` LIMIT ${BATCH_SIZE} OFFSET ${offset}`;
    const batch = await zcql.executeZCQLQuery(query);
    if (!batch || batch.length === 0) break;
    for (const row of batch) {
      const t = row.Transaction || row;
      rows.push(mapper(t));
    }
    if (batch.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }
  return rows;
}

async function fetchNewTransactionEventsSinceImport(zcql, accountCode, importStartedAtMs) {
  const createdFloor = createdTimeFloorFromMs(importStartedAtMs);
  const inflowTypesList = CASH_ADD.map((t) => `'${esc(t)}'`).join(", ");
  const outflowTypesList = CASH_SUBTRACT.map((t) => `'${esc(t)}'`).join(", ");

  const inflowQuery = `
    SELECT ROWID, TRANDATE, SETDATE, executionPriority, Tran_Type, Security_Name, Net_Amount, QTY, WS_client_id, NETRATE, ISIN, STT
    FROM Transaction
    WHERE WS_Account_code = '${esc(accountCode)}'
      AND Tran_Type IN (${inflowTypesList})
      AND CREATEDTIME >= '${createdFloor}'
    ORDER BY SETDATE ASC, executionPriority ASC, ROWID ASC
  `;

  const outflowQuery = `
    SELECT ROWID, TRANDATE, SETDATE, executionPriority, Tran_Type, Security_Name, Net_Amount, QTY, WS_client_id, NETRATE, ISIN, STT
    FROM Transaction
    WHERE WS_Account_code = '${esc(accountCode)}'
      AND Tran_Type IN (${outflowTypesList})
      AND CREATEDTIME >= '${createdFloor}'
    ORDER BY TRANDATE ASC, executionPriority ASC, ROWID ASC
  `;

  const [inflowRows, outflowRows] = await Promise.all([
    fetchBatched(zcql, inflowQuery, mapInflow),
    fetchBatched(zcql, outflowQuery, mapOutflow),
  ]);

  return [...inflowRows, ...outflowRows];
}

async function getPassbookTail(zcql, accountCode) {
  const rows = await zcql.executeZCQLQuery(`
    SELECT Cash_Balance, Sequence
    FROM Cash_Balance_Per_Transaction
    WHERE Account_Code = '${esc(accountCode)}'
    ORDER BY Sequence DESC
    LIMIT 1
  `);

  if (!rows || rows.length === 0) {
    return null;
  }

  const row = rows[0].Cash_Balance_Per_Transaction || rows[0];
  const balance = Number(row.Cash_Balance) || 0;
  const sequence = Number(row.Sequence) || 0;
  return {
    balanceP: Math.round(balance * 100),
    sequence,
    usedOpeningCsPlus: sequence > 0,
  };
}

async function insertPassbookEvents(zcql, accountCode, events, state) {
  let { balanceP, sequence, usedOpeningCsPlus } = state;
  let inserted = 0;

  for (const row of events) {
    const { trandate, setdate, type, securityName, netAmount, isInflow, qty, price, isin, stt } =
      row;

    const sttP = Math.round(Math.abs(Number(stt ?? 0)) * 100) || 0;
    const amtP = Math.round(Math.abs(netAmount) * 100);

    if (!usedOpeningCsPlus && type === "CS+") {
      usedOpeningCsPlus = true;
      balanceP = amtP - sttP;
    } else if (isInflow) {
      balanceP += amtP - sttP;
    } else {
      balanceP -= amtP + sttP;
    }

    const txDate = String(trandate).slice(0, 10);
    const setDateStr = String(setdate).slice(0, 10);

    await zcql.executeZCQLQuery(`
      INSERT INTO Cash_Balance_Per_Transaction
      (Account_Code, Transaction_Type, Transaction_Date, Settlement_Date, Price, Cash_Balance, Security_Name, ISIN, Quantity, Total_Amount, STT, Sequence)
      VALUES (
        '${esc(accountCode)}',
        '${esc(type)}',
        '${txDate}',
        '${setDateStr}',
        ${Number(price)},
        ${Number((balanceP / 100).toFixed(2))},
        '${esc(securityName)}',
        '${esc(isin)}',
        ${Math.round(Number(qty ?? 0) || 0)},
        ${Number(netAmount)},
        ${Number(stt ?? 0)},
        ${sequence + 1}
      )
    `);
    sequence++;
    inserted++;
  }

  return {
    inserted,
    finalBalance: Number((balanceP / 100).toFixed(2)),
    balanceP,
    sequence,
    usedOpeningCsPlus,
  };
}

const DELETE_LOOP_MAX_ROUNDS = 500;

/**
 * Remove any passbook rows this import already wrote for the account — cash rows
 * are inserted while/after the import, so CREATEDTIME >= createdFloor isolates
 * exactly this import's rows. Makes a re-run after a mid-account crash safe:
 * the tail then reflects only pre-import rows and we rebuild this import cleanly.
 * Catalyst caps ~300 deletes per call, so repeat until none remain.
 */
async function deleteThisImportCashRowsForAccount(zcql, accountCode, createdFloor) {
  let rounds = 0;
  while (true) {
    const before = await zcql.executeZCQLQuery(`
      SELECT COUNT(ROWID) FROM Cash_Balance_Per_Transaction
      WHERE Account_Code = '${esc(accountCode)}' AND CREATEDTIME >= '${createdFloor}'
    `);
    const r = before?.[0]?.Cash_Balance_Per_Transaction || before?.[0] || {};
    const remaining = Number(
      r["COUNT(ROWID)"] ?? r.cnt ?? r["count"] ?? Object.values(r)[0] ?? 0,
    );
    if (remaining === 0) return;

    rounds++;
    if (rounds > DELETE_LOOP_MAX_ROUNDS) {
      throw new Error(
        `this-import cash delete for ${accountCode} exceeded ${DELETE_LOOP_MAX_ROUNDS} rounds (${remaining} left)`,
      );
    }

    await zcql.executeZCQLQuery(`
      DELETE FROM Cash_Balance_Per_Transaction
      WHERE Account_Code = '${esc(accountCode)}' AND CREATEDTIME >= '${createdFloor}'
    `);
  }
}

async function incrementalAppendForAccount(zcql, accountCode, importStartedAtMs) {
  const createdFloor = createdTimeFloorFromMs(importStartedAtMs);

  // Idempotency: clear anything this import already wrote for the account (in
  // case a previous run crashed mid-account) before re-appending.
  await deleteThisImportCashRowsForAccount(zcql, accountCode, createdFloor);

  const newEvents = await fetchNewTransactionEventsSinceImport(
    zcql,
    accountCode,
    importStartedAtMs,
  );

  if (newEvents.length === 0) {
    const tail = await getPassbookTail(zcql, accountCode);
    return {
      inserted: 0,
      finalBalance: tail ? Number((tail.balanceP / 100).toFixed(2)) : 0,
      skipped: true,
    };
  }

  sortCashEvents(newEvents);

  let state = await getPassbookTail(zcql, accountCode);
  if (!state) {
    state = { balanceP: 0, sequence: 0, usedOpeningCsPlus: false };
  }

  const result = await insertPassbookEvents(zcql, accountCode, newEvents, state);
  return { inserted: result.inserted, finalBalance: result.finalBalance, skipped: false };
}

/** Re-trigger this same function to resume after `lastAccount`. */
async function retriggerSelf(catalystApp, importStartedAtMs, lastAccount) {
  const scheduling = catalystApp.jobScheduling();
  await scheduling.JOB.submitJob({
    job_name: `CCB_${Date.now()}`.slice(0, 20),
    jobpool_name: "UpdateMasters",
    target_name: "Cal_CB_Append_TxnUpload",
    target_type: "Function",
    job_config: { number_of_retries: 5, retry_interval: 60 * 1000 },
    params: {
      source: CASH_UPLOAD_SOURCE,
      importStartedAtMs: String(importStartedAtMs),
      lastAccount: String(lastAccount),
    },
  });
}

module.exports = async (jobRequest, context) => {
  const catalystApp = catalyst.initialize(context);
  const zcql = catalystApp.zcql();

  const startedAt = Date.now();
  const importStartedAtMs = parseImportStartedAtMs(jobRequest);
  const counters = { accounts: 0, rows: 0, errors: 0, skipped: 0 };

  // Cursor = last fully-processed account, in WS_Account_code sort order.
  let cursor = parseLastAccount(jobRequest);

  try {
    if (getJobSource(jobRequest) !== CASH_UPLOAD_SOURCE) {
      console.error(
        `Cal_CB_Append_TxnUpload: requires source=${CASH_UPLOAD_SOURCE} — exiting.`,
      );
      context.closeWithFailure();
      return;
    }

    if (importStartedAtMs <= 0) {
      console.error(
        "Cal_CB_Append_TxnUpload: importStartedAtMs job param is required — exiting.",
      );
      context.closeWithFailure();
      return;
    }

    const createdFloor = createdTimeFloorFromMs(importStartedAtMs);

    console.log(
      `Cal_CB_Append_TxnUpload: run=incremental | importStartedAtMs=${importStartedAtMs} | ` +
        `createdFloor=${createdFloor} | resumeAfter="${cursor}"`,
    );

    // INNER LOOP — page through distinct accounts past the 300-row query cap.
    while (true) {
      const page = await fetchNextAccountsPage(zcql, createdFloor, cursor);
      if (page.length === 0) {
        console.log("Cal_CB_Append_TxnUpload: no more accounts — all done.");
        break;
      }

      for (const accountCode of page) {
        counters.accounts++;
        console.log(`\n===== Account #${counters.accounts}: ${accountCode} =====`);

        try {
          const result = await incrementalAppendForAccount(
            zcql,
            accountCode,
            importStartedAtMs,
          );
          counters.rows += result.inserted;
          if (result.skipped) counters.skipped++;

          console.log(
            `Account ${accountCode} done: ${result.inserted} row(s) appended` +
              `${result.skipped ? " (no new cash transactions for this import)" : ""}, ` +
              `final balance=${result.finalBalance}`,
          );
        } catch (err) {
          counters.errors++;
          console.error(`[${accountCode}] cash passbook append failed:`, err.message);
        }

        // Advance cursor only after the account is FULLY processed.
        cursor = accountCode;

        // TIMEOUT GUARD — hand the rest to a fresh run before the function dies.
        if (Date.now() - startedAt > TIME_BUDGET_MS) {
          console.log(
            `Cal_CB_Append_TxnUpload: time budget reached after ${counters.accounts} ` +
              `account(s). Re-triggering with lastAccount="${cursor}".`,
          );
          await retriggerSelf(catalystApp, importStartedAtMs, cursor);
          console.log(
            `Cal_CB_Append_TxnUpload partial run in ${Date.now() - startedAt}ms: ` +
              `${counters.accounts} account(s), ${counters.rows} row(s) appended, ` +
              `${counters.skipped} skipped, ${counters.errors} error(s).`,
          );
          context.closeWithSuccess();
          return;
        }
      }

      // Fewer than a full page → that was the last page.
      if (page.length < ACCOUNT_PAGE_SIZE) break;
    }

    console.log(
      `\nCal_CB_Append_TxnUpload completed in ${Date.now() - startedAt}ms: ` +
        `${counters.accounts} account(s), ${counters.rows} row(s) appended, ` +
        `${counters.skipped} skipped, ${counters.errors} error(s).`,
    );

    if (counters.errors > 0) {
      context.closeWithFailure();
      return;
    }
    context.closeWithSuccess();
  } catch (error) {
    console.error("Cal_CB_Append_TxnUpload failed:", error);
    context.closeWithFailure();
  }
};
