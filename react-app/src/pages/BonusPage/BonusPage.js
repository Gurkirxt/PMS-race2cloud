import React, { useState, useEffect, useRef, useMemo } from "react";
import MainLayout from "../../layouts/MainLayout";
import { Card } from "../../components/common/CommonComponents";
import "./BonusPage.css";
import { BASE_URL } from "../../constant";

function BonusPage() {
  /* ===========================
     FORM STATE
     =========================== */
  const [isin, setIsin] = useState("");
  const [securityCode, setSecurityCode] = useState("");
  const [securityName, setSecurityName] = useState("");
  const [ratio1, setRatio1] = useState("");
  const [ratio2, setRatio2] = useState("");
  const [date, setDate] = useState("");

  const [securities, setSecurities] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [applying, setApplying] = useState(false);
  const [applySuccess, setApplySuccess] = useState(false);
  const [success, setSuccess] = useState(false);
  const [applyJobName, setApplyJobName] = useState(null);
  const [applyStatus, setApplyStatus] = useState(null);

  const [previewData, setPreviewData] = useState([]);
  const [step, setStep] = useState("form");
  /** Actual codes whose virtual-scheme rows are expanded in the preview table. */
  const [expandedActuals, setExpandedActuals] = useState(() => new Set());

  const [exportDownloadUrl, setExportDownloadUrl] = useState("");
  const [exportLoading, setExportLoading] = useState(false);

  /* ===========================
     GROUP BY ACTUAL CODE + PAGINATION
     =========================== */
  const PAGE_SIZE = 10;
  const [page, setPage] = useState(1);

  const previewGroups = useMemo(() => {
    const map = new Map();
    for (const row of previewData) {
      const actualKey = String(row.actualCode ?? "").trim() || "—";
      let group = map.get(actualKey);
      if (!group) {
        group = {
          actualCode: actualKey,
          isin: row.isin || "",
          virtuals: [],
          currentHolding: 0,
          bonusShares: 0,
          newHolding: 0,
          delta: 0,
        };
        map.set(actualKey, group);
      }
      group.virtuals.push(row);
      group.currentHolding += Number(row.currentHolding) || 0;
      group.bonusShares += Number(row.bonusShares) || 0;
      group.newHolding += Number(row.newHolding) || 0;
      group.delta += Number(row.delta) || 0;
      if (!group.isin && row.isin) group.isin = row.isin;
    }
    return [...map.values()];
  }, [previewData]);

  useEffect(() => {
    setPage(1);
    setExpandedActuals(new Set());
  }, [previewData]);

  const totalPages = Math.ceil(previewGroups.length / PAGE_SIZE) || 1;
  const paginatedGroups = previewGroups.slice(
    (page - 1) * PAGE_SIZE,
    page * PAGE_SIZE,
  );

  const toggleActualExpand = (actualCode) => {
    setExpandedActuals((prev) => {
      const next = new Set(prev);
      if (next.has(actualCode)) next.delete(actualCode);
      else next.add(actualCode);
      return next;
    });
  };

  const dropdownRef = useRef(null);

  /* ===========================
     FETCH SECURITIES
     =========================== */
     useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          const res = await fetch(`${BASE_URL}/bonus/getAllSecuritiesList`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          if (!cancelled && data.success) setSecurities(data.data);
        } catch (err) {
          if (!cancelled) setError(err.message || "Failed to load securities");
          setSecurities([]);
        }
      })();
      return () => { cancelled = true; };
    }, []);

  /* ===========================
     DROPDOWN CLOSE
     =========================== */
  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  /* ===========================
     POLL BONUS APPLY JOB STATUS
     =========================== */
  useEffect(() => {
    if (!applyJobName || !applying) return;

    const terminalStatuses = ["COMPLETED", "FAILED", "ERROR"];
    if (terminalStatuses.includes(applyStatus)) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(
          `${BASE_URL}/bonus/apply-status?jobName=${encodeURIComponent(applyJobName)}`,
          { credentials: "include" }
        );
        const data = await res.json();

        if (!data.success) return;

        setApplyStatus(data.status);

        if (data.status === "COMPLETED") {
          clearInterval(interval);
          setApplySuccess(true);

          setTimeout(() => {
            setIsin("");
            setSearchQuery("");
            setSecurityCode("");
            setSecurityName("");
            setRatio1("");
            setRatio2("");
            setDate("");
            setPreviewData([]);
            setStep("form");
            setExportDownloadUrl("");
            setApplying(false);
            setApplySuccess(false);
            setApplyJobName(null);
            setApplyStatus(null);
            setSuccess(true);
          }, 800);
        } else if (data.status === "FAILED" || data.status === "ERROR") {
          clearInterval(interval);
          setError("Bonus application failed. Please try again.");
          setApplying(false);
          setApplyJobName(null);
          setApplyStatus(null);
        }
      } catch {
        // ignore polling errors
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [applyJobName, applying, applyStatus]);

  const q = searchQuery.toLowerCase();
  const filteredSecurities = securities.filter(
    (s) =>
      String(s?.isin ?? "").toLowerCase().includes(q) ||
      String(s?.securityCode ?? "").toLowerCase().includes(q) ||
      String(s?.securityName ?? "").toLowerCase().includes(q),
  );

  const handleSelectISIN = (sec) => {
    setIsin(sec.isin);
    setSearchQuery(sec.isin);
    setSecurityCode(sec.securityCode);
    setSecurityName(sec.securityName);
    setShowDropdown(false);
  };

  /* ===========================
     PREVIEW BONUS (FIFO)
     =========================== */
  const fetchPreview = async () => {
    setLoading(true);
    setError(null);

    const res = await fetch(`${BASE_URL}/bonus/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        isin,
        ratio1: Number(ratio1),
        ratio2: Number(ratio2),
        exDate: date, // ✅ REQUIRED FOR FIFO
      }),
    });

    const data = await res.json();

    if (data.success) {
      setPreviewData(data.data || []);
      setStep("preview");
    } else {
      setError(data.message);
    }

    setLoading(false);
  };
  const downloadBonusExport = () => {
    if (!isin || !ratio1 || !ratio2 || !date) return;

    const url =
      `${BASE_URL}/export/bonus-preview` +
      `?isin=${encodeURIComponent(isin)}` +
      `&ratio1=${encodeURIComponent(ratio1)}` +
      `&ratio2=${encodeURIComponent(ratio2)}` +
      `&exDate=${encodeURIComponent(date)}`;

    window.open(url, "_blank");
  };

  return (
    <MainLayout title="Stock Bonus">
      <Card style={{ marginTop: 4 }}>

        {success && (
          <div className="alert success">Bonus applied successfully</div>
        )}
        {error && <div className="alert error">{error}</div>}

        <div className="bonus-card">
          {/* ISIN SEARCH */}
          <div className="account-code-search" ref={dropdownRef}>
            <label className="search-label">ISIN</label>
            <div className="search-input-wrapper">
              <span className="search-icon">🔍</span>
              <input
                className="search-input"
                placeholder="Search ISIN..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setShowDropdown(true);
                }}
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

          <div className="bonus-field">
            <label>Security Code</label>
            <input value={securityCode} disabled />
          </div>

          <div className="bonus-field">
            <label>Security Name</label>
            <input value={securityName} disabled />
          </div>

          <div className="bonus-field">
            <label>
              Ratio <span className="ratio-hint">(For every held)</span>
            </label>
            <input
              type="number"
              value={ratio2}
              onChange={(e) => setRatio2(e.target.value)}
            />
          </div>

          <div className="bonus-field">
            <label>
              Ratio <span className="ratio-hint">(Bonus shares)</span>
            </label>
            <input
              type="number"
              value={ratio1}
              onChange={(e) => setRatio1(e.target.value)}
            />
          </div>

          <div className="bonus-field">
            <label>Effective Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>

          <button
            className="bonus-submit"
            disabled={!isin || ratio1 <= 0 || !ratio2 || !date || loading}
            onClick={fetchPreview}
          >
            Fetch Affected Accounts
          </button>
        </div>
      </Card>

      {/* ===========================
         PREVIEW
         =========================== */}
      {step === "preview" && (
        <div className="bonus-preview-wrapper full-width">
          <h3>Bonus Impact Preview</h3>

          {previewData.length === 0 ? (
            <div className="alert info">No accounts affected</div>
          ) : (
            <>
              <div className="bonus-preview-table-wrapper">
                <table className="bonus-preview-table">
                  <thead>
                    <tr>
                      <th>Actual Code</th>
                      <th>ISIN</th>
                      <th>Current Holding</th>
                      <th>Bonus Shares</th>
                      <th>New Holding</th>
                      <th>Δ Change</th>
                    </tr>
                  </thead>

                  <tbody>
                    {paginatedGroups.map((group) => {
                      const expanded = expandedActuals.has(group.actualCode);
                      return (
                        <React.Fragment key={group.actualCode}>
                          <tr
                            className="bonus-preview-parent-row"
                            onClick={() =>
                              toggleActualExpand(group.actualCode)
                            }
                          >
                            <td>
                              <button
                                type="button"
                                className="bonus-actual-toggle"
                                aria-expanded={expanded}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleActualExpand(group.actualCode);
                                }}
                              >
                                <span
                                  className="bonus-actual-chevron"
                                  aria-hidden
                                >
                                  {expanded ? "▾" : "▸"}
                                </span>
                                {group.actualCode}
                                <span className="bonus-virtual-count">
                                  {group.virtuals.length} virtual
                                  {group.virtuals.length === 1 ? "" : "s"}
                                </span>
                              </button>
                            </td>
                            <td>{group.isin}</td>
                            <td>
                              {Math.floor(Number(group.currentHolding) || 0)}
                            </td>
                            <td>{Math.floor(Number(group.bonusShares) || 0)}</td>
                            <td>
                              {Math.floor(Number(group.newHolding) || 0)}
                            </td>
                            <td className="bonus-delta-cell">
                              +{Math.floor(Number(group.delta) || 0)}
                            </td>
                          </tr>

                          {expanded &&
                            group.virtuals.map((row) => (
                              <tr
                                key={`${group.actualCode}-${row.accountCode}`}
                                className="bonus-preview-child-row"
                              >
                                <td className="bonus-virtual-cell">
                                  <span className="bonus-virtual-label">
                                    Virtual
                                  </span>
                                  {row.accountCode}
                                </td>
                                <td>{row.isin}</td>
                                <td>
                                  {Math.floor(Number(row.currentHolding) || 0)}
                                </td>
                                <td>{row.bonusShares}</td>
                                <td>
                                  {Math.floor(Number(row.newHolding) || 0)}
                                </td>
                                <td className="bonus-delta-cell">
                                  +{row.delta}
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
                  <span>
                    Page {page} of {totalPages}
                  </span>
                  <button
                    disabled={page === totalPages}
                    onClick={() => setPage(page + 1)}
                  >
                    Next
                  </button>
                </div>
              )}

              <div className="bonus-preview-actions">
                {/* EXPORT - generates report */}
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
                        exDate: date,
                      });

                      const res = await fetch(
                        `${BASE_URL}/bonus/export-preview?${params.toString()}`,
                        { credentials: "include" }
                      );

                      if (!res.ok) throw new Error("Export request failed");

                      const data = await res.json();

                      if (!data.success) {
                        throw new Error(data.message || "Export failed");
                      }

                      const signedUrl =
                        data.downloadUrl?.signature?.signature ??
                        data.downloadUrl?.signature;

                      if (!signedUrl) {
                        throw new Error("Download URL missing");
                      }

                      setExportDownloadUrl(signedUrl);
                    } catch (err) {
                      console.error(err);
                      alert("Failed to export bonus preview CSV");
                    } finally {
                      setExportLoading(false);
                    }
                  }}
                >
                  {exportLoading ? "Generating..." : "Export"}
                </button>

                {/* DOWNLOAD - opens generated report */}
                <button
                  className="bonus-submit"
                  disabled={!exportDownloadUrl}
                  onClick={() => {
                    if (exportDownloadUrl) {
                      window.open(exportDownloadUrl, "_blank");
                    }
                  }}
                >
                  Download
                </button>

                {/* APPLY BONUS */}
                <button
                  className="bonus-submit"
                  disabled={applying}
                  onClick={async () => {
                    setApplying(true);
                    setError(null);
                    setApplyStatus("SUBMITTING");

                    try {
                      const res = await fetch(`${BASE_URL}/bonus/apply`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          isin,
                          ratio1: Number(ratio1),
                          ratio2: Number(ratio2),
                          exDate: date,
                          securityCode,
                          securityName,
                        }),
                      });

                      const data = await res.json();

                      if (!data.success) {
                        setError(data.message || "Failed to apply bonus");
                        setApplying(false);
                        setApplyStatus(null);
                        return;
                      }

                      setApplyJobName(data.jobName);
                      setApplyStatus(data.status);
                    } catch (err) {
                      setError("Something went wrong");
                      setApplying(false);
                      setApplyStatus(null);
                    }
                  }}
                >
                  {applying
                    ? applyStatus === "COMPLETED"
                      ? "Bonus Applied!"
                      : "Applying Bonus..."
                    : "Confirm & Apply Bonus"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </MainLayout>
  );
}

export default BonusPage;
