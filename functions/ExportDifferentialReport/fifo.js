"use strict";

/**
 * Quantity epsilon for normal (non-corporate-action) holding math. Snaps tiny
 * floating-point residue to exactly zero so fully-sold positions report 0.
 * Genuine fractional quantities are preserved. Corporate-action rounding is
 * intentional and unaffected.
 */
const QTY_EPS = 1e-6;
const snapQty = (n) => {
  const v = Number(n) || 0;
  return Math.abs(v) < QTY_EPS ? 0 : v;
};

/**
 * runFifoEngine
 *
 * @param {Array}   transactions  - Array of transaction rows
 * @param {Array}   bonuses       - Array of bonus rows
 * @param {Array}   splits        - Array of split rows
 * @param {boolean} [returnHoldingsOnly=false]
 *   When true (used by the per-row simulation in the UI and by the export),
 *   return { isin, holdings } without any extra computation.
 *   The 4th arg was always being passed as `true` by callers but the old
 *   function signature silently ignored it — this fixes that mismatch.
 *
 * @returns {{ isin: string, holdings: number }}
 */
function runFifoEngine(transactions, bonuses, splits, returnHoldingsOnly = false) {
  if (!Array.isArray(transactions)) transactions = [];
  if (!Array.isArray(bonuses)) bonuses = [];
  if (!Array.isArray(splits)) splits = [];

  if (!transactions.length && !bonuses.length && !splits.length) {
    return { isin: "", holdings: 0 };
  }

  const activeIsin =
    transactions[0]?.ISIN ||
    transactions[0]?.isin ||
    bonuses[0]?.ISIN ||
    bonuses[0]?.isin ||
    splits[0]?.isin ||
    null;

  if (!activeIsin) return { isin: "", holdings: 0 };

  let holdings = 0;

  const isBuy = (t) => /^BY-|SQB|OPI/.test(String(t).toUpperCase());
  const isSell = (t) => /^SL\+|SQS|OPO|NF-/.test(String(t).toUpperCase());

  /* ── Process transactions ── */
  for (const txn of transactions) {
    const txnIsin = txn.ISIN || txn.isin;
    if (txnIsin !== activeIsin) continue;

    const qty = Math.abs(Number(txn.QTY || txn.qty) || 0);
    if (!qty) continue;

    const type = txn.Tran_Type || txn.tranType || "";

    if (isBuy(type)) holdings += qty;
    if (isSell(type)) holdings -= qty;
  }

  /* ── Process bonuses ── */
  for (const bonus of bonuses) {
    const bonusIsin = bonus.ISIN || bonus.isin;
    if (bonusIsin !== activeIsin) continue;

    const qty = Number(bonus.BonusShare || bonus.bonusShare) || 0;
    holdings += qty;
  }

  /* ── Process splits ── */
  for (const split of splits) {
    if (split.isin !== activeIsin) continue;

    const ratio1 = Number(split.ratio1);
    const ratio2 = Number(split.ratio2);

    if (!ratio1 || !ratio2) continue;

    const multiplier = ratio2 / ratio1;
    holdings = holdings * multiplier;
  }

  // Holdings can never go below zero
  if (holdings < 0) holdings = 0;

  // Snap floating-point dust from fractional buys/sells to exactly zero.
  holdings = snapQty(holdings);

  return {
    isin: activeIsin,
    holdings,
  };
}

module.exports = { runFifoEngine };