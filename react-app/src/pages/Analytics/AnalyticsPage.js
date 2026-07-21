import React, { useState, useEffect, useRef, useMemo } from "react";
import MainLayout from "../../layouts/MainLayout.js";
import { Card, TextInput } from "../../components/common/CommonComponents.js";
import TransactionPage from "../TransactionPage/TransactionPage.js";
import "./AnalyticsPage.css";
import { useAccountCodes } from "../../hooks/GetAllCodes.js";
import { useHoldings } from "../../hooks/GetHolding.js";

import Holdingtabs from "./tabs/holding/HoldingTab";
import Allocation from "./tabs/allocations/AllocationTab";
import Performance from "./tabs/performance/PerformanceTab";
import TransactionTab from "./tabs/transaction/TransactionTab";
import { BASE_URL } from "../../constant.js";

function AnalyticsPage() {
  /* -------------------- DATA HOOKS -------------------- */
  const { clientOptions } = useAccountCodes();
  const { holdings, setHoldings, loadingHoldings, fetchHoldings } =
    useHoldings();

  /* -------------------- STATE -------------------- */
  const [accountCode, setAccountCode] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [isinOptions, setIsinOptions] = useState([]);
  const [isinQuery, setIsinQuery] = useState("");
  const [selectedIsin, setSelectedIsin] = useState("");
  const [showIsinDropdown, setShowIsinDropdown] = useState(false);
  const [isinHoldings, setIsinHoldings] = useState([]);
  const [loadingIsinHoldings, setLoadingIsinHoldings] = useState(false);
  const [asOnDate, setAsOnDate] = useState("");

  const [activeTab, setActiveTab] = useState("holding");
  const [selectedStock, setSelectedStock] = useState(null);

  const [viewMode, setViewMode] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const [cashBalance, setCashBalance] = useState(0);

  const dropdownRef = useRef(null);
  const isinDropdownRef = useRef(null);
  const cashRequestIdRef = useRef(0);
  const isinRequestIdRef = useRef(0);
  /* -------------------- EFFECTS -------------------- */
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
      if (
        isinDropdownRef.current &&
        !isinDropdownRef.current.contains(e.target)
      ) {
        setShowIsinDropdown(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    fetchSecurityList();
  }, []);

  /* -------------------- DERIVED DATA -------------------- */
  const filteredOptions = useMemo(() => {
    return clientOptions.filter((opt) =>
      opt.label.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [clientOptions, searchQuery]);

  const filteredIsinOptions = useMemo(() => {
    const q = String(isinQuery ?? "").toLowerCase().trim();
    if (!q) return isinOptions;
    return isinOptions.filter(
      (opt) =>
        String(opt?.isin ?? "").toLowerCase().includes(q) ||
        String(opt?.securityCode ?? "").toLowerCase().includes(q) ||
        String(opt?.securityName ?? "").toLowerCase().includes(q)
    );
  }, [isinOptions, isinQuery]);

  function formatAmount(value) {
    if (value === null || value === undefined) return "–";

    const absValue = Math.abs(value);

    // Crores (1 Cr = 1,00,00,000)
    if (absValue >= 1e7) {
      const cr = Math.floor((absValue / 1e7) * 100) / 100;
      return `${cr} Cr`;
    }

    // Lakhs (1 L = 1,00,000)
    if (absValue >= 1e5) {
      const l = Math.floor((absValue / 1e5) * 100) / 100;
      return `${l} L`;
    }

    return value.toLocaleString("en-IN");
  }

  const summaryCards = useMemo(() => {
    const equityMktValue = holdings.reduce(
      (sum, h) => sum + (h.marketValue || 0),
      0
    );

    const totalAssets = equityMktValue + cashBalance;

    const equityPct = totalAssets
      ? ((equityMktValue / totalAssets) * 100).toFixed(2)
      : "0.00";

    const cashPct = totalAssets
      ? ((cashBalance / totalAssets) * 100).toFixed(2)
      : "0.00";

    return [
      {
        key: "total",
        label: "Total",
        cost: formatAmount(totalAssets),
        mktVal: formatAmount(totalAssets),
        income: "–",
        gl: "–",
        glPct: "–",
        pctAssets: "100.00 %",
      },
      {
        key: "equity",
        label: "Equity",
        cost: formatAmount(equityMktValue),
        mktVal: formatAmount(equityMktValue),
        income: "–",
        gl: "–",
        glPct: "–",
        pctAssets: `${equityPct} %`,
      },
      {
        key: "cash",
        label: "Cash and Equivalent",
        cost: formatAmount(cashBalance),
        mktVal: formatAmount(cashBalance),
        income: "–",
        gl: "–",
        glPct: "0.00 %",
        pctAssets: `${cashPct} %`,
      },
    ];
  }, [holdings, cashBalance]);

  /* -------------------- HANDLERS -------------------- */
  const handleSearchChange = (e) => {
    setSearchQuery(e.target.value);
    setShowIsinDropdown(false);
    setShowDropdown(true);
  };

  const handleAccountSelect = (option) => {
    setSearchQuery(option.label);
    setAccountCode(option.value);
    setShowDropdown(false);
    setSelectedIsin("");
    setIsinQuery("");
    setIsinHoldings([]);
    setCurrentPage(1);
    fetchHoldings(option.value, asOnDate);
    fetchCashBalance(option.value, asOnDate);
  };

  const handleIsinSearchChange = (e) => {
    setIsinQuery(e.target.value);
    setShowDropdown(false);
    setShowIsinDropdown(true);
  };

  const handleIsinSelect = (option) => {
    const label = option.securityName
      ? `${option.isin} - ${option.securityName}`
      : option.isin;
    setIsinQuery(label);
    setSelectedIsin(option.isin);
    setShowIsinDropdown(false);
    setSearchQuery("");
    setAccountCode("");
    setCashBalance(0);
    setHoldings([]);
    setSelectedStock(null);
    setCurrentPage(1);
    fetchHoldingsByIsin(option.isin, asOnDate);
  };

  const clearAccountSelection = () => {
    setSearchQuery("");
    setAccountCode("");
    setHoldings([]);
    setSelectedStock(null);
    setCashBalance(0);
  };

  const clearIsinSelection = () => {
    setIsinQuery("");
    setSelectedIsin("");
    setIsinHoldings([]);
    setCurrentPage(1);
  };

  const handleDateChange = (e) => {
    const date = e.target.value;
    setAsOnDate(date);
    setCurrentPage(1);

    if (selectedIsin) {
      fetchHoldingsByIsin(selectedIsin, date);
    }
    if (accountCode) {
      fetchHoldings(accountCode, date);
      fetchCashBalance(accountCode, date);
    }
  };

  const handlePageChange = (page) => setCurrentPage(page);

  const handlePageSizeChange = (size) => {
    setPageSize(size);
    setCurrentPage(1);
  };

  const fetchCashBalance = async (accountCode, asOnDate) => {
    if (!accountCode) return;

    const currentRequestId = ++cashRequestIdRef.current;

    try {
      let url = `${BASE_URL}/analytics/getCashBalanceSummary?accountCode=${accountCode}`;

      if (asOnDate) {
        url += `&asOnDate=${asOnDate}`;
      }

      const response = await fetch(url);
      const data = await response.json();

      if (currentRequestId !== cashRequestIdRef.current) return;
      setCashBalance(data?.cashBalance || 0);
    } catch (error) {
      if (currentRequestId !== cashRequestIdRef.current) return;
      console.error("Error fetching cash balance:", error);
      setCashBalance(0);
    }
  };

  const fetchSecurityList = async () => {
    try {
      const response = await fetch(`${BASE_URL}/security/list`);
      const data = await response.json();
      const rows = Array.isArray(data?.data) ? data.data : [];
      setIsinOptions(
        rows
          .map((row) => ({
            isin: String(row?.isin ?? "").trim(),
            securityCode: String(row?.securityCode ?? "").trim(),
            securityName: String(row?.securityName ?? "").trim(),
          }))
          .filter((row) => row.isin)
      );
    } catch (error) {
      console.error("Error fetching securities list:", error);
      setIsinOptions([]);
    }
  };

  const fetchHoldingsByIsin = async (isin, asOnDateValue) => {
    const isinTrim = String(isin ?? "").trim();
    if (!isinTrim) return;

    const currentRequestId = ++isinRequestIdRef.current;
    setLoadingIsinHoldings(true);
    setIsinHoldings([]);

    try {
      const params = new URLSearchParams({ isin: isinTrim });
      if (asOnDateValue) params.set("asOnDate", asOnDateValue);

      const response = await fetch(
        `${BASE_URL}/analytics/getHoldingsByIsin?${params.toString()}`
      );
      const data = await response.json();

      if (currentRequestId !== isinRequestIdRef.current) return;
      if (Array.isArray(data)) {
        setIsinHoldings(data);
      } else {
        setIsinHoldings([]);
      }
    } catch (error) {
      if (currentRequestId !== isinRequestIdRef.current) return;
      console.error("Error fetching ISIN holdings:", error);
      setIsinHoldings([]);
    } finally {
      if (currentRequestId === isinRequestIdRef.current) {
        setLoadingIsinHoldings(false);
      }
    }
  };

  /* -------------------- TABS CONFIG -------------------- */
  const TAB_ITEMS = [
    { key: "holding", label: "Holding" },
    { key: "allocation", label: "Allocation" },
    { key: "performance", label: "Performance" },
    { key: "transaction", label: "Transaction" },
  ];

  const renderActiveTab = () => {
    switch (activeTab) {
      case "holding":
        return (
          <Holdingtabs
            viewMode={viewMode}
            setViewMode={setViewMode}
            holdings={holdings}
            accountCode={accountCode}
            isIsinMode={Boolean(selectedIsin)}
            isinReportRows={isinHoldings}
            loadingIsinReport={loadingIsinHoldings}
            selectedIsin={selectedIsin}
            asOnDate={asOnDate}
            selectedStock={selectedStock}
            setSelectedStock={setSelectedStock}
            pageSize={pageSize}
            currentPage={currentPage}
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
          />
        );

      case "allocation":
        return <Allocation />;

      case "performance":
        return <Performance />;

      case "transaction":
        return <TransactionTab accountCode={accountCode} asOnDate={asOnDate} />;

      default:
        return null;
    }
  };

  /* -------------------- JSX -------------------- */
  return (
    <MainLayout title="Analytics Filters">
      {/* Filters */}
      <Card className="filters-card">
        <div
          className={`filters-grid${
            showIsinDropdown && filteredIsinOptions.length > 0
              ? " isin-dropdown-active"
              : ""
          }`}
        >
          <div
            className={`isin-code-search${showIsinDropdown ? " is-open" : ""}`}
            ref={isinDropdownRef}
          >
            <label className="search-label">ISIN</label>

            <div className="search-input-wrapper">
              <span className="search-icon">🔍</span>
              <input
                type="text"
                className="search-input"
                placeholder="Search ISIN / Security..."
                value={isinQuery}
                onChange={handleIsinSearchChange}
                onFocus={() => {
                  setShowDropdown(false);
                  setShowIsinDropdown(true);
                }}
              />

              {isinQuery && (
                <span className="clear-icon" onClick={clearIsinSelection}>
                  ✕
                </span>
              )}
              <span className="arrow-icon">▾</span>
            </div>

            {showIsinDropdown && filteredIsinOptions.length > 0 && (
              <div className="search-dropdown">
                <div className="dropdown-header">Search ISIN / Name...</div>
                <div className="dropdown-options">
                  {filteredIsinOptions.map((opt, idx) => (
                    <div
                      key={`${opt.isin || "no-isin"}-${idx}`}
                      className="dropdown-option"
                      onClick={() => handleIsinSelect(opt)}
                    >
                      {opt.isin}
                      {opt.securityName ? ` - ${opt.securityName}` : ""}
                    </div>
                  ))}
                </div>
                <div className="dropdown-footer">
                  {filteredIsinOptions.length} of {isinOptions.length} options
                </div>
              </div>
            )}
          </div>

          <div
            className={`account-code-search${showDropdown ? " is-open" : ""}`}
            ref={dropdownRef}
          >
            <label className="search-label">Account Code</label>

            <div className="search-input-wrapper">
              <span className="search-icon">🔍</span>

              <input
                type="text"
                className="search-input"
                placeholder="Search Account Code..."
                value={searchQuery}
                onChange={handleSearchChange}
                onFocus={() => {
                  setShowIsinDropdown(false);
                  setShowDropdown(true);
                }}
              />

              {searchQuery && (
                <span className="clear-icon" onClick={clearAccountSelection}>
                  ✕
                </span>
              )}

              <span className="arrow-icon">▾</span>
            </div>

            {showDropdown && filteredOptions.length > 0 && (
              <div className="search-dropdown">
                <div className="dropdown-header">Search Account Code...</div>

                <div className="dropdown-options">
                  {filteredOptions.map((opt) => (
                    <div
                      key={opt.value}
                      className="dropdown-option"
                      onClick={() => handleAccountSelect(opt)}
                    >
                      {opt.label}
                    </div>
                  ))}
                </div>

                <div className="dropdown-footer">
                  {filteredOptions.length} of {clientOptions.length} options
                </div>
              </div>
            )}
          </div>

          <TextInput
            label="Filter by Date"
            type="date"
            value={asOnDate}
            onChange={handleDateChange}
          />
        </div>
      </Card>

      {/* Tabs */}
      <div className="analytics-tabs">
        {TAB_ITEMS.map((tab) => (
          <button
            key={tab.key}
            className={`analytics-tab ${activeTab === tab.key ? "active" : ""}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {/* Holding Summary – only for Holding tab, once an account is selected */}
      {activeTab === "holding" && accountCode && !selectedIsin && (
        <div className="holding-summary-table">
          <div className="summary-table-header">
            <h3>Holding Summary</h3>
            <span className="summary-sort-icon">⇅</span>
          </div>

          <div className="summary-table-wrapper">
            <table className="summary-table">
              <thead>
                <tr>
                  <th>Description</th>
                  <th>Cost</th>
                  <th>Mkt Val</th>
                  <th>Income</th>
                  <th>G/L</th>
                  <th>% G/L</th>
                  <th>% Assets</th>
                </tr>
              </thead>

              <tbody>
                {summaryCards.map((item) => (
                  <tr key={item.key} className="summary-row">
                    <td>
                      <div className="summary-desc">
                        <span className={`summary-dot ${item.key}`} />
                        {item.label}
                      </div>
                    </td>
                    <td>{item.cost}</td>
                    <td>{item.mktVal}</td>
                    <td>{item.income}</td>
                    <td>{item.gl}</td>
                    <td>{item.glPct}</td>
                    <td>{item.pctAssets}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab Content */}
      <div className="analytics-tab-content">{renderActiveTab()}</div>

      {loadingHoldings && !selectedIsin && (
        <p className="loading-text">Loading holdings...</p>
      )}

      {selectedStock && (
        <TransactionPage
          key={`${selectedStock.accountCode || accountCode}-${selectedStock.isin || selectedStock.securityCode}-${asOnDate}`}
          stock={selectedStock}
          accountCode={selectedStock.accountCode || accountCode}
          asOnDate={asOnDate}
          onClose={() => setSelectedStock(null)}
        />
      )}
    </MainLayout>
  );
}

export default AnalyticsPage;
