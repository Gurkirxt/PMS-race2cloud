import React from "react";
import HoldingsGrid from "../../../Holding/HoldingCards";
import { Pagination } from "../../../../components/common/CommonComponents";

const HoldingTab = ({
  holdings = [],
  viewMode,
  setViewMode,
  accountCode,
  isIsinMode = false,
  isinReportRows = [],
  loadingIsinReport = false,
  selectedIsin = "",
  asOnDate,
  selectedStock,
  setSelectedStock,
  currentPage,
  pageSize,
  onPageChange,
  onPageSizeChange,
}) => {
  // Hide content until one of account code / ISIN is selected.
  if (!accountCode && !isIsinMode) return null;

  const formatNumber = (value, maxFractionDigits = 2) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString("en-IN", { maximumFractionDigits: maxFractionDigits });
  };

  if (isIsinMode) {
    const rows = Array.isArray(isinReportRows) ? isinReportRows : [];
    const start = (currentPage - 1) * pageSize;
    const paginatedRows = rows.slice(start, start + pageSize);

    const openIsinRowTransactions = (row) => {
      if (!setSelectedStock) return;
      const virtualCode = String(row?.virtualCode ?? "").trim();
      if (!virtualCode) return;

      setSelectedStock({
        isin: row.isin || selectedIsin,
        stockName: row.stockName || selectedIsin,
        securityCode: row.securityCode || "",
        currentHolding: row.currentHolding,
        avgPrice: row.avgPrice,
        holdingValue: row.holdingValue,
        lastPrice: row.lastPrice,
        marketValue: row.marketValue,
        accountCode: virtualCode,
        asOnDate,
      });
    };

    return (
      <>
        <div className="holdings-wrapper">
          <h2 className="holdings-title">
            ISIN Report ({selectedIsin || "—"}) - Accounts ({rows.length})
          </h2>
          <div className="holdings-table-wrapper">
            <table className="holdings-table">
              <thead>
                <tr>
                  <th>Virtual Code</th>
                  <th>Actual Code</th>
                  <th>Quantity</th>
                  <th>WAP</th>
                  <th>Holding Value</th>
                  <th>Last Price</th>
                  <th>Market Value</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {loadingIsinReport && (
                  <tr>
                    <td colSpan="8" style={{ textAlign: "center", padding: "20px" }}>
                      Loading ISIN report...
                    </td>
                  </tr>
                )}
                {!loadingIsinReport && paginatedRows.length === 0 && (
                  <tr>
                    <td colSpan="8" style={{ textAlign: "center", padding: "20px" }}>
                      No accounts hold this ISIN
                    </td>
                  </tr>
                )}
                {!loadingIsinReport &&
                  paginatedRows.map((row, idx) => (
                    <tr
                      key={`${row.virtualCode || "virtual"}-${idx}`}
                      onClick={() => openIsinRowTransactions(row)}
                      style={{ cursor: "pointer" }}
                    >
                      <td>{row.virtualCode || "—"}</td>
                      <td>{row.actualCode || "—"}</td>
                      <td>{formatNumber(row.currentHolding, 3)}</td>
                      <td>{formatNumber(row.avgPrice)}</td>
                      <td>{formatNumber(row.holdingValue)}</td>
                      <td>{formatNumber(row.lastPrice)}</td>
                      <td>{formatNumber(row.marketValue)}</td>
                      <td className="view-cell">
                        <button
                          type="button"
                          className="view-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            openIsinRowTransactions(row);
                          }}
                        >
                          👁 View
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="analytics-pagination">
          <Pagination
            currentPage={currentPage}
            pageSize={pageSize}
            totalRows={rows.length}
            onPageChange={onPageChange}
            onPageSizeChange={onPageSizeChange}
          />
        </div>
      </>
    );
  }

  const displayedHoldings = Array.isArray(holdings)
    ? holdings
    : [];

  const rowsForTable =
    displayedHoldings.length === 0
      ? [
          {
            stockName: viewMode === "cash" ? "Cash and Equivalent" : "—",
            securityCode: "—",
            currentHolding: "—",
            avgPrice: "—",
            holdingValue: "—",
          },
        ]
      : displayedHoldings;

  const start = (currentPage - 1) * pageSize;
  const paginatedRows = rowsForTable.slice(start, start + pageSize);

  return (
    <>
      {/* Holding Summary Table stays outside; here we keep tabs + grid */}
      <div className="holding-tabs">
        {["all", "equity", "cash"].map((m) => (
          <button
            key={m}
            className={`holding-tab ${viewMode === m ? "active" : ""}`}
            onClick={() => setViewMode(m)}
          >
            {m === "all" ? "All" : m === "equity" ? "Equity" : "Cash"}
          </button>
        ))}
      </div>

      <HoldingsGrid
        holdings={paginatedRows}
        onSelectStock={(stock) =>
          setSelectedStock({
            ...stock,
            accountCode: accountCode,
            asOnDate,
          })
        }
      />

      <div className="analytics-pagination">
        <Pagination
          currentPage={currentPage}
          pageSize={pageSize}
          totalRows={rowsForTable.length}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
        />
      </div>
    </>
  );
};

export default HoldingTab;