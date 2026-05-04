/**
 * CalculateHoldingPerAccount (Catalyst Job)
 *
 * Reads Transaction (+ Bonus, Split, Demerger_Record, Merger), runs the same FIFO engine
 * as AppSail analytics, and materializes rows into the Holdings table.
 *
 * Holdings columns: WS_Account_code, LINE_NO, TRANSACTION_DATE, SETTLEMENT_DATE, TYPE,
 * ISIN, QUANTITY, PRICE, TOTAL_AMOUNT, HOLDING, WAP, HOLDING_VALUE, P_L
 *
 * Configure ACCOUNTS_FILTER / AS_ON_DATE below. Deploy as type "job", then run on a schedule
 * or invoke manually from the Catalyst console (Event functions fire per-row — unsuitable for full rebuilds).
 */

const catalyst = require("zcatalyst-sdk-node");

/** Non-empty array = only these WS_Account_code values; empty array = all accounts found in Transaction */
const ACCOUNTS_FILTER = [];

/** YYYY-MM-DD inclusive as-on date, or null for full history */
const AS_ON_DATE = null;

const BATCH = 250;

const esc = (s) => String(s ?? "").replace(/'/g, "''");

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

async function fetchDistinctIsins(zcql, accountCode) {
  const isins = new Set();
  let offset = 0;
  const ac = esc(accountCode);
  while (true) {
    const batch = await zcql.executeZCQLQuery(`
      SELECT ISIN FROM Transaction
      WHERE WS_Account_code = '${ac}'
        AND ISIN IS NOT NULL AND ISIN != ''
      ORDER BY ROWID ASC
      LIMIT ${BATCH} OFFSET ${offset}
    `);
    if (!batch || batch.length === 0) break;
    for (const row of batch) {
      const t = row.Transaction || row;
      const i = String(t.ISIN ?? "").trim();
      if (i) isins.add(i);
    }
    if (batch.length < BATCH) break;
    offset += BATCH;
  }
  return [...isins].sort((a, b) => a.localeCompare(b));
}

async function fetchStockTransactions(zcql, accountCode, isin, asOnDate) {
  let dateCondition = "";
  let cutoff = null;
  if (asOnDate && /^\d{4}-\d{2}-\d{2}$/.test(asOnDate)) {
    const nextDay = new Date(asOnDate);
    nextDay.setDate(nextDay.getDate() + 1);
    const nextDayStr = nextDay.toISOString().split("T")[0];
    dateCondition = ` AND (TRANDATE < '${nextDayStr}' OR SETDATE < '${nextDayStr}')`;
    cutoff = nextDayStr;
  }
  const where = `
    WHERE WS_Account_code = '${esc(accountCode)}'
    AND ISIN = '${esc(isin)}'
    ${dateCondition}
  `;
  const rows = [];
  const seenRowIds = new Set();
  let offset = 0;
  while (true) {
    try {
      const query = `
        SELECT SETDATE, TRANDATE, Tran_Type, Security_code, QTY, NETRATE, Net_Amount, ISIN, ROWID
        FROM Transaction
        ${where}
        ORDER BY SETDATE ASC, ROWID ASC
        LIMIT ${BATCH} OFFSET ${offset}
      `;
      const batch = await zcql.executeZCQLQuery(query);
      if (!batch || batch.length === 0) break;
      for (const row of batch) {
        const r = row.Transaction || row;
        if (r.ROWID && seenRowIds.has(r.ROWID)) continue;
        if (r.ROWID) seenRowIds.add(r.ROWID);
        rows.push(r);
      }
      if (batch.length < BATCH) break;
      offset += BATCH;
    } catch (err) {
      console.error(`fetchStockTransactions offset ${offset}:`, err.message);
      break;
    }
  }
  const filteredRows = cutoff
    ? rows.filter((r) => {
        const effectiveDate = getEffectiveDate(r);
        return !effectiveDate || effectiveDate < cutoff;
      })
    : rows;

  return filteredRows.map((r) => ({
    SETDATE: r.SETDATE,
    TRANDATE: r.TRANDATE,
    Tran_Type: r.Tran_Type,
    tranType: r.Tran_Type,
    QTY: r.QTY,
    qty: Number(r.QTY) || 0,
    NETRATE: r.NETRATE,
    netrate: Number(r.NETRATE) || 0,
    Net_Amount: r.Net_Amount,
    netAmount: Number(r.Net_Amount) || 0,
    ISIN: r.ISIN || "",
    isin: r.ISIN || "",
  }));
}

async function fetchBonusesForStock(zcql, accountCode, isin, asOnDate) {
  let dateCondition = "";
  if (asOnDate && /^\d{4}-\d{2}-\d{2}$/.test(asOnDate)) {
    const nextDay = new Date(asOnDate);
    nextDay.setDate(nextDay.getDate() + 1);
    dateCondition = ` AND ExDate < '${nextDay.toISOString().split("T")[0]}'`;
  }
  const rows = [];
  const seenRowIds = new Set();
  let offset = 0;
  while (true) {
    try {
      const query = `
        SELECT SecurityCode, SecurityName, ExDate, BonusShare, ISIN, ROWID
        FROM Bonus
        WHERE WS_Account_code = '${esc(accountCode)}'
        AND ISIN = '${esc(isin)}'
        ${dateCondition}
        ORDER BY ExDate ASC, ROWID ASC
        LIMIT ${BATCH} OFFSET ${offset}
      `;
      const batch = await zcql.executeZCQLQuery(query);
      if (!batch || batch.length === 0) break;
      for (const row of batch) {
        const b = row.Bonus || row;
        if (b.ROWID && seenRowIds.has(b.ROWID)) continue;
        if (b.ROWID) seenRowIds.add(b.ROWID);
        rows.push(b);
      }
      if (batch.length < BATCH) break;
      offset += BATCH;
    } catch (err) {
      console.error(`fetchBonuses offset ${offset}:`, err.message);
      break;
    }
  }
  return rows.map((b) => ({
    SecurityCode: b.SecurityCode,
    SecurityName: b.SecurityName,
    ExDate: b.ExDate,
    exDate: b.ExDate,
    BonusShare: b.BonusShare,
    bonusShare: Number(b.BonusShare) || 0,
    ISIN: b.ISIN || "",
    isin: b.ISIN || "",
  }));
}

async function fetchSplitForStock(zcql, isin, asOnDate) {
  let dateCondition = "";
  if (asOnDate && /^\d{4}-\d{2}-\d{2}$/.test(asOnDate)) {
    const nextDay = new Date(asOnDate);
    nextDay.setDate(nextDay.getDate() + 1);
    dateCondition = ` AND Issue_Date < '${nextDay.toISOString().split("T")[0]}'`;
  }
  const rows = [];
  const seenRowIds = new Set();
  let offset = 0;
  while (true) {
    try {
      const query = `
        SELECT Security_Code, Security_Name, Issue_Date, Ratio1, Ratio2, ISIN, ROWID
        FROM Split
        WHERE ISIN = '${esc(isin)}'
        ${dateCondition}
        ORDER BY Issue_Date ASC, ROWID ASC
        LIMIT ${BATCH} OFFSET ${offset}
      `;
      const batch = await zcql.executeZCQLQuery(query);
      if (!batch || batch.length === 0) break;
      for (const row of batch) {
        const s = row.Split || row;
        if (s.ROWID && seenRowIds.has(s.ROWID)) continue;
        if (s.ROWID) seenRowIds.add(s.ROWID);
        rows.push(s);
      }
      if (batch.length < BATCH) break;
      offset += BATCH;
    } catch (err) {
      console.error(`fetchSplit offset ${offset}:`, err.message);
      break;
    }
  }
  return rows.map((b) => ({
    ratio1: Number(b.Ratio1) || 0,
    ratio2: Number(b.Ratio2) || 0,
    issueDate: b.Issue_Date,
    isin: b.ISIN || "",
  }));
}

async function fetchDemergerRecordsForAccount(zcql, accountCode, asOnDate) {
  let dateCondition = "";
  if (asOnDate && /^\d{4}-\d{2}-\d{2}$/.test(asOnDate)) {
    const nextDay = new Date(asOnDate);
    nextDay.setDate(nextDay.getDate() + 1);
    dateCondition = ` AND (TRANDATE < '${nextDay.toISOString().split("T")[0]}' OR SETDATE < '${nextDay.toISOString().split("T")[0]}')`;
  }
  const rows = [];
  const seen = new Set();
  let offset = 0;
  while (true) {
    const batch = await zcql.executeZCQLQuery(`
      SELECT *
      FROM Demerger_Record
      WHERE WS_Account_code = '${esc(accountCode)}'
      ${dateCondition}
      ORDER BY TRANDATE ASC, ROWID ASC
      LIMIT ${BATCH} OFFSET ${offset}
    `);
    if (!batch || batch.length === 0) break;
    for (const row of batch) {
      const d = row.Demerger_Record || row;
      const rid = d.ROWID;
      if (rid != null && seen.has(rid)) continue;
      if (rid != null) seen.add(rid);
      rows.push(d);
    }
    if (batch.length < BATCH) break;
    offset += BATCH;
  }
  return rows.filter(
    (d) => String(d.Tran_Type || d.tran_type || "").toUpperCase() === "DEMERGER",
  );
}

async function fetchDemergerRecordsForStock(zcql, accountCode, isin, asOnDate) {
  const all = await fetchDemergerRecordsForAccount(zcql, accountCode, asOnDate);
  const u = String(isin || "").trim().toUpperCase();
  return all.filter((d) => String(d.ISIN || d.isin || "").trim().toUpperCase() === u);
}

async function fetchMergerRecordsForAccount(zcql, accountCode, asOnDate) {
  let dateCondition = "";
  if (asOnDate && /^\d{4}-\d{2}-\d{2}$/.test(asOnDate)) {
    const nextDay = new Date(asOnDate);
    nextDay.setDate(nextDay.getDate() + 1);
    dateCondition = ` AND (TRANDATE < '${nextDay.toISOString().split("T")[0]}' OR SETDATE < '${nextDay.toISOString().split("T")[0]}')`;
  }
  const rows = [];
  const seen = new Set();
  let offset = 0;
  while (true) {
    const batch = await zcql.executeZCQLQuery(`
      SELECT *
      FROM Merger
      WHERE WS_Account_code = '${esc(accountCode)}'
      ${dateCondition}
      ORDER BY TRANDATE ASC, ROWID ASC
      LIMIT ${BATCH} OFFSET ${offset}
    `);
    if (!batch || batch.length === 0) break;
    for (const row of batch) {
      const m = row.Merger || row;
      const rid = m.ROWID;
      if (rid != null && seen.has(rid)) continue;
      if (rid != null) seen.add(rid);
      rows.push(m);
    }
    if (batch.length < BATCH) break;
    offset += BATCH;
  }
  return rows.filter(
    (m) => String(m.Tran_Type || m.tran_type || "").toUpperCase() === "MERGER",
  );
}

async function fetchMergerRecordsForStock(zcql, accountCode, isin, asOnDate) {
  const all = await fetchMergerRecordsForAccount(zcql, accountCode, asOnDate);
  const u = String(isin || "").trim().toUpperCase();
  return all.filter((m) => String(m.ISIN || m.isin || "").trim().toUpperCase() === u);
}

/* ========= FIFO engine (aligned with appsail-nodejs/util/analytics/transactionHistory/fifo.js) ========= */

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
    const [y, m, d] = rawDate.split("-").map(Number);
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

async function deleteHoldingsForPair(zcql, accountCode, isin) {
  await zcql.executeZCQLQuery(`
    DELETE FROM Holdings WHERE WS_Account_code = '${esc(accountCode)}' AND ISIN = '${esc(isin)}'
  `);
}

async function insertHoldingsRow(zcql, accountCode, lineNo, row, displayIsin) {
  const txD = sqlDate(row.originalTrandate || row.trandate);
  const setD = sqlDate(row.setdate);
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

  await zcql.executeZCQLQuery(`
    INSERT INTO Holdings (
      WS_Account_code, LINE_NO, TRANSACTION_DATE, SETTLEMENT_DATE, TYPE, ISIN,
      QUANTITY, PRICE, TOTAL_AMOUNT, HOLDING, WAP, HOLDING_VALUE, P_L
    ) VALUES (
      '${esc(accountCode)}',
      ${lineNo},
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
      ${pl}
    )
  `);
}

async function rebuildHoldingsForPair(zcql, accountCode, isin, asOnDate) {
  const transactions = await fetchStockTransactions(zcql, accountCode, isin, asOnDate);
  const bonuses = await fetchBonusesForStock(zcql, accountCode, isin, asOnDate);
  const splits = await fetchSplitForStock(zcql, isin, asOnDate);
  const demergers = await fetchDemergerRecordsForStock(zcql, accountCode, isin, asOnDate);
  const mergers = await fetchMergerRecordsForStock(zcql, accountCode, isin, asOnDate);

  if (
    transactions.length === 0 &&
    bonuses.length === 0 &&
    splits.length === 0 &&
    demergers.length === 0 &&
    mergers.length === 0
  ) {
    await deleteHoldingsForPair(zcql, accountCode, isin);
    return 0;
  }

  const fifoRows = runFifoEngine(transactions, bonuses, splits, false, demergers, mergers);
  if (!Array.isArray(fifoRows) || fifoRows.length === 0) {
    await deleteHoldingsForPair(zcql, accountCode, isin);
    return 0;
  }

  await deleteHoldingsForPair(zcql, accountCode, isin);

  let lineNo = 1;
  for (const r of fifoRows) {
    await insertHoldingsRow(zcql, accountCode, lineNo, r, isin);
    lineNo++;
  }
  return fifoRows.length;
}

/** Catalyst Job entry (same pattern as Cal_CB_Per_TNX) */
module.exports = async (jobRequest, context) => {
  const app = catalyst.initialize(context);
  const zcql = app.zcql();

  try {
    const accounts = await fetchDistinctAccounts(zcql);
    console.log(
      `CalculateHoldingPerAccount: ${accounts.length} account(s), AS_ON_DATE=${AS_ON_DATE ?? "null"}`,
    );

    let pairs = 0;
    let rowsWritten = 0;

    for (let ai = 0; ai < accounts.length; ai++) {
      const accountCode = accounts[ai];
      const isins = await fetchDistinctIsins(zcql, accountCode);
      console.log(`Account ${ai + 1}/${accounts.length} ${accountCode}: ${isins.length} ISIN(s)`);

      for (const isin of isins) {
        const n = await rebuildHoldingsForPair(zcql, accountCode, isin, AS_ON_DATE);
        pairs++;
        rowsWritten += n;
      }
    }

    console.log(`CalculateHoldingPerAccount done: ${pairs} pair(s), ${rowsWritten} row(s) inserted.`);
    context.closeWithSuccess();
  } catch (err) {
    console.error("CalculateHoldingPerAccount failed:", err);
    context.closeWithFailure();
  }
};