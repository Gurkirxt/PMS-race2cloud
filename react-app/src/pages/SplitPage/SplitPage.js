

import React, { useState, useEffect, useRef, useMemo } from "react";
import MainLayout from "../../layouts/MainLayout";
import { Card } from "../../components/common/CommonComponents";
import "./SplitPage.css";
import { BASE_URL } from "../../constant";

function SplitPage() {
  /* ===========================
     FORM STATE
     =========================== */
  const [isin, setIsin] = useState("");
  const [securityCode, setSecurityCode] = useState("");
  const [securityName, setSecurityName] = useState("");
  const [ratio1, setRatio1] = useState("");
  const [ratio2, setRatio2] = useState("");
  const [date, setDate] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState([]);
  const [showPreview, setShowPreview] = useState(false);

  const [exportLoading, setExportLoading] = useState(false);
  const [exportDownloadUrl, setExportDownloadUrl] = useState("");

  const [securities, setSecurities] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const PAGE_SIZE = 10;
  const [page, setPage] = useState(1);

  // Which actual-account groups are expanded (drill-down open).
  const [expandedKeys, setExpandedKeys] = useState(() => new Set());

  const dropdownRef = useRef(null);

  useEffect(() => setPage(1), [previewData]);

  /* ===========================
     GROUP PREVIEW BY ACTUAL ACCOUNT
     Holdings come back one row per code (WS_Account_code). A single real
     account can hold shares under many virtual codes AND directly under its
     actual code, so we fold every code that resolves to the same actual
     account into one cumulative row and keep the underlying rows as children
     for the drill-down. Group totals use the same Math.floor the table
     displays, so a group total equals the visible sum of its children.
     =========================== */
  const groupedData = useMemo(() => {
    const groups = new Map();
    for (const row of previewData) {
      const actual = String(row.actualCode || "").trim();
      const key = actual || row.accountCode;
      let g = groups.get(key);
      if (!g) {
        g = {
          key,
          actualCode: actual,
          currentHolding: 0,
          newHolding: 0,
          delta: 0,
          children: [],
        };
        groups.set(key, g);
      }
      if (!g.actualCode && actual) g.actualCode = actual;
      g.currentHolding += Math.floor(Number(row.currentHolding) || 0);
      g.newHolding += Math.floor(Number(row.newHolding) || 0);
      g.children.push(row);
    }
    for (const g of groups.values()) {
      g.delta = g.newHolding - g.currentHolding;
    }
    return [...groups.values()];
  }, [previewData]);

  const totalPages = Math.max(1, Math.ceil(groupedData.length / PAGE_SIZE));
  const paginatedGroups = groupedData.slice(
    (page - 1) * PAGE_SIZE,
    page * PAGE_SIZE,
  );

  const toggleGroup = (key) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /* ===========================
     FETCH ISIN + CODE + NAME
     =========================== */
  useEffect(() => {
    fetchAllSecurities();
  }, []);

  const handlePreview = async () => {
    try {
      setPreviewLoading(true);
      setError(null);
      setShowPreview(false);

      const payload = {
        isin,
        ratio1: Number(ratio1),
        ratio2: Number(ratio2),
        issueDate: date,
      };

      const res = await fetch(`${BASE_URL}/split/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || "Failed to preview split");
      }

      const data = await res.json();

      setPreviewData(data.data || []);
      setShowPreview(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setPreviewLoading(false);
    }
  };


  const fetchAllSecurities = async () => {
    try {
      const res = await fetch(`${BASE_URL}/split/getAllSecuritiesList`);
      const data = await res.json();
      if (data.success) {
        setSecurities(data.data);
      }
    } catch (err) {
      console.error("Failed to fetch securities", err);
    }
  };

  /* ===========================
     CLOSE DROPDOWN ON OUTSIDE CLICK
     =========================== */
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  /* ===========================
     FILTER ISIN SEARCH
     =========================== */
  const q = searchQuery.toLowerCase();
  const filteredSecurities = securities.filter(
    (sec) =>
      String(sec?.isin ?? "").toLowerCase().includes(q) ||
      String(sec?.securityCode ?? "").toLowerCase().includes(q) ||
      String(sec?.securityName ?? "").toLowerCase().includes(q),
  );

  /* ===========================
     HANDLE ISIN SELECTION
     =========================== */
  const handleSelectISIN = (sec) => {
    setIsin(sec.isin);
    setSearchQuery(sec.isin);
    setSecurityCode(sec.securityCode);
    setSecurityName(sec.securityName);
    setShowDropdown(false);
  };

  /* ===========================
     SUBMIT SPLIT
     =========================== */
  const handleSubmit = async () => {
    if (Number(ratio1) === Number(ratio2)) {
      setError("Split ratio cannot be the same");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      setSuccess(false);

      const payload = {
        isin,
        securityCode,
        securityName,
        ratio1: Number(ratio1),
        ratio2: Number(ratio2),
        issueDate: date,
      };

      const res = await fetch(`${BASE_URL}/split/add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || "Failed to apply split");
      }

      setSuccess(true);

      // Reset form and preview (same as Bonus)
      setIsin("");
      setSearchQuery("");
      setSecurityCode("");
      setSecurityName("");
      setRatio1("");
      setRatio2("");
      setDate("");
      setPreviewData([]);
      setShowPreview(false);
      setExportDownloadUrl("");

      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <MainLayout title="Stock Split">
      <Card style={{ marginTop: 4 }}>
        {success && (
          <div className="alert success">Split saved successfully!</div>
        )}
        {error && <div className="alert error">{error}</div>}

        <div className="split-card">
          {/* ISIN SEARCH */}
          <div className="account-code-search" ref={dropdownRef}>
            <label className="search-label">ISIN</label>

            <div className="search-input-wrapper">
              <span className="search-icon">🔍</span>

              <input
                type="text"
                className="search-input"
                placeholder="Search ISIN..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setShowDropdown(true);
                }}
                onFocus={() => setShowDropdown(true)}
              />

              {searchQuery && (
                <span
                  className="clear-icon"
                  onClick={() => {
                    setSearchQuery("");
                    setIsin("");
                    setSecurityCode("");
                    setSecurityName("");
                  }}
                >
                  ✕
                </span>
              )}

              <span className="arrow-icon">▾</span>
            </div>

            {showDropdown && filteredSecurities.length > 0 && (
              <div className="search-dropdown">
                <div className="dropdown-header">Search ISIN</div>

                <div className="dropdown-options">
                  {filteredSecurities.map((sec, idx) => (
                    <div
                      key={`${sec.isin || "no-isin"}-${idx}`}
                      className="dropdown-option"
                      onClick={() => handleSelectISIN(sec)}
                    >
                      <strong>{sec.isin}</strong>
                      <div style={{ fontSize: 12, color: "#6b7280" }}>
                        {sec.securityCode} – {sec.securityName}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="dropdown-footer">
                  {filteredSecurities.length} of {securities.length} ISINs
                </div>
              </div>
            )}
          </div>

          {/* AUTO FILLED */}
          <div className="split-field">
            <label>Security Code</label>
            <input value={securityCode} disabled />
          </div>

          <div className="split-field">
            <label>Security Name</label>
            <input value={securityName} disabled />
          </div>

          {/* RATIOS */}
          <div className="split-field">
            <label>
              Ratio <span className="ratio-hint">(For every)</span>
            </label>
            <input
              type="number"
              value={ratio1}
              onChange={(e) => setRatio1(e.target.value)}
            />
          </div>

          <div className="split-field">
            <label>
              Ratio <span className="ratio-hint">(Investor gets)</span>
            </label>
            <input
              type="number"
              value={ratio2}
              onChange={(e) => setRatio2(e.target.value)}
            />
          </div>

          {/* DATE */}
          <div className="split-field">
            <label>Effective Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>

          {/* ACTION - same as Bonus: single "Fetch Affected Accounts" button */}
          <button
            className="bonus-submit"
            disabled={
              !isin ||
              !ratio1 ||
              !ratio2 ||
              !date ||
              Number(ratio1) <= 0 ||
              Number(ratio2) <= 0 ||
              previewLoading
            }
            onClick={handlePreview}
          >
            {previewLoading ? "Fetching…" : "Fetch Affected Accounts"}
          </button>
        </div>
      </Card>
      {showPreview && (
        <div className="bonus-preview-wrapper full-width">
          <h3>Split Impact Preview</h3>

          {previewData.length === 0 ? (
            <div className="alert info">No eligible holdings found before split date.</div>
          ) : (
            <>
              <div className="bonus-preview-table-wrapper">
                <table className="bonus-preview-table">
                  <thead>
                    <tr>
                      <th>Actual Code</th>
                      <th>Current Holding</th>
                      <th>New Holding</th>
                      <th>Δ Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedGroups.map((group) => {
                      const isOpen = expandedKeys.has(group.key);
                      return (
                        <React.Fragment key={group.key}>
                          <tr
                            className="split-group-row"
                            role="button"
                            tabIndex={0}
                            onClick={() => toggleGroup(group.key)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                toggleGroup(group.key);
                              }
                            }}
                          >
                            <td>
                              <span className="split-expand-toggle">
                                {isOpen ? "▾" : "▸"}
                              </span>
                              {group.actualCode || "—"} ({group.children.length})
                            </td>
                            <td>{group.currentHolding}</td>
                            <td>{group.newHolding}</td>
                            <td className="delta-cell">
                              {group.delta > 0 ? `+${group.delta}` : group.delta}
                            </td>
                          </tr>

                          {isOpen &&
                            group.children.map((row, cIdx) => (
                              <tr
                                key={`${group.key}-${row.accountCode}-${cIdx}`}
                                className="split-detail-row"
                              >
                                <td className="split-detail-code">
                                  {row.accountCode}
                                </td>
                                <td>
                                  {Math.floor(Number(row.currentHolding) || 0)}
                                </td>
                                <td>
                                  {Math.floor(Number(row.newHolding) || 0)}
                                </td>
                                <td className="delta-cell">
                                  {row.delta > 0 ? `+${row.delta}` : row.delta}
                                </td>
                              </tr>
                            ))}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <div className="pagination">
                  <button
                    disabled={page === 1}
                    onClick={() => setPage(page - 1)}
                  >
                    Prev
                  </button>
                  <span>Page {page} of {totalPages}</span>
                  <button
                    disabled={page === totalPages}
                    onClick={() => setPage(page + 1)}
                  >
                    Next
                  </button>
                </div>
              )}

              <div className="bonus-preview-actions">
                <button
                  className="bonus-submit"
                  disabled={exportLoading}
                  onClick={async () => {
                    try {
                      setExportLoading(true);
                      setExportDownloadUrl("");
                      const params = new URLSearchParams({
                        isin,
                        ratio1,
                        ratio2,
                        issueDate: date,
                      });
                      const res = await fetch(
                        `${BASE_URL}/split/export-preview?${params.toString()}`,
                        { credentials: "include" }
                      );
                      if (!res.ok) throw new Error("Export request failed");
                      const data = await res.json();
                      if (!data.success) throw new Error(data.message || "Export failed");
                      const signedUrl =
                        data.downloadUrl?.signature?.signature ?? data.downloadUrl?.signature;
                      if (!signedUrl) throw new Error("Download URL missing");
                      setExportDownloadUrl(signedUrl);
                    } catch (err) {
                      console.error(err);
                      alert("Failed to export split preview CSV");
                    } finally {
                      setExportLoading(false);
                    }
                  }}
                >
                  {exportLoading ? "Generating…" : "Export"}
                </button>
                <button
                  className="bonus-submit"
                  disabled={!exportDownloadUrl}
                  onClick={() => {
                    if (exportDownloadUrl) window.open(exportDownloadUrl, "_blank");
                  }}
                >
                  Download
                </button>
                <button
                  className="bonus-submit"
                  disabled={loading}
                  onClick={handleSubmit}
                >
                  {loading ? "Applying…" : "Confirm & Apply Split"}
                </button>
              </div>
            </>
          )}
        </div>
      )}

    </MainLayout>

  );
}

export default SplitPage;
