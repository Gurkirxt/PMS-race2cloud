/**
 * UpdateDividendData (Catalyst job function)
 *
 * Triggered as a background job by the AppSail controller
 * `applyStockDividendMaster` (DividendUploader.js) via
 * `jobScheduling.JOB.submitJob({ target_name: "UpdateDividendData", ... })`.
 *
 * Job params (all required, supplied by the controller):
 *   isin, securityCode, securityName, rate, exDate, recordDate,
 *   paymentDate, dividendType, jobName
 *
 * What it does:
 *   1. INSERT a row into `Jobs` (status='PENDING') keyed by jobName so the
 *      React UI can poll `/dividend/apply-status?jobName=...`.
 *   2. Idempotency check on (ISIN, RecordDate) in `Dividend`.
 *   3. INSERT one master row into `Dividend`.
 *   4. Discover all accounts that ever traded the ISIN.
 *   5. Fetch Transaction / Bonus / Split rows ≤ RecordDate for the ISIN.
 *   6. Run FIFO engine per account (card mode) to get holding-on-record-date.
 *   7. INSERT one row into `Dividend_Record` per eligible account.
 *   8. APPEND one row into `Cash_Balance_Per_Transaction` per eligible
 *      account (running balance + monotonic Sequence per account).
 *   9. UPDATE the `Jobs` row to status='COMPLETED' (or 'FAILED' on error).
 */

const catalyst = require("zcatalyst-sdk-node");

const ZCQL_ROW_LIMIT = 270;

const esc = (s) => String(s ?? "").replace(/'/g, "''");

const normalizeDate = (d) => {
  const dt = new Date(d);
  dt.setHours(0, 0, 0, 0);
  return dt.toISOString().split("T")[0];
};

/* =========================================================================
   FIFO ENGINE — inlined verbatim from
   appsail-nodejs/util/analytics/transactionHistory/fifo.js
   (converted from ESM to CommonJS, behavior unchanged).
   ========================================================================= */

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

  const normalizeFifoDate = (rawDate) => {
    if (!rawDate) return null;
    const [y, m, d] = rawDate.split("-").map(Number);
    const fullYear = y < 100 ? 2000 + y : y;
    return `${fullYear}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };

  const isBuy = (type) => /^BY-|SQB|OPI/.test(String(type || "").toUpperCase());
  const isSell = (t) => /^SL\+|SQS|OPO|NF-/.test(String(t).toUpperCase());

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
          date: normalizeFifoDate(eventDate),
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
        date: normalizeFifoDate(b.ExDate || b.exDate),
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
        date: normalizeFifoDate(s.issueDate),
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
          date: normalizeFifoDate(td),
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
          date: normalizeFifoDate(td),
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

  const getCostOfHoldings = () =>
    buyQueue.reduce((sum, lot) => sum + lot.qty * lot.price, 0);
  const getWAP = () => (holdings > 0 ? getCostOfHoldings() / holdings : 0);

  for (const e of events) {
    const t = e.data;

    if (e.type === "TXN") {
      const qty = Math.abs(Number(t.qty) || 0);
      if (!qty) continue;

      const price = Number(t.netrate) || (t.netAmount && qty ? t.netAmount / qty : 0);

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
          buyDate: normalizeFifoDate(t.trandate),
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
        buyDate: normalizeFifoDate(e.data.exDate),
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
      const splitDate = normalizeFifoDate(e.data.issueDate);
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

      const demergerDate = normalizeFifoDate(e.data.trandate);
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

      const mergerDate = normalizeFifoDate(e.data.trandate);
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
      return { isin: "", holdings: 0, holdingValue: 0, averageCostOfHoldings: 0 };
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

/* =========================================================================
   JOB ENTRY POINT
   ========================================================================= */
module.exports = async (jobRequest, context) => {
  const catalystApp = catalyst.initialize(context);
  const zcql = catalystApp.zcql();
  let jobName = "";

  try {
    console.log("UpdateDividendData job started");

    /* ---- 1. Resolve inputs from job params (controller always supplies these) ---- */
    const params = jobRequest.getAllJobParams();
    const {
      isin,
      securityCode,
      securityName,
      exDate,
      recordDate,
      paymentDate,
      dividendType,
    } = params;
    const rate = Number(params.rate);
    jobName = params.jobName;

    if (!Number.isFinite(rate) || rate <= 0) {
      console.error("UpdateDividendData: invalid dividend rate ->", params.rate);
      if (jobName) {
        try {
          await zcql.executeZCQLQuery(
            `UPDATE Jobs SET status = 'FAILED' WHERE jobName = '${jobName}'`
          );
        } catch (e) {
          console.error("Failed to mark job FAILED on validation error:", e);
        }
      }
      context.closeWithFailure();
      return;
    }
    if (!isin || !securityCode || !securityName || !recordDate || !paymentDate) {
      console.error("UpdateDividendData: missing required fields", {
        isin,
        securityCode,
        securityName,
        recordDate,
        paymentDate,
      });
      if (jobName) {
        try {
          await zcql.executeZCQLQuery(
            `UPDATE Jobs SET status = 'FAILED' WHERE jobName = '${jobName}'`
          );
        } catch (e) {
          console.error("Failed to mark job FAILED on validation error:", e);
        }
      }
      context.closeWithFailure();
      return;
    }

    /* ---- 1b. Insert PENDING row in Jobs so /apply-status can be polled ---- */
    await zcql.executeZCQLQuery(
      `INSERT INTO Jobs (jobName, status) VALUES ('${jobName}', 'PENDING')`
    );

    const recordDateISO = normalizeDate(recordDate);
    const exDateISO = exDate && String(exDate).trim()
      ? normalizeDate(exDate)
      : recordDateISO;
    const paymentDateISO = normalizeDate(paymentDate);

    console.log(
      `UpdateDividendData: ISIN=${isin} RecordDate=${recordDateISO} Rate=${rate} PaymentDate=${paymentDateISO}`,
    );

    /* ---- 2. Idempotency check ---- */
    const existing = await zcql.executeZCQLQuery(`
      SELECT ROWID
      FROM Dividend
      WHERE ISIN='${esc(isin)}'
      AND RecordDate='${recordDateISO}'
      LIMIT 1
    `);

    if (existing && existing.length > 0) {
      console.warn(
        `Dividend already exists for ISIN=${isin} RecordDate=${recordDateISO}. Skipping master insert and per-account allocation.`,
      );
      await zcql.executeZCQLQuery(
        `UPDATE Jobs SET status = 'COMPLETED' WHERE jobName = '${jobName}'`
      );
      context.closeWithSuccess();
      return;
    }

    /* ---- 3. INSERT INTO Dividend (master row) ---- */
    await zcql.executeZCQLQuery(`
      INSERT INTO Dividend
      (
        SecurityCode,
        Security_Name,
        ISIN,
        Rate,
        ExDate,
        RecordDate,
        PaymentDate,
        Dividend_Type,
        Status
      )
      VALUES
      (
        '${esc(securityCode)}',
        '${esc(securityName)}',
        '${esc(isin)}',
        ${rate},
        '${exDateISO}',
        '${recordDateISO}',
        '${paymentDateISO}',
        '${esc(dividendType || "Final")}',
        'Draft'
      )
    `);
    console.log(`Dividend master row inserted for ${isin}/${recordDateISO}`);

    /* ---- 4. Discover candidate accounts ---- */
    const accountSet = new Set();
    let holdOffset = 0;
    while (true) {
      const batch = await zcql.executeZCQLQuery(`
        SELECT WS_Account_code FROM Transaction
        WHERE ISIN='${esc(isin)}'
        LIMIT ${ZCQL_ROW_LIMIT} OFFSET ${holdOffset}
      `);
      if (!batch || batch.length === 0) break;
      batch.forEach((r) => accountSet.add(r.Transaction.WS_Account_code));
      if (batch.length < ZCQL_ROW_LIMIT) break;
      holdOffset += ZCQL_ROW_LIMIT;
    }
    const eligibleAccounts = Array.from(accountSet);
    console.log(`Candidate accounts discovered: ${eligibleAccounts.length}`);

    if (eligibleAccounts.length === 0) {
      console.log("No eligible accounts. Job complete (master row inserted only).");
      await zcql.executeZCQLQuery(
        `UPDATE Jobs SET status = 'COMPLETED' WHERE jobName = '${jobName}'`
      );
      context.closeWithSuccess();
      return;
    }

    /* ---- 5. Fetch Transactions ≤ recordDate for ISIN ---- */
    const txRows = [];
    const seenTxnRowIds = new Set();
    let txOffset = 0;
    while (true) {
      const batch = await zcql.executeZCQLQuery(`
        SELECT * FROM Transaction
        WHERE ISIN='${esc(isin)}' AND SETDATE <= '${recordDateISO}'
        ORDER BY SETDATE ASC, ROWID ASC
        LIMIT ${ZCQL_ROW_LIMIT} OFFSET ${txOffset}
      `);
      if (!batch || batch.length === 0) break;
      for (const row of batch) {
        const t = row.Transaction || row;
        if (t.ROWID != null && seenTxnRowIds.has(t.ROWID)) continue;
        if (t.ROWID != null) seenTxnRowIds.add(t.ROWID);
        txRows.push(row);
      }
      if (batch.length < ZCQL_ROW_LIMIT) break;
      txOffset += ZCQL_ROW_LIMIT;
    }

    /* ---- 6. Fetch Bonuses ≤ recordDate for ISIN ---- */
    const bonusRows = [];
    let bonusOffset = 0;
    while (true) {
      const batch = await zcql.executeZCQLQuery(`
        SELECT * FROM Bonus
        WHERE ISIN='${esc(isin)}' AND ExDate <= '${recordDateISO}'
        ORDER BY ExDate ASC, ROWID ASC
        LIMIT ${ZCQL_ROW_LIMIT} OFFSET ${bonusOffset}
      `);
      if (!batch || batch.length === 0) break;
      bonusRows.push(...batch);
      if (batch.length < ZCQL_ROW_LIMIT) break;
      bonusOffset += ZCQL_ROW_LIMIT;
    }

    /* ---- 7. Fetch Splits ≤ recordDate for ISIN ---- */
    const splitRows = [];
    let splitOffset = 0;
    while (true) {
      const batch = await zcql.executeZCQLQuery(`
        SELECT * FROM Split
        WHERE ISIN='${esc(isin)}' AND Issue_Date <= '${recordDateISO}'
        ORDER BY Issue_Date ASC, ROWID ASC
        LIMIT ${ZCQL_ROW_LIMIT} OFFSET ${splitOffset}
      `);
      if (!batch || batch.length === 0) break;
      splitRows.push(...batch);
      if (batch.length < ZCQL_ROW_LIMIT) break;
      splitOffset += ZCQL_ROW_LIMIT;
    }

    console.log(
      `Fetched: ${txRows.length} txn(s), ${bonusRows.length} bonus(es), ${splitRows.length} split(s)`,
    );

    /* ---- 8. Group by account ---- */
    const txByAccount = {};
    txRows.forEach((r) => {
      const t = r.Transaction;
      (txByAccount[t.WS_Account_code] ||= []).push(t);
    });

    const bonusByAccount = {};
    bonusRows.forEach((r) => {
      const b = r.Bonus;
      (bonusByAccount[b.WS_Account_code] ||= []).push(b);
    });

    const splits = splitRows.map((r) => {
      const s = r.Split;
      return {
        issueDate: s.Issue_Date,
        ratio1: Number(s.Ratio1) || 0,
        ratio2: Number(s.Ratio2) || 0,
        isin: s.ISIN,
      };
    });

    /* ---- 9. FIFO + INSERT INTO Dividend_Record + Cash_Balance_Per_Transaction
     *        per eligible account.
     *
     *        Cash_Balance_Per_Transaction insert rules (append-only):
     *          - Skip if a row already exists for
     *            (Account_Code, ISIN, Transaction_Date=RecordDate, Type='DIVIDEND').
     *          - Otherwise read the last row for the account (ORDER BY Sequence DESC),
     *            insert a new row with Sequence=lastSeq+1 and
     *            Cash_Balance=lastBalance+dividendAmount.
     *          - Tran Date = RecordDate, Set Date = RecordDate (both store/display
     *            the record date so the Cash Passbook UI shows the dividend's
     *            entitlement date in both date columns).
     * ---- */
    let insertedCount = 0;
    let skippedNoTxn = 0;
    let skippedFlat = 0;
    let insertErrors = 0;
    let cashInsertedCount = 0;
    let cashSkippedDup = 0;
    let cashErrors = 0;

    for (const accountCode of eligibleAccounts) {
      const transactions = txByAccount[accountCode] || [];
      if (!transactions.length) {
        skippedNoTxn++;
        continue;
      }

      const bonuses = bonusByAccount[accountCode] || [];
      const fifo = runFifoEngine(transactions, bonuses, splits, true);
      if (!fifo || fifo.holdings <= 0) {
        skippedFlat++;
        continue;
      }

      const holding = fifo.holdings;
      const dividendAmount = Math.round(holding * rate * 100) / 100;

      try {
        await zcql.executeZCQLQuery(`
          INSERT INTO Dividend_Record
          (ISIN, RecordDate, WS_Account_code, Holding, Rate, Dividend_Amount, PaymentDate, Security_Code, Status)
          VALUES (
            '${esc(isin)}',
            '${recordDateISO}',
            '${esc(accountCode)}',
            ${holding},
            ${rate},
            ${dividendAmount},
            '${paymentDateISO}',
            '${esc(securityCode)}',
            'Draft'
          )
        `);
        insertedCount++;

        /* ---- Cash_Balance_Per_Transaction: append dividend credit ---- */
        try {
          const existingCash = await zcql.executeZCQLQuery(`
            SELECT ROWID FROM Cash_Balance_Per_Transaction
            WHERE Account_Code = '${esc(accountCode)}'
              AND ISIN = '${esc(isin)}'
              AND Transaction_Date = '${recordDateISO}'
              AND Transaction_Type = 'DIVIDEND'
            LIMIT 1
          `);

          if (existingCash && existingCash.length > 0) {
            cashSkippedDup++;
          } else {
            const lastRow = await zcql.executeZCQLQuery(`
              SELECT Cash_Balance, Sequence FROM Cash_Balance_Per_Transaction
              WHERE Account_Code = '${esc(accountCode)}'
              ORDER BY Sequence DESC
              LIMIT 1
            `);

            let lastBalance = 0;
            let lastSequence = 0;
            if (lastRow && lastRow.length > 0) {
              const r = lastRow[0].Cash_Balance_Per_Transaction || lastRow[0];
              lastBalance = Number(r.Cash_Balance) || 0;
              lastSequence = Number(r.Sequence) || 0;
            }

            const newBalance =
              Math.round((lastBalance + dividendAmount) * 100) / 100;
            const newSequence = lastSequence + 1;

            await zcql.executeZCQLQuery(`
              INSERT INTO Cash_Balance_Per_Transaction
              (Account_Code, Transaction_Type, Transaction_Date, Settlement_Date, Price, Cash_Balance, Security_Name, ISIN, Quantity, Total_Amount, STT, Sequence)
              VALUES (
                '${esc(accountCode)}',
                'DIVIDEND',
                '${recordDateISO}',
                '${recordDateISO}',
                ${rate},
                ${newBalance},
                '${esc(securityCode)}',
                '${esc(isin)}',
                ${Math.round(Number(holding) || 0)},
                ${dividendAmount},
                0,
                ${newSequence}
              )
            `);
            cashInsertedCount++;
          }
        } catch (cashErr) {
          cashErrors++;
          console.error(
            `Cash_Balance_Per_Transaction insert failed for ${accountCode}: ${cashErr.message}`,
          );
        }
      } catch (insertErr) {
        insertErrors++;
        console.error(
          `Dividend_Record insert failed for ${accountCode}: ${insertErr.message}`,
        );
      }
    }

    console.log(
      `UpdateDividendData done. Master=1, Records inserted=${insertedCount}, ` +
        `skipped(noTxn)=${skippedNoTxn}, skipped(flat)=${skippedFlat}, errors=${insertErrors}, ` +
        `CashRows inserted=${cashInsertedCount}, CashRows skipped(dup)=${cashSkippedDup}, CashRows errors=${cashErrors}`,
    );

    await zcql.executeZCQLQuery(
      `UPDATE Jobs SET status = 'COMPLETED' WHERE jobName = '${jobName}'`
    );
    context.closeWithSuccess();
  } catch (error) {
    console.error("UpdateDividendData failed:", error);
    if (jobName) {
      try {
        await zcql.executeZCQLQuery(
          `UPDATE Jobs SET status = 'FAILED' WHERE jobName = '${jobName}'`
        );
      } catch (updateErr) {
        console.error("Failed to update job status to FAILED:", updateErr);
      }
    }
    context.closeWithFailure();
  }
};
