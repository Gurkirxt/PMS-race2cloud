"use strict";

/**
 * Holdings rebuild for DemergerFn only — duplicated FIFO + writer from CalculateHoldingPerAccount.
 * Keep in sync manually if holdings logic changes.
 */

const BATCH = 250;
const ISINS_FILTER = [];
const MAX_PAIRS = 0;
const DRY_RUN = false;

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

const nextDayCutoff = (asOnDate) => {
  if (!asOnDate || !/^\d{4}-\d{2}-\d{2}$/.test(asOnDate)) return null;
  const nextDay = new Date(asOnDate);
  nextDay.setDate(nextDay.getDate() + 1);
  return nextDay.toISOString().split("T")[0];
};

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
        SELECT SETDATE, TRANDATE, Tran_Type, Security_Name, Security_code, QTY, NETRATE, Net_Amount, ISIN, ROWID
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

async function fetchAccountBonuses(zcql, accountCode, asOnDate) {
  const cutoff = nextDayCutoff(asOnDate);
  const dateClause = cutoff ? ` AND ExDate < '${cutoff}'` : "";

  const rows = [];
  const seen = new Set();
  let offset = 0;
  while (true) {
    try {
      const batch = await zcql.executeZCQLQuery(`
        SELECT SecurityCode, SecurityName, ExDate, BonusShare, ISIN, ROWID
        FROM Bonus
        WHERE WS_Account_code = '${esc(accountCode)}'
        ${dateClause}
        ORDER BY ExDate ASC, ROWID ASC
        LIMIT ${BATCH} OFFSET ${offset}
      `);
      if (!batch || batch.length === 0) break;
      for (const row of batch) {
        const b = row.Bonus || row;
        if (b.ROWID && seen.has(b.ROWID)) continue;
        if (b.ROWID) seen.add(b.ROWID);
        rows.push(b);
      }
      if (batch.length < BATCH) break;
      offset += BATCH;
    } catch (err) {
      console.error(`fetchAccountBonuses[${accountCode}] offset=${offset}:`, err.message);
      break;
    }
  }
  return rows;
}

async function fetchAccountDemergers(zcql, accountCode, asOnDate) {
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
        SELECT *
        FROM Demerger_Record
        WHERE WS_Account_code = '${esc(accountCode)}'
        ${dateClause}
        ORDER BY TRANDATE ASC, ROWID ASC
        LIMIT ${BATCH} OFFSET ${offset}
      `);
      if (!batch || batch.length === 0) break;
      for (const row of batch) {
        const d = row.Demerger_Record || row;
        if (d.ROWID != null && seen.has(d.ROWID)) continue;
        if (d.ROWID != null) seen.add(d.ROWID);
        rows.push(d);
      }
      if (batch.length < BATCH) break;
      offset += BATCH;
    } catch (err) {
      console.error(`fetchAccountDemergers[${accountCode}] offset=${offset}:`, err.message);
      break;
    }
  }
  return rows.filter(
    (d) => String(d.Tran_Type || d.tran_type || "").toUpperCase() === "DEMERGER",
  );
}

async function fetchAccountMergers(zcql, accountCode, asOnDate) {
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
        SELECT *
        FROM Merger
        WHERE WS_Account_code = '${esc(accountCode)}'
        ${dateClause}
        ORDER BY TRANDATE ASC, ROWID ASC
        LIMIT ${BATCH} OFFSET ${offset}
      `);
      if (!batch || batch.length === 0) break;
      for (const row of batch) {
        const m = row.Merger || row;
        if (m.ROWID != null && seen.has(m.ROWID)) continue;
        if (m.ROWID != null) seen.add(m.ROWID);
        rows.push(m);
      }
      if (batch.length < BATCH) break;
      offset += BATCH;
    } catch (err) {
      console.error(`fetchAccountMergers[${accountCode}] offset=${offset}:`, err.message);
      break;
    }
  }
  return rows.filter(
    (m) => String(m.Tran_Type || m.tran_type || "").toUpperCase() === "MERGER",
  );
}

async function fetchSplitsForIsins(zcql, isins, asOnDate) {
  if (!isins || !isins.length) return [];
  const cutoff = nextDayCutoff(asOnDate);
  const dateClause = cutoff ? ` AND Issue_Date < '${cutoff}'` : "";
  const inClause = isins.map((i) => `'${esc(i)}'`).join(",");

  const rows = [];
  const seen = new Set();
  let offset = 0;
  while (true) {
    try {
      const batch = await zcql.executeZCQLQuery(`
        SELECT Security_Code, Security_Name, Issue_Date, Ratio1, Ratio2, ISIN, ROWID
        FROM Split
        WHERE ISIN IN (${inClause})
        ${dateClause}
        ORDER BY Issue_Date ASC, ROWID ASC
        LIMIT ${BATCH} OFFSET ${offset}
      `);
      if (!batch || batch.length === 0) break;
      for (const row of batch) {
        const s = row.Split || row;
        if (s.ROWID && seen.has(s.ROWID)) continue;
        if (s.ROWID) seen.add(s.ROWID);
        rows.push(s);
      }
      if (batch.length < BATCH) break;
      offset += BATCH;
    } catch (err) {
      console.error(`fetchSplitsForIsins offset=${offset}:`, err.message);
      break;
    }
  }

  return rows.map((s) => ({
    ratio1: Number(s.Ratio1) || 0,
    ratio2: Number(s.Ratio2) || 0,
    issueDate: s.Issue_Date,
    isin: s.ISIN || "",
  }));
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

async function rebuildHoldingsForAccount(zcql, accountCode, asOnDate, counters) {
  const t0 = Date.now();

  const transactions = await fetchAccountTransactions(zcql, accountCode, asOnDate);
  const bonuses = await fetchAccountBonuses(zcql, accountCode, asOnDate);
  const demergers = await fetchAccountDemergers(zcql, accountCode, asOnDate);
  const mergers = await fetchAccountMergers(zcql, accountCode, asOnDate);

  const isins = new Set();
  for (const t of transactions) if (t.ISIN) isins.add(t.ISIN);
  for (const b of bonuses) if (b.ISIN) isins.add(b.ISIN);
  for (const d of demergers) if (d.ISIN) isins.add(d.ISIN);
  for (const m of mergers) if (m.ISIN) isins.add(m.ISIN);

  let isinList = [...isins];
  if (ISINS_FILTER.length > 0) {
    const allow = new Set(ISINS_FILTER.map(String));
    isinList = isinList.filter((i) => allow.has(i));
  }

  const splits = await fetchSplitsForIsins(zcql, isinList, asOnDate);

  // Match dashboard behavior: ISINs that appear as Merger.OldISIN are merged
  // away — the surviving (new) ISIN is used instead.
  const mergedAwayIsins = new Set();
  for (const m of mergers) {
    const oldIsin = String(m.OldISIN || m.oldIsin || "").trim();
    if (oldIsin) mergedAwayIsins.add(oldIsin);
  }

  // Group inputs by ISIN.
  const txByIsin = {};
  const bonusByIsin = {};
  const splitByIsin = {};
  const demergerByIsin = {};
  const mergerByIsin = {};

  for (const t of transactions) {
    if (!t.ISIN) continue;
    (txByIsin[t.ISIN] = txByIsin[t.ISIN] || []).push(t);
  }
  for (const b of bonuses) {
    if (!b.ISIN) continue;
    (bonusByIsin[b.ISIN] = bonusByIsin[b.ISIN] || []).push(b);
  }
  for (const s of splits) {
    if (!s.isin) continue;
    (splitByIsin[s.isin] = splitByIsin[s.isin] || []).push(s);
  }
  for (const d of demergers) {
    if (!d.ISIN) continue;
    (demergerByIsin[d.ISIN] = demergerByIsin[d.ISIN] || []).push(d);
  }
  for (const m of mergers) {
    if (!m.ISIN) continue;
    (mergerByIsin[m.ISIN] = mergerByIsin[m.ISIN] || []).push(m);
  }

  const targetIsins = isinList.filter((i) => !mergedAwayIsins.has(i));

  console.log(
    `[${accountCode}] tx=${transactions.length} bon=${bonuses.length} ` +
    `spl=${splits.length} dmg=${demergers.length} mrg=${mergers.length} ` +
    `isins=${isinList.length} mergedAway=${mergedAwayIsins.size} ` +
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
      fifoRows = runFifoEngine(
        txByIsin[isin] || [],
        bonusByIsin[isin] || [],
        splitByIsin[isin] || [],
        false,
        demergerByIsin[isin] || [],
        mergerByIsin[isin] || [],
      );
    } catch (err) {
      console.error(`[${accountCode}/${isin}] FIFO failed:`, err.message);
      counters.errors++;
      continue;
    }

    const rowCount = Array.isArray(fifoRows) ? fifoRows.length : 0;

    if (DRY_RUN) {
      console.log(
        `[DRY_RUN][${accountCode}/${isin}] would write ${rowCount} row(s)`,
      );
      counters.rows += rowCount;
      continue;
    }

    if (!rowCount) {
      try {
        await deleteHoldingsForPair(zcql, accountCode, isin);
      } catch (err) {
        console.error(`[${accountCode}/${isin}] delete (empty) failed:`, err.message);
        counters.errors++;
      }
      continue;
    }

    try {
      await deleteHoldingsForPair(zcql, accountCode, isin);
      for (const r of fifoRows) {
        await insertHoldingsRow(zcql, accountCode, r, isin);
      }
      counters.rows += rowCount;
    } catch (err) {
      console.error(`[${accountCode}/${isin}] rebuild failed:`, err.message);
      counters.errors++;
    }
  }
}

async function rebuildHoldingsForAccountList(zcql, accountCodes, asOnDate) {
  const counters = { pairs: 0, rows: 0, errors: 0 };
  const cutoff = asOnDate !== undefined && asOnDate !== null ? asOnDate : null;
  const list = Array.isArray(accountCodes) ? accountCodes : [];
  for (const accountCode of list) {
    try {
      await rebuildHoldingsForAccount(zcql, accountCode, cutoff, counters);
    } catch (err) {
      console.error(`[DemergerFn holdings][${accountCode}]`, err.message);
      counters.errors++;
    }
  }
  console.log(
    `[DemergerFn] holdings rebuild: ${list.length} accounts, pairs=${counters.pairs}, rows=${counters.rows}, errors=${counters.errors}`
  );
  return counters;
}

module.exports = { rebuildHoldingsForAccountList };
