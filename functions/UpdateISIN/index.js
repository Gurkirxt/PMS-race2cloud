"use strict";

/**
 * UpdateISIN (Catalyst job) — two modes
 *
 *   mode = "rename" (default, params: old_isin, new_isin)
 *     Replaces old_isin with new_isin across every table in
 *     TABLES_WITH_ISIN_COLUMN. Per-table errors are logged and skipped.
 *
 *   mode = "apply-new" (params: isin, security_code?, security_name?)
 *     Backs the "New ISIN" Apply panel. Syncs Security_Code / Security_Name
 *     for the given ISIN across NEW_ISIN_TARGETS. Per column, per row:
 *       - Skip if existing value already equals the new value.
 *       - Otherwise (NULL, empty, or different) → UPDATE.
 *     If a value param is blank/missing, that column is not touched at all.
 *     Column casing differs by table — handled per entry in NEW_ISIN_TARGETS.
 */

const catalyst = require("zcatalyst-sdk-node");

const esc = (v) => String(v ?? "").replace(/'/g, "''");

const TABLES_WITH_ISIN_COLUMN = [
  "Security_List",
  "Transaction",
  "Bonus",
  "Bonus_Record",
  "Split",
  "Dividend",
  "Temp_Transaction",
  "Temp_Custodian",
  "Bhav_Copy",
  "Cash_Balance_Per_Transaction",
  "Holdings",
];

const NEW_ISIN_TARGETS = [
  { table: "Security_List", codeCol: "Security_Code", nameCol: "Security_Name" },
  { table: "Transaction", codeCol: "Security_code", nameCol: "Security_Name" },
];

async function runRenameMode(zcql, params) {
  const oldIsin = String(params.old_isin ?? "").trim();
  const newIsin = String(params.new_isin ?? "").trim();

  console.log(`[UpdateISIN/rename] Started: "${oldIsin}" → "${newIsin}"`);

  if (!oldIsin || !newIsin) {
    throw new Error("Parameters old_isin and new_isin are required for rename mode");
  }
  if (oldIsin === newIsin) {
    throw new Error("Old and new ISIN must differ");
  }

  const oldSql = esc(oldIsin);
  const newSql = esc(newIsin);

  for (const table of TABLES_WITH_ISIN_COLUMN) {
    try {
      await zcql.executeZCQLQuery(
        `UPDATE ${table} SET ISIN = '${newSql}' WHERE ISIN = '${oldSql}'`
      );
      console.log(`[UpdateISIN/rename] Updated table: ${table}`);
    } catch (tableErr) {
      console.warn(`[UpdateISIN/rename] Skipped table "${table}":`, tableErr?.message);
    }
  }

  console.log(`[UpdateISIN/rename] Done: "${oldIsin}" → "${newIsin}"`);
}

async function countRowsToSync(zcql, table, col, isin, newVal) {
  try {
    const rows = await zcql.executeZCQLQuery(
      `SELECT COUNT(ROWID) FROM ${table}
       WHERE ISIN = '${esc(isin)}'
         AND (${col} IS NULL OR ${col} != '${esc(newVal)}')`
    );
    const r = rows?.[0]?.[table] || rows?.[0] || {};
    return Number(
      r["COUNT(ROWID)"] ?? r.cnt ?? r["count"] ?? Object.values(r)[0] ?? 0
    );
  } catch (err) {
    console.warn(`[UpdateISIN/apply-new] count ${table}.${col} failed:`, err?.message);
    return -1;
  }
}

async function syncColumn(zcql, table, col, isin, newVal) {
  const before = await countRowsToSync(zcql, table, col, isin, newVal);
  try {
    await zcql.executeZCQLQuery(
      `UPDATE ${table}
       SET ${col} = '${esc(newVal)}'
       WHERE ISIN = '${esc(isin)}'
         AND (${col} IS NULL OR ${col} != '${esc(newVal)}')`
    );
    console.log(`[UpdateISIN/apply-new] ${table}.${col}: updated ~${before} row(s)`);
    return before >= 0 ? before : 0;
  } catch (err) {
    console.warn(`[UpdateISIN/apply-new] ${table}.${col} update skipped:`, err?.message);
    return 0;
  }
}

async function runApplyNewMode(zcql, params) {
  const isin = String(params.isin ?? "").trim();
  const securityCode = String(params.security_code ?? "").trim();
  const securityName = String(params.security_name ?? "").trim();

  console.log(
    `[UpdateISIN/apply-new] Started: isin="${isin}" code="${securityCode}" name="${securityName}"`
  );

  if (!isin) {
    throw new Error("Parameter isin is required for apply-new mode");
  }
  if (!securityCode && !securityName) {
    throw new Error(
      "At least one of security_code / security_name must be provided for apply-new mode"
    );
  }

  const summary = [];

  for (const { table, codeCol, nameCol } of NEW_ISIN_TARGETS) {
    let codeUpdates = 0;
    let nameUpdates = 0;

    if (securityCode) {
      codeUpdates = await syncColumn(zcql, table, codeCol, isin, securityCode);
    }
    if (securityName) {
      nameUpdates = await syncColumn(zcql, table, nameCol, isin, securityName);
    }

    summary.push({ table, codeUpdates, nameUpdates });
  }

  console.log(
    `[UpdateISIN/apply-new] Done isin="${isin}" — ${JSON.stringify(summary)}`
  );
}

/**
 * @param {import("./types/job").JobRequest} jobRequest
 * @param {import("./types/job").Context} context
 */
module.exports = async (jobRequest, context) => {
  const catalystApp = catalyst.initialize(context);
  const zcql = catalystApp.zcql();

  try {
    const params = jobRequest.getAllJobParams();
    const mode = String(params.mode ?? "rename").trim();

    if (mode === "rename") {
      await runRenameMode(zcql, params);
    } else if (mode === "apply-new") {
      await runApplyNewMode(zcql, params);
    } else {
      throw new Error(`Unknown mode: "${mode}" (expected "rename" or "apply-new")`);
    }

    context.closeWithSuccess();
  } catch (err) {
    console.error("[UpdateISIN] Fatal Error:", err?.message || err);
    context.closeWithFailure();
  }
};
