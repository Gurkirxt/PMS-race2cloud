import React, { useState, useEffect, useMemo, useRef } from "react";
import MainLayout from "../../layouts/MainLayout";
import { Card, Pagination } from "../../components/common/CommonComponents";
import { BASE_URL } from "../../constant";
import "../SplitPage/SplitPage.css";
import "./ClientPage.css";

const PAGE_SIZE = 10;

/* Columns that the platform stores on every record — hidden from display. */
const SYSTEM_FIELDS = ["ROWID", "CREATORID", "CREATEDTIME", "MODIFIEDTIME"];
/* Business columns intentionally hidden from the table. */
const HIDDEN_FIELDS = ["WS_client_id"];
const ACCOUNT_FIELD = "WS_Account_code";
/* Search filters on the actual (broker) code — one actual maps to many virtual codes. */
const SEARCH_FIELD = "Actual_Code";

/* Header overrides — data key stays the same, only the displayed label changes. */
const COLUMN_LABELS = { WS_Account_code: "Virtual Code" };

/* "WS_Account_code" -> "WS Account Code" */
function prettyLabel(key) {
  return String(key)
    .split("_")
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function displayValue(val) {
  if (val === null || val === undefined || val === "") return "–";
  return String(val);
}

function ClientPage() {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef(null);

  /* Load every client once; the table shows all by default. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const res = await fetch(`${BASE_URL}/client/list`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(json.message || "Failed to load clients.");
          setClients([]);
        } else {
          setClients(json.data || []);
        }
      } catch (err) {
        console.error("Client list fetch error:", err);
        if (!cancelled) {
          setError("Failed to fetch clients.");
          setClients([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* Column set derived from the data (account code first, system cols hidden). */
  const columns = useMemo(() => {
    const keys = [];
    const seen = new Set();
    clients.forEach((row) =>
      Object.keys(row).forEach((k) => {
        if (!SYSTEM_FIELDS.includes(k) && !HIDDEN_FIELDS.includes(k) && !seen.has(k)) {
          seen.add(k);
          keys.push(k);
        }
      })
    );
    return keys.sort((a, b) =>
      a === ACCOUNT_FIELD ? -1 : b === ACCOUNT_FIELD ? 1 : 0
    );
  }, [clients]);

  /* The search box filters the table by actual code — returns every virtual code for it. */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter((r) =>
      String(r[SEARCH_FIELD] ?? "").toLowerCase().includes(q)
    );
  }, [clients, search]);

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

  /* Autocomplete suggestions — distinct actual codes (deduped) from the matches. */
  const suggestions = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const r of filtered) {
      const code = String(r[SEARCH_FIELD] ?? "").trim();
      if (code && !seen.has(code)) {
        seen.add(code);
        out.push(code);
      }
      if (out.length >= 50) break;
    }
    return out;
  }, [filtered]);

  const handleSelectSuggestion = (code) => {
    setSearch(code);
    setShowDropdown(false);
  };

  const pageRows = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  return (
    <MainLayout title="Master · Client">
      <div className="client-page">
        {/* Filter */}
        <Card>
          <div className="client-filter-card">
            <div className="cash-filter-field">
              <div className="account-code-search" ref={dropdownRef}>
                <label className="search-label">Filter by Actual Code</label>
                <div className="search-input-wrapper">
                  <span className="search-icon">&#128269;</span>
                  <input
                    type="text"
                    className="search-input"
                    placeholder="Search Actual Code..."
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
                    <div className="dropdown-header">Actual Code</div>
                    <div className="dropdown-options">
                      {suggestions.map((code) => (
                        <div
                          key={code}
                          className="dropdown-option"
                          onClick={() => handleSelectSuggestion(code)}
                        >
                          {code}
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
        {loading && <div className="client-state">Loading clients...</div>}
        {!loading && error && (
          <div className="client-state client-state-error">{error}</div>
        )}

        {!loading && !error && (
          <div className="client-details-section">
            <Card>
              <div className="client-details-header">
                <h3>Clients</h3>
                <span className="client-row-count">
                  Showing {filtered.length} of {clients.length}
                </span>
              </div>

              {filtered.length === 0 ? (
                <div className="client-state">No clients match your filter.</div>
              ) : (
                <>
                  <div className="client-table-wrapper">
                    <table className="client-table">
                      <thead>
                        <tr>
                          {columns.map((c) => (
                            <th key={c}>{COLUMN_LABELS[c] || prettyLabel(c)}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {pageRows.map((row, i) => (
                          <tr key={row.ROWID ?? i}>
                            {columns.map((c) => (
                              <td key={c}>{displayValue(row[c])}</td>
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

export default ClientPage;
