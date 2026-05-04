/**
 * Quantity-only FIFO engine.
 *
 * Used by TransactionUploader.computeBaseHolding to compute the running holding
 * count for a stock. Returns { isin, holdings } — does NOT track WAP, lot
 * details or per-row output. Date-sorted so that on the same date a SPLIT is
 * always applied before a BONUS (matches the analytics engine).
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
};

const isBuy = (type) => /^BY-|SQB|OPI/.test(String(type || "").toUpperCase());
const isSell = (type) => /^SL\+|SQS|OPO|NF-/.test(String(type || "").toUpperCase());

const normalizeDate = (rawDate) => {
  if (!rawDate) return null;
  const [y, m, d] = String(rawDate).split("-").map(Number);
  if (!y || !m || !d) return null;
  const fullYear = y < 100 ? 2000 + y : y;
  return `${fullYear}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

/** Buy → settlement date (SETDATE); Sell → transaction date (TRANDATE). */
const getTxnEventDate = (t) => {
  const setDate = t.SETDATE || t.setdate;
  const tradeDate = t.TRANDATE || t.trandate;
  return isBuy(t.Tran_Type || t.tranType) ? setDate || tradeDate : tradeDate || setDate;
};

export const runFifoEngine = (
  transactions = [],
  bonuses = [],
  splits = []
) => {
  if (!transactions.length && !bonuses.length && !splits.length) {
    return { isin: "", holdings: 0 };
  }

  const activeIsin =
    transactions[0]?.ISIN ||
    bonuses[0]?.ISIN ||
    splits[0]?.isin ||
    null;

  if (!activeIsin) return { isin: "", holdings: 0 };

  const events = [
    ...transactions
      .filter((t) => (t.ISIN || t.isin) === activeIsin)
      .map((t) => ({
        type: "TXN",
        date: normalizeDate(getTxnEventDate(t)),
        data: { tranType: t.Tran_Type || t.tranType, qty: t.QTY || t.qty },
      })),
    ...bonuses
      .filter((b) => (b.ISIN || b.isin) === activeIsin)
      .map((b) => ({
        type: "BONUS",
        date: normalizeDate(b.ExDate || b.exDate),
        data: { bonusShare: b.BonusShare || b.bonusShare },
      })),
    ...splits
      .filter((s) => s.isin === activeIsin)
      .map((s) => ({
        type: "SPLIT",
        date: normalizeDate(s.issueDate),
        data: { ratio1: s.ratio1, ratio2: s.ratio2 },
      })),
  ].sort((a, b) => {
    const dateDiff = new Date(a.date) - new Date(b.date);
    if (dateDiff !== 0) return dateDiff;
    return (EVENT_TYPE_PRIORITY[a.type] ?? 99) - (EVENT_TYPE_PRIORITY[b.type] ?? 99);
  });

  let holdings = 0;

  for (const e of events) {
    if (e.type === "TXN") {
      const qty = Math.abs(Number(e.data.qty) || 0);
      if (!qty) continue;
      if (isBuy(e.data.tranType)) holdings += qty;
      if (isSell(e.data.tranType)) holdings -= qty;
    } else if (e.type === "BONUS") {
      const qty = Number(e.data.bonusShare) || 0;
      holdings += qty;
    } else if (e.type === "SPLIT") {
      const ratio1 = Number(e.data.ratio1);
      const ratio2 = Number(e.data.ratio2);
      if (!ratio1 || !ratio2) continue;
      holdings = holdings * (ratio2 / ratio1);
    }
  }

  if (holdings < 0) holdings = 0;

  return { isin: activeIsin, holdings };
};
