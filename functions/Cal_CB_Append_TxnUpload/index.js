/**
 * Cal_CB_Append_TxnUpload: Incremental cash passbook append after transaction CSV upload.
 *
 * - No DELETE. Appends new Transaction rows from this import only (CREATEDTIME >= importStartedAtMs).
 * - Continues Cash_Balance / Sequence from the last passbook row per account.
 * - Queued from TempTransactionUpload with source=TxnUpload, accountCodesJson, importStartedAtMs.
 *
 * Full rebuild: use Cal_CB_Per_TNX (manual / cron).
 */

const catalyst = require("zcatalyst-sdk-node");

const BATCH_SIZE = 300;
const CASH_UPLOAD_SOURCE = "TxnUpload";

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

function parseAccountCodesFromJob(jobRequest) {
  try {
    const p = getJobParams(jobRequest);
    const raw = p.accountCodesJson ?? p.account_codes_json;
    if (raw == null || raw === "") return [];
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr) || arr.length === 0) return [];
    const out = [];
    const seen = new Set();
    for (const item of arr) {
      let acc = "";
      if (typeof item === "string") {
        acc = item.trim();
      } else if (Array.isArray(item) && item.length >= 1) {
        acc = String(item[0] ?? "").trim();
      } else if (item && typeof item === "object") {
        acc = String(
          item.wsAccountCode ?? item.account ?? item.WS_Account_code ?? "",
        ).trim();
      }
      if (!acc || seen.has(acc)) continue;
      seen.add(acc);
      out.push(acc);
    }
    return out.sort((a, b) => a.localeCompare(b));
  } catch (e) {
    console.warn("parseAccountCodesFromJob:", e.message);
    return [];
  }
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

async function incrementalAppendForAccount(zcql, accountCode, importStartedAtMs) {
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

module.exports = async (jobRequest, context) => {
  const catalystApp = catalyst.initialize(context);
  const zcql = catalystApp.zcql();

  const startedAt = Date.now();
  const importStartedAtMs = parseImportStartedAtMs(jobRequest);
  const accounts = parseAccountCodesFromJob(jobRequest);
  const counters = { accounts: 0, rows: 0, errors: 0, skipped: 0 };

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

    if (accounts.length === 0) {
      console.warn(
        "Cal_CB_Append_TxnUpload: no accounts in accountCodesJson — exiting.",
      );
      context.closeWithSuccess();
      return;
    }

    console.log(
      `Cal_CB_Append_TxnUpload: ${accounts.length} account(s) | run=incremental | ` +
        `importStartedAtMs=${importStartedAtMs}`,
    );

    for (let ai = 0; ai < accounts.length; ai++) {
      const accountCode = accounts[ai];
      counters.accounts++;
      console.log(`\n===== Account ${ai + 1}/${accounts.length}: ${accountCode} =====`);

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
