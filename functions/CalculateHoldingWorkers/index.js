/**
 * CalculateHoldingWorkers (Catalyst Job Function) — TxnUpload append-only
 *
 * Single responsibility: incrementally append Holdings rows after a transaction
 * CSV upload. Full rebuilds (DELETE + INSERT all) are NOT handled here — they
 * live in a separate dedicated job. This function never deletes Holdings rows.
 *
 * Required job params (otherwise the function exits as a no-op):
 *   - `source` = "TxnUpload"
 *   - `pairsJson` = JSON array of `[accountCode, ISIN]` pairs touched by the upload
 *   - `importStartedAtMs` = epoch ms; only Transaction rows with
 *     `CREATEDTIME >= import floor` are considered new
 *
 * Per pair logic:
 *   - Buys-only new txns → cheap append. Continue qty / cost / WAP from the last
 *     Holdings row and INSERT one Holdings row per new buy (no queue rebuild).
 *   - Any sell present → read existing Holdings rows for the pair, replay them
 *     once to rebuild the active buy queue in memory, then apply each new txn
 *     FIFO-style and INSERT one Holdings row per new txn. Prior Holdings rows
 *     are never touched. The Transaction table is not re-read here.
 *
 * Holdings columns written:
 *   WS_Account_code, TRANSACTION_DATE, SETTLEMENT_DATE, TYPE, ISIN,
 *   QUANTITY, PRICE, TOTAL_AMOUNT, HOLDING, WAP, HOLDING_VALUE, P_L, STATUS
 *
 * Row order within a pair is preserved by INSERT order. Reads must use the
 * same ORDER BY as AppSail `HOLDINGS_FIFO_ORDER_BY_SQL`
 * (`CREATEDTIME ASC, ROWID ASC`), not settlement-only.
 *
 * Bonus / Split / Demerger / Merger are intentionally not loaded here — they
 * are applied via separate methods.
 *
 * Optional: pass non-empty `jobName` via `jobRequest.getAllJobParams()` so the
 * function writes `Jobs` / `JobStatusPerAccount` for retries and UX; omit it
 * for legacy / smoke runs and no Job tables are touched.
 */

const catalyst = require("zcatalyst-sdk-node");

/* ============================== CONFIG ============================== */

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

/** Default Stratus bucket holding the pairs manifest (overridable via `bucketName` param). */
const DEFAULT_META_BUCKET = "client-transaction-files";

/** Normalize a raw array into deduped [WS_Account_code, ISIN] pairs. */
function normalizePairs(arr) {
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
}

/**
 * Legacy inline mode: parses `pairsJson` job param (JSON array of [WS_Account_code, ISIN]
 * or { wsAccountCode, isin }). Kept for small uploads / backward compatibility.
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
    return normalizePairs(arr);
  } catch (e) {
    console.warn("parseScopedPairsFromJob:", e.message);
    return [];
  }
}

function rawToUtf8(raw) {
  if (raw == null) return "";
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  if (typeof raw === "string") return raw;
  return null;
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Read a Stratus object fully into a UTF-8 string (handles stream / buffer / string). */
async function readStratusObjectAsString(app, bucketName, objectKey) {
  const bucket = app.stratus().bucket(bucketName);
  const raw = await bucket.getObject(objectKey);
  if (raw != null && typeof raw === "object" && typeof raw.pipe === "function") {
    return await streamToString(raw);
  }
  const s = rawToUtf8(raw);
  return s == null ? "" : s;
}

/**
 * Resolve this invocation's scoped pairs. Two modes:
 *   - Slave mode (preferred): `pairsObjectKey` points to a Stratus JSON manifest of
 *     all pairs; `chunkStart` / `chunkCount` select this slave's slice.
 *   - Inline mode (legacy): `pairsJson` carries the pairs directly.
 * @returns {Promise<Array<[string, string]>>}
 */
async function resolveScopedPairs(app, jobRequest) {
  const p =
    jobRequest && typeof jobRequest.getAllJobParams === "function"
      ? jobRequest.getAllJobParams() || {}
      : {};

  const objectKey = String(p.pairsObjectKey ?? p.pairs_object_key ?? "").trim();
  if (!objectKey) {
    return parseScopedPairsFromJob(jobRequest);
  }

  const bucketName =
    String(p.bucketName ?? p.bucket_name ?? "").trim() || DEFAULT_META_BUCKET;

  let text = "";
  try {
    text = await readStratusObjectAsString(app, bucketName, objectKey);
  } catch (e) {
    console.error(
      `resolveScopedPairs: failed to read ${bucketName}/${objectKey}:`,
      e.message,
    );
    return [];
  }

  let arr;
  try {
    arr = JSON.parse(text);
  } catch (e) {
    console.error(`resolveScopedPairs: invalid JSON in ${objectKey}:`, e.message);
    return [];
  }
  if (!Array.isArray(arr) || arr.length === 0) return [];

  const start = Math.max(0, Math.floor(Number(p.chunkStart ?? p.chunk_start) || 0));
  const rawCount = Number(p.chunkCount ?? p.chunk_count);
  const count =
    Number.isFinite(rawCount) && rawCount > 0 ? Math.floor(rawCount) : arr.length;
  const slice = arr.slice(start, start + count);

  console.log(
    `resolveScopedPairs: ${bucketName}/${objectKey} total=${arr.length} ` +
      `slice=[${start}, ${start + count}) -> ${slice.length} item(s)`,
  );

  return normalizePairs(slice);
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

const isSellType = (type) => /^SL\+|SQS|OPO|NF-/i.test(String(type || ""));

/** Build CREATEDTIME floor string for "since this import" filter (matches cash append). */
function createdTimeFloorFromMs(ms) {
  const d = new Date(ms - 15_000);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}:000`
  );
}

const getEffectiveDate = (r) => {
  const setDate = r.SETDATE || r.setdate;
  const tradeDate = r.TRANDATE || r.trandate;
  return isBuyType(r.Tran_Type || r.tranType)
    ? setDate || tradeDate
    : tradeDate || setDate;
};

/* ============================== FETCH (batched per pair) ============================== */

/** New transactions for one pair since CSV import (CREATEDTIME floor). */
async function fetchNewTxnsForPair(zcql, accountCode, isin, importStartedAtMs) {
  const createdFloor = createdTimeFloorFromMs(importStartedAtMs);
  const rows = [];
  const seen = new Set();
  let offset = 0;
  while (true) {
    try {
      const batch = await zcql.executeZCQLQuery(`
        SELECT TRANDATE, SETDATE, Tran_Type, QTY, NETRATE, Net_Amount, ISIN, ROWID
        FROM Transaction
        WHERE WS_Account_code = '${esc(accountCode)}'
          AND ISIN = '${esc(isin)}'
          AND CREATEDTIME >= '${createdFloor}'
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
      console.error(`fetchNewTxnsForPair[${accountCode}/${isin}] offset=${offset}:`, err.message);
      break;
    }
  }
  return rows;
}

/** Last Holdings row for one pair — checkpoint for cheap-append. */
async function fetchLastHoldingsRowForPair(zcql, accountCode, isin) {
  try {
    const rows = await zcql.executeZCQLQuery(`
      SELECT TRANSACTION_DATE, SETTLEMENT_DATE, TYPE, QUANTITY, PRICE, TOTAL_AMOUNT,
             HOLDING, WAP, HOLDING_VALUE, P_L, STATUS
      FROM Holdings
      WHERE WS_Account_code = '${esc(accountCode)}' AND ISIN = '${esc(isin)}'
      ORDER BY CREATEDTIME DESC, ROWID DESC
      LIMIT 1
    `);
    if (!rows || rows.length === 0) return null;
    return rows[0].Holdings || rows[0];
  } catch (e) {
    console.warn(`fetchLastHoldingsRowForPair[${accountCode}/${isin}]:`, e.message);
    return null;
  }
}

/** All Holdings rows for one pair, in canonical FIFO order (insert order). */
async function fetchAllHoldingsRowsForPair(zcql, accountCode, isin) {
  const rows = [];
  let offset = 0;
  while (true) {
    try {
      const batch = await zcql.executeZCQLQuery(`
        SELECT TRANSACTION_DATE, SETTLEMENT_DATE, TYPE, QUANTITY, PRICE,
               HOLDING, WAP, HOLDING_VALUE, ROWID
        FROM Holdings
        WHERE WS_Account_code = '${esc(accountCode)}' AND ISIN = '${esc(isin)}'
        ORDER BY CREATEDTIME ASC, ROWID ASC
        LIMIT ${BATCH} OFFSET ${offset}
      `);
      if (!batch || batch.length === 0) break;
      for (const row of batch) {
        const r = row.Holdings || row;
        rows.push(r);
      }
      if (batch.length < BATCH) break;
      offset += BATCH;
    } catch (err) {
      console.error(
        `fetchAllHoldingsRowsForPair[${accountCode}/${isin}] offset=${offset}:`,
        err.message,
      );
      break;
    }
  }
  return rows;
}

/* ============================== QUEUE RECONSTRUCTION ============================== */

/**
 * Replay existing Holdings rows (in insert order) to rebuild the active buy
 * queue at the end of recorded history.
 *
 * Row → queue effect:
 *   BY- / SQB / OPI / BONUS                 → push lot {qty, price}
 *   SPLIT / DEMERGER / MERGER               → first row of an event clears the
 *                                              queue; subsequent rows of the
 *                                              same event add a lot each
 *   SL+ / SQS / OPO / NF-                   → consume FIFO from the oldest
 *                                              active lot(s)
 *
 * Returns the queue plus its qty / cost totals — the seed for applying new
 * transactions on top.
 */
function reconstructBuyQueueFromHoldings(rows) {
  const queue = [];
  let lastReplaceKey = null;

  for (const r of rows) {
    const type = String(r.TYPE || "").trim();
    const upper = type.toUpperCase();
    const qty = Number(r.QUANTITY) || 0;
    const price = Number(r.PRICE) || 0;
    const date = String(r.TRANSACTION_DATE || "").trim();

    if (upper === "SPLIT" || upper === "DEMERGER" || upper === "MERGER") {
      const key = `${upper}|${date}`;
      if (key !== lastReplaceKey) queue.length = 0;
      if (qty > 0) queue.push({ qty, price });
      lastReplaceKey = key;
      continue;
    }
    lastReplaceKey = null;

    if (upper === "BONUS" || isBuyType(type)) {
      if (qty > 0) queue.push({ qty, price });
      continue;
    }

    if (isSellType(type)) {
      const holdingBefore = queue.reduce((s, l) => s + l.qty, 0);
      let remaining = Math.min(qty, holdingBefore);
      while (remaining > 0 && queue.length) {
        const lot = queue[0];
        const used = Math.min(lot.qty, remaining);
        lot.qty -= used;
        remaining -= used;
        if (lot.qty === 0) queue.shift();
      }
    }
  }

  const holding = queue.reduce((s, l) => s + l.qty, 0);
  const cost = queue.reduce((s, l) => s + l.qty * l.price, 0);
  return { queue, holding, cost };
}

/* ============================== HOLDINGS WRITER ============================== */

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

/* ============================== CHEAP BUY-APPEND ============================== */

/**
 * Append rows for new buys without running the FIFO engine. Uses last Holdings
 * row as checkpoint and updates running qty / cost / WAP per buy.
 *
 * Caller must ensure `newBuyTxns` contains only buy-type transactions.
 *
 * @returns {Promise<number>} appended row count
 */
async function appendBuyRowsCheap(zcql, accountCode, isin, newBuyTxns, counters) {
  const tail = await fetchLastHoldingsRowForPair(zcql, accountCode, isin);
  let holding = Number(tail?.HOLDING) || 0;
  let cost = Number(tail?.HOLDING_VALUE) || 0;

  let appended = 0;
  for (const t of newBuyTxns) {
    const tranType = t.Tran_Type;
    const qty = Math.abs(Number(t.QTY) || 0);
    if (!qty) continue;

    const netRate = Number(t.NETRATE) || 0;
    const netAmount = Number(t.Net_Amount) || 0;
    const price = netRate || (netAmount && qty ? netAmount / qty : 0);

    if (
      String(tranType).toUpperCase() === "OPI" &&
      qty === 1 &&
      price === 0 &&
      netAmount === 0
    ) {
      continue;
    }

    holding += qty;
    cost += qty * price;
    const wap = holding > 0 ? cost / holding : 0;

    const row = {
      tranType,
      trandate: t.TRANDATE,
      originalTrandate: t.TRANDATE,
      setdate: t.SETDATE || t.TRANDATE,
      qty,
      price,
      netAmount,
      holdings: holding,
      costOfHoldings: cost,
      averageCostOfHoldings: wap,
      profitLoss: null,
      isActive: true,
      isin: t.ISIN || isin,
    };

    await insertHoldingsRow(zcql, accountCode, row, isin);
    appended++;
  }

  counters.rows += appended;
  return appended;
}

/**
 * Sell-path append. Rebuilds the active buy queue from existing Holdings,
 * applies each new txn (FIFO consume on sells, push lot on buys), and INSERTs
 * one Holdings row per new non-zero txn. Prior Holdings rows are never touched.
 *
 * @returns {Promise<number>} appended row count
 */
async function appendTxnsWithQueueReconstruct(
  zcql,
  accountCode,
  isin,
  newTxns,
  counters,
) {
  const existingHoldings = await fetchAllHoldingsRowsForPair(
    zcql,
    accountCode,
    isin,
  );
  const { queue, holding: initialHolding, cost: initialCost } =
    reconstructBuyQueueFromHoldings(existingHoldings);

  let holding = initialHolding;
  let cost = initialCost;

  const sortedTxns = [...newTxns].sort((a, b) => {
    const eA = String(getEffectiveDate(a) || "");
    const eB = String(getEffectiveDate(b) || "");
    if (eA !== eB) return eA.localeCompare(eB);
    return String(a.ROWID || "").localeCompare(String(b.ROWID || ""));
  });

  let appended = 0;
  for (const t of sortedTxns) {
    const tranType = t.Tran_Type;
    const qty = Math.abs(Number(t.QTY) || 0);
    if (!qty) continue;

    const netRate = Number(t.NETRATE) || 0;
    const netAmount = Number(t.Net_Amount) || 0;
    const price = netRate || (netAmount && qty ? netAmount / qty : 0);

    if (
      String(tranType).toUpperCase() === "OPI" &&
      qty === 1 &&
      price === 0 &&
      netAmount === 0
    ) {
      continue;
    }

    let profitLoss = null;
    let isActive = true;

    if (isBuyType(tranType)) {
      queue.push({ qty, price });
      holding += qty;
      cost += qty * price;
    } else if (isSellType(tranType)) {
      const sellQty = Math.min(qty, holding);
      let remaining = sellQty;
      let fifoCost = 0;
      while (remaining > 0 && queue.length) {
        const lot = queue[0];
        const used = Math.min(lot.qty, remaining);
        fifoCost += used * lot.price;
        lot.qty -= used;
        remaining -= used;
        if (lot.qty === 0) queue.shift();
      }
      holding -= sellQty;
      cost -= fifoCost;
      profitLoss = sellQty * price - fifoCost;
      isActive = false;
    } else {
      continue;
    }

    const wap = holding > 0 ? cost / holding : 0;

    const row = {
      tranType,
      trandate: t.TRANDATE,
      originalTrandate: t.TRANDATE,
      setdate: t.SETDATE || t.TRANDATE,
      qty,
      price,
      netAmount,
      holdings: holding,
      costOfHoldings: cost,
      averageCostOfHoldings: wap,
      profitLoss,
      isActive,
      isin: t.ISIN || isin,
    };

    await insertHoldingsRow(zcql, accountCode, row, isin);
    appended++;
  }

  counters.rows += appended;
  return appended;
}

/**
 * Per-(account, ISIN) processing for TxnUpload mode.
 *   - Reads only new transactions since import.
 *   - Buys-only → cheap-append (read last Holdings row, append).
 *   - Any sell present → reconstruct buy queue from existing Holdings, then
 *     append one Holdings row per new txn.
 *   - No new txns → skip.
 */
async function processPairTxnUpload(
  zcql,
  accountCode,
  isin,
  asOnDate,
  importStartedAtMs,
  counters,
) {
  const newTxns = await fetchNewTxnsForPair(
    zcql,
    accountCode,
    isin,
    importStartedAtMs,
  );

  if (newTxns.length === 0) {
    console.log(`[${accountCode}/${isin}] no new txns since import — skip`);
    return;
  }

  counters.pairs++;

  const hasSell = newTxns.some((t) => isSellType(t.Tran_Type));

  if (!hasSell) {
    if (DRY_RUN) {
      console.log(
        `[DRY_RUN][${accountCode}/${isin}] would cheap-append ${newTxns.length} buy txn(s)`,
      );
      counters.rows += newTxns.length;
      return;
    }

    try {
      const appended = await appendBuyRowsCheap(
        zcql,
        accountCode,
        isin,
        newTxns,
        counters,
      );
      console.log(
        `[${accountCode}/${isin}] cheap-append: ${appended} buy row(s) from ${newTxns.length} new txn(s)`,
      );
      return;
    } catch (err) {
      console.error(
        `[${accountCode}/${isin}] cheap-append failed — falling back to queue reconstruct:`,
        err.message,
      );
    }
  } else {
    console.log(
      `[${accountCode}/${isin}] sell in upload — reconstruct queue from Holdings`,
    );
  }

  if (DRY_RUN) {
    console.log(
      `[DRY_RUN][${accountCode}/${isin}] would reconstruct queue + append ${newTxns.length} txn(s)`,
    );
    return;
  }

  try {
    const appended = await appendTxnsWithQueueReconstruct(
      zcql,
      accountCode,
      isin,
      newTxns,
      counters,
    );
    console.log(
      `[${accountCode}/${isin}] appended ${appended} row(s) from ${newTxns.length} new txn(s)`,
    );
  } catch (err) {
    console.error(
      `[${accountCode}/${isin}] queue reconstruct failed:`,
      err.message,
    );
    counters.errors++;
  }
}

/* ============================== PER-ACCOUNT DISPATCH (TxnUpload only) ============================== */

/**
 * Dispatches per-pair processing for one account in TxnUpload mode only.
 *
 * Caller must guarantee: importStartedAtMs > 0 and scopedIsinsSet has entries.
 * Full rebuilds live in a separate dedicated job.
 */
async function rebuildHoldingsForAccount(
  zcql,
  accountCode,
  asOnDate,
  counters,
  scopedIsinsSet,
  importStartedAtMs,
) {
  const t0 = Date.now();
  const targetIsins = [...scopedIsinsSet]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  console.log(
    `[${accountCode}] TxnUpload: ${targetIsins.length} ISIN(s) | ` +
      `importStartedAtMs=${importStartedAtMs} (start in ${Date.now() - t0}ms)`,
  );

  for (const isin of targetIsins) {
    if (MAX_PAIRS > 0 && counters.pairs >= MAX_PAIRS) {
      console.log(`MAX_PAIRS=${MAX_PAIRS} reached, stopping early`);
      return;
    }
    try {
      await processPairTxnUpload(
        zcql,
        accountCode,
        isin,
        asOnDate,
        importStartedAtMs,
        counters,
      );
    } catch (err) {
      console.error(
        `[${accountCode}/${isin}] processPairTxnUpload failed:`,
        err.message,
      );
      counters.errors++;
    }
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
    const scopedPairs = await resolveScopedPairs(app, jobRequest);
    const fromTxnUpload = getJobSource(jobRequest) === HOLDINGS_UPLOAD_SOURCE;
    const importStartedAtMs = parseImportStartedAtMs(jobRequest);
    const counters = { pairs: 0, rows: 0, errors: 0 };

    // Hard guard: this job is TxnUpload-only. Full rebuilds live in a separate job.
    if (!fromTxnUpload) {
      console.warn(
        `CalculateHoldingWorkers: ignoring invocation — source must be "${HOLDINGS_UPLOAD_SOURCE}". ` +
          `Full rebuilds are handled by a dedicated job.`,
      );
      context.closeWithSuccess();
      return;
    }
    if (scopedPairs.length === 0) {
      console.warn(
        `CalculateHoldingWorkers: source=${HOLDINGS_UPLOAD_SOURCE} but no pairs to process ` +
          `(empty slice or manifest) — nothing to do.`,
      );
      context.closeWithSuccess();
      return;
    }
    if (!importStartedAtMs) {
      console.warn(
        `CalculateHoldingWorkers: source=${HOLDINGS_UPLOAD_SOURCE} but importStartedAtMs missing — nothing to do.`,
      );
      context.closeWithSuccess();
      return;
    }

    /** @type {Map<string, Set<string>>} */
    const byAccount = new Map();
    for (const [acc, isin] of scopedPairs) {
      if (!byAccount.has(acc)) byAccount.set(acc, new Set());
      byAccount.get(acc).add(isin);
    }

    console.log(
      `CalculateHoldingWorkers TxnUpload: ${scopedPairs.length} distinct pair(s) across ${byAccount.size} account(s) | ` +
        `AS_ON_DATE=${AS_ON_DATE ?? "null"} | DRY_RUN=${DRY_RUN} | ` +
        `MAX_PAIRS=${MAX_PAIRS} | importStartedAtMs=${importStartedAtMs} | ` +
        `jobTracking=${trackingOn ? `"${trackingJobName}"` : "off"}`,
    );

    if (trackingOn) {
      await ensureJobsRowRunning(zcql, trackingJobName);
    }

    let ai = 0;
    for (const [accountCode, isinSet] of byAccount) {
      ai++;
      if (MAX_PAIRS > 0 && counters.pairs >= MAX_PAIRS) break;
      console.log(
        `Scoped account ${ai}/${byAccount.size} ${accountCode} (${isinSet.size} ISIN(s))`,
      );

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
          importStartedAtMs,
        );
        if (trackingOn) {
          if (counters.errors > errsBeforeAccount) {
            await markAccountFailed(
              zcql,
              trackingJobName,
              accountCode,
              "One or more scoped ISIN appends logged errors — see Catalyst logs.",
            );
          } else {
            await markAccountSuccess(zcql, trackingJobName, accountCode);
          }
        }
      } catch (err) {
        console.error(
          `[${accountCode}] scoped account append failed:`,
          err.message,
        );
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
      `CalculateHoldingWorkers TxnUpload done in ${Date.now() - startedAt}ms: ` +
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
    console.error("CalculateHoldingWorkers failed:", err);
    if (trackingOn) {
      await finalizeJobsRow(zcql, trackingJobName, "FAILED");
    }
    context.closeWithFailure();
  }
};
