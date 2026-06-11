"use strict";

const catalyst = require("zcatalyst-sdk-node");
const {
  rebuildHoldingsForAccountList,
} = require("./holdingsRebuildFromSources.js");

/**
 * Catalyst job — rebuild `Holdings` from Transaction / Bonus / Split / Demerger / Merger.
 *
 * Params:
 * - accountCodesJson: JSON array string of WS_Account_code (preferred)
 * - accountCodes: comma-separated fallback
 * - asOnDate: optional YYYY-MM-DD cutoff
 * - source: optional tag for logs (e.g. DemergerFn, MegerFn)
 *
 * @param {import("./types/job").JobRequest} jobRequest
 * @param {import("./types/job").Context} context
 */
module.exports = async (jobRequest, context) => {
  const catalystApp = catalyst.initialize(context);
  const zcql = catalystApp.zcql();

  try {
    const params = jobRequest.getAllJobParams();
    const source = String(params.source || "").trim() || "RebuildHoldingtable";
    const asOnDateRaw = String(params.asOnDate || "").trim();
    const asOnDate =
      /^\d{4}-\d{2}-\d{2}$/.test(asOnDateRaw) ? asOnDateRaw : null;

    let accounts = [];

    const jsonParam = params.accountCodesJson;
    if (jsonParam) {
      try {
        const parsed = JSON.parse(jsonParam);
        if (Array.isArray(parsed)) {
          accounts = parsed.map((a) => String(a || "").trim()).filter(Boolean);
        }
      } catch (e) {
        console.error("[RebuildHoldingtable] Invalid accountCodesJson:", e.message);
        context.closeWithFailure();
        return;
      }
    }

    if (!accounts.length && params.accountCodes) {
      accounts = String(params.accountCodes)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    // Optional ISIN scope: when present, rebuild ONLY these ISIN(s) for each
    // account instead of the account's full ISIN set. Absent → full rebuild.
    let scopedIsins = [];
    if (params.isinsJson) {
      try {
        const parsed = JSON.parse(params.isinsJson);
        if (Array.isArray(parsed)) {
          scopedIsins = parsed.map((i) => String(i || "").trim()).filter(Boolean);
        }
      } catch (e) {
        console.error("[RebuildHoldingtable] Invalid isinsJson:", e.message);
      }
    }
    if (!scopedIsins.length && params.isin) {
      const single = String(params.isin).trim();
      if (single) scopedIsins = [single];
    }
    const scopedIsinsSet = scopedIsins.length ? new Set(scopedIsins) : null;

    const uniq = [...new Set(accounts)];
    console.log("[RebuildHoldingtable] Start", {
      source,
      accountCount: uniq.length,
      asOnDate,
      scopedIsins: scopedIsinsSet ? scopedIsins : "off",
    });

    if (!uniq.length) {
      console.error("[RebuildHoldingtable] No account codes in params");
      context.closeWithFailure();
      return;
    }

    const counters = await rebuildHoldingsForAccountList(
      zcql,
      uniq,
      asOnDate,
      scopedIsinsSet,
    );

    if (counters.errors > 0) {
      console.error("[RebuildHoldingtable] Completed with errors", counters);
      context.closeWithFailure();
      return;
    }

    console.log("[RebuildHoldingtable] Success", counters);
    context.closeWithSuccess();
  } catch (err) {
    console.error("[RebuildHoldingtable] FATAL:", err);
    context.closeWithFailure();
  }
};
