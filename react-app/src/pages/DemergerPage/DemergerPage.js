import React, { useCallback, useEffect, useRef, useState } from "react";
import MainLayout from "../../layouts/MainLayout";
import { Card } from "../../components/common/CommonComponents";
import "../SplitPage/SplitPage.css";
import "../BonusPage/BonusPage.css";
import "./DemergerPage.css";
import { BASE_URL } from "../../constant";

function escapeCsvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function DemergerPage() {
  const [effectiveDate, setEffectiveDate] = useState("");
  const [recordDate, setRecordDate] = useState("");
  const [ratio1, setRatio1] = useState("");
  const [ratio2, setRatio2] = useState("");

  const [oldIsin, setOldIsin] = useState("");
  const [oldSecurityCode, setOldSecurityCode] = useState("");
  const [oldSecurityName, setOldSecurityName] = useState("");

  const [newIsin, setNewIsin] = useState("");
  const [newSecurityCode, setNewSecurityCode] = useState("");
  const [newSecurityName, setNewSecurityName] = useState("");

  const [costSplitPercent, setCostSplitPercent] = useState("");

  const [securities, setSecurities] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);

  const [loadError, setLoadError] = useState(null);
  const [formError, setFormError] = useState(null);

  const [previewData, setPreviewData] = useState([]);
  const [previewSummary, setPreviewSummary] = useState({ accounts: 0, lots: 0 });
  const [previewLoading, setPreviewLoading] = useState(false);
  const [step, setStep] = useState("form");

  const [applying, setApplying] = useState(false);
  const [applySuccess, setApplySuccess] = useState(false);
  const [applyStatus, setApplyStatus] = useState("");

  const PAGE_SIZE = 10;
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [previewData]);
  const totalPages = Math.max(1, Math.ceil(previewData.length / PAGE_SIZE));
  const paginatedPreview = previewData.slice(
    (page - 1) * PAGE_SIZE,
    page * PAGE_SIZE,
  );

  const dropdownRef = useRef(null);
  const applyPollRef = useRef(null);

  const stopApplyPoll = useCallback(() => {
    if (applyPollRef.current) {
      clearInterval(applyPollRef.current);
      applyPollRef.current = null;
    }
  }, []);

  const resetFormAfterApply = useCallback(() => {
    setOldIsin("");
    setOldSecurityCode("");
    setOldSecurityName("");
    setSearchQuery("");
    setNewIsin("");
    setNewSecurityCode("");
    setNewSecurityName("");
    setRatio1("");
    setRatio2("");
    setEffectiveDate("");
    setRecordDate("");
    setCostSplitPercent("");
    setPreviewData([]);
    setPreviewSummary({ accounts: 0, lots: 0 });
    setStep("form");
    setApplySuccess(false);
    setApplyStatus("");
  }, []);

  /**
   * Poll /demerger/apply-status until COMPLETED / FAILED / ERROR.
   */
  const startApplyPoll = useCallback(
    (jobName) => {
      stopApplyPoll();
      const POLL_INTERVAL_MS = 3000;
      const MAX_POLL_ATTEMPTS = 200;
      let attempts = 0;

      const tick = async () => {
        attempts += 1;
        try {
          const url = `${BASE_URL}/demerger/apply-status?jobName=${encodeURIComponent(jobName)}`;
          const res = await fetch(url);
          const data = await res.json().catch(() => ({}));
          if (!data?.success) {
            setFormError(data?.message || `Status check failed (HTTP ${res.status})`);
            stopApplyPoll();
            setApplying(false);
            return;
          }
          const status = String(data.status || "").toUpperCase();
          setApplyStatus(status);

          if (status === "COMPLETED") {
            stopApplyPoll();
            setApplying(false);
            setApplySuccess(true);
            setTimeout(() => {
              resetFormAfterApply();
            }, 2500);
            return;
          }
          if (status === "FAILED" || status === "ERROR") {
            stopApplyPoll();
            setApplying(false);
            setFormError(
              status === "FAILED"
                ? "Demerger application failed. Check DemergerFn logs in Catalyst."
                : "Demerger job is stale or errored. Try again.",
            );
            return;
          }
          if (attempts >= MAX_POLL_ATTEMPTS) {
            stopApplyPoll();
            setApplying(false);
            setFormError(
              "Demerger is taking longer than expected. Check Catalyst job logs or refresh.",
            );
          }
        } catch (e) {
          stopApplyPoll();
          setApplying(false);
          setFormError(e.message || "Status check error");
        }
      };

      tick();
      applyPollRef.current = setInterval(tick, POLL_INTERVAL_MS);
    },
    [stopApplyPoll, resetFormAfterApply],
  );

  useEffect(() => () => stopApplyPoll(), [stopApplyPoll]);

  const clearStatus = useCallback(() => {
    setFormError(null);
    setApplySuccess(false);
    setApplyStatus("");
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${BASE_URL}/split/getAllSecuritiesList`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled && data.success && Array.isArray(data.data)) {
          setSecurities(data.data);
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err.message || "Could not load securities list");
          setSecurities([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const q = searchQuery.toLowerCase();
  const filteredSecurities = securities.filter(
    (s) =>
      String(s?.isin ?? "").toLowerCase().includes(q) ||
      String(s?.securityCode ?? "").toLowerCase().includes(q) ||
      String(s?.securityName ?? "").toLowerCase().includes(q),
  );

  const handleSelectOldISIN = (sec) => {
    setOldIsin(sec.isin);
    setSearchQuery(sec.isin);
    setOldSecurityCode(sec.securityCode);
    setOldSecurityName(sec.securityName);
    setShowDropdown(false);
    clearStatus();
  };

  const remainderHint =
    costSplitPercent === "" || Number.isNaN(Number(costSplitPercent))
      ? null
      : Math.round((100 - Number(costSplitPercent)) * 100) / 100;

  const isFormValid = () => {
    const r1 = Number(ratio1);
    const r2 = Number(ratio2);
    const pct = Number(costSplitPercent);
    return (
      effectiveDate &&
      recordDate &&
      oldIsin &&
      newIsin &&
      newSecurityCode &&
      newSecurityName &&
      oldIsin !== newIsin &&
      Number.isFinite(r1) && r1 > 0 &&
      Number.isFinite(r2) && r2 > 0 &&
      Number.isFinite(pct) && pct >= 0 && pct <= 100
    );
  };

  const fetchPreview = async () => {
    clearStatus();

    if (!isFormValid()) {
      setFormError("Please fill all fields correctly before preview.");
      return;
    }

    setPreviewLoading(true);
    setFormError(null);

    try {
      const res = await fetch(`${BASE_URL}/demerger/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          oldIsin,
          newIsin,
          ratio1: Number(ratio1),
          ratio2: Number(ratio2),
          effectiveDate,
          recordDate,
          allocationToNewPercent: Number(costSplitPercent),
        }),
      });

      const data = await res.json();

      if (data.success) {
        setPreviewData(data.data || []);
        setPreviewSummary(
          data.summary && typeof data.summary === "object"
            ? {
                accounts: Number(data.summary.accounts) || 0,
                lots: Number(data.summary.lots) || 0,
              }
            : { accounts: 0, lots: (data.data || []).length },
        );
        setStep("preview");
      } else {
        setFormError(data.message || "Preview failed");
      }
    } catch (err) {
      setFormError(err.message || "Network error");
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleApply = async () => {
    clearStatus();
    if (!previewData.length) {
      setFormError("Fetch preview first.");
      return;
    }

    setApplying(true);
    setApplyStatus("PENDING");

    try {
      const res = await fetch(`${BASE_URL}/demerger/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          oldIsin,
          oldSecurityCode,
          oldSecurityName,
          newIsin,
          newSecurityCode,
          newSecurityName,
          ratio1: Number(ratio1),
          ratio2: Number(ratio2),
          effectiveDate,
          recordDate,
          allocationToNewPercent: Number(costSplitPercent),
        }),
      });

      const data = await res.json();

      if (!data.success) {
        setFormError(data.message || "Apply failed");
        setApplying(false);
        setApplyStatus("");
        return;
      }

      const jn = data.jobName;
      if (!jn) {
        setFormError("Apply queued but no jobName returned.");
        setApplying(false);
        setApplyStatus("");
        return;
      }

      startApplyPoll(jn);
    } catch (err) {
      setFormError(err.message || "Network error");
      setApplying(false);
      setApplyStatus("");
    }
  };

  const handleExportDemergerCsv = useCallback(() => {
    if (!previewData.length) return;
    const headers = [
      "Account Code",
      "Old ISIN",
      "Source Buy Date",
      "Old Qty",
      "Old WAP (Before)",
      "Old WAP (After)",
      "New ISIN",
      "New Qty",
      "New WAP",
    ];
    const lines = [headers.map(escapeCsvCell).join(",")];
    for (const row of previewData) {
      lines.push(
        [
          row.accountCode,
          row.oldIsin,
          row.sourceLotDate,
          row.oldQty,
          row.oldWapBefore,
          row.oldWapAfter,
          row.newIsin,
          row.newQty,
          row.newWap,
        ]
          .map(escapeCsvCell)
          .join(","),
      );
    }
    const csv = lines.join("\r\n");
    const safeDate = (recordDate || "nodate").replace(/[^\d-]/g, "") || "nodate";
    const safeNewIsin = (newIsin || "demerger").replace(/[^A-Za-z0-9_-]/g, "") || "demerger";
    const filename = `demerger-preview_${safeDate}_${safeNewIsin}.csv`;
    const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [previewData, recordDate, newIsin]);

  return (
    <MainLayout title="Demerger">
      <Card style={{ marginTop: 4 }}>
        <div className="demerger-page">
          {loadError && (
            <div className="alert error" style={{ marginBottom: 12 }}>
              {loadError} (dropdown may be empty until the list loads.)
            </div>
          )}
          {formError && <div className="alert error">{formError}</div>}
          {applySuccess && (
            <div className="alert success">
              Demerger applied successfully. Holdings table has been rebuilt for affected
              accounts.
            </div>
          )}
          {applying && applyStatus && !applySuccess && (
            <div className="alert info">
              Background job status: <strong>{applyStatus}</strong>
              {" — "}DemergerFn is writing Demerger_Record and rebuilding Holdings.
            </div>
          )}

          <div className="split-card">
            {/* Old company — searchable dropdown */}
            <div className="demerger-section">
              <h3 className="demerger-section-title">Old Company (existing)</h3>
              <div className="account-code-search" ref={dropdownRef}>
                <label className="search-label">Search ISIN / Name</label>
                <div className="search-input-wrapper">
                  <span className="search-icon">&#128269;</span>
                  <input
                    className="search-input"
                    placeholder="Search old company..."
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setShowDropdown(true);
                      clearStatus();
                    }}
                  />
                  {searchQuery && (
                    <span
                      className="clear-icon"
                      onClick={() => {
                        setSearchQuery("");
                        setOldIsin("");
                        setOldSecurityCode("");
                        setOldSecurityName("");
                      }}
                    >
                      &#10005;
                    </span>
                  )}
                </div>

                {showDropdown && filteredSecurities.length > 0 && (
                  <div className="search-dropdown">
                    <div className="dropdown-header">Select Old Company</div>
                    <div className="dropdown-options">
                      {filteredSecurities.map((sec, idx) => (
                        <div
                          key={`${sec.isin || "no-isin"}-${idx}`}
                          className="dropdown-option"
                          onClick={() => handleSelectOldISIN(sec)}
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

              <div className="demerger-readonly-fields">
                <div className="bonus-field">
                  <label>Security Code</label>
                  <input value={oldSecurityCode} disabled />
                </div>
                <div className="bonus-field">
                  <label>Security Name</label>
                  <input value={oldSecurityName} disabled />
                </div>
              </div>
            </div>

            {/* New company — manual text inputs */}
            <div className="demerger-section">
              <h3 className="demerger-section-title">New Company (demerged)</h3>
              <div className="demerger-new-company-fields">
                <div className="bonus-field">
                  <label>New ISIN</label>
                  <input
                    placeholder="e.g. INE999X01010"
                    value={newIsin}
                    onChange={(e) => {
                      clearStatus();
                      setNewIsin(e.target.value.trim());
                    }}
                  />
                </div>
                <div className="bonus-field">
                  <label>New Security Code</label>
                  <input
                    placeholder="e.g. XYZ"
                    value={newSecurityCode}
                    onChange={(e) => {
                      clearStatus();
                      setNewSecurityCode(e.target.value);
                    }}
                  />
                </div>
                <div className="bonus-field">
                  <label>New Security Name</label>
                  <input
                    placeholder="e.g. XYZ Ltd"
                    value={newSecurityName}
                    onChange={(e) => {
                      clearStatus();
                      setNewSecurityName(e.target.value);
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Ratios, date, cost % */}
            <div className="demerger-section">
              <h3 className="demerger-section-title">Demerger Details</h3>
              <div className="demerger-details-grid">
                <div className="bonus-field">
                  <label>Ratio 1</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    placeholder="e.g. 1"
                    value={ratio1}
                    onChange={(e) => {
                      clearStatus();
                      setRatio1(e.target.value);
                    }}
                  />
                </div>
                <div className="bonus-field">
                  <label>Ratio 2</label>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    placeholder="e.g. 1"
                    value={ratio2}
                    onChange={(e) => {
                      clearStatus();
                      setRatio2(e.target.value);
                    }}
                  />
                </div>
                <div className="bonus-field">
                  <label>Effective Date</label>
                  <input
                    type="date"
                    value={effectiveDate}
                    onChange={(e) => {
                      clearStatus();
                      setEffectiveDate(e.target.value);
                    }}
                  />
                </div>
                <div className="bonus-field">
                  <label>Record Date</label>
                  <input
                    type="date"
                    value={recordDate}
                    onChange={(e) => {
                      clearStatus();
                      setRecordDate(e.target.value);
                    }}
                  />
                  <p className="demerger-cost-hint ok">
                    Holdings calculated up to one day before this date
                  </p>
                </div>
                <div className="bonus-field">
                  <label>Allocation to new company (%)</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    placeholder="0 – 100"
                    value={costSplitPercent}
                    onChange={(e) => {
                      clearStatus();
                      setCostSplitPercent(e.target.value);
                    }}
                  />
                  {remainderHint !== null && (
                    <p
                      className={`demerger-cost-hint ${
                        remainderHint < 0 || remainderHint > 100 ? "warn" : "ok"
                      }`}
                    >
                      Remainder to old company:{" "}
                      <strong>
                        {Number.isFinite(remainderHint)
                          ? `${remainderHint}%`
                          : "—"}
                      </strong>
                    </p>
                  )}
                </div>
              </div>
            </div>

            <button
              className="bonus-submit"
              disabled={!isFormValid() || previewLoading}
              onClick={fetchPreview}
            >
              {previewLoading ? "Loading..." : "Fetch Affected Accounts"}
            </button>
          </div>
        </div>
      </Card>

      {/* Preview table */}
      {step === "preview" && (
        <div className="bonus-preview-wrapper full-width">
          {previewData.length === 0 ? (
            <>
              <h3>Demerger Impact Preview</h3>
              <div className="alert info">No accounts affected</div>
            </>
          ) : (
            <>
              <div className="demerger-preview-header-row">
                <h3>Demerger Impact Preview (lot-level)</h3>
                <div className="bonus-preview-actions">
                  <button
                    type="button"
                    className="bonus-submit"
                    onClick={handleExportDemergerCsv}
                  >
                    Export CSV
                  </button>
                </div>
              </div>

              <div
                className="alert info"
                style={{ marginBottom: 8, fontSize: 13 }}
              >
                <strong>{previewSummary.accounts}</strong> account
                {previewSummary.accounts === 1 ? "" : "s"} affected ·{" "}
                <strong>{previewSummary.lots}</strong> surviving lot
                {previewSummary.lots === 1 ? "" : "s"} — queued apply writes lot-level rows to{" "}
                <code>Demerger_Record</code> and refreshes <code>Holdings</code> via DemergerFn.
              </div>

              <div className="bonus-preview-table-wrapper">
                <table className="bonus-preview-table">
                  <thead>
                    <tr>
                      <th>Account Code</th>
                      <th>Old ISIN</th>
                      <th>Source Buy Date</th>
                      <th>Old Qty</th>
                      <th>Old WAP (Before)</th>
                      <th>Old WAP (After)</th>
                      <th>New ISIN</th>
                      <th>New Qty</th>
                      <th>New WAP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedPreview.map((row, idx) => (
                      <tr
                        key={`${row.accountCode}-${row.sourceLotRowId || idx}`}
                      >
                        <td>{row.accountCode}</td>
                        <td>{row.oldIsin}</td>
                        <td>{row.sourceLotDate}</td>
                        <td>{row.oldQty}</td>
                        <td>{row.oldWapBefore}</td>
                        <td>{row.oldWapAfter}</td>
                        <td>{row.newIsin}</td>
                        <td>{row.newQty}</td>
                        <td>{row.newWap}</td>
                      </tr>
                    ))}
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
                <button
                  className="bonus-submit"
                  disabled={applying}
                  onClick={handleApply}
                >
                  {applying ? "Applying (background job)…" : "Confirm & Apply Demerger"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </MainLayout>
  );
}

export default DemergerPage;
