const {
  escHoldingsSql,
  fetchHoldingsRowsPaged,
  fetchSecurityListByIsins,
  rollupLastSnapshotByIsin,
} = require("./holdingsFromTable.js");

/**
 * Per-account holdings for bulk export — from materialised `Holdings` + Bhav_Copy.
 * Matches AppSail `exportHolding/analyticsController.js` and dashboard summary.
 *
 * @param {{ catalystApp: object, accountCode: string, asOnDate?: string, sharedPriceMap?: Record<string, number> }} opts
 */
exports.calculateHoldingsSummary = async ({
  catalystApp,
  accountCode,
  asOnDate,
  sharedPriceMap,
}) => {
  const zcql = catalystApp.zcql();

  const rows = await fetchHoldingsRowsPaged(zcql, accountCode, asOnDate, "");
  const snapshots = rollupLastSnapshotByIsin(rows);
  const isinList = snapshots.map((s) => s.isin);

  const metaByIsin = await fetchSecurityListByIsins(zcql, isinList);

  const todayStr = new Date().toISOString().split("T")[0];
  const priceDate = asOnDate && asOnDate < todayStr ? asOnDate : todayStr;

  const priceMap = sharedPriceMap || {};

  for (const isin of isinList) {
    if (isin in priceMap) continue;
    try {
      const priceRows = await zcql.executeZCQLQuery(`
        SELECT ISIN, ClsPric, TradDt
        FROM Bhav_Copy
        WHERE ISIN = '${escHoldingsSql(isin)}'
          AND TradDt <= '${escHoldingsSql(priceDate)}'
        ORDER BY TradDt DESC
        LIMIT 1
      `);

      if (priceRows.length) {
        const row = priceRows[0].Bhav_Copy || priceRows[0];
        priceMap[isin] = row.ClsPric || 0;
      } else {
        priceMap[isin] = 0;
      }
    } catch (err) {
      console.error(`Error fetching price for ISIN ${isin}:`, err);
      priceMap[isin] = 0;
    }
  }

  const result = [];
  for (const { isin, lastRow } of snapshots) {
    const hold = Number(lastRow.HOLDING) || 0;
    const wap = Number(lastRow.WAP) || 0;
    const hv = Number(lastRow.HOLDING_VALUE) || hold * wap;
    const meta = metaByIsin[isin] || {};
    const lastPrice = priceMap[isin] || 0;

    result.push({
      isin,
      stockName: meta.securityName || isin,
      securityCode: meta.securityCode || "",
      currentHolding: hold,
      avgPrice: wap,
      holdingValue: hv,
      lastPrice,
      marketValue: hold * lastPrice,
    });
  }

  return result.sort((a, b) =>
    (a.stockName || "").localeCompare(b.stockName || ""),
  );
};
