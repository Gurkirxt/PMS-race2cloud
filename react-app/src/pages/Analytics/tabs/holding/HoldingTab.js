import React from "react";
import HoldingsGrid from "../../../Holding/HoldingCards";
import { Card, Pagination } from "../../../../components/common/CommonComponents";

const HoldingTab = ({
  holdings = [],
  viewMode,
  setViewMode,
  accountCode,
  asOnDate,
  selectedStock,
  setSelectedStock,
  currentPage,
  pageSize,
  onPageChange,
  onPageSizeChange,
}) => {
  // Hide the Stock Holdings grid until an account is selected.
  if (!accountCode) return null;

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