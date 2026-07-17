import { runFifoEngine } from "../../../util/analytics/transactionHistory/fifo.js";
import { buildVirtualToActualMap } from "../../../util/mapVirtualToActualCodes.js";

const BATCH_SIZE = 270;

export const exportSplitPreviewFile = async (req, res) => {
  try {
    if (!req.catalystApp) {
      return res
        .status(500)
        .json({ success: false, message: "Catalyst not initialized" });
    }

    const { isin, ratio1, ratio2, issueDate } = req.query;
    const r1 = Number(ratio1);
    const r2 = Number(ratio2);

    if (!isin || !issueDate || r1 <= 0 || r2 <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid input" });
    }

    const issueDateISO = new Date(issueDate).toISOString().split("T")[0];

    const catalystApp = req.catalystApp;
    const zcql = catalystApp.zcql();
    const bucket = catalystApp.stratus().bucket("export-app-data");

    let csv =
      "ISIN,VIRTUAL_CODE,ACTUAL_CODE,CURRENT_HOLDING,NEW_HOLDING,DELTA\n";

    /* ================= FIND ACCOUNTS WITH TRANSACTIONS ================= */
    const accountSet = new Set();
    let offset = 0;

    while (true) {
      const rows = await zcql.executeZCQLQuery(`
        SELECT WS_Account_code
        FROM Transaction
        WHERE ISIN='${isin}'
        LIMIT ${BATCH_SIZE} OFFSET ${offset}
      `);

      if (!rows || rows.length === 0) break;
      rows.forEach((r) => accountSet.add(r.Transaction.WS_Account_code));
      if (rows.length < BATCH_SIZE) break;
      offset += BATCH_SIZE;
    }

    const eligibleAccounts = Array.from(accountSet);

    if (!eligibleAccounts.length) {
      return res.json({ success: false, message: "No eligible accounts" });
    }

    const virtualToActual = await buildVirtualToActualMap(
      zcql,
      eligibleAccounts,
    );

    /* ================= FETCH TX / BONUS / PAST SPLITS (ROWID dedupe) ================= */
    const fetchAllDeduped = async (table, dateCol, operator, orderBySql) => {
      const out = [];
      const seenRowIds = new Set();
      let off = 0;

      while (true) {
        const r = await zcql.executeZCQLQuery(`
          SELECT *
          FROM ${table}
          WHERE ISIN='${isin}' AND ${dateCol} ${operator} '${issueDateISO}'
          ORDER BY ${orderBySql}
          LIMIT ${BATCH_SIZE} OFFSET ${off}
        `);

        if (!r || r.length === 0) break;
        for (const row of r) {
          const rec = row[table] || row.Transaction || row.Bonus || row.Split || row;
          const rowId = rec.ROWID;
          if (rowId != null && seenRowIds.has(rowId)) continue;
          if (rowId != null) seenRowIds.add(rowId);
          out.push(row);
        }
        if (r.length < BATCH_SIZE) break;
        off += BATCH_SIZE;
      }
      return out;
    };

    const txRows = await fetchAllDeduped(
      "Transaction",
      "SETDATE",
      "<=",
      "SETDATE ASC, ROWID ASC"
    );
    const bonusRows = await fetchAllDeduped(
      "Bonus",
      "ExDate",
      "<=",
      "ExDate ASC, ROWID ASC"
    );
    const splitRows = await fetchAllDeduped(
      "Split",
      "Issue_Date",
      "<=",
      "Issue_Date ASC, ROWID ASC"
    );

    /* ================= GROUP DATA ================= */
    const txByAcc = {};
    txRows.forEach((r) => {
      const t = r.Transaction;
      (txByAcc[t.WS_Account_code] ||= []).push(t);
    });

    const bonusByAcc = {};
    bonusRows.forEach((r) => {
      const b = r.Bonus;
      (bonusByAcc[b.WS_Account_code] ||= []).push(b);
    });

    const pastSplits = splitRows.map((r) => {
      const s = r.Split;
      return {
        issueDate: s.Issue_Date,
        ratio1: Number(s.Ratio1) || 0,
        ratio2: Number(s.Ratio2) || 0,
        isin: s.ISIN,
      };
    });

    /* ================= FIFO + CSV ================= */
    const splitMultiplier = r2 / r1;

    for (const acc of eligibleAccounts) {
      const tx = txByAcc[acc] || [];
      if (!tx.length) continue;

      const bonuses = bonusByAcc[acc] || [];

      const before = runFifoEngine(tx, bonuses, pastSplits, true);
      if (!before || before.holdings <= 1e-6) continue;

      const newHolding = Math.floor(before.holdings * splitMultiplier);
      const delta = newHolding - before.holdings;
      const actualCode = virtualToActual.get(acc) || "";

      csv += `"${isin}","${acc}","${actualCode}","${before.holdings}","${newHolding}","${delta}"\n`;
    }

    /* ================= UPLOAD ================= */
    const fileName = `SplitExport_${isin}_${Date.now()}.csv`;
    await bucket.putObject(fileName, Buffer.from(csv), {
      overwrite: true,
      contentType: "text/csv",
    });

    const signedUrl = await bucket.generatePreSignedUrl(fileName, "GET", {
      expiresIn: 3600,
    });

    return res.json({
      success: true,
      downloadUrl: { signature: signedUrl },
    });

  } catch (err) {
    console.error("EXPORT SPLIT PREVIEW ERROR:", err);
    return res
      .status(500)
      .json({ success: false, message: err.message });
  }
};
