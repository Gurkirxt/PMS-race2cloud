import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import MainLayout from "../../layouts/MainLayout";
import { Card } from "../../components/common/CommonComponents";
import { useAccountCodes } from "../../hooks/GetAllCodes";
import { BASE_URL } from "../../constant";
import "../SplitPage/SplitPage.css";
import "./CashBalancePage.css";

function formatINR(val) {
  if (val === null || val === undefined || val === "") return "–";
  const n = Number(val);
  if (isNaN(n)) return "–";
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function CashBalancePage() {
  const { clientOptions } = useAccountCodes();

  const [accountCode, setAccountCode] = useState("");
  const [accountSearch, setAccountSearch] = useState("");
  const [showAccountDropdown, setShowAccountDropdown] = useState(false);

  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [searchInput, setSearchInput] = useState("");

  const [selectedIsin, setSelectedIsin] = useState("");
  const [isinSearch, setIsinSearch] = useState("");
  /** @type {[{isin:string, name:string}[], Function]} */
  const [isinOptions, setIsinOptions] = useState([]);
  const [showIsinDropdown, setShowIsinDropdown] = useState(false);
  const [isinLoading, setIsinLoading] = useState(false);

  const [rows, setRows] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);

  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 25;

  const dropdownRef = useRef(null);
  const isinDropdownRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowAccountDropdown(false);
      }
      if (isinDropdownRef.current && !isinDropdownRef.current.contains(e.target)) {
        setShowIsinDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (!accountCode) {
      setIsinOptions([]);
      setSelectedIsin("");
      setIsinSearch("");
      return;
    }
    let cancelled = false;
    const loadIsins = async () => {
      setIsinLoading(true);
      try {
        const res = await fetch(`${BASE_URL}/cash-balance/isins?accountCode=${encodeURIComponent(accountCode)}`);
        const json = await res.json();
        if (!cancelled) setIsinOptions(json.data || []);
      } catch (err) {
        console.error("ISIN list fetch error:", err);
        if (!cancelled) setIsinOptions([]);
      } finally {
        if (!cancelled) setIsinLoading(false);
      }
    };
    loadIsins();
    return () => { cancelled = true; };
  }, [accountCode]);

  const filteredIsins = useMemo(() => {
    if (!isinSearch) return isinOptions;
    const q = isinSearch.toLowerCase();
    return isinOptions.filter((opt) =>
      opt.isin.toLowerCase().includes(q) || opt.name.toLowerCase().includes(q)
    );
  }, [isinOptions, isinSearch]);

  const filteredAccounts = useMemo(() => {
    return clientOptions.filter((opt) =>
      opt.label.toLowerCase().includes(accountSearch.toLowerCase())
    );
  }, [clientOptions, accountSearch]);

  const fetchData = useCallback(
    async (page = 1) => {
      if (!accountCode) return;
      setLoading(true);
      try {
        const params = new URLSearchParams({
          accountCode,
          page: String(page),
          pageSize: String(pageSize),
        });
        if (fromDate) params.set("fromDate", fromDate);
        if (toDate) params.set("toDate", toDate);
        if (selectedIsin) params.set("isin", selectedIsin);
        else if (searchInput.trim()) params.set("search", searchInput.trim());

        const res = await fetch(`${BASE_URL}/cash-balance/passbook?${params}`);
        const json = await res.json();

        setRows(json.data || []);
        setTotalCount(json.totalCount || 0);
        setCurrentPage(json.page != null ? json.page : page);
        setFetched(true);
      } catch (err) {
        console.error("Cash passbook fetch error:", err);
        setRows([]);
        setTotalCount(0);
      } finally {
        setLoading(false);
      }
    },
    [accountCode, fromDate, toDate, searchInput, selectedIsin, pageSize]
  );

  const handleFetch = () => {
    setCurrentPage(1);
    setExportStatus("");
    setExportJobName("");
    fetchData(1);
  };

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  /* API returns newest-first; closing balance = balance after latest txn on this page */
  const closingBalance = useMemo(() => {
    if (!rows.length) return null;
    return rows[0];
  }, [rows]);

  const [exportJobName, setExportJobName] = useState("");
  const [exportStatus, setExportStatus] = useState("");
  const pollRef = useRef(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const pollExportStatus = useCallback(
    (jn) => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch(`${BASE_URL}/cash-balance/export/status?jobName=${encodeURIComponent(jn)}`);
          const json = await res.json();
          setExportStatus(json.status);

          if (json.status === "COMPLETED") {
            clearInterval(pollRef.current);
            pollRef.current = null;
          } else if (json.status === "FAILED" || json.status === "ERROR" || json.status === "NOT_FOUND") {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        } catch {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setExportStatus("ERROR");
        }
      }, 3000);
    },
    []
  );

  const handleExport = async () => {
    if (!accountCode) return;
    setExportStatus("STARTING");
    setExportJobName("");

    try {
      const params = new URLSearchParams({ accountCode });
      if (selectedIsin) params.set("isin", selectedIsin);
      if (fromDate) params.set("fromDate", fromDate);
      if (toDate) params.set("toDate", toDate);

      const res = await fetch(`${BASE_URL}/cash-balance/export?${params}`);
      const json = await res.json();

      if (!res.ok) {
        setExportStatus("ERROR");
        return;
      }

      setExportJobName(json.jobName);
      setExportStatus(json.status === "COMPLETED" ? "COMPLETED" : "RUNNING");

      if (json.status !== "COMPLETED") {
        pollExportStatus(json.jobName);
      }
    } catch {
      setExportStatus("ERROR");
    }
  };

  const handleDownload = async () => {
    if (!exportJobName) return;
    try {
      const res = await fetch(`${BASE_URL}/cash-balance/export/download?jobName=${encodeURIComponent(exportJobName)}`);
      const json = await res.json();
      const url =
        json.downloadUrl?.signature?.signature ??
        json.downloadUrl?.signature ??
        json.downloadUrl;
      if (url && typeof url === "string") {
        window.open(url, "_blank");
      }
    } catch (err) {
      console.error("Download failed:", err);
    }
  };

  return (
    <MainLayout title="Cash Balance">
      <div className="cash-balance-page">
        {/* Filters */}
        <Card>
          <div className="filters-card">
            {/* Account Code Dropdown */}
            <div className="cash-filter-field">
              <div className="account-code-search" ref={dropdownRef}>
                <label className="search-label">Account Code</label>

                <div className="search-input-wrapper">
                  <span className="search-icon">&#128269;</span>

                  <input
                    type="text"
                    className="search-input"
                    placeholder="Search Account Code..."
                    value={accountSearch}
                    onChange={(e) => {
                      setAccountSearch(e.target.value);
                      setShowAccountDropdown(true);
                    }}
                    onFocus={() => setShowAccountDropdown(true)}
                  />

                  {accountSearch && (
                    <span
                      className="clear-icon"
                      onClick={() => {
                        setAccountCode("");
                        setAccountSearch("");
                        setFetched(false);
                        setRows([]);
                        setExportStatus("");
                        setExportJobName("");
                      }}
                    >
                      &#10005;
                    </span>
                  )}

                  <span className="arrow-icon">&#9662;</span>
                </div>

                {showAccountDropdown && filteredAccounts.length > 0 && (
                  <div className="search-dropdown">
                    <div className="dropdown-header">Search Account Code...</div>

                    <div className="dropdown-options">
                      {filteredAccounts.map((opt) => (
                        <div
                          key={opt.value}
                          className="dropdown-option"
                          onClick={() => {
                            setAccountCode(opt.value);
                            setAccountSearch(opt.label);
                            setShowAccountDropdown(false);
                            setFetched(false);
                            setRows([]);
                          }}
                        >
                          {opt.label}
                        </div>
                      ))}
                    </div>

                    <div className="dropdown-footer">
                      {filteredAccounts.length} of {clientOptions.length} options
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* From Date */}
            <div className="cash-filter-field">
              <label>From Date</label>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </div>

            {/* To Date */}
            <div className="cash-filter-field">
              <label>To Date</label>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
              />
            </div>

            {/* ISIN Dropdown */}
            <div className="cash-filter-field">
              <div className="account-code-search" ref={isinDropdownRef}>
                <label className="search-label">ISIN</label>

                <div className="search-input-wrapper">
                  <span className="search-icon">&#128269;</span>

                  <input
                    type="text"
                    className="search-input"
                    placeholder={isinLoading ? "Loading ISINs..." : "Search ISIN..."}
                    value={isinSearch}
                    onChange={(e) => {
                      setIsinSearch(e.target.value);
                      setShowIsinDropdown(true);
                    }}
                    onFocus={() => setShowIsinDropdown(true)}
                    disabled={!accountCode}
                  />

                  {isinSearch && (
                    <span
                      className="clear-icon"
                      onClick={() => {
                        setSelectedIsin("");
                        setIsinSearch("");
                      }}
                    >
                      &#10005;
                    </span>
                  )}

                  <span className="arrow-icon">&#9662;</span>
                </div>

                {showIsinDropdown && filteredIsins.length > 0 && (
                  <div className="search-dropdown">
                    <div className="dropdown-header">Search ISIN / Name...</div>

                    <div className="dropdown-options">
                      {filteredIsins.map((opt) => (
                        <div
                          key={opt.isin}
                          className="dropdown-option"
                          onClick={() => {
                            setSelectedIsin(opt.isin);
                            setIsinSearch(opt.name !== opt.isin ? `${opt.name} (${opt.isin})` : opt.isin);
                            setShowIsinDropdown(false);
                          }}
                        >
                          <span className="isin-opt-name">{opt.name}</span>
                          <span className="isin-opt-code">{opt.isin}</span>
                        </div>
                      ))}
                    </div>

                    <div className="dropdown-footer">
                      {filteredIsins.length} of {isinOptions.length} securities
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Fetch Button */}
            <div className="cash-filter-field" style={{ justifyContent: "flex-end" }}>
              <button
                className="cash-fetch-btn"
                onClick={handleFetch}
                disabled={!accountCode || loading}
              >
                {loading ? "Loading..." : "Fetch"}
              </button>
            </div>
          </div>
        </Card>

        {/* Summary Strip */}
        {fetched && closingBalance && (
          <div className="cash-summary-strip">
            <div className="cash-summary-card">
              <span className="label">Account</span>
              <span className="value">{accountCode}</span>
            </div>
            <div className="cash-summary-card">
              <span className="label">Closing Balance (Page)</span>
              <span className="value">{formatINR(closingBalance.Cash_Balance)}</span>
            </div>
            <div className="cash-summary-card">
              <span className="label">Total Records</span>
              <span className="value">{totalCount.toLocaleString("en-IN")}</span>
            </div>
          </div>
        )}

        {/* Table */}
        {fetched && (
          <div className="cash-table-section">
            <Card>
              <div className="cash-table-header">
                <h3>Cash Passbook</h3>
                <span className="cash-row-count">
                  Showing {rows.length} of {totalCount} records
                </span>
              </div>

              {loading ? (
                <div className="cash-loading">Loading transactions...</div>
              ) : rows.length === 0 ? (
                <div className="cash-empty">No transactions found for the selected filters.</div>
              ) : (
                <>
                  <div className="cash-table-wrapper">
                    <table className="cash-table">
                      <thead>
                        <tr>
                          <th>Tran Date</th>
                          <th>Set Date</th>
                          <th>Account</th>
                          <th>ISIN</th>
                          <th>Security Name</th>
                          <th>Tran Type</th>
                          <th>QTY</th>
                          <th>Rate</th>
                          <th>STT</th>
                          <th>Amount</th>
                          <th className="cash-th-balance">Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, idx) => {
                          const bal = Number(r.Cash_Balance);
                          const balValid = !Number.isNaN(bal);
                          return (
                            <tr key={r.ROWID ?? idx}>
                              <td>{r.Transaction_Date || "–"}</td>
                              <td>{r.Settlement_Date || "–"}</td>
                              <td>{r.Account_Code || "–"}</td>
                              <td>{r.ISIN || "–"}</td>
                              <td className="cash-col-name">{r.Security_Name || "–"}</td>
                              <td>{r.Transaction_Type || "–"}</td>
                              <td>{r.Quantity ?? "–"}</td>
                              <td>{r.Price != null ? formatINR(r.Price) : "–"}</td>
                              <td className={Number(r.STT) ? "cash-debit" : ""}>
                                {Number(r.STT) ? `- ${formatINR(r.STT)}` : "–"}
                              </td>
                              <td className={r.Debit ? "cash-debit" : r.Credit ? "cash-credit" : ""}>
                                {r.Debit ? `- ${formatINR(r.Debit)}` : r.Credit ? `+ ${formatINR(r.Credit)}` : "–"}
                              </td>
                              <td className={`cash-col-balance ${balValid && bal >= 0 ? "cash-balance-positive" : ""} ${balValid && bal < 0 ? "cash-balance-negative" : ""}`}>
                                {balValid ? formatINR(bal) : "–"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Pagination */}
                  {totalPages > 1 && (
                    <div className="cash-pagination">
                      <button
                        className="cash-page-btn"
                        disabled={currentPage <= 1}
                        onClick={() => fetchData(1)}
                        title="Newest transactions"
                      >
                        «
                      </button>
                      <button
                        className="cash-page-btn"
                        disabled={currentPage <= 1}
                        onClick={() => fetchData(currentPage - 1)}
                        title="Newer"
                      >
                        Prev
                      </button>

                      {(() => {
                        const pages = [];
                        const maxVisible = 5;
                        let start = Math.max(1, currentPage - Math.floor(maxVisible / 2));
                        let end = start + maxVisible - 1;
                        if (end > totalPages) {
                          end = totalPages;
                          start = Math.max(1, end - maxVisible + 1);
                        }

                        if (start > 1) {
                          pages.push(
                            <button key={1} className="cash-page-num" onClick={() => fetchData(1)}>1</button>
                          );
                          if (start > 2) pages.push(<span key="dots-l" className="cash-page-dots">…</span>);
                        }

                        for (let i = start; i <= end; i++) {
                          pages.push(
                            <button
                              key={i}
                              className={`cash-page-num ${i === currentPage ? "active" : ""}`}
                              onClick={() => fetchData(i)}
                              disabled={i === currentPage}
                            >
                              {i}
                            </button>
                          );
                        }

                        if (end < totalPages) {
                          if (end < totalPages - 1) pages.push(<span key="dots-r" className="cash-page-dots">…</span>);
                          pages.push(
                            <button key={totalPages} className="cash-page-num" onClick={() => fetchData(totalPages)}>{totalPages}</button>
                          );
                        }

                        return pages;
                      })()}

                      <button
                        className="cash-page-btn"
                        disabled={currentPage >= totalPages}
                        onClick={() => fetchData(currentPage + 1)}
                        title="Older"
                      >
                        Next
                      </button>
                      <button
                        className="cash-page-btn"
                        disabled={currentPage >= totalPages}
                        onClick={() => fetchData(totalPages)}
                        title="Oldest transactions"
                      >
                        »
                      </button>

                      <span className="cash-page-info">
                        Page {currentPage} of {totalPages}
                      </span>
                    </div>
                  )}
                </>
              )}

              {/* Export */}
              {rows.length > 0 && (
                <div className="cash-export-bar">
                  {exportStatus === "COMPLETED" ? (
                    <button className="cash-export-btn cash-download-btn" onClick={handleDownload}>
                      Download CSV
                    </button>
                  ) : (
                    <button
                      className="cash-export-btn"
                      onClick={handleExport}
                      disabled={loading || exportStatus === "RUNNING" || exportStatus === "STARTING" || exportStatus === "PENDING"}
                    >
                      {exportStatus === "RUNNING" || exportStatus === "PENDING"
                        ? "Exporting..."
                        : exportStatus === "STARTING"
                        ? "Starting..."
                        : exportStatus === "ERROR" || exportStatus === "FAILED"
                        ? "Retry Export"
                        : "Export CSV"}
                    </button>
                  )}
                  {(exportStatus === "RUNNING" || exportStatus === "PENDING") && (
                    <span className="cash-export-status">Background job running, please wait...</span>
                  )}
                  {(exportStatus === "ERROR" || exportStatus === "FAILED") && (
                    <span className="cash-export-status cash-export-error">Export failed. Try again.</span>
                  )}
                </div>
              )}
            </Card>
          </div>
        )}
      </div>
    </MainLayout>
  );
}

export default CashBalancePage;
