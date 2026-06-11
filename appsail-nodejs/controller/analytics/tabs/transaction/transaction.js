import {
  fetchHoldingsRowsPaged,
  fetchSecurityListByIsins,
  holdingsTypePriority,
} from "../../../../util/analytics/holdingsFromTable.js";
import {
  fetchTransactionLedgerRows,
  fetchLedgerIsinMeta,
} from "../../../../util/analytics/transactionHistory/ledger.js";

/**
 * Corporate-action TYPE values written into Holdings by RebuildHoldingtable.
 * The Transaction tab shows the uploaded trade ledger (from `Transaction`) PLUS
 * these corporate-action rows lifted from `Holdings`.
 */
const CORP_ACTION_TYPES = ["BONUS", "SPLIT", "MERGER", "DEMERGER"];
const escSql = (s) => String(s ?? "").replace(/'/g, "''");

/** Cash credits add (|amount| − STT); debits subtract (|amount| + STT). */
export const applyCashEffect = (balance, tranType, amount, stt = 0) => {
  const amt = Math.abs(Number(amount)) || 0;
  const sttVal = Math.abs(Number(stt)) || 0;

  if (
    tranType === "CS+" ||
    tranType === "SL+" ||
    tranType === "DIO" ||
    tranType === "DI0" ||
    tranType === "CSI" ||
    tranType === "DIS" ||
    tranType === "IN1" ||
    tranType === "OI1" ||
    tranType === "SQS" ||
    tranType === "DI1" ||
    tranType === "IN+" ||
    tranType === "DIV+"
  ) {
    return balance + amt - sttVal;
  }

  if (
    tranType === "BY-" ||
    tranType === "MGF" ||
    tranType === "TDO" ||
    tranType === "TDI" ||
    tranType === "E22" ||
    tranType === "E01" ||
    tranType === "CUS" ||
    tranType === "E23" ||
    tranType === "CS-" ||
    tranType === "MGE" ||
    tranType === "E10" ||
    tranType === "PRF" ||
    tranType === "NF-" ||
    tranType === "SQB"
  ) {
    return balance - amt - sttVal;
  }

  return balance;
};

export const getPaginatedTransactions = async (req, res) => {
  try {
    const app = req.catalystApp;
    if (!app) {
      return res.status(500).json({ message: "Catalyst app missing" });
    }

    const zcql = app.zcql();
    const limit = Math.max(parseInt(req.query.limit, 10) || 20, 1);

    /* Page (1-indexed) takes precedence over cursor when present. */
    const pageParam =
      req.query.page != null
        ? parseInt(String(req.query.page), 10)
        : null;
    const hasPage =
      pageParam != null && !Number.isNaN(pageParam) && pageParam >= 1;

    /* Cursor kept as a legacy fallback for callers without `page`. */
    const lastDate = (req.query.lastDate || "").trim() || null;
    const lastPriority =
      req.query.lastPriority != null
        ? parseInt(String(req.query.lastPriority), 10)
        : null;
    const lastRowId =
      req.query.lastRowId != null ? String(req.query.lastRowId) : null;

    const direction = req.query.direction === "prev" ? "prev" : "next";

    const hasCursor =
      !hasPage &&
      lastDate &&
      lastPriority != null &&
      !Number.isNaN(lastPriority) &&
      lastRowId != null;

    const accountCode = (req.query.accountCode || "").trim();
    const rawAsOnDate = (req.query.asOnDate || "").trim();
    const securityNameFilter = (req.query.securityName || "").trim();
    const isinFilter = (req.query.isin || "").trim();

    if (!accountCode) {
      return res.status(200).json({
        data: [],
        nextCursor: null,
        prevCursor: null,
        hasNext: false,
        hasPrev: false,
        totalCount: 0,
        totalPages: 1,
        page: 1,
        pageSize: limit,
      });
    }

    const normalizeDate = (d) => {
      if (!d) return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(d)) {
        const [dd, mm, yyyy] = d.split("/");
        return `${yyyy}-${mm}-${dd}`;
      }
      return null;
    };

    const asOnDate = normalizeDate(rawAsOnDate);

    /*
     * Source 1 — uploaded trade ledger straight from the `Transaction` table.
     * Source 2 — corporate-action rows (BONUS/SPLIT/MERGER/DEMERGER) from the
     * materialised `Holdings` table. The two are merged into one ledger.
     */
    const corpExtra =
      ` AND TYPE IN (${CORP_ACTION_TYPES.map((t) => `'${t}'`).join(",")})` +
      (isinFilter ? ` AND ISIN = '${escSql(isinFilter)}'` : "");

    const [ledgerRows, corpHoldings] = await Promise.all([
      fetchTransactionLedgerRows(zcql, {
        accountCode,
        isin: isinFilter || "",
        asOnDate,
      }),
      fetchHoldingsRowsPaged(zcql, accountCode, asOnDate, corpExtra),
    ]);

    /* ISINs needing a Security_List lookup: any ledger row missing a name + every corp row. */
    const isinSetForMeta = new Set();
    for (const r of ledgerRows) {
      if (r.isin && !r.securityName) isinSetForMeta.add(r.isin);
    }
    for (const h of corpHoldings) {
      const isin = String(h.ISIN || "").trim();
      if (isin) isinSetForMeta.add(isin);
    }
    const metaByIsin = await fetchSecurityListByIsins(zcql, [...isinSetForMeta]);

    const ledgerTransactions = ledgerRows.map((r) => {
      const trd = r.trandate || "";
      const setD = r.setdate || "";
      const primaryDate = trd || setD || "";
      return {
        rowId: r.rowId,
        date: primaryDate,
        trandate: trd || primaryDate || null,
        setdate: setD || trd || null,
        executionPriority: holdingsTypePriority(r.type),
        type: r.type,
        securityName:
          r.securityName || metaByIsin[r.isin]?.securityName || "—",
        securityCode: r.securityCode || metaByIsin[r.isin]?.securityCode || "",
        isin: r.isin,
        quantity: r.quantity,
        price: r.price,
        totalAmount: r.totalAmount,
        stt: 0,
      };
    });

    const corpTransactions = corpHoldings.map((h) => {
      const isin = String(h.ISIN || "").trim();
      const meta = metaByIsin[isin] || {};
      const trd = String(h.TRANSACTION_DATE || "").trim().slice(0, 10);
      const setD = String(h.SETTLEMENT_DATE || "").trim().slice(0, 10);
      const primaryDate = trd || setD || "";
      return {
        rowId: `H-${h.ROWID}`,
        date: primaryDate,
        trandate: trd || primaryDate || null,
        setdate: setD || trd || null,
        executionPriority: holdingsTypePriority(h.TYPE),
        type: String(h.TYPE || "").trim(),
        securityName: meta.securityName || "—",
        securityCode: meta.securityCode || "",
        isin: isin || null,
        quantity: Number(h.QUANTITY) || 0,
        price: Number(h.PRICE) || 0,
        totalAmount: Number(h.TOTAL_AMOUNT) || 0,
        stt: 0,
      };
    });

    const merged = [...ledgerTransactions, ...corpTransactions];

    /*
     * `securityName` is a legacy filter (callers normally send `isin`). When an
     * ISIN is present it already scoped both sources, so only apply the name
     * filter as a back-compat fallback when no ISIN was given.
     */
    const transactions =
      !isinFilter && securityNameFilter
        ? merged.filter(
            (t) => (t.securityName || "").trim() === securityNameFilter,
          )
        : merged;

    /*
     * Display order: newest TRANDATE first.
     * Tie-breakers (deterministic, page-stable):
     *   1. date DESC (primary)
     *   2. executionPriority ASC (same day: corp-actions like SPLIT/BONUS/DIV+ before regular trades)
     *   3. isin ASC (group same-day rows of the same security together)
     *   4. rowId ASC (final tiebreaker so two requests return the same order)
     */
    transactions.sort((a, b) => {
      const dA = a.date || "";
      const dB = b.date || "";
      if (dA !== dB) return dA < dB ? 1 : -1;
      if (a.executionPriority !== b.executionPriority) {
        return a.executionPriority - b.executionPriority;
      }
      const isinA = a.isin || "";
      const isinB = b.isin || "";
      if (isinA !== isinB) return isinA.localeCompare(isinB);
      return String(a.rowId).localeCompare(String(b.rowId));
    });

    const totalCount = transactions.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / limit));

    let startIdx = 0;
    let pageNumber = 1;

    if (hasPage) {
      pageNumber = Math.min(Math.max(1, pageParam), totalPages);
      startIdx = (pageNumber - 1) * limit;
    } else if (hasCursor) {
      const cursorIdx = transactions.findIndex(
        (t) =>
          t.date === lastDate &&
          t.executionPriority === lastPriority &&
          t.rowId === lastRowId,
      );

      if (cursorIdx !== -1) {
        if (direction === "next") {
          startIdx = cursorIdx + 1;
        } else {
          startIdx = Math.max(0, cursorIdx - limit);
        }
      }
      pageNumber = Math.floor(startIdx / limit) + 1;
    }

    const paginated = transactions.slice(startIdx, startIdx + limit);

    const hasNextPage = startIdx + limit < totalCount;
    const hasPrevPage = startIdx > 0;

    const firstRow = paginated[0];
    const lastRow = paginated[paginated.length - 1];

    const prevCursorObj = firstRow
      ? {
          lastDate: firstRow.date,
          lastPriority: firstRow.executionPriority,
          lastRowId: firstRow.rowId,
        }
      : null;

    const nextCursorObj = lastRow
      ? {
          lastDate: lastRow.date,
          lastPriority: lastRow.executionPriority,
          lastRowId: lastRow.rowId,
        }
      : null;

    return res.status(200).json({
      data: paginated,
      nextCursor: nextCursorObj,
      prevCursor: prevCursorObj,
      hasNext: hasNextPage,
      hasPrev: hasPrevPage,
      totalCount,
      totalPages,
      page: pageNumber,
      pageSize: limit,
    });
  } catch (err) {
    console.error("[getPaginatedTransactions]", err);
    return res.status(500).json({
      message: "Failed to fetch transactions",
      error: err.message,
    });
  }
};

/**
 * Distinct securities (ISIN + name) for an account, optionally cut off by `asOnDate`.
 * Response shape: `{ data: Array<{ isin: string, securityName: string }> }`
 *
 * Search query (`?search=...`) matches against EITHER ISIN or Security_Name (case-insensitive
 * substring) so users can find a security by typing the company name OR the ISIN.
 */
export const getSecurityNameOptions = async (req, res) => {
  try {
    const app = req.catalystApp;
    if (!app) {
      return res.status(500).json({ message: "Catalyst app missing" });
    }

    const zcql = app.zcql();

    const rawSearch = (req.query.search || "").trim();
    const accountCode = (req.query.accountCode || "").trim();
    const rawAsOn = (req.query.asOnDate || "").trim();
    const asOnDate =
      /^\d{4}-\d{2}-\d{2}$/.test(rawAsOn)
        ? rawAsOn
        : /^\d{2}\/\d{2}\/\d{4}$/.test(rawAsOn)
          ? (() => {
              const [dd, mm, yyyy] = rawAsOn.split("/");
              return `${yyyy}-${mm}-${dd}`;
            })()
          : null;

    if (!accountCode) {
      return res.status(200).json({ data: [] });
    }

    /*
     * Securities come from the uploaded ledger (`Transaction`) plus any
     * corporate-action ISINs materialised in `Holdings` — matching the two
     * sources the transaction tab merges.
     */
    const corpExtra = ` AND TYPE IN (${CORP_ACTION_TYPES.map((t) => `'${t}'`).join(",")})`;
    const [ledgerMeta, corpHoldings] = await Promise.all([
      fetchLedgerIsinMeta(zcql, { accountCode, asOnDate }),
      fetchHoldingsRowsPaged(zcql, accountCode, asOnDate, corpExtra),
    ]);

    /* Ledger names come from the Transaction table; only look up ISINs missing one. */
    const nameByIsin = new Map(ledgerMeta);
    for (const h of corpHoldings) {
      const isin = String(h.ISIN || "").trim();
      if (isin && !nameByIsin.has(isin)) {
        nameByIsin.set(isin, { isin, securityName: "" });
      }
    }

    const needLookup = [...nameByIsin.values()]
      .filter((it) => !it.securityName)
      .map((it) => it.isin);
    const metaByIsin = await fetchSecurityListByIsins(zcql, needLookup);

    const items = [];
    for (const { isin, securityName } of nameByIsin.values()) {
      items.push({
        isin,
        securityName: (securityName || metaByIsin[isin]?.securityName || "").trim(),
      });
    }

    items.sort((a, b) => {
      const nA = a.securityName || "";
      const nB = b.securityName || "";
      if (nA && nB) return nA.localeCompare(nB);
      if (nA) return -1;
      if (nB) return 1;
      return a.isin.localeCompare(b.isin);
    });

    const q = rawSearch.toLowerCase();
    const filtered = q
      ? items.filter(
          (it) =>
            (it.securityName || "").toLowerCase().includes(q) ||
            it.isin.toLowerCase().includes(q),
        )
      : items;

    return res.status(200).json({ data: filtered });
  } catch (err) {
    console.error("[getSecurityNameOptions]", err);
    return res.status(500).json({
      message: "Failed to fetch security names",
      error: err.message,
    });
  }
};
