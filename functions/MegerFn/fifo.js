"use strict";

/**
 * Lot-aware FIFO engine for merger lot extraction.
 *
 * Mirrors the structure of appsail-nodejs/util/analytics/transactionHistory/fifo.js
 * but in CommonJS, and exposes the surviving open lots (with their source ROWID and
 * original buy date) instead of just running totals.
 *
 * mode === "openLots" → returns { holdings, holdingValue, averageCostOfHoldings, openLots[] }
 * mode === "card"     → returns { holdings, holdingValue, averageCostOfHoldings }
 */
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

function runFifoForLots(transactions, bonuses, splits, demergers, mergers, mode) {
  transactions = Array.isArray(transactions) ? transactions : [];
  bonuses = Array.isArray(bonuses) ? bonuses : [];
  splits = Array.isArray(splits) ? splits : [];
  demergers = Array.isArray(demergers) ? demergers : [];
  mergers = Array.isArray(mergers) ? mergers : [];

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
  // Multiple lot-level Merger rows belonging to the same event are additive.
  let lastMergerEventKey = null;

  const normalizeDate = (rawDate) => {
    if (!rawDate) return null;
    const s = String(rawDate).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const [y, m, d] = s.split("-").map(Number);
    if (!y || !m || !d) return s;
    const fullYear = y < 100 ? 2000 + y : y;
    return `${fullYear}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };

  const isBuy = (type) => /^BY-|SQB|OPI/.test(String(type || "").toUpperCase());
  const isSell = (t) => /^SL\+|SQS|OPO|NF-/.test(String(t || "").toUpperCase());

  /** Buy → settlement date (SETDATE); Sell → transaction date (TRANDATE). */
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
            sourceRowId: t.ROWID || null,
            tranType: t.Tran_Type || t.tranType,
            qty: t.QTY || t.qty,
            netrate: t.NETRATE || t.netrate,
            netAmount: t.NETAMOUNT || t.netAmount || t.Net_Amount || 0,
            originalTrandate: normalizeDate(t.TRANDATE || t.trandate || eventDate),
            originalSetdate: normalizeDate(
              t.SETDATE || t.setdate || t.TRANDATE || t.trandate || eventDate,
            ),
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
          sourceRowId: b.ROWID ? `BON-${b.ROWID}` : null,
          bonusShare: b.BonusShare || b.bonusShare,
          exDate: normalizeDate(b.ExDate || b.exDate),
          isin: b.ISIN || b.isin,
        },
      })),

    ...splits
      .filter((s) => s.isin === activeIsin)
      .map((s) => ({
        type: "SPLIT",
        date: normalizeDate(s.issueDate),
        data: {
          ratio1: Number(s.ratio1) || 0,
          ratio2: Number(s.ratio2) || 0,
          issueDate: normalizeDate(s.issueDate),
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
            sourceRowId: d.ROWID ? `DMG-${d.ROWID}` : null,
            qty: d.QTY ?? d.qty,
            price: d.PRICE ?? d.price,
            totalAmount:
              Number(d.TOTAL_AMOUNT ?? d.total_amount ?? d.HOLDING_VALUE ?? 0) || 0,
            trandate: normalizeDate(td),
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
            sourceRowId: m.ROWID ? `MRG-${m.ROWID}` : null,
            qty: Number(m.Quantity ?? m.quantity ?? m.Holding ?? 0) || 0,
            price: Number(m.WAP ?? m.wap ?? 0) || 0,
            totalAmount:
              Number(m.Total_Amount ?? m.total_amount ?? m.HoldingValue ?? 0) || 0,
            trandate: normalizeDate(td),
            isin: m.ISIN || m.isin,
            oldIsin: m.OldISIN || m.oldIsin || "",
          },
        };
      }),
  ].sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    if (da !== db) return da - db;
    return (EVENT_TYPE_PRIORITY[a.type] ?? 99) - (EVENT_TYPE_PRIORITY[b.type] ?? 99);
  });

  const getCostOfHoldings = () =>
    buyQueue.reduce((sum, lot) => sum + lot.qty * lot.price, 0);

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
          sourceRowId: t.sourceRowId,
          sourceType: "TXN",
          originalQty: qty,
          qty,
          price,
          originalTrandate: t.originalTrandate,
          originalSetdate: t.originalSetdate,
          isActive: true,
        });
        holdings += qty;
      }

      if (isSell(t.tranType)) {
        const sellQty = Math.min(qty, holdings);
        let remaining = sellQty;

        while (remaining > 0 && buyQueue.length) {
          const lot = buyQueue[0];
          const used = Math.min(lot.qty, remaining);
          lot.qty -= used;
          remaining -= used;
          if (lot.qty === 0) {
            lot.isActive = false;
            buyQueue.shift();
          }
        }
        holdings -= sellQty;
      }
    }

    if (e.type === "BONUS") {
      const qty = Number(t.bonusShare) || 0;
      if (!qty) continue;

      const lotId = ++lotCounter;
      buyQueue.push({
        lotId,
        sourceRowId: t.sourceRowId,
        sourceType: "BONUS",
        originalQty: qty,
        qty,
        price: 0,
        originalTrandate: t.exDate,
        isActive: true,
      });
      holdings += qty;
    }

    if (e.type === "SPLIT") {
      if (!buyQueue.length) continue;
      const r1 = t.ratio1;
      const r2 = t.ratio2;
      if (!r1 || !r2) continue;

      const multiplier = r2 / r1;
      const activeLots = buyQueue.filter((l) => l.isActive);
      if (!activeLots.length) continue;

      let runningHoldings = 0;
      for (const lot of activeLots) {
        lot.qty = lot.qty * multiplier;
        lot.price = multiplier > 0 ? lot.price / multiplier : lot.price;
        runningHoldings += lot.qty;
      }
      holdings = runningHoldings;
    }

    if (e.type === "DEMERGER") {
      const qty = Math.abs(Number(t.qty) || 0);
      if (!qty) continue;

      let price = Number(t.price) || 0;
      let totalAmount = Number(t.totalAmount) || 0;
      if (!price && totalAmount && qty) price = totalAmount / qty;

      for (const lot of buyQueue) {
        lot.isActive = false;
        lot.qty = 0;
      }
      buyQueue.length = 0;

      const lotId = ++lotCounter;
      buyQueue.push({
        lotId,
        sourceRowId: t.sourceRowId,
        sourceType: "DEMERGER",
        originalQty: qty,
        qty,
        price,
        originalTrandate: t.trandate,
        isActive: true,
      });
      holdings = qty;
    }

    if (e.type === "MERGER") {
      const qty = Math.abs(Number(t.qty) || 0);
      if (!qty) continue;

      let price = Number(t.price) || 0;
      let totalAmount = Number(t.totalAmount) || 0;
      if (!price && totalAmount && qty) price = totalAmount / qty;

      const eventKey = `${t.trandate || ""}|${t.oldIsin || ""}`;
      if (eventKey !== lastMergerEventKey) {
        // First lot of a new merger event — retire pre-merger holdings.
        for (const lot of buyQueue) {
          lot.isActive = false;
          lot.qty = 0;
        }
        buyQueue.length = 0;
        holdings = 0;
        lastMergerEventKey = eventKey;
      }

      const lotId = ++lotCounter;
      buyQueue.push({
        lotId,
        sourceRowId: t.sourceRowId,
        sourceType: "MERGER",
        originalQty: qty,
        qty,
        price,
        originalTrandate: t.trandate,
        isActive: true,
      });
      holdings += qty;
    }
  }

  const cost = getCostOfHoldings();
  const wap = holdings > 0 ? cost / holdings : 0;

  if (mode === "card") {
    return { holdings, holdingValue: cost, averageCostOfHoldings: wap };
  }

  const openLots = buyQueue
    .filter((lot) => lot.isActive && lot.qty > 0)
    .map((lot) => ({
      sourceRowId: lot.sourceRowId,
      sourceType: lot.sourceType,
      originalTrandate: lot.originalTrandate,
      originalSetdate: lot.originalSetdate,
      qty: lot.qty,
      costPerShare: lot.price,
      totalCost: lot.qty * lot.price,
    }));

  return {
    holdings,
    holdingValue: cost,
    averageCostOfHoldings: wap,
    openLots,
  };
}

module.exports = { runFifoForLots };
