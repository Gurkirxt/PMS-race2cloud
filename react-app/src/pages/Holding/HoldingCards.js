import React from "react";
import "./HoldingCard.css";

function HoldingsGrid({ holdings = [], onSelectStock }) {
  if (!holdings.length) {
    return (
      <div className="holdings-wrapper">
        <div className="holdings-table-wrapper">
          <table className="holdings-table">
            <tbody>
              <tr>
                <td
                  colSpan="7"
                  style={{ textAlign: "center", padding: "20px" }}
                >
                  No holdings available
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  const formatNumber = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return n.toLocaleString("en-IN", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
  };

  // Current holding is the net outcome of normal buys/sells and can be
  // fractional (e.g. 5.533). Show real decimals; snap sub-epsilon dust to 0.
  const formatQuantity = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    const snapped = Math.abs(n) < 1e-6 ? 0 : n;
    return snapped.toLocaleString("en-IN", { maximumFractionDigits: 3 });
  };

  return (
    <div className="holdings-wrapper">
      <h2 className="holdings-title">Stock Holdings ({holdings.length})</h2>

      <div className="holdings-table-wrapper">
        <table className="holdings-table">
          <thead>
            <tr>
              <th>Security Name</th>
              <th>Security Code</th>
              <th>Security ISIN</th>
              <th>Current Holding</th>
              <th>Average Holding Value</th>
              <th>Holding Value</th>
              <th>Last Price</th>
              <th>Market value</th>
              <th></th>
            </tr>
          </thead>

          <tbody>
            {holdings.map((item, index) => {
              const isSold = Number(item.currentHolding) === 0;

              return (
                <tr
                  key={`${item.stockName}-${index}`}
                  className={isSold ? "sold-row" : ""}
                  onClick={() => onSelectStock(item)}
                >
                  <td className="security-name">{item.stockName}</td>
                  <td className="security-code">{item.securityCode || "—"}</td>
                  <td className="security-code">{item.isin || "—"}</td>
                  <td className="holding-value">
                    {formatQuantity(item.currentHolding)}
                    {isSold && <span className="sold-badge">FULLY SOLD</span>}
                  </td>
                  <td className="security-code">
                    {formatNumber(item.avgPrice)}
                  </td>
                  <td className="security-code">
                    {formatNumber(item.holdingValue)}
                  </td>
                  <td className="security-code">
                    {formatNumber(item.lastPrice)}
                  </td>
                  <td className="security-code">
                    {formatNumber(item.marketValue)}
                  </td>
                  <td className="view-cell">
                    <button
                      type="button"
                      className="view-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectStock(item);
                      }}
                    >
                      👁 View
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default HoldingsGrid;
