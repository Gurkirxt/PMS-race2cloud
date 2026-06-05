import React, { useState, useEffect, useMemo, useRef } from "react";
import MainLayout from "../../layouts/MainLayout";
import { Card, Pagination } from "../../components/common/CommonComponents";
import { BASE_URL } from "../../constant";
import "../SplitPage/SplitPage.css";
import "./ClientPage.css";

const PAGE_SIZE = 10;

const COLUMNS = [
  { key: "securityName", label: "Security Name" },
  { key: "isin", label: "ISIN" },
  { key: "securityCode", label: "Security Code" },
];

function displayValue(val) {
  if (val === null || val === undefined || val === "") return "–";
  return String(val);
}

function SecurityPage() {
  const [securities, setSecurities] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef(null);

  /* Load all securities once; the table shows all by default. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const res = await fetch(`${BASE_URL}/security/list`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(json.message || "Failed to load securities.");
          setSecurities([]);
        } else {
          setSecurities(json.data || []);
        }
      } catch (err) {
        console.error("Security list fetch error:", err);
        if (!cancelled) {
          setError("Failed to fetch securities.");
          setSecurities([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* One search box, filters the table by Security Name, ISIN or Code. */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return securities;
    return securities.filter((s) => {
      const name = String(s.securityName ?? "").toLowerCase();
      const isin = String(s.isin ?? "").toLowerCase();
      const code = String(s.securityCode ?? "").toLowerCase();
      return name.includes(q) || isin.includes(q) || code.includes(q);
    });
  }, [securities, search]);

  /* Reset to the first page whenever the filter changes. */
  useEffect(() => {
    setPage(1);
  }, [search]);

  /* Close the suggestion dropdown when clicking outside. */
  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  /* Autocomplete suggestions (first 50 matches). */
  const suggestions = useMemo(() => filtered.slice(0, 50), [filtered]);

  const handleSelectSuggestion = (opt) => {
    setSearch(opt.securityName || opt.isin);
    setShowDropdown(false);
  };

  const pageRows = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  return (
    <MainLayout title="Master · Security">
      <div className="client-page">
        {/* Filter */}
        <Card>
          <div className="client-filter-card">
            <div className="cash-filter-field">
              <div className="account-code-search" ref={dropdownRef}>
                <label className="search-label">Filter by Security Name or ISIN</label>
                <div className="search-input-wrapper">
                  <span className="search-icon">&#128269;</span>
                  <input
                    type="text"
                    className="search-input"
                    placeholder="Search Security Name or ISIN..."
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setShowDropdown(true);
                    }}
                    onFocus={() => setShowDropdown(true)}
                  />
                  {search && (
                    <span className="clear-icon" onClick={() => setSearch("")}>
                      &#10005;
                    </span>
                  )}
                </div>

                {showDropdown && suggestions.length > 0 && (
                  <div className="search-dropdown">
                    <div className="dropdown-header">Security Name / ISIN</div>
                    <div className="dropdown-options">
                      {suggestions.map((opt) => (
                        <div
                          key={opt.isin}
                          className="dropdown-option"
                          onClick={() => handleSelectSuggestion(opt)}
                        >
                          <span className="isin-opt-name">
                            {opt.securityName || "(no name)"}
                          </span>
                          <span className="isin-opt-code">{opt.isin}</span>
                        </div>
                      ))}
                    </div>
                    <div className="dropdown-footer">
                      {suggestions.length} of {filtered.length} matches
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </Card>

        {/* Table */}
        {loading && <div className="client-state">Loading securities...</div>}
        {!loading && error && (
          <div className="client-state client-state-error">{error}</div>
        )}

        {!loading && !error && (
          <div className="client-details-section">
            <Card>
              <div className="client-details-header">
                <h3>Securities</h3>
                <span className="client-row-count">
                  Showing {filtered.length} of {securities.length}
                </span>
              </div>

              {filtered.length === 0 ? (
                <div className="client-state">No securities match your filter.</div>
              ) : (
                <>
                  <div className="client-table-wrapper">
                    <table className="client-table">
                      <thead>
                        <tr>
                          {COLUMNS.map((c) => (
                            <th key={c.key}>{c.label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {pageRows.map((row, i) => (
                          <tr key={row.isin ?? i}>
                            {COLUMNS.map((c) => (
                              <td key={c.key}>{displayValue(row[c.key])}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <Pagination
                    currentPage={page}
                    pageSize={PAGE_SIZE}
                    totalRows={filtered.length}
                    onPageChange={setPage}
                  />
                </>
              )}
            </Card>
          </div>
        )}
      </div>
    </MainLayout>
  );
}

export default SecurityPage;
