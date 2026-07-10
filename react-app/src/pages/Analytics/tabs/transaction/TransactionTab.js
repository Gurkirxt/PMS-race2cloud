import React, { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { Card } from "../../../../components/common/CommonComponents";
import { BASE_URL } from "../../../../constant";
import "./TransactionTab.css";

const PAGE_SIZE_DEFAULT = 20;

const TransactionTab = ({ accountCode, asOnDate }) => {
  const [data, setData] = useState([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [limit] = useState(PAGE_SIZE_DEFAULT);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  const [secSearch, setSecSearch] = useState("");
  /** Committed ISIN filter — empty string when no security is selected. */
  const [selectedIsin, setSelectedIsin] = useState("");
  /** @type {[Array<{isin: string, securityName: string}>, React.Dispatch<React.SetStateAction<any[]>>]} */
  const [secOptions, setSecOptions] = useState([]);
  const [showSecDropdown, setShowSecDropdown] = useState(false);
  const secDropdownRef = useRef(null);
  const initialLoadIdRef = useRef(0);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (
        secDropdownRef.current &&
        !secDropdownRef.current.contains(e.target)
      ) {
        setShowSecDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const buildBaseParams = useCallback(() => {
    const params = {
      limit,
      accountCode,
      ...(asOnDate ? { asOnDate } : {}),
      ...(selectedIsin ? { isin: selectedIsin } : {}),
    };
    return params;
  }, [limit, accountCode, asOnDate, selectedIsin]);

  const fetchPage = useCallback(
    async (page) => {
      const params = new URLSearchParams({
        ...buildBaseParams(),
        page: String(Math.max(1, page || 1)),
      });
      const res = await fetch(
        `${BASE_URL}/analytics/getPaginatedTransactions?${params.toString()}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    [buildBaseParams]
  );

  // Initial load + reset to page 1 whenever filters change.
  useEffect(() => {
    if (!accountCode || !accountCode.trim()) {
      setData([]);
      setCurrentPage(1);
      setTotalPages(1);
      setTotalCount(0);
      setLoading(false);
      setError("");
      return;
    }
    const loadId = ++initialLoadIdRef.current;
    setLoading(true);
    setError("");
    const loadFirstPage = async () => {
      try {
        const json = await fetchPage(1);
        if (loadId !== initialLoadIdRef.current) return;
        setData(json.data || []);
        setCurrentPage(json.page || 1);
        setTotalPages(Math.max(1, json.totalPages || 1));
        setTotalCount(Number(json.totalCount) || 0);
      } catch (err) {
        if (loadId !== initialLoadIdRef.current) return;
        setError(err.message || "Failed to load transactions");
      } finally {
        if (loadId === initialLoadIdRef.current) setLoading(false);
      }
    };
    loadFirstPage();
  }, [accountCode, asOnDate, selectedIsin, fetchPage]);

  const goToPage = useCallback(
    async (page) => {
      const target = Math.min(Math.max(1, page), Math.max(1, totalPages));
      if (target === currentPage || loading || loadingMore) return;
      setLoadingMore(true);
      setError("");
      try {
        const json = await fetchPage(target);
        setData(json.data || []);
        setCurrentPage(json.page || target);
        setTotalPages(Math.max(1, json.totalPages || 1));
        setTotalCount(Number(json.totalCount) || 0);
      } catch (err) {
        setError(err.message || "Failed to load page");
      } finally {
        setLoadingMore(false);
      }
    },
    [currentPage, fetchPage, loading, loadingMore, totalPages]
  );

  // Fetch security options (on open/typing, debounce 400ms)
  useEffect(() => {
    const id = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          ...(secSearch ? { search: secSearch } : {}),
          ...(accountCode ? { accountCode } : {}),
          ...(asOnDate ? { asOnDate } : {}),
        });
        const res = await fetch(
          `${BASE_URL}/analytics/getSecurityNameOptions?${params.toString()}`
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        setSecOptions(json.data || []);
      } catch {}
    }, 500);
    return () => clearTimeout(id);
  }, [secSearch, accountCode, asOnDate]);

  // Client-side contains filter over fetched options — matches Security Name OR ISIN.
  const filteredSecOptions = useMemo(() => {
    const q = secSearch.trim().toLowerCase();
    if (!q) return secOptions;
    return secOptions.filter(
      (opt) =>
        (opt.securityName || "").toLowerCase().indexOf(q) !== -1 ||
        (opt.isin || "").toLowerCase().indexOf(q) !== -1
    );
  }, [secOptions, secSearch]);

  const formatNumber = (v) =>
    v === null || v === undefined || Number.isNaN(Number(v))
      ? "-"
      : Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 });

  // Corporate actions round share counts (intentional); normal transactions
  // can be fractional and must display their real decimals.
  const CA_TYPES = ["BONUS", "SPLIT", "MERGER", "DEMERGER", "RIGHTS"];
  const isCorporateAction = (type) =>
    CA_TYPES.includes(String(type || "").toUpperCase());

  const formatQuantity = (v, type) => {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return "-";
    const num = Number(v);
    const snapped = Math.abs(num) < 1e-6 ? 0 : num;
    return isCorporateAction(type)
      ? Math.floor(snapped).toLocaleString("en-IN")
      : snapped.toLocaleString("en-IN", { maximumFractionDigits: 3 });
  };

  return (
    <Card>
      <div className="transaction-tab-header">
        <h3>Transaction History</h3>

        <div className="security-name-search" ref={secDropdownRef}>
          <label className="search-label">Security</label>

          <div className="search-input-wrapper">
            <span className="search-icon">🔍</span>

            <input
              type="text"
              className="search-input"
              placeholder="Search Security Name or ISIN..."
              value={secSearch}
              onChange={(e) => {
                setSecSearch(e.target.value);
                setShowSecDropdown(true);
              }}
              onFocus={() => setShowSecDropdown(true)}
            />

            {secSearch && (
              <span
                className="clear-icon"
                onClick={() => {
                  setSecSearch("");
                  setSelectedIsin("");
                  setSecOptions([]);
                  setShowSecDropdown(false);
                }}
              >
                ✕
              </span>
            )}

            <span className="arrow-icon">▾</span>
          </div>

          {showSecDropdown && (
            <div className="search-dropdown">
              <div className="dropdown-header">Search Security Name or ISIN...</div>

              <div className="dropdown-options">
                {filteredSecOptions.map((opt) => (
                  <div
                    key={opt.isin}
                    className="dropdown-option security-option"
                    onClick={() => {
                      setSelectedIsin(opt.isin);
                      setSecSearch(
                        opt.securityName
                          ? `${opt.securityName} (${opt.isin})`
                          : opt.isin
                      );
                      setShowSecDropdown(false);
                    }}
                  >
                    <span className="security-option-name">
                      {opt.securityName || "—"}
                    </span>
                    <span className="security-option-isin">{opt.isin}</span>
                  </div>
                ))}
              </div>

              <div className="dropdown-footer">
                {filteredSecOptions.length} option
                {filteredSecOptions.length === 1 ? "" : "s"}
              </div>
            </div>
          )}
        </div>
      </div>

      {!accountCode || !accountCode.trim() ? (
        <div className="empty-cell" style={{ padding: 24, textAlign: "center", color: "#6b7280" }}>
          Please select an account code to view transactions.
        </div>
      ) : (
        <>
      {loading && <div>Loading...</div>}
      {error && <div className="error-text">{error}</div>}

      {!loading && !error && (
        <div className="transaction-table-wrapper">
          <table className="transaction-table">
            <thead>
              <tr>
                <th>TRANDATE</th>
                <th>SETDATE</th>
                <th>Type</th>
                <th>Security Name</th>
                <th>ISIN</th>
                <th className="num">Quantity</th>
                <th className="num">Price</th>
                <th className="num">Total Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 ? (
                <tr>
                  <td colSpan={8} className="empty-cell">
                    No transactions found
                  </td>
                </tr>
              ) : (
                data.map((t) => (
                  <tr key={t.rowId}>
                    <td>{t.trandate ?? t.date ?? "-"}</td>
                    <td>{t.setdate ?? "-"}</td>
                    <td>{t.type || "-"}</td>
                    <td>{t.securityName || "-"}</td>
                    <td>{t.isin || "-"}</td>
                    <td className="num">{formatQuantity(t.quantity, t.type)}</td>
                    <td className="num">{formatNumber(t.price)}</td>
                    <td className="num">{formatNumber(t.totalAmount)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {!loading && !error && data.length > 0 && totalPages > 1 && (
        <div className="transaction-pagination">
          <button
            type="button"
            className="transaction-page-btn"
            disabled={currentPage <= 1 || loadingMore}
            onClick={() => goToPage(1)}
            title="First page"
          >
            «
          </button>
          <button
            type="button"
            className="transaction-page-btn"
            disabled={currentPage <= 1 || loadingMore}
            onClick={() => goToPage(currentPage - 1)}
            title="Previous page"
          >
            Prev
          </button>

          {(() => {
            const pages = [];
            const maxVisible = 5;
            let start = Math.max(
              1,
              currentPage - Math.floor(maxVisible / 2)
            );
            let end = start + maxVisible - 1;
            if (end > totalPages) {
              end = totalPages;
              start = Math.max(1, end - maxVisible + 1);
            }

            if (start > 1) {
              pages.push(
                <button
                  key={1}
                  className="transaction-page-num"
                  onClick={() => goToPage(1)}
                  disabled={loadingMore}
                >
                  1
                </button>
              );
              if (start > 2) {
                pages.push(
                  <span
                    key="dots-l"
                    className="transaction-page-dots"
                  >
                    …
                  </span>
                );
              }
            }

            for (let i = start; i <= end; i++) {
              pages.push(
                <button
                  key={i}
                  className={`transaction-page-num ${i === currentPage ? "active" : ""}`}
                  onClick={() => goToPage(i)}
                  disabled={i === currentPage || loadingMore}
                >
                  {i}
                </button>
              );
            }

            if (end < totalPages) {
              if (end < totalPages - 1) {
                pages.push(
                  <span
                    key="dots-r"
                    className="transaction-page-dots"
                  >
                    …
                  </span>
                );
              }
              pages.push(
                <button
                  key={totalPages}
                  className="transaction-page-num"
                  onClick={() => goToPage(totalPages)}
                  disabled={loadingMore}
                >
                  {totalPages}
                </button>
              );
            }

            return pages;
          })()}

          <button
            type="button"
            className="transaction-page-btn"
            disabled={currentPage >= totalPages || loadingMore}
            onClick={() => goToPage(currentPage + 1)}
            title="Next page"
          >
            Next
          </button>
          <button
            type="button"
            className="transaction-page-btn"
            disabled={currentPage >= totalPages || loadingMore}
            onClick={() => goToPage(totalPages)}
            title="Last page"
          >
            »
          </button>

          <span className="transaction-page-info">
            {loadingMore
              ? "Loading…"
              : `Page ${currentPage} of ${totalPages} • ${totalCount.toLocaleString("en-IN")} transaction${totalCount === 1 ? "" : "s"}`}
          </span>
        </div>
      )}
        </>
      )}
    </Card>
  );
};

export default TransactionTab;
