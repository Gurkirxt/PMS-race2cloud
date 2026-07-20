import { fetchHoldingsRowsForAccountIsin } from "../../../util/analytics/holdingsFromTable.js";
import { buildVirtualToActualMap } from "../../../util/mapVirtualToActualCodes.js";

const BATCH_SIZE = 270;

export const exportBonusPreviewFile = async (req, res) => {
  try {
    if (!req.catalystApp) {
      return res.status(500).json({ success: false, message: "Catalyst not initialized" });
    }

    const { isin, ratio1, ratio2, exDate } = req.query;
    const r1 = Number(ratio1);
    const r2 = Number(ratio2);

    if (!isin || !exDate || r1 <= 0 || r2 <= 0) {
      return res.status(400).json({ success: false, message: "Invalid input" });
    }

    const exDateISO = new Date(exDate).toISOString().split("T")[0];

    const catalystApp = req.catalystApp;
    const zcql = catalystApp.zcql();
    const bucket = catalystApp.stratus().bucket("export-app-data");

    let csv =
      "ISIN,VIRTUAL_CODE,ACTUAL_CODE,CURRENT_HOLDING,BONUS_SHARES,NEW_HOLDING,DELTA\n";

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

      if (!rows.length) break;
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

    /* ================= HOLDING AS OF EX-DATE (read materialised Holdings) =================
       Read the stored Holdings ledger — the same source of truth as the
       rebuild / upload worker — as of the ex-date, instead of replaying FIFO
       from the source tables. The last row in FIFO order carries the running
       HOLDING (holding as of that date), and corporate actions already applied
       (incl. demerger/merger) are reflected automatically. */
    for (const acc of eligibleAccounts) {
      const holdingRows = await fetchHoldingsRowsForAccountIsin(
        zcql,
        acc,
        isin,
        exDateISO,
      );
      const beforeHolding = holdingRows.length
        ? Number(holdingRows[holdingRows.length - 1].HOLDING) || 0
        : 0;
      if (beforeHolding <= 1e-6) continue;

      const bonusShares = Math.floor((beforeHolding * r1) / r2);
      if (bonusShares <= 0) continue;

      const afterHolding = beforeHolding + bonusShares;

      const actualCode = virtualToActual.get(acc) || "";
      csv += `"${isin}","${acc}","${actualCode}","${beforeHolding}","${bonusShares}","${afterHolding}","${afterHolding - beforeHolding}"\n`;
    }

    /* ================= UPLOAD ================= */
    const fileName = `BonusExport_${isin}_${Date.now()}.csv`;
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
    console.error("EXPORT BONUS ERROR:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
