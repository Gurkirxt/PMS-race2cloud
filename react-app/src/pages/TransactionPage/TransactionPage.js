import React, { useState, useEffect } from "react";
import "./TransactionPage.css";
import { BASE_URL } from "../../constant.js";

function TransactionPage({ stock, accountCode, asOnDate, onClose }) {
  const [transactions, setTransactions] = useState([]);
  const [totalBuy, setTotalBuy] = useState(0);
  const [totalSell, setTotalSell] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (stock && accountCode && stock.isin) {
      fetchAllData();
    } else if (stock && accountCode && !stock.isin) {
      setError("ISIN not available for this stock");
      setLoading(false);
    }
  }, [stock, accountCode, asOnDate]);

  const fetchAllData = async () => {
    try {
      setLoading(true);
      setError(null);

      const baseUrl = `${BASE_URL}/transaction`;
      const params = new URLSearchParams({
        accountCode,
        isin: stock.isin,
      });

      if (asOnDate) {
        params.set("asOnDate", asOnDate);
      }

      const [historyRes, buyRes, sellRes] = await Promise.all([
        fetch(`${baseUrl}/getStockTransactionHistory?${params.toString()}`),
        fetch(`${baseUrl}/getAllBuys?${params.toString()}`),
        fetch(`${baseUrl}/getAllSells?${params.toString()}`),
      ]);

      const historyData = await historyRes.json();
      const buyData = await buyRes.json();
      const sellData = await sellRes.json();

      if (Array.isArray(historyData)) {
        setTransactions(historyData);
      } else {
        setTransactions([]);
      }

      setTotalBuy(buyData.totalBuyQty || 0);
      setTotalSell(sellData.totalSellQty || 0);
    } catch (err) {
      setError(err.message);
      setTransactions([]);
      setTotalBuy(0);
      setTotalSell(0);
    } finally {
      setLoading(false);
    }
  };

  if (!stock) return null;

  const getRowClass = (type) => {
    if (!type) return "";
    const typeUpper = String(type).toUpperCase();
    if (typeUpper.includes("BY") || typeUpper === "SQB" || typeUpper === "OPI")  // previous: OPI styled as buy
      return "buy";
    if (
      typeUpper.includes("SL") ||
      typeUpper === "SQS" ||
      typeUpper === "OPO" ||
      typeUpper === "NF-"
    )
      return "sell";
    if (typeUpper === "BONUS") return "bonus";
    if (typeUpper === "DEMERGER") return "bonus";
    if (typeUpper === "MERGER") return "bonus";
    return "";
  };

  const formatCurrency = (value) => {
    if (value === null || value === undefined || value === "") return "-";
    const num = Number(value);
    if (isNaN(num)) return "-";
    return `₹${num.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  };

  const formatNumber = (value) => {
    if (value === null || value === undefined || value === "") return "-";
    const num = Number(value);
    if (isNaN(num)) return "-";
    return num.toLocaleString("en-IN");
  };

  const formatQuantity = (value) => {
    const num = Number(value);
    if (value === null || value === undefined || value === "" || isNaN(num)) return "-";
    return Math.floor(num).toLocaleString("en-IN");
  };

  const lastTransaction = transactions[transactions.length - 1];
  const currentHolding = lastTransaction?.holdings ?? 0;
  const totalProfitLoss = transactions.reduce(
    (sum, tx) => sum + (Number(tx.profitLoss) || 0),
    0
  );
  const avgPrice = lastTransaction?.averageCostOfHoldings || 0;

  // Only surface the Merger Date column for a security that actually merged
  // (i.e. has TYPE=MERGER rows). Hidden for everything else.
  const showMergerDate = transactions.some(
    (t) => String(t.tranType || "").toUpperCase() === "MERGER",
  );

  // Same idea for demergers: show the Demerger Date column (record date, from
  // Holdings.CA_DATE) only for a security that actually demerged.
  const showDemergerDate = transactions.some(
    (t) => String(t.tranType || "").toUpperCase() === "DEMERGER",
  );

  // Base table has 11 columns; each optional corporate-action date adds one.
  const tableColSpan =
    11 + (showMergerDate ? 1 : 0) + (showDemergerDate ? 1 : 0);

  return (
    <div className="hd-overlay">
      <div className="hd-container">
        <div className="hd-header">
          <h2>{stock.stockName}</h2>
          <button className="hd-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="hd-summary">
          <div className="hd-card purple">
            <p>CURRENT HOLDING</p>
            <h3>{formatQuantity(currentHolding)}</h3>
          </div>

          <div className="hd-card green">
            <p>TOTAL BUY</p>
            <h3>{formatNumber(totalBuy)}</h3>
          </div>

          <div className="hd-card red">
            <p>TOTAL SELL</p>
            <h3>{formatNumber(totalSell)}</h3>
          </div>

          <div className="hd-card profit">
            <p>PROFIT / LOSS</p>
            <h3>{formatCurrency(totalProfitLoss)}</h3>
          </div>
          <div className="hd-card blue">
            <p>WEIGHTED AVG BUY PRICE</p>
            <h3>{Math.trunc(avgPrice * 100) / 100}</h3>
          </div>
        </div>

        <h3 className="hd-table-title">Transaction History</h3>

        {loading ? (
          <div
            style={{ padding: "40px", textAlign: "center", color: "#6b7280" }}
          >
            Loading...
          </div>
        ) : error ? (
          <div
            style={{ padding: "40px", textAlign: "center", color: "#dc2626" }}
          >
            Error: {error}
          </div>
        ) : (
          <div className="hd-table-wrapper">
            <table className="hd-table">
              <thead>
                <tr>
                  <th>Transaction Date</th>
                  <th>Settlement Date</th>
                  {showMergerDate && <th>Merger Date</th>}
                  {showDemergerDate && <th>Demerger Date</th>}
                  <th>Type</th>
                  <th>ISIN</th>
                  <th>Quantity</th>
                  <th>Price</th>
                  <th>Total Amount</th>
                  <th>Holding</th>
                  <th>WAP</th>
                  <th>Holding Value</th>
                  <th>P/L</th>
                </tr>
              </thead>
              <tbody>
                {transactions.length === 0 ? (
                  <tr>
                    <td
                      colSpan={tableColSpan}
                      style={{
                        textAlign: "center",
                        padding: "40px",
                        color: "#6b7280",
                      }}
                    >
                      No transactions found
                    </td>
                  </tr>
                ) : (
                  transactions.map((tx, idx) => (
                    <tr key={idx} className={getRowClass(tx.tranType)}>
                      <td>{tx.originalTrandate || tx.trandate || "-"}</td>
                      <td>{tx.setdate || "-"}</td>
                      {showMergerDate && <td>{tx.caDate || "-"}</td>}
                      {showDemergerDate && <td>{tx.caDate || "-"}</td>}
                      <td>{tx.tranType || "-"}</td>
                      <td>{tx.isin || "-"}</td>
                      <td>
                        {formatQuantity(tx.qty)}
                        <span>
                          {/^BY-|SQB|OPI/i.test(String(tx.tranType || "")) &&
                          tx.isActive === false
                            ? "Inactive"
                            : ""}
                        </span>
                      </td>
                      <td>{Math.trunc(tx.price * 100) / 100}</td>
                      <td>{formatCurrency(tx.netAmount)}</td>
                      <td>{formatQuantity(tx.holdings)}</td>
                      <td>
                        {Math.trunc(tx.averageCostOfHoldings * 100) / 100}
                      </td>
                      <td>{Math.trunc(tx.costOfHoldings * 100) / 100}</td>
                      <td
                        className={
                          tx.profitLoss !== null && tx.profitLoss !== undefined
                            ? Number(tx.profitLoss) >= 0
                              ? "pl"
                              : "pl negative"
                            : ""
                        }
                      >
                        {formatCurrency(tx.profitLoss)}
                      </td>
                      {/* <td>{formatCurrency(tx.cashBalance)}</td> */}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default TransactionPage;
