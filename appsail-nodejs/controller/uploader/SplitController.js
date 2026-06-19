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

// Each RebuildHoldingtable job handles at most this many accounts. Smaller
// batches → more, shorter parallel jobs (run concurrently in the job pool),
// avoiding a single long-running job timing out as the account count grows.
const REBUILD_HOLDINGS_BATCH = 100;

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

    if (!securityCode || !securityName || !ratio1 || !ratio2 || !issueDate || !isin) {
      return res.status(400).json({
        message: "Missing required fields (ISIN is required to scope the holdings rebuild)",
      });
    }

    const isinEsc = String(isin ?? "").replace(/'/g, "''");
    const issueDateEsc = String(issueDate ?? "").replace(/'/g, "''");

    // Idempotency guard (mirrors bonus's bonusRowExists): a split event is
    // uniquely identified by ISIN + Issue_Date + ratios. If it already exists,
    // skip the insert AND the rebuild — re-applying would otherwise insert a
    // duplicate Split row and apply the split ratio twice.
    const existingSplit = await zcql.executeZCQLQuery(`
      SELECT ROWID FROM Split
      WHERE ISIN = '${isinEsc}'
        AND Issue_Date = '${issueDateEsc}'
        AND Ratio1 = ${Number(ratio1)}
        AND Ratio2 = ${Number(ratio2)}
      LIMIT 1
    `);
    if (existingSplit && existingSplit.length > 0) {
      console.log(
        `[SplitController] Split already applied for ${isin} on ${issueDate} ` +
          `(${ratio1}:${ratio2}) — idempotent skip, no rebuild.`,
      );
      return res.status(200).json({
        success: true,
        alreadyApplied: true,
        message:
          "Split already applied for this ISIN, date and ratio — skipped (no duplicate inserted).",
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
          jobpool_name: "CorporateActions",
          target_name: "RebuildHoldingtable",
          target_type: "Function",
          /* Catalyst Job Pool: retries only on execution failure. Min interval 1m. */
          job_config: {
            number_of_retries: 5,
            retry_interval: 60 * 1000,
          },
          params: {
            accountCodesJson: JSON.stringify(chunk),
            isinsJson: JSON.stringify([isin]),
            source: "SplitController",
          },
        });
      }
    }

    // A bonus already applied on/after this split's date had its BonusShare
    // sized on the PRE-split holding — it is now stale. Re-run the bonus apply
    // in recompute mode (the Split row above is now in the DB, so the bonus
    // FIFO will re-size on the post-split holding and overwrite BonusShare).
    // The recompute job re-queues its own RebuildHoldingtable afterward.
    try {
      const bonusRecords = await zcql.executeZCQLQuery(`
        SELECT SecurityCode, SecurityName, ISIN, Ratio1, Ratio2, ExDate
        FROM Bonus_Record
        WHERE ISIN = '${isinEsc}' AND ExDate >= '${issueDateEsc}'
        ORDER BY ExDate ASC
      `);

      const scheduling = app.jobScheduling();
      for (const row of bonusRecords || []) {
        const b = row.Bonus_Record || row;
        const exDateISO = String(b.ExDate || "").slice(0, 10);
        if (!exDateISO) continue;

        // Unique tracking name so UpdateBonusTable's per-account SUCCESS guard
        // (scoped by jobName) does not skip a prior bonus run for this ex-date.
        const bonusJobName = `BONRC_${isin.slice(-6)}_${exDateISO}_${Date.now()}`;
        await scheduling.JOB.submitJob({
          job_name: `BRC${Date.now()}`.slice(0, 20),
          jobpool_name: "CorporateActions",
          target_name: "UpdateBonusTable",
          target_type: "Function",
          job_config: {
            number_of_retries: 5,
            retry_interval: 60 * 1000,
          },
          params: {
            isin,
            ratio1: String(Number(b.Ratio1) || 0),
            ratio2: String(Number(b.Ratio2) || 0),
            exDate: exDateISO,
            secCode: b.SecurityCode || securityCode || "",
            secName: b.SecurityName || securityName || "",
            recompute: "true",
            jobName: bonusJobName,
          },
        });
        console.log(
          `[SplitController] Queued bonus recompute for ${isin} ex-date ${exDateISO}`,
        );
      }
    } catch (recomputeErr) {
      console.error(
        "[SplitController] Failed to queue bonus recompute:",
        recomputeErr.message,
      );
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
