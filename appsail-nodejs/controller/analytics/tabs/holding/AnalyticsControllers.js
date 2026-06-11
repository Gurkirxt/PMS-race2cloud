import { getAllAccountCodesFromDatabase } from "../../../../util/allAccountCodes.js";
import {
  escHoldingsSql,
  fetchHoldingsRowsPaged,
  fetchSecurityListByIsins,
  rollupLastSnapshotByIsin,
} from "../../../../util/analytics/holdingsFromTable.js";

export const getAllAccountCodes = async (req, res) => {
  try {
    const zohoCatalyst = req.catalystApp;
    let zcql = zohoCatalyst.zcql();
    let tableName = "clientIds";
    const cliendIds = await getAllAccountCodesFromDatabase(zcql, tableName);
    return res.status(200).json({ data: cliendIds });
  } catch (error) {
    console.log("Error in fetching data", error);
    res.status(400).json({ error: error.message });
  }
};

/**
 * Distinct `Actual_Code` values from `clientIds`. Used by the consolidated
 * holdings export, where one actual code groups several virtual codes.
 * Returned in the same shape as `getAllAccountCodes` so the UI hook can parse
 * either list with the same code.
 */
export const getAllActualCodes = async (req, res) => {
  try {
    const zcql = req.catalystApp.zcql();
    const seen = new Set();
    const codes = [];
    let offset = 0;
    const LIMIT = 270;

    while (true) {
      const batch = await zcql.executeZCQLQuery(
        `SELECT Actual_Code FROM clientIds LIMIT ${LIMIT} OFFSET ${offset}`,
      );
      if (!batch?.length) break;

      for (const r of batch) {
        const row = r.clientIds || r;
        const code = String(row.Actual_Code ?? "").trim();
        if (code && !seen.has(code)) {
          seen.add(code);
          codes.push(code);
        }
      }

      if (batch.length < LIMIT) break;
      offset += LIMIT;
    }

    codes.sort((a, b) => a.localeCompare(b));
    return res.status(200).json({
      data: codes.map((code) => ({ clientIds: { WS_Account_code: code } })),
    });
  } catch (error) {
    console.log("Error fetching actual codes", error);
    res.status(400).json({ error: error.message });
  }
};

export const getHoldingsSummarySimple = async (req, res) => {
  try {
    const accountCode = req.query.accountCode;
    if (!accountCode)
      return res.status(400).json({ message: "accountCode required" });

    const data = await calculateHoldingsSummary({
      catalystApp: req.catalystApp,
      accountCode,
      asOnDate: req.query.asOnDate,
    });

    return res.json(data);
  } catch (err) {
    console.error("Holding summary error:", err);
    res.status(500).json({ message: "Failed", error: err.message });
  }
};

/**
 * Aggregate current positions from the materialised `Holdings` table + Bhav prices.
 */
export const calculateHoldingsSummary = async ({
  catalystApp,
  accountCode,
  asOnDate,
}) => {
  const zcql = catalystApp.zcql();

  const rows = await fetchHoldingsRowsPaged(zcql, accountCode, asOnDate, "");
  const snapshots = rollupLastSnapshotByIsin(rows);
  const isinList = snapshots.map((s) => s.isin);

  const metaByIsin = await fetchSecurityListByIsins(zcql, isinList);

  const todayStr = new Date().toISOString().split("T")[0];
  const priceDate = asOnDate && asOnDate < todayStr ? asOnDate : todayStr;

  const priceMap = {};
  for (const isin of isinList) {
    try {
      const priceRows = await zcql.executeZCQLQuery(`
        SELECT ISIN, ClsPric, TradDt
        FROM Bhav_Copy
        WHERE ISIN = '${escHoldingsSql(isin)}'
          AND TradDt <= '${escHoldingsSql(priceDate)}'
        ORDER BY TradDt DESC
        LIMIT 1
      `);

      if (priceRows?.length) {
        const row = priceRows[0].Bhav_Copy || priceRows[0];
        priceMap[isin] = row.ClsPric || 0;
      } else priceMap[isin] = 0;
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
