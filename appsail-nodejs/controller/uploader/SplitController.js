const HOLDINGS_BATCH = 250;

export const getAllSecuritiesISINs = async (req, res) => {
  try {
    const app = req.catalystApp;
    if (!app) {
      return res.status(500).json({ message: "Catalyst app not initialized" });
    }
    const zcql = app.zcql();

    const LIMIT = 300;
    let offset = 0;
    let hasMore = true;

    const securities = [];

    while (hasMore) {
      const query = `
        SELECT ISIN, Security_Code, Security_Name
        FROM Security_List
        WHERE ISIN IS NOT NULL
        LIMIT ${LIMIT} OFFSET ${offset}
      `;

      const response = await zcql.executeZCQLQuery(query);

      if (!response || response.length === 0) {
        hasMore = false;
        break;
      }

      response.forEach((row) => {
        const sec = row.Security_List;
        securities.push({
          isin: sec.ISIN,
          securityCode: sec.Security_Code,
          securityName: sec.Security_Name,
        });
      });

      offset += LIMIT;
    }

    return res.status(200).json({
      success: true,
      count: securities.length,
      data: securities,
    });
  } catch (error) {
    console.error("Error fetching securities:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch security list",
    });
  }
};

const ZCQL_ROW_LIMIT = 270;

export const previewStockSplit = async (req, res) => {
  try {
    if (!req.catalystApp) {
      return res.status(500).json({
        success: false,
        message: "Catalyst app not initialized",
      });
    }

    const { isin, ratio1, ratio2, issueDate } = req.body;

    const r1 = Number(ratio1);
    const r2 = Number(ratio2);

    if (!isin || !issueDate || !Number.isFinite(r1) || !Number.isFinite(r2) || r1 <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid ISIN, ratio or date",
      });
    }

    const issueDateObj = new Date(issueDate);
    issueDateObj.setHours(0, 0, 0, 0);
    const issueDateISO = issueDateObj.toISOString().split("T")[0];

    // cutoff = day AFTER issueDate for the date filter
    const cutoffObj = new Date(issueDateISO);
    cutoffObj.setDate(cutoffObj.getDate() + 1);
    const cutoff = cutoffObj.toISOString().split("T")[0];

    const zcql = req.catalystApp.zcql();

    /* ======================================================
       STEP 1: READ Holdings AS OF issueDate
       Fetch all Holdings rows for this ISIN with date filter.
       Walk in FIFO order (CREATEDTIME ASC, ROWID ASC) and keep
       updating per account — last row per account = state on issueDate.
       ====================================================== */
    const latestByAccount = new Map(); // accountCode → last Holdings row
    let offset = 0;

    while (true) {
      const batch = await zcql.executeZCQLQuery(`
        SELECT WS_Account_code, HOLDING, WAP, HOLDING_VALUE,
               SETTLEMENT_DATE, TRANSACTION_DATE
        FROM Holdings
        WHERE ISIN = '${isin}'
          AND (SETTLEMENT_DATE < '${cutoff}' OR TRANSACTION_DATE < '${cutoff}')
        ORDER BY CREATEDTIME ASC, ROWID ASC
        LIMIT ${HOLDINGS_BATCH} OFFSET ${offset}
      `);

      if (!batch || batch.length === 0) break;

      for (const row of batch) {
        const h = row.Holdings || row;
        const acc = String(h.WS_Account_code || "").trim();
        if (!acc) continue;
        latestByAccount.set(acc, h); // last row per account wins
      }

      if (batch.length < HOLDINGS_BATCH) break;
      offset += HOLDINGS_BATCH;
    }

    if (latestByAccount.size === 0) {
      return res.json({ success: true, data: [] });
    }

    /* ======================================================
       STEP 2: CALCULATE SPLIT PREVIEW (simple arithmetic)
       Holdings table already has HOLDING, WAP, HOLDING_VALUE
       computed by FIFO. No need to re-run FIFO engine.

       Split logic:
         newHolding      = floor(currentHolding × ratio2 / ratio1)
         holdingValue    = unchanged (same total cost)
         newWAP          = holdingValue / newHolding (price per share halves)
       ====================================================== */
    const preview = [];
    const splitMultiplier = r2 / r1;

    for (const [accountCode, h] of latestByAccount) {
      const currentHolding = Number(h.HOLDING) || 0;
      if (currentHolding <= 0) continue; // fully sold before issueDate

      const holdingValue = Number(h.HOLDING_VALUE) || 0;
      const currentWAP   = Number(h.WAP) || 0;

      const newHolding = Math.floor(currentHolding * splitMultiplier);
      if (newHolding <= 0) continue;

      // Cost is unchanged — more shares at same total cost → WAP goes down
      const newWAP = newHolding > 0
        ? Math.round((holdingValue / newHolding) * 100) / 100
        : 0;

      preview.push({
        isin,
        accountCode,
        currentHolding,
        currentWAP,
        holdingValue,
        newHolding,
        newWAP,
        delta: newHolding - currentHolding,
      });
    }

    return res.json({ success: true, data: preview });
  } catch (error) {
    console.error("Preview split error:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

const REBUILD_HOLDINGS_BATCH = 400;

export const addStockSplit = async (req, res) => {
  try {
    const app = req.catalystApp;
    if (!app) {
      return res.status(500).json({
        success: false,
        message: "Catalyst app not initialized",
      });
    }
    const zcql = app.zcql();

    const { securityCode, securityName, ratio1, ratio2, issueDate, isin } =
      req.body;

    if (!securityCode || !securityName || !ratio1 || !ratio2 || !issueDate) {
      return res.status(400).json({
        message: "Missing required fields",
      });
    }

    await zcql.executeZCQLQuery(`
      INSERT INTO Split
      (
        Security_Code,
        Security_Name,
        Ratio1,
        Ratio2,
        Issue_Date,
        ISIN
      )
      VALUES
      (
        '${securityCode}',
        '${securityName}',
        ${Number(ratio1)},
        ${Number(ratio2)},
        '${issueDate}',
        '${isin}'
      )
    `);

    const isinEsc = String(isin ?? "").replace(/'/g, "''");
    const accountSet = new Set();
    let holdOffset = 0;

    while (true) {
      const batch = await zcql.executeZCQLQuery(`
        SELECT WS_Account_code
        FROM Transaction
        WHERE ISIN='${isinEsc}'
        LIMIT ${ZCQL_ROW_LIMIT} OFFSET ${holdOffset}
      `);

      if (!batch || batch.length === 0) break;
      batch.forEach((r) => accountSet.add(r.Transaction.WS_Account_code));
      if (batch.length < ZCQL_ROW_LIMIT) break;
      holdOffset += ZCQL_ROW_LIMIT;
    }

    const affectedAccounts = Array.from(accountSet);
    if (affectedAccounts.length > 0) {
      const scheduling = app.jobScheduling();
      for (let i = 0; i < affectedAccounts.length; i += REBUILD_HOLDINGS_BATCH) {
        const chunk = affectedAccounts.slice(i, i + REBUILD_HOLDINGS_BATCH);
        const catalystJobName = `H${Date.now()}${i}`.slice(0, 20);
        await scheduling.JOB.submitJob({
          job_name: catalystJobName,
          jobpool_name: "Export",
          target_name: "RebuildHoldingtable",
          target_type: "Function",
          /* Catalyst Job Pool: retries only on execution failure. Min interval 1m. */
          job_config: {
            number_of_retries: 5,
            retry_interval: 60 * 1000,
          },
          params: {
            accountCodesJson: JSON.stringify(chunk),
            source: "SplitController",
          },
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: "Stock split applied successfully",
    });
  } catch (error) {
    console.error("Error in addStockSplit", error);
    return res.status(500).json({
      success: false,
      message: "Failed to apply stock split",
    });
  }
};
