/**
 * CalculateHoldingsPerAccount (Catalyst Job Function)
 *
 * This is the job deployment (type job) mirroring the former event function logic.
 *
 * Reads Transaction only, runs the same FIFO engine as AppSail analytics
 * (`util/analytics/transactionHistory/fifo.js`) for buy/sell events, and materializes
 * the per-(account, ISIN) FIFO timeline into the Holdings table.
 * Bonus / Split / Demerger / Merger are not loaded here — supply via other methods later.
 *
 * Holdings columns it writes:
 *   WS_Account_code, TRANSACTION_DATE, SETTLEMENT_DATE, TYPE, ISIN,
 *   QUANTITY, PRICE, TOTAL_AMOUNT, HOLDING, WAP, HOLDING_VALUE, P_L, STATUS
 *
 * Row order within a pair is preserved by INSERT order — reads should use the same ORDER BY
 * as AppSail `HOLDINGS_FIFO_ORDER_BY_SQL` (`CREATEDTIME ASC, ROWID ASC`), not settlement-only.
 *
 * Per account: one paged read of Transaction (NOT per pair), then FIFO per ISIN.
 *
 * TxnUpload (`source=TxnUpload` + `pairsJson`): append mode — FIFO replays all
 * transactions for the ISIN (correct sells), then INSERT only new tail rows into
 * Holdings (no DELETE). Full rebuild when not TxnUpload or when tail is shorter than existing.
 *
 * Configure ACCOUNTS_FILTER / ISINS_FILTER / MAX_PAIRS / DRY_RUN below for test
 * runs. Deploy and invoke from the Catalyst console (or via the configured
 * trigger). Optionally pass non-empty `jobName` via `jobRequest.getAllJobParams()`
 * so this function writes `Jobs` / `JobStatusPerAccount` for retries and UX; omit
 * `jobName` for legacy/test runs — no Job tables are touched.
 */

const catalyst = require("zcatalyst-sdk-node");

/* ============================== CONFIG ============================== */

/** Non-empty array = process only these WS_Account_code values; empty = all accounts found in Transaction. */
const ACCOUNTS_FILTER = ["AYAN002"];
/** Non-empty array = process only these ISINs (within selected accounts); empty = all ISINs for the account. */
const ISINS_FILTER = ["INE117A01022"];

/** Hard cap on number of (account, ISIN) pairs processed; 0 = unlimited. Useful for first event-fire tests. */
const MAX_PAIRS = 0;

/** YYYY-MM-DD inclusive cutoff for source data, or null for full history. */
const AS_ON_DATE = null;

/** When true, computes everything but does not DELETE/INSERT into Holdings (safe smoke test). */
const DRY_RUN = false;

/** ZCQL paging size. */
const BATCH = 250;

/* ============================== HELPERS ============================== */

const esc = (s) => String(s ?? "").replace(/'/g, "''");

/** When tracking is enabled, written to JobStatusPerAccount.jobType unless params.jobType overrides. */
const HOLDINGS_JOB_TYPE_DEFAULT = "HOLDINGS_FULL_REBUILD";

/** AppSail upload-temp-file sets this — job must not fall back to full DB rebuild. */
const HOLDINGS_UPLOAD_SOURCE = "TxnUpload";

/* ---------------- Optional Jobs / JobStatusPerAccount (see file header) ---------------- */

function extractJobParams(jobRequest) {
  try {
    if (jobRequest && typeof jobRequest.getAllJobParams === "function") {
      const p = jobRequest.getAllJobParams() || {};
      return {
        jobName: String(p.jobName ?? "").trim(),
        jobType: String(p.jobType ?? "").trim() || HOLDINGS_JOB_TYPE_DEFAULT,
      };
    }
  } catch (e) {
    console.warn("extractJobParams:", e.message);
  }
  return { jobName: "", jobType: HOLDINGS_JOB_TYPE_DEFAULT };
}

/**
 * Parses `pairsJson` job param from upload-temp-file: JSON array of [WS_Account_code, ISIN] or { wsAccountCode, isin }.
 * @returns {Array<[string, string]>}
 */
function parseScopedPairsFromJob(jobRequest) {
  try {
    if (!jobRequest || typeof jobRequest.getAllJobParams !== "function") {
      return [];
    }
    const p = jobRequest.getAllJobParams() || {};
    const raw = p.pairsJson ?? p.pairs_json;
    if (raw == null || raw === "") return [];
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr) || arr.length === 0) return [];
    const out = [];
    const seen = new Set();
    for (const item of arr) {
      let a = "";
      let i = "";
      if (Array.isArray(item) && item.length >= 2) {
        a = String(item[0] ?? "").trim();
        i = String(item[1] ?? "").trim();
      } else if (item && typeof item === "object") {
        a = String(item.wsAccountCode ?? item.account ?? "").trim();
        i = String(item.isin ?? "").trim();
      }
      if (!a || !i) continue;
      const k = `${a}\t${i}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([a, i]);
    }
    return out;
  } catch (e) {
    console.warn("parseScopedPairsFromJob:", e.message);
    return [];
  }
}

function getJobSource(jobRequest) {
  try {
    if (jobRequest && typeof jobRequest.getAllJobParams === "function") {
      const p = jobRequest.getAllJobParams() || {};
      return String(p.source ?? "").trim();
    }
  } catch (e) {
    console.warn("getJobSource:", e.message);
  }
  return "";
}

function parseImportStartedAtMs(jobRequest) {
  try {
    if (!jobRequest || typeof jobRequest.getAllJobParams !== "function") {
      return 0;
    }
    const p = jobRequest.getAllJobParams() || {};
    const raw = p.importStartedAtMs ?? p.import_started_at_ms;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch (e) {
    console.warn("parseImportStartedAtMs:", e.message);
    return 0;
  }
}

function rowFromJobStatusRow(r) {
  if (!r) return null;
  return r.JobStatusPerAccount || r;
}

async function ensureJobsRowRunning(zcql, jobName) {
  try {
    await zcql.executeZCQLQuery(
      `INSERT INTO Jobs (jobName, status) VALUES ('${esc(jobName)}', 'RUNNING')`,
    );
  } catch (insertErr) {
    try {
      await zcql.executeZCQLQuery(
        `UPDATE Jobs SET status = 'RUNNING' WHERE jobName = '${esc(jobName)}'`,
      );
    } catch (upErr) {
      console.warn(`[Jobs] ensure RUNNING failed for ${jobName}:`, upErr.message);
    }
  }
}

async function finalizeJobsRow(zcql, jobName, status) {
  if (!jobName) return;
  try {
    await zcql.executeZCQLQuery(
      `UPDATE Jobs SET status = '${esc(status)}' WHERE jobName = '${esc(jobName)}'`,
    );
  } catch (e) {
    console.error(`[Jobs] finalize failed for ${jobName}:`, e.message);
  }
}

async function getPerAccountJobStatus(zcql, jobName, accountCode) {
  try {
    const rows = await zcql.executeZCQLQuery(`
      SELECT status FROM JobStatusPerAccount
      WHERE jobName = '${esc(jobName)}' AND WS_Account_code = '${esc(accountCode)}'
      LIMIT 1
    `);
    if (!rows?.length) return "";
    const st = rowFromJobStatusRow(rows[0]);
    return String(st?.status ?? "").trim();
  } catch (e) {
    console.warn("[JobStatusPerAccount] read status failed:", e.message);
    return "";
  }
}

async function upsertAccountRowRunning(zcql, jobName, jobType, accountCode) {
  try {
    await zcql.executeZCQLQuery(`
      INSERT INTO JobStatusPerAccount (jobType, WS_Account_code, status, lastError, jobName)
      VALUES (
        '${esc(jobType)}',
        '${esc(accountCode)}',
        'RUNNING',
        '',
        '${esc(jobName)}'
      )
    `);
  } catch (insertErr) {
    try {
      await zcql.executeZCQLQuery(`
        UPDATE JobStatusPerAccount
        SET status = 'RUNNING', lastError = '', jobType = '${esc(jobType)}'
        WHERE jobName = '${esc(jobName)}' AND WS_Account_code = '${esc(accountCode)}'
      `);
    } catch (upErr) {
      console.warn(
        `[JobStatusPerAccount] upsert RUNNING failed ${accountCode}:`,
        upErr.message,
      );
    }
  }
}

async function markAccountSuccess(zcql, jobName, accountCode) {
  try {
    await zcql.executeZCQLQuery(`
      UPDATE JobStatusPerAccount
      SET status = 'SUCCESS', lastError = ''
      WHERE jobName = '${esc(jobName)}' AND WS_Account_code = '${esc(accountCode)}'
    `);
  } catch (e) {
    console.warn(`[JobStatusPerAccount] mark SUCCESS failed ${accountCode}:`, e.message);
  }
}

async function markAccountFailed(zcql, jobName, accountCode, errMsg) {
  const msg = esc(String(errMsg || "UNKNOWN").slice(0, 500));
  try {
    await zcql.executeZCQLQuery(`
      UPDATE JobStatusPerAccount
      SET status = 'FAILED', lastError = '${msg}'
      WHERE jobName = '${esc(jobName)}' AND WS_Account_code = '${esc(accountCode)}'
    `);
  } catch (e) {
    console.warn(`[JobStatusPerAccount] mark FAILED failed ${accountCode}:`, e.message);
  }
}

const sqlDate = (v) => {
  const s = String(v ?? "").trim().slice(0, 10);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
};

const isBuyType = (type) => /^BY-|SQB|OPI/i.test(String(type || ""));

const getEffectiveDate = (r) => {
  const setDate = r.SETDATE || r.setdate;
  const tradeDate = r.TRANDATE || r.trandate;
  return isBuyType(r.Tran_Type || r.tranType)
    ? setDate || tradeDate
    : tradeDate || setDate;
};

const nextDayCutoff = (asOnDate) => {
  if (!asOnDate || !/^\d{4}-\d{2}-\d{2}$/.test(asOnDate)) return null;
  const nextDay = new Date(asOnDate);
  nextDay.setDate(nextDay.getDate() + 1);
  return nextDay.toISOString().split("T")[0];
};

/* ============================== FETCH (batched per account) ============================== */

async function fetchDistinctAccounts(zcql) {
  const codes = new Set();
  let offset = 0;
  while (true) {
    const batch = await zcql.executeZCQLQuery(`
      SELECT WS_Account_code FROM Transaction
      WHERE WS_Account_code IS NOT NULL AND WS_Account_code != ''
      ORDER BY ROWID ASC
      LIMIT ${BATCH} OFFSET ${offset}
    `);
    if (!batch || batch.length === 0) break;
    for (const row of batch) {
      const t = row.Transaction || row;
      const c = String(t.WS_Account_code ?? "").trim();
      if (c) codes.add(c);
    }
    if (batch.length < BATCH) break;
    offset += BATCH;
  }
  let list = [...codes].sort((a, b) => a.localeCompare(b));
  if (ACCOUNTS_FILTER.length > 0) {
    const allow = new Set(ACCOUNTS_FILTER.map(String));
    list = list.filter((c) => allow.has(c));
  }
  return list;
}

async function fetchAccountTransactions(zcql, accountCode, asOnDate) {
  const cutoff = nextDayCutoff(asOnDate);
  const dateClause = cutoff
    ? ` AND (TRANDATE < '${cutoff}' OR SETDATE < '${cutoff}')`
    : "";

  const rows = [];
  const seen = new Set();
  let offset = 0;
  while (true) {
    try {
      const batch = await zcql.executeZCQLQuery(`
        SELECT TRANDATE, SETDATE, Tran_Type, QTY, NETRATE, Net_Amount, ISIN, ROWID
        FROM Transaction
        WHERE WS_Account_code = '${esc(accountCode)}'
        ${dateClause}
        ORDER BY SETDATE ASC, ROWID ASC
        LIMIT ${BATCH} OFFSET ${offset}
      `);
      if (!batch || batch.length === 0) break;
      for (const row of batch) {
        const r = row.Transaction || row;
        if (r.ROWID && seen.has(r.ROWID)) continue;
        if (r.ROWID) seen.add(r.ROWID);
        rows.push(r);
      }
      if (batch.length < BATCH) break;
      offset += BATCH;
    } catch (err) {
      console.error(`fetchAccountTransactions[${accountCode}] offset=${offset}:`, err.message);
      break;
    }
  }

  return cutoff
    ? rows.filter((r) => {
        const d = getEffectiveDate(r);
        return !d || d < cutoff;
      })
    : rows;
}

/* ============================== FIFO ENGINE (mirror of analytics fifo.js) ============================== */

/**
 * Tie-breaker for events that share the same date.
 * SPLIT must be processed BEFORE BONUS so that bonus shares (stored in the DB
 * as the post-split count) are not multiplied a second time by the split.
 */
const EVENT_TYPE_PRIORITY = {
  TXN: 0,
  SPLIT: 1,
  BONUS: 2,
  DEMERGER: 3,
  MERGER: 4,
};

function runFifoEngine(
  transactions = [],
  bonuses = [],
  splits = [],
  card = false,
  demergers = [],
  mergers = [],
) {
  const activeIsin =
    transactions[0]?.ISIN ||
    transactions[0]?.isin ||
    bonuses[0]?.ISIN ||
    bonuses[0]?.isin ||
    splits[0]?.isin ||
    demergers[0]?.ISIN ||
    demergers[0]?.isin ||
    mergers[0]?.ISIN ||
    mergers[0]?.isin ||
    null;

  let holdings = 0;
  let lotCounter = 0;
  const buyQueue = [];
  const output = [];
  let lastMergerEventKey = null;

  const normalizeDate = (rawDate) => {
    if (!rawDate) return null;
    const [y, m, d] = String(rawDate).split("-").map(Number);
    const fullYear = y < 100 ? 2000 + y : y;
    return `${fullYear}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };

  const isBuy = (type) => /^BY-|SQB|OPI/.test(String(type || "").toUpperCase());

  const getTxnEventDate = (t) => {
    const setDate = t.SETDATE || t.setdate;
    const tradeDate = t.TRANDATE || t.trandate;
    return isBuy(t.Tran_Type || t.tranType) ? setDate || tradeDate : tradeDate || setDate;
  };

  const events = [
    ...transactions
      .filter((t) => (t.ISIN || t.isin) === activeIsin)
      .map((t) => {
        const eventDate = getTxnEventDate(t);
        return {
          type: "TXN",
          date: normalizeDate(eventDate),
          data: {
            tranType: t.Tran_Type || t.tranType,
            qty: t.QTY || t.qty,
            netrate: t.NETRATE || t.netrate,
            netAmount: t.NETAMOUNT || t.netAmount || t.Net_Amount || 0,
            trandate: eventDate,
            originalTrandate: t.TRANDATE || t.trandate || null,
            setdate: t.SETDATE || t.setdate || null,
            isin: t.ISIN || t.isin,
          },
        };
      }),
    ...bonuses
      .filter((b) => (b.ISIN || b.isin) === activeIsin)
      .map((b) => ({
        type: "BONUS",
        date: normalizeDate(b.ExDate || b.exDate),
        data: {
          bonusShare: b.BonusShare || b.bonusShare,
          exDate: b.ExDate || b.exDate,
          isin: b.ISIN || b.isin,
        },
      })),
    ...splits
      .filter((s) => s.isin === activeIsin)
      .map((s) => ({
        type: "SPLIT",
        date: normalizeDate(s.issueDate),
        data: {
          ratio1: s.ratio1,
          ratio2: s.ratio2,
          issueDate: s.issueDate,
          isin: s.isin,
        },
      })),
    ...demergers
      .filter((d) => (d.ISIN || d.isin) === activeIsin)
      .map((d) => {
        const td = d.TRANDATE || d.trandate;
        return {
          type: "DEMERGER",
          date: normalizeDate(td),
          data: {
            qty: d.QTY ?? d.qty,
            price: d.PRICE ?? d.price,
            totalAmount:
              Number(d.TOTAL_AMOUNT ?? d.total_amount ?? d.HOLDING_VALUE ?? 0) || 0,
            trandate: td,
            setdate: d.SETDATE || d.setdate || td,
            isin: d.ISIN || d.isin,
          },
        };
      }),
    ...mergers
      .filter((m) => (m.ISIN || m.isin) === activeIsin)
      .map((m) => {
        const td = m.TRANDATE || m.trandate;
        return {
          type: "MERGER",
          date: normalizeDate(td),
          data: {
            qty: Number(m.Quantity ?? m.quantity ?? m.Holding ?? 0) || 0,
            price: Number(m.WAP ?? m.wap ?? 0) || 0,
            totalAmount: Number(m.Total_Amount ?? m.total_amount ?? m.HoldingValue ?? 0) || 0,
            trandate: td,
            setdate: m.SETDATE || m.setdate || td,
            isin: m.ISIN || m.isin,
            oldIsin: m.OldISIN || m.oldIsin || "",
          },
        };
      }),
  ].sort((a, b) => {
    const dateDiff = new Date(a.date) - new Date(b.date);
    if (dateDiff !== 0) return dateDiff;
    return (EVENT_TYPE_PRIORITY[a.type] ?? 99) - (EVENT_TYPE_PRIORITY[b.type] ?? 99);
  });

  const isSell = (t) => /^SL\+|SQS|OPO|NF-/.test(String(t).toUpperCase());

  const getCostOfHoldings = () =>
    buyQueue.reduce((sum, lot) => sum + lot.qty * lot.price, 0);

  const getWAP = () => (holdings > 0 ? getCostOfHoldings() / holdings : 0);

  for (const e of events) {
    const t = e.data;

    if (e.type === "TXN") {
      const qty = Math.abs(Number(t.qty) || 0);
      if (!qty) continue;

      const price =
        Number(t.netrate) || (t.netAmount && qty ? t.netAmount / qty : 0);

      if (
        String(t.tranType).toUpperCase() === "OPI" &&
        qty == 1 &&
        Number(price) === 0 &&
        Number(t.netAmount) === 0
      ) {
        continue;
      }

      if (isBuy(t.tranType)) {
        const lotId = ++lotCounter;
        buyQueue.push({
          lotId,
          originalQty: qty,
          qty,
          price,
          buyDate: normalizeDate(t.trandate),
          isActive: true,
        });
        holdings += qty;
        output.push({
          lotId,
          trandate: t.trandate,
          originalTrandate: t.originalTrandate,
          setdate: t.setdate,
          tranType: t.tranType,
          qty,
          price,
          netAmount: t.netAmount,
          holdings,
          costOfHoldings: getCostOfHoldings(),
          averageCostOfHoldings: getWAP(),
          profitLoss: null,
          isActive: true,
          isin: t.ISIN || t.isin,
        });
      }

      if (isSell(t.tranType)) {
        const sellQty = Math.min(qty, holdings);
        let remaining = sellQty;
        let fifoCost = 0;

        while (remaining > 0 && buyQueue.length) {
          const lot = buyQueue[0];
          const used = Math.min(lot.qty, remaining);
          fifoCost += used * lot.price;
          lot.qty -= used;
          remaining -= used;
          if (lot.qty === 0) {
            lot.isActive = false;
            buyQueue.shift();
          }
        }

        holdings -= sellQty;

        output.push({
          trandate: t.trandate,
          originalTrandate: t.originalTrandate,
          setdate: t.setdate,
          tranType: t.tranType,
          qty,
          price,
          netAmount: t.netAmount,
          holdings,
          costOfHoldings: getCostOfHoldings(),
          averageCostOfHoldings: getWAP(),
          profitLoss: sellQty * price - fifoCost,
          isActive: false,
          isin: t.ISIN || t.isin,
        });
      }
    }

    if (e.type === "BONUS") {
      const qty = Number(e.data.bonusShare) || 0;
      if (!qty) continue;

      const lotId = ++lotCounter;
      buyQueue.push({
        lotId,
        originalQty: qty,
        qty,
        price: 0,
        buyDate: normalizeDate(e.data.exDate),
        isActive: true,
      });
      holdings += qty;
      output.push({
        lotId,
        trandate: e.data.exDate,
        tranType: "BONUS",
        qty,
        price: 0,
        netAmount: 0,
        holdings,
        costOfHoldings: getCostOfHoldings(),
        averageCostOfHoldings: getWAP(),
        profitLoss: null,
        isActive: true,
        isin: e.data.isin,
      });
    }

    if (e.type === "SPLIT") {
      if (!buyQueue.length) continue;
      const ratio1 = Number(e.data.ratio1);
      const ratio2 = Number(e.data.ratio2);
      if (!ratio1 || !ratio2) continue;

      const multiplier = ratio2 / ratio1;
      const splitDate = normalizeDate(e.data.issueDate);
      const activeLots = buyQueue.filter((l) => l.isActive);
      if (!activeLots.length) continue;

      for (const oldLot of activeLots) {
        oldLot.isActive = false;
        const oldRow = output.find((r) => r.lotId === oldLot.lotId && r.isActive);
        if (oldRow) oldRow.isActive = false;
      }
      buyQueue.length = 0;

      let runningHoldings = 0;
      let runningCost = 0;

      for (let i = 0; i < activeLots.length; i++) {
        const oldLot = activeLots[i];
        const newQty = oldLot.qty * multiplier;
        const newPrice = oldLot.price / multiplier;
        const newLotId = ++lotCounter;

        buyQueue.push({
          lotId: newLotId,
          originalQty: newQty,
          qty: newQty,
          price: newPrice,
          buyDate: splitDate,
          isActive: true,
        });

        runningHoldings += newQty;
        runningCost += newQty * newPrice;
        const runningWAP = runningHoldings > 0 ? runningCost / runningHoldings : 0;

        const buyRowIndex = output.findIndex((r) => r.lotId === oldLot.lotId);
        let insertIndex = output.length;
        for (let j = buyRowIndex + 1; j < output.length; j++) {
          if (new Date(output[j].trandate) > new Date(splitDate)) {
            insertIndex = j;
            break;
          }
        }

        output.splice(insertIndex, 0, {
          lotId: newLotId,
          trandate: splitDate,
          tranType: "SPLIT",
          qty: newQty,
          price: newPrice,
          netAmount: Number((newQty * newPrice).toFixed(2)),
          holdings: runningHoldings,
          costOfHoldings: runningCost,
          averageCostOfHoldings: runningWAP,
          profitLoss: null,
          isActive: true,
          isin: e.data.isin,
        });
      }

      holdings = runningHoldings;
    }

    if (e.type === "DEMERGER") {
      const qty = Math.abs(Number(e.data.qty) || 0);
      if (!qty) continue;

      let price = Number(e.data.price) || 0;
      let totalAmount = Number(e.data.totalAmount) || 0;
      if (!price && totalAmount && qty) price = totalAmount / qty;
      if (!totalAmount && price && qty) totalAmount = qty * price;

      const activeLots = buyQueue.filter((l) => l.isActive);
      for (const oldLot of activeLots) {
        oldLot.isActive = false;
        const oldRow = output.find((r) => r.lotId === oldLot.lotId && r.isActive);
        if (oldRow) oldRow.isActive = false;
      }
      buyQueue.length = 0;

      const demergerDate = normalizeDate(e.data.trandate);
      const lotId = ++lotCounter;

      buyQueue.push({
        lotId,
        originalQty: qty,
        qty,
        price,
        buyDate: demergerDate,
        isActive: true,
      });

      holdings = qty;

      output.push({
        lotId,
        trandate: e.data.trandate,
        originalTrandate: e.data.trandate,
        setdate: e.data.setdate,
        tranType: "DEMERGER",
        qty,
        price,
        netAmount: totalAmount,
        holdings,
        costOfHoldings: getCostOfHoldings(),
        averageCostOfHoldings: getWAP(),
        profitLoss: null,
        isActive: true,
        isin: e.data.isin,
      });
    }

    if (e.type === "MERGER") {
      const qty = Math.abs(Number(e.data.qty) || 0);
      if (!qty) continue;

      let price = Number(e.data.price) || 0;
      let totalAmount = Number(e.data.totalAmount) || 0;
      if (!price && totalAmount && qty) price = totalAmount / qty;
      if (!totalAmount && price && qty) totalAmount = qty * price;

      const mergerDate = normalizeDate(e.data.trandate);
      const eventKey = `${mergerDate}|${e.data.oldIsin || ""}`;

      if (eventKey !== lastMergerEventKey) {
        const activeLots = buyQueue.filter((l) => l.isActive);
        for (const oldLot of activeLots) {
          oldLot.isActive = false;
          const oldRow = output.find((r) => r.lotId === oldLot.lotId && r.isActive);
          if (oldRow) oldRow.isActive = false;
        }
        buyQueue.length = 0;
        holdings = 0;
        lastMergerEventKey = eventKey;
      }

      const lotId = ++lotCounter;

      buyQueue.push({
        lotId,
        originalQty: qty,
        qty,
        price,
        buyDate: mergerDate,
        isActive: true,
      });

      holdings += qty;

      output.push({
        lotId,
        trandate: e.data.trandate,
        originalTrandate: e.data.trandate,
        setdate: e.data.setdate,
        tranType: "MERGER",
        qty,
        price,
        netAmount: totalAmount,
        holdings,
        costOfHoldings: getCostOfHoldings(),
        averageCostOfHoldings: getWAP(),
        profitLoss: null,
        isActive: true,
        isin: e.data.isin,
      });
    }
  }

  if (card) {
    if (!output.length) {
      return {
        isin: "",
        holdings: 0,
        holdingValue: 0,
        averageCostOfHoldings: 0,
      };
    }
    const last = output[output.length - 1];
    return {
      isin: last.isin || "",
      holdings: last.holdings || 0,
      holdingValue: last.costOfHoldings || 0,
      averageCostOfHoldings: last.averageCostOfHoldings || 0,
    };
  }

  return output;
}

/* ============================== HOLDINGS WRITER ============================== */

async function deleteHoldingsForPair(zcql, accountCode, isin) {
  await zcql.executeZCQLQuery(`
    DELETE FROM Holdings
    WHERE WS_Account_code = '${esc(accountCode)}' AND ISIN = '${esc(isin)}'
  `);
}

/** Row count for append mode (same order as reads: CREATEDTIME ASC, ROWID ASC). */
async function countHoldingsRowsForPair(zcql, accountCode, isin) {
  let count = 0;
  let offset = 0;
  while (true) {
    const batch = await zcql.executeZCQLQuery(`
      SELECT ROWID FROM Holdings
      WHERE WS_Account_code = '${esc(accountCode)}' AND ISIN = '${esc(isin)}'
      ORDER BY CREATEDTIME ASC, ROWID ASC
      LIMIT ${BATCH} OFFSET ${offset}
    `);
    if (!batch || batch.length === 0) break;
    count += batch.length;
    if (batch.length < BATCH) break;
    offset += BATCH;
  }
  return count;
}

/**
 * Full rebuild (delete + insert all) or TxnUpload append (insert tail only after FIFO replay).
 * @param {{ appendOnly?: boolean }} writeOpts
 */
async function writeHoldingsForPair(
  zcql,
  accountCode,
  isin,
  fifoRows,
  counters,
  writeOpts = {},
) {
  const appendOnly = Boolean(writeOpts.appendOnly);
  const rowCount = Array.isArray(fifoRows) ? fifoRows.length : 0;

  if (DRY_RUN) {
    if (appendOnly && rowCount > 0) {
      const existing = await countHoldingsRowsForPair(zcql, accountCode, isin);
      const appendN = Math.max(0, rowCount - existing);
      console.log(
        `[DRY_RUN][${accountCode}/${isin}] would append ${appendN} row(s) (${existing} existing, ${rowCount} fifo)`,
      );
      counters.rows += appendN;
    } else {
      console.log(
        `[DRY_RUN][${accountCode}/${isin}] would write ${rowCount} row(s)`,
      );
      counters.rows += rowCount;
    }
    return;
  }

  if (!rowCount) {
    if (!appendOnly) {
      try {
        await deleteHoldingsForPair(zcql, accountCode, isin);
      } catch (err) {
        console.error(`[${accountCode}/${isin}] delete (empty) failed:`, err.message);
        counters.errors++;
      }
    }
    return;
  }

  try {
    if (appendOnly) {
      const existingCount = await countHoldingsRowsForPair(zcql, accountCode, isin);

      if (rowCount < existingCount) {
        console.warn(
          `[${accountCode}/${isin}] FIFO ${rowCount} row(s) < Holdings ${existingCount} — full rebuild`,
        );
        await deleteHoldingsForPair(zcql, accountCode, isin);
        for (const r of fifoRows) {
          await insertHoldingsRow(zcql, accountCode, r, isin);
        }
        counters.rows += rowCount;
        return;
      }

      if (rowCount === existingCount) {
        console.log(`[${accountCode}/${isin}] append: no new Holdings rows`);
        return;
      }

      const toAppend = fifoRows.slice(existingCount);
      for (const r of toAppend) {
        await insertHoldingsRow(zcql, accountCode, r, isin);
      }
      counters.rows += toAppend.length;
      console.log(
        `[${accountCode}/${isin}] appended ${toAppend.length} row(s) (${existingCount} unchanged)`,
      );
      return;
    }

    await deleteHoldingsForPair(zcql, accountCode, isin);
    for (const r of fifoRows) {
      await insertHoldingsRow(zcql, accountCode, r, isin);
    }
    counters.rows += rowCount;
  } catch (err) {
    console.error(
      `[${accountCode}/${isin}] ${appendOnly ? "append" : "rebuild"} failed:`,
      err.message,
    );
    counters.errors++;
  }
}

async function insertHoldingsRow(zcql, accountCode, row, displayIsin) {
  const txD = sqlDate(row.originalTrandate || row.trandate);
  const setD = sqlDate(row.setdate || row.trandate);
  const typ = String(row.tranType ?? "").trim();
  const qty = Number(row.qty) || 0;
  const price = Number(row.price) || 0;
  const totalAmt = Number(row.netAmount) || 0;
  const holding = Number(row.holdings) || 0;
  const wap = Number(row.averageCostOfHoldings) || 0;
  const hv = Number(row.costOfHoldings) || 0;
  const pl =
    row.profitLoss === null || row.profitLoss === undefined
      ? "NULL"
      : Number(row.profitLoss);
  const status = row.isActive ? "true" : "false";

  await zcql.executeZCQLQuery(`
    INSERT INTO Holdings (
      WS_Account_code, TRANSACTION_DATE, SETTLEMENT_DATE, TYPE, ISIN,
      QUANTITY, PRICE, TOTAL_AMOUNT, HOLDING, WAP, HOLDING_VALUE, P_L, STATUS
    ) VALUES (
      '${esc(accountCode)}',
      '${esc(txD)}',
      '${esc(setD)}',
      '${esc(typ)}',
      '${esc(displayIsin)}',
      ${qty},
      ${price},
      ${totalAmt},
      ${holding},
      ${wap},
      ${hv},
      ${pl},
      ${status}
    )
  `);
}

/* ============================== PER-ACCOUNT REBUILD ============================== */

async function rebuildHoldingsForAccount(
  zcql,
  accountCode,
  asOnDate,
  counters,
  scopedIsinsSet = null,
  writeOpts = {},
) {
  const t0 = Date.now();

  const transactions = await fetchAccountTransactions(zcql, accountCode, asOnDate);

  const isins = new Set();
  for (const t of transactions) if (t.ISIN) isins.add(t.ISIN);

  let isinList = [...isins];
  if (!scopedIsinsSet || scopedIsinsSet.size === 0) {
    if (ISINS_FILTER.length > 0) {
      const allow = new Set(ISINS_FILTER.map(String));
      isinList = isinList.filter((i) => allow.has(i));
    }
  }

  const txByIsin = {};
  for (const t of transactions) {
    if (!t.ISIN) continue;
    (txByIsin[t.ISIN] = txByIsin[t.ISIN] || []).push(t);
  }

  let targetIsins;
  if (scopedIsinsSet && scopedIsinsSet.size > 0) {
    targetIsins = [...scopedIsinsSet].filter(Boolean).sort((a, b) => a.localeCompare(b));
  } else {
    targetIsins = isinList;
  }

  console.log(
    `[${accountCode}] tx=${transactions.length} ` +
      `scoped=${scopedIsinsSet && scopedIsinsSet.size > 0 ? scopedIsinsSet.size : "off"} ` +
      `append=${writeOpts.appendOnly ? "yes" : "no"} ` +
      `pairs=${targetIsins.length} (fetched in ${Date.now() - t0}ms)`,
  );

  for (const isin of targetIsins) {
    if (MAX_PAIRS > 0 && counters.pairs >= MAX_PAIRS) {
      console.log(`MAX_PAIRS=${MAX_PAIRS} reached, stopping early`);
      return;
    }

    counters.pairs++;

    let fifoRows;
    try {
      fifoRows = runFifoEngine(txByIsin[isin] || [], [], [], false, [], []);
    } catch (err) {
      console.error(`[${accountCode}/${isin}] FIFO failed:`, err.message);
      counters.errors++;
      continue;
    }

    await writeHoldingsForPair(zcql, accountCode, isin, fifoRows, counters, writeOpts);
  }
}

/* ============================== ENTRY ============================== */

module.exports = async (jobRequest, context) => {
  const app = catalyst.initialize(context);
  const zcql = app.zcql();

  const { jobName: trackingJobName, jobType: trackingJobType } =
    extractJobParams(jobRequest);
  const trackingOn = Boolean(trackingJobName);

  const startedAt = Date.now();

  try {
    const scopedPairs = parseScopedPairsFromJob(jobRequest);
    const fromTxnUpload = getJobSource(jobRequest) === HOLDINGS_UPLOAD_SOURCE;
    const importStartedAtMs = parseImportStartedAtMs(jobRequest);
    const counters = { pairs: 0, rows: 0, errors: 0 };

    if (fromTxnUpload && scopedPairs.length === 0) {
      console.warn(
        `CalculateHoldingsPerAccount: source=${HOLDINGS_UPLOAD_SOURCE} but no pairs in pairsJson — exiting without full rebuild.`,
      );
      context.closeWithSuccess();
      return;
    }

    if (scopedPairs.length > 0) {
      /** @type {Map<string, Set<string>>} */
      const byAccount = new Map();
      for (const [acc, isin] of scopedPairs) {
        if (!byAccount.has(acc)) byAccount.set(acc, new Set());
        byAccount.get(acc).add(isin);
      }

      console.log(
        `CalculateHoldingsPerAccount scoped: ${scopedPairs.length} distinct pair(s) across ${byAccount.size} account(s) | ` +
          `AS_ON_DATE=${AS_ON_DATE ?? "null"} | DRY_RUN=${DRY_RUN} | ` +
          `MAX_PAIRS=${MAX_PAIRS} | append=${fromTxnUpload ? "yes" : "no"} ` +
          `importStartedAtMs=${importStartedAtMs || "n/a"} | ` +
          `jobTracking=${trackingOn ? `"${trackingJobName}"` : "off"}`,
      );

      if (trackingOn) {
        await ensureJobsRowRunning(zcql, trackingJobName);
      }

      let ai = 0;
      for (const [accountCode, isinSet] of byAccount) {
        ai++;
        if (MAX_PAIRS > 0 && counters.pairs >= MAX_PAIRS) break;
        console.log(`Scoped account ${ai}/${byAccount.size} ${accountCode} (${isinSet.size} ISIN(s))`);

        if (trackingOn) {
          const prev = await getPerAccountJobStatus(
            zcql,
            trackingJobName,
            accountCode,
          );
          if (prev === "SUCCESS") {
            console.log(`[${accountCode}] skip — JobStatusPerAccount already SUCCESS`);
            continue;
          }
          await upsertAccountRowRunning(
            zcql,
            trackingJobName,
            trackingJobType,
            accountCode,
          );
        }

        const errsBeforeAccount = counters.errors;
        try {
          await rebuildHoldingsForAccount(
            zcql,
            accountCode,
            AS_ON_DATE,
            counters,
            isinSet,
            { appendOnly: fromTxnUpload },
          );
          if (trackingOn) {
            if (counters.errors > errsBeforeAccount) {
              await markAccountFailed(
                zcql,
                trackingJobName,
                accountCode,
                "One or more scoped ISIN rebuild(s) logged errors — see Catalyst logs.",
              );
            } else {
              await markAccountSuccess(zcql, trackingJobName, accountCode);
            }
          }
        } catch (err) {
          console.error(`[${accountCode}] scoped account rebuild failed:`, err.message);
          counters.errors++;
          if (trackingOn) {
            await markAccountFailed(
              zcql,
              trackingJobName,
              accountCode,
              err.message,
            );
          }
        }
      }

      console.log(
        `CalculateHoldingsPerAccount scoped done in ${Date.now() - startedAt}ms: ` +
          `${counters.pairs} pair(s), ${counters.rows} row(s), ${counters.errors} error(s).`,
      );

      if (trackingOn) {
        await finalizeJobsRow(
          zcql,
          trackingJobName,
          counters.errors > 0 ? "FAILED" : "COMPLETED",
        );
      }

      context.closeWithSuccess();
      return;
    }

    if (fromTxnUpload) {
      console.warn(
        `CalculateHoldingsPerAccount: source=${HOLDINGS_UPLOAD_SOURCE} requires pairsJson — exiting without full rebuild.`,
      );
      context.closeWithSuccess();
      return;
    }

    const accounts = await fetchDistinctAccounts(zcql);

    console.log(
      `CalculateHoldingsPerAccount: ${accounts.length} account(s) | ` +
      `AS_ON_DATE=${AS_ON_DATE ?? "null"} | DRY_RUN=${DRY_RUN} | ` +
      `ACCOUNTS_FILTER=[${ACCOUNTS_FILTER.join(",")}] | ` +
      `ISINS_FILTER=[${ISINS_FILTER.join(",")}] | MAX_PAIRS=${MAX_PAIRS} | ` +
      `jobTracking=${trackingOn ? `"${trackingJobName}"` : "off"}`,
    );

    if (trackingOn) {
      await ensureJobsRowRunning(zcql, trackingJobName);
    }

    for (let ai = 0; ai < accounts.length; ai++) {
      if (MAX_PAIRS > 0 && counters.pairs >= MAX_PAIRS) break;
      const accountCode = accounts[ai];
      console.log(`Account ${ai + 1}/${accounts.length} ${accountCode}`);

      if (trackingOn) {
        const prev = await getPerAccountJobStatus(
          zcql,
          trackingJobName,
          accountCode,
        );
        if (prev === "SUCCESS") {
          console.log(`[${accountCode}] skip — JobStatusPerAccount already SUCCESS`);
          continue;
        }
        await upsertAccountRowRunning(
          zcql,
          trackingJobName,
          trackingJobType,
          accountCode,
        );
      }

      const errsBeforeAccount = counters.errors;
      try {
        await rebuildHoldingsForAccount(
          zcql,
          accountCode,
          AS_ON_DATE,
          counters,
          null,
        );
        if (trackingOn) {
          if (counters.errors > errsBeforeAccount) {
            await markAccountFailed(
              zcql,
              trackingJobName,
              accountCode,
              "One or more ISIN rebuild(s) logged errors — see Catalyst logs.",
            );
          } else {
            await markAccountSuccess(zcql, trackingJobName, accountCode);
          }
        }
      } catch (err) {
        console.error(`[${accountCode}] account rebuild failed:`, err.message);
        counters.errors++;
        if (trackingOn) {
          await markAccountFailed(
            zcql,
            trackingJobName,
            accountCode,
            err.message,
          );
        }
      }
    }

    console.log(
      `CalculateHoldingsPerAccount done in ${Date.now() - startedAt}ms: ` +
      `${counters.pairs} pair(s), ${counters.rows} row(s), ${counters.errors} error(s).`,
    );

    if (trackingOn) {
      await finalizeJobsRow(
        zcql,
        trackingJobName,
        counters.errors > 0 ? "FAILED" : "COMPLETED",
      );
    }

    context.closeWithSuccess();
  } catch (err) {
    console.error("CalculateHoldingsPerAccount failed:", err);
    if (trackingOn) {
      await finalizeJobsRow(zcql, trackingJobName, "FAILED");
    }
    context.closeWithFailure();
  }
};
