import React, { useState, useEffect, useRef } from "react";
import MainLayout from "../../layouts/MainLayout";
import { Card } from "../../components/common/CommonComponents";
import "./DividendPage.css";
import { BASE_URL } from "../../constant";

/**
 * Friendly labels for the per-row reconciliation status produced by
 * /api/dividend/preview when a custodian file is uploaded. Keys here must
 * match the `status` strings emitted by the backend's computeStatus().
 */
const STATUS_LABEL = {
  ready: "Matched",
  mismatch: "Mismatch",
  partial: "Partial",
  overpaid: "Over-paid",
  already_paid: "Already paid",
  missing_in_system: "Missing in system",
  missing_in_file: "Missing in file",
};

function DividendPage() {
  const [symbol, setSymbol] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [isin, setIsin] = useState("");
  const [dividendType, setDividendType] = useState("Interim");
  const [rate, setRate] = useState("");
  const [unit, setUnit] = useState("Per Share");
  const [exDate, setExDate] = useState("");
  const [recordDate, setRecordDate] = useState("");
  const [paymentDate, setPaymentDate] = useState("");

  const [securities, setSecurities] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [dividendList, setDividendList] = useState([]);

  /*
   * previewData / setPreviewData kept (the /preview response still returns
   * a `data` array for backward compatibility) but is no longer rendered —
   * the reconciliation grid is the only preview now.
   */
  const [previewData, setPreviewData] = useState([]);
  const [previewEmptyMessage, setPreviewEmptyMessage] = useState("");
  const PAGE_SIZE = 10;
  const [page, setPage] = useState(1);

  /* ===========================
     CUSTODIAN-FILE RECONCILIATION STATE
     - reconEvents : array of events from /preview when a file is uploaded
     - reconSummary: counts + totals across all events
     - statusFilter: which status bucket the user is filtering on
     - activeEvent : index of selected event tab (for multi-rate dividends)
     - warnings    : soft warnings returned by the backend
     =========================== */
  const [reconEvents, setReconEvents] = useState(null);
  const [reconSummary, setReconSummary] = useState(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [activeEvent, setActiveEvent] = useState(0);
  const [warnings, setWarnings] = useState([]);

  const [exportDownloadUrl, setExportDownloadUrl] = useState("");
  const [exportLoading, setExportLoading] = useState(false);

  const [applyJobName, setApplyJobName] = useState(null);
  const [applyStatus, setApplyStatus] = useState(null);

  const [custodianFile, setCustodianFile] = useState(null);
  const custodianInputRef = useRef(null);

  const dropdownRef = useRef(null);

  useEffect(() => setPage(1), [reconEvents, statusFilter, activeEvent]);

  /* Currently selected event's reconciled rows (filtered by status chip). */
  const activeEventObj =
    reconEvents && reconEvents.length > 0
      ? reconEvents[Math.min(activeEvent, reconEvents.length - 1)]
      : null;
  const filteredReconRows = (() => {
    if (!activeEventObj) return [];
    if (statusFilter === "all") return activeEventObj.rows;
    return activeEventObj.rows.filter((r) => r.status === statusFilter);
  })();
  const reconTotalPages = Math.max(
    1,
    Math.ceil(filteredReconRows.length / PAGE_SIZE),
  );
  const paginatedReconRows = filteredReconRows.slice(
    (page - 1) * PAGE_SIZE,
    page * PAGE_SIZE,
  );

  useEffect(() => {
    fetchAllSecurities();
  }, []);

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
     POLL DIVIDEND APPLY JOB STATUS
     =========================== */
  useEffect(() => {
    if (!applyJobName || !loading) return;

    const terminalStatuses = ["COMPLETED", "FAILED", "ERROR"];
    if (terminalStatuses.includes(applyStatus)) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(
          `${BASE_URL}/dividend/apply-status?jobName=${encodeURIComponent(applyJobName)}`,
          { credentials: "include" },
        );
        const data = await res.json();
        if (!data.success) return;

        setApplyStatus(data.status);

        if (data.status === "COMPLETED") {
          clearInterval(interval);

          const entry = {
            securityCode: symbol,
            securityName: companyName,
            isin,
            dividendType,
            rate: rate || "-",
            unit,
            exDate,
            recordDate: recordDate || "-",
            paymentDate: paymentDate || "-",
          };
          setDividendList((prev) => [entry, ...prev]);
          setSuccess(true);

          setTimeout(() => {
            setSuccess(false);
            setExportDownloadUrl("");
            setPreviewData([]);
            setPreviewEmptyMessage("");
            setReconEvents(null);
            setReconSummary(null);
            setWarnings([]);
            setStatusFilter("all");
            setActiveEvent(0);
            setCustodianFile(null);
            setSymbol("");
            setSearchQuery("");
            setCompanyName("");
            setIsin("");
            setRate("");
            setExDate("");
            setRecordDate("");
            setPaymentDate("");
            setLoading(false);
            setApplyJobName(null);
            setApplyStatus(null);
          }, 3000);
        } else if (data.status === "FAILED" || data.status === "ERROR") {
          clearInterval(interval);
          setError("Dividend application failed. Please try again.");
          setLoading(false);
          setApplyJobName(null);
          setApplyStatus(null);
        }
      } catch {
        /* ignore polling errors */
      }
    }, 10000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyJobName, loading, applyStatus]);

  const fetchAllSecurities = async () => {
    try {
      const res = await fetch(`${BASE_URL}/dividend/getAllSecuritiesList`);
      const data = await res.json();
      if (data.success) setSecurities(data.data || []);
    } catch (err) {
      console.error("Failed to fetch securities", err);
    }
  };

  const filteredSecurities = securities.filter(
    (sec) =>
      sec.securityCode?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      sec.securityName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      sec.isin?.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const handleSelectSecurity = (sec) => {
    setSymbol(sec.securityCode || "");
    setSearchQuery(sec.securityCode || sec.isin || "");
    setCompanyName(sec.securityName || "");
    setIsin(sec.isin || "");
    setShowDropdown(false);
  };

  const fetchPreview = async () => {
    setError(null);
    setPreviewEmptyMessage("");
    setReconEvents(null);
    setReconSummary(null);
    setPreviewData([]);
    setWarnings([]);
    setStatusFilter("all");
    setActiveEvent(0);
    /* Record Date is used for calculation (holdings as on record date); Ex-Date kept for UI/display */
    if (!isin || !recordDate || !rate || Number(rate) <= 0 || !paymentDate) {
      setError("ISIN, Record Date, Dividend Rate and Payment Date are required for preview.");
      return;
    }

    /*
     * Custodian file is mandatory. Reconciliation is the source of truth
     * for dividend Apply, so we don't allow a FIFO-only preview path.
     */
    if (!custodianFile) {
      setError(
        "Please upload the custodian Benefit Collection Report (CSV) " +
          "before fetching affected accounts.",
      );
      return;
    }

    setPreviewLoading(true);
    try {
      const fd = new FormData();
      fd.append("isin", isin);
      fd.append("recordDate", recordDate);
      fd.append("rate", String(Number(rate)));
      fd.append("paymentDate", paymentDate);
      fd.append("file", custodianFile);
      const res = await fetch(`${BASE_URL}/dividend/preview`, {
        method: "POST",
        body: fd,
      });
      const data = await res.json();
      if (data.success) {
        const rows = data.data || [];
        setPreviewData(rows);
        if (Array.isArray(data.events)) {
          setReconEvents(data.events);
          setReconSummary(data.summary || null);
          setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
          if (!data.events.length && !rows.length) {
            setPreviewEmptyMessage(
              "No accounts found in either system or custodian file.",
            );
          }
        } else {
          /*
           * Backend always returns `events` now that the file is mandatory;
           * this branch only fires for very old API builds and is kept as
           * a defensive fallback.
           */
          setPreviewEmptyMessage(
            "Backend returned no reconciliation data — please retry.",
          );
        }
      } else {
        setError(data.message || "Preview failed");
      }
    } catch (err) {
      console.error(err);
      setError("Failed to load preview");
    } finally {
      setPreviewLoading(false);
    }
  };

  /** Export preview CSV – calls GET /dividend/export-preview and sets signed download URL */
  const handleExportPreview = async () => {
    setExportLoading(true);
    setExportDownloadUrl("");
    setError(null);
    try {
      /* recordDate used for calculation; exDate included for CSV display */
      const params = new URLSearchParams({
        isin,
        recordDate: recordDate || "",
        rate,
        paymentDate: paymentDate || "",
      });
      if (exDate) params.set("exDate", exDate);
      const res = await fetch(`${BASE_URL}/dividend/export-preview?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Export request failed");
      const data = await res.json();
      if (!data.success) throw new Error(data.message || "Export failed");
      const signedUrl =
        data.downloadUrl?.signature?.signature ?? data.downloadUrl?.signature;
      if (!signedUrl) throw new Error("Download URL missing");
      setExportDownloadUrl(signedUrl);
    } catch (err) {
      console.error(err);
      setError(err.message || "Failed to export dividend preview CSV");
    } finally {
      setExportLoading(false);
    }
  };

  /** Download generated export file – opens exportDownloadUrl when set by handleExportPreview */
  const handleDownload = () => {
    if (exportDownloadUrl) window.open(exportDownloadUrl, "_blank");
  };

  /**
   * Apply dividend (called from preview section after fetch).
   *
   * Submits a Catalyst Job via the AppSail controller. The controller returns
   * { jobName, status: "PENDING" } immediately; the polling useEffect above
   * then polls /dividend/apply-status until COMPLETED / FAILED / ERROR.
   * `loading` stays true for the entire duration so the button shows "Applying…".
   */
  /*
   * Apply dividend.
   *
   * mode:
   *   "system"  – legacy behaviour, no account filter, FIFO universe.
   *   "matched" – send only accounts with status === "ready".
   *   "all"     – send every reconciled account except already_paid /
   *               missing_in_system (those are unsafe to auto-apply).
   *
   * accountCodes: optional explicit allow-list. When omitted the handler
   *   derives it from the active reconciliation event using `mode`.
   */
  const handleApply = async (mode = "system", accountCodes = null) => {
    setError(null);
    if (!symbol || !companyName || !recordDate || !paymentDate) {
      setError("Security Code, Security Name, Record Date and Payment Date are required.");
      return;
    }
    if (!rate || Number(rate) <= 0) {
      setError("Dividend Rate is required and must be greater than 0.");
      return;
    }

    let codesToSend = accountCodes;
    if (!codesToSend && mode !== "system" && activeEventObj) {
      const safeStatuses =
        mode === "matched"
          ? new Set(["ready"])
          : new Set(["ready", "mismatch", "partial", "overpaid", "missing_in_file"]);
      codesToSend = activeEventObj.rows
        .filter((r) => safeStatuses.has(r.status))
        .map((r) => r.accountCode)
        .filter(Boolean);
      if (!codesToSend.length) {
        setError("No accounts to apply for the selected mode.");
        return;
      }
    }

    const payload = {
      isin,
      securityCode: symbol,
      securityName: companyName,
      rate: Number(rate),
      exDate,
      recordDate: recordDate || "",
      paymentDate: paymentDate || "",
      dividendType,
      applyMode: mode,
    };
    if (codesToSend && codesToSend.length) {
      payload.accountCodes = codesToSend;
    }

    setLoading(true);
    setApplyStatus(null);
    setApplyJobName(null);
    try {
      const res = await fetch(`${BASE_URL}/dividend/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.success || !data.jobName) {
        setError(data.message || "Failed to apply dividend");
        setLoading(false);
        return;
      }
      setApplyJobName(data.jobName);
      setApplyStatus(data.status || "PENDING");
    } catch (err) {
      console.error(err);
      setError("Failed to apply dividend");
      setLoading(false);
    }
  };

  /*
   * Confirmation modal state for the two reconciliation Apply buttons.
   * confirmApply is null when no dialog is open, or { mode, count, gross }.
   */
  const [confirmApply, setConfirmApply] = useState(null);

  const requestApply = (mode) => {
    if (!activeEventObj) {
      setError("No reconciliation data — fetch affected accounts first.");
      return;
    }
    const matchedRows = activeEventObj.rows.filter((r) => r.status === "ready");
    const safeAllRows = activeEventObj.rows.filter((r) =>
      ["ready", "mismatch", "partial", "overpaid", "missing_in_file"].includes(r.status),
    );
    const rows = mode === "matched" ? matchedRows : safeAllRows;
    const gross = rows.reduce((s, r) => s + (Number(r.grossSys) || 0), 0);
    setConfirmApply({ mode, count: rows.length, gross });
  };

  const closeConfirm = () => setConfirmApply(null);
  const confirmAndApply = () => {
    if (!confirmApply) return;
    const { mode } = confirmApply;
    setConfirmApply(null);
    handleApply(mode);
  };

  return (
    <MainLayout title="Dividend">
      <Card style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 20 }}>
          Add Dividend 
        </h2>

        {success && (
          <div className="alert success">Dividend applied successfully.</div>
        )}
        {error && <div className="alert error">{error}</div>}
        {previewEmptyMessage && (
          <div className="alert info">{previewEmptyMessage}</div>
        )}

        <form className="dividend-card" onSubmit={(e) => e.preventDefault()}>
          <div className="account-code-search" ref={dropdownRef}>
            <label className="search-label">Security Code</label>
            <div className="search-input-wrapper">
              <span className="search-icon">🔍</span>
              <input
                type="text"
                className="search-input"
                placeholder="Search security code or company..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setShowDropdown(true);
                  if (!e.target.value) {
                    setSymbol("");
                    setCompanyName("");
                    setIsin("");
                  }
                }}
                onFocus={() => setShowDropdown(true)}
              />
              {searchQuery && (
                <span
                  className="clear-icon"
                  onClick={() => {
                    setSearchQuery("");
                    setSymbol("");
                    setCompanyName("");
                    setIsin("");
                  }}
                >
                  ✕
                </span>
              )}
              <span className="arrow-icon">▾</span>
            </div>
            {showDropdown && filteredSecurities.length > 0 && (
              <div className="search-dropdown">
                <div className="dropdown-header">Search Security Code</div>
                <div className="dropdown-options">
                  {filteredSecurities.map((sec) => (
                    <div
                      key={sec.isin || sec.securityCode}
                      className="dropdown-option"
                      onClick={() => handleSelectSecurity(sec)}
                    >
                      <strong>{sec.securityCode || sec.isin}</strong>
                      <div style={{ fontSize: 12, color: "#6b7280" }}>
                        {sec.securityName}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="dropdown-footer">
                  {filteredSecurities.length} of {securities.length} securities
                </div>
              </div>
            )}
          </div>

          <div className="dividend-field">
            <label>ISIN</label>
            <input value={isin} disabled />
          </div>

          <div className="dividend-field">
            <label>Security Name</label>
            <input value={companyName} disabled />
          </div>

          <div className="dividend-field">
            <label>Dividend Type</label>
            <select
              value={dividendType}
              onChange={(e) => setDividendType(e.target.value)}
              className="dividend-select"
            >
              <option value="Interim">Interim</option>
              <option value="Special">Special</option>
              <option value="Final">Final</option>
              <option value="Interest">Interest</option>
            </select>
          </div>

          <div className="dividend-field">
            <label>Dividend Rate</label>
            <input
              type="number"
              step="any"
              placeholder="0"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </div>

          <div className="dividend-field">
            <label>Unit</label>
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              className="dividend-select"
            >
              <option value="Per Share">Per Share</option>
              <option value="Per Unit">Per Unit</option>
              <option value="Per Unit/Interest">Per Unit/Interest</option>
            </select>
          </div>

          <div className="dividend-field">
            <label>Ex-Date</label>
            <input
              type="date"
              value={exDate}
              onChange={(e) => setExDate(e.target.value)}
            />
          </div>

          <div className="dividend-field">
            <label>Record Date <span className="required-asterisk">*</span></label>
            <input
              type="date"
              value={recordDate}
              onChange={(e) => setRecordDate(e.target.value)}
              title="Used for eligibility calculation (holdings as on this date)"
            />
          </div>

          <div className="dividend-field">
            <label>Payment Date <span className="required-asterisk">*</span></label>
            <input
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              required
            />
          </div>

          <div className="dividend-actions">
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              ref={custodianInputRef}
              style={{ display: "none" }}
              onChange={(e) => {
                setCustodianFile(e.target.files?.[0] || null);
                if (e.target) e.target.value = "";
              }}
            />
            <button
              type="button"
              className="dividend-preview-btn"
              style={{ marginRight: 12 }}
              onClick={() => custodianInputRef.current?.click()}
            >
              Upload Custodian File <span className="required-asterisk">*</span>
            </button>

            {custodianFile ? (
              <span
                style={{
                  marginRight: 12,
                  fontSize: 13,
                  color: "#374151",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                {custodianFile.name}
                <span
                  role="button"
                  aria-label="Remove file"
                  style={{ cursor: "pointer", color: "#dc2626", fontWeight: 700 }}
                  onClick={() => setCustodianFile(null)}
                >
                  ✕
                </span>
              </span>
            ) : (
              <span
                style={{
                  marginRight: 12,
                  fontSize: 12,
                  color: "#9ca3af",
                  fontStyle: "italic",
                }}
              >
                No file selected — required to fetch accounts
              </span>
            )}

            <button
              type="button"
              className="dividend-preview-btn"
              disabled={
                !isin ||
                !recordDate ||
                !rate ||
                Number(rate) <= 0 ||
                !paymentDate ||
                !custodianFile ||
                previewLoading
              }
              title={
                !custodianFile
                  ? "Upload the custodian Benefit Collection Report (CSV) first."
                  : ""
              }
              onClick={fetchPreview}
            >
              {previewLoading ? "Fetching…" : "Fetch Affected Accounts"}
            </button>
          </div>
        </form>
      </Card>

      {/* ============================================================
          RECONCILIATION GRID — the only preview path now. Always renders
          from a custodian-file upload. The legacy FIFO-only 5-column
          preview was removed because we never want to apply dividends
          without the custodian's confirmation.
          ============================================================ */}
      {reconEvents && (
        <Card style={{ marginTop: 24 }} className="dividend-preview-card">
          <div className="dividend-recon-header">
            <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
              Custodian Reconciliation
            </h3>
          </div>

          {warnings.length > 0 && (
            <div className="alert info" style={{ marginBottom: 12 }}>
              {warnings.map((w, i) => (
                <div key={i}>• {w}</div>
              ))}
            </div>
          )}

          {/* Event tabs (only when >1 event in the file) */}
          {reconEvents.length > 1 && (
            <div className="dividend-recon-tabs">
              {reconEvents.map((evt, idx) => (
                <button
                  key={`${evt.caRef || "-"}-${evt.rate}-${idx}`}
                  type="button"
                  className={
                    idx === activeEvent
                      ? "recon-tab recon-tab-active"
                      : "recon-tab"
                  }
                  onClick={() => {
                    setActiveEvent(idx);
                    setStatusFilter("all");
                  }}
                >
                  {evt.caRef ? `${evt.caRef} · ` : ""}₹{evt.rate}/share ·{" "}
                  {evt.rowCount} acc.
                </button>
              ))}
            </div>
          )}

          {/* Status filter chips */}
          {activeEventObj && reconSummary && (
            <div className="dividend-recon-filters">
              {[
                { key: "all", label: "All", count: activeEventObj.rowCount },
                {
                  key: "ready",
                  label: "🟢 Matched",
                  count: activeEventObj.rows.filter((r) => r.status === "ready").length,
                },
                {
                  key: "mismatch",
                  label: "🟡 Mismatch",
                  count: activeEventObj.rows.filter((r) => r.status === "mismatch").length,
                },
                {
                  key: "partial",
                  label: "🟠 Partial",
                  count: activeEventObj.rows.filter((r) => r.status === "partial").length,
                },
                {
                  key: "overpaid",
                  label: "🔴 Over-paid",
                  count: activeEventObj.rows.filter((r) => r.status === "overpaid").length,
                },
                {
                  key: "already_paid",
                  label: "✅ Already paid",
                  count: activeEventObj.rows.filter((r) => r.status === "already_paid").length,
                },
                {
                  key: "missing_in_system",
                  label: "🟣 Missing in system",
                  count: activeEventObj.rows.filter((r) => r.status === "missing_in_system").length,
                },
                {
                  key: "missing_in_file",
                  label: "🟣 Missing in file",
                  count: activeEventObj.rows.filter((r) => r.status === "missing_in_file").length,
                },
              ]
                .filter((c) => c.key === "all" || c.count > 0)
                .map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className={
                      statusFilter === c.key
                        ? "recon-chip recon-chip-active"
                        : "recon-chip"
                    }
                    onClick={() => setStatusFilter(c.key)}
                  >
                    {c.label} ({c.count})
                  </button>
                ))}
            </div>
          )}

          <div className="dividend-preview-table-wrapper">
            <table className="dividend-table dividend-recon-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Holding<br />PMS / File / Diff</th>
                  <th>Rate<br />PMS / File</th>
                  <th>Gross<br />PMS / File / Diff</th>
                  <th>CA Tax Amt</th>
                  <th>Net</th>
                  <th>Already<br />Received</th>
                  <th>To Receive<br />(Net)</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {paginatedReconRows.length === 0 && (
                  <tr>
                    <td
                      colSpan={9}
                      style={{ textAlign: "center", color: "#6b7280" }}
                    >
                      No rows in this filter.
                    </td>
                  </tr>
                )}
                {paginatedReconRows.map((row) => (
                  <tr
                    key={`${row.accountCode}`}
                    className={`recon-row recon-row-${row.status}`}
                    title={row.clientName || ""}
                  >
                    <td>
                      <div style={{ fontWeight: 600 }}>{row.accountCode}</div>
                      {row.clientName && (
                        <div style={{ fontSize: 11, color: "#6b7280" }}>
                          {row.clientName}
                        </div>
                      )}
                    </td>
                    <td>
                      {row.holdingSys ?? "—"} / {row.holdingFile ?? "—"} /{" "}
                      <span
                        className={
                          row.holdingDelta === 0
                            ? "delta-zero"
                            : row.holdingDelta > 0
                              ? "delta-pos"
                              : "delta-neg"
                        }
                      >
                        {row.holdingDelta > 0 ? "+" : ""}
                        {row.holdingDelta || 0}
                      </span>
                    </td>
                    <td>
                      {row.rateSys ?? "—"} / {row.rateFile ?? "—"}
                    </td>
                    <td>
                      {row.grossSys ?? "—"} / {row.grossFile ?? "—"} /{" "}
                      <span
                        className={
                          row.grossDelta === 0
                            ? "delta-zero"
                            : row.grossDelta > 0
                              ? "delta-pos"
                              : "delta-neg"
                        }
                      >
                        {row.grossDelta > 0 ? "+" : ""}
                        {row.grossDelta || 0}
                      </span>
                    </td>
                    <td>{row.tdsFile ?? "—"}</td>
                    <td style={{ fontWeight: 600 }}>{row.netFile ?? "—"}</td>
                    <td>
                      {row.alreadyReceivedGross || 0}
                      {row.alreadyCreditedCash && (
                        <span
                          title="Cash credit row exists"
                          style={{ marginLeft: 6 }}
                        >
                          ✅
                        </span>
                      )}
                    </td>
                    <td style={{ fontWeight: 600 }}>{row.toReceiveNet}</td>
                    <td>
                      <span className={`recon-badge recon-badge-${row.status}`}>
                        {STATUS_LABEL[row.status] || row.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {reconTotalPages > 1 && (
            <div className="dividend-pagination">
              <button
                type="button"
                disabled={page === 1}
                onClick={() => setPage(page - 1)}
              >
                Prev
              </button>
              <span>
                Page {page} of {reconTotalPages}
              </span>
              <button
                type="button"
                disabled={page === reconTotalPages}
                onClick={() => setPage(page + 1)}
              >
                Next
              </button>
            </div>
          )}

          {success && (
            <div className="alert success" style={{ marginTop: 12 }}>
              Dividend applied successfully.
            </div>
          )}

          <div className="dividend-preview-actions">
            <button
              type="button"
              className="dividend-submit"
              disabled={exportLoading}
              onClick={handleExportPreview}
            >
              {exportLoading ? "Generating..." : "Export"}
            </button>
            <button
              type="button"
              className="dividend-submit"
              disabled={!exportDownloadUrl}
              onClick={handleDownload}
            >
              Download
            </button>

            {/*
             * v2 Apply controls:
             *   Primary  – Apply Matched Only (status === "ready")
             *   Secondary – Apply All Reconciled (everything except
             *               already_paid / missing_in_system)
             */}
            {(() => {
              const matchedRows = activeEventObj
                ? activeEventObj.rows.filter((r) => r.status === "ready")
                : [];
              const safeAllRows = activeEventObj
                ? activeEventObj.rows.filter((r) =>
                    [
                      "ready",
                      "mismatch",
                      "partial",
                      "overpaid",
                      "missing_in_file",
                    ].includes(r.status),
                  )
                : [];
              return (
                <>
                  <button
                    type="button"
                    className="dividend-submit dividend-submit-primary"
                    disabled={loading || matchedRows.length === 0}
                    onClick={() => requestApply("matched")}
                    title={
                      matchedRows.length === 0
                        ? "No matched rows in this event."
                        : `Apply ${matchedRows.length} matched row(s).`
                    }
                  >
                    {loading
                      ? "Applying…"
                      : `Apply Matched Only (${matchedRows.length})`}
                  </button>
                  <button
                    type="button"
                    className="dividend-submit dividend-submit-secondary"
                    disabled={loading || safeAllRows.length === 0}
                    onClick={() => requestApply("all")}
                    title={
                      safeAllRows.length === 0
                        ? "No reconcilable rows in this event."
                        : `Apply ${safeAllRows.length} row(s) including mismatches.`
                    }
                  >
                    {loading
                      ? "Applying…"
                      : `Apply All Reconciled (${safeAllRows.length})`}
                  </button>
                </>
              );
            })()}
          </div>
        </Card>
      )}

      {/* Confirmation modal for Apply Matched Only / Apply All Reconciled */}
      {confirmApply && (
        <div className="dividend-modal-backdrop" onClick={closeConfirm}>
          <div
            className="dividend-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>
              {confirmApply.mode === "matched"
                ? "Apply Matched Only?"
                : "Apply All Reconciled?"}
            </h3>
            <p style={{ marginBottom: 8 }}>
              You are about to credit dividend to{" "}
              <strong>{confirmApply.count}</strong> account(s) for{" "}
              <strong>{symbol}</strong> ({isin}).
            </p>
            <p style={{ marginBottom: 8 }}>
              Estimated system gross:{" "}
              <strong>₹{confirmApply.gross.toFixed(2)}</strong>
            </p>
            {confirmApply.mode === "all" && (
              <div className="alert info" style={{ fontSize: 13 }}>
                This includes <em>mismatch</em>, <em>partial</em>,{" "}
                <em>over-paid</em> and <em>missing-in-file</em> accounts. Review
                the grid before continuing.
              </div>
            )}
            <p style={{ fontSize: 12, color: "#6b7280" }}>
              Already-paid and missing-in-system accounts are always skipped.
            </p>
            <div
              style={{
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
                marginTop: 16,
              }}
            >
              <button
                type="button"
                className="dividend-submit"
                style={{ background: "#e5e7eb", color: "#111" }}
                onClick={closeConfirm}
              >
                Cancel
              </button>
              <button
                type="button"
                className="dividend-submit dividend-submit-primary"
                onClick={confirmAndApply}
              >
                Confirm Apply
              </button>
            </div>
          </div>
        </div>
      )}

      {dividendList.length > 0 && (
        <Card style={{ marginTop: 24 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>
            Previous Dividends
          </h3>
          <div className="dividend-table-wrapper">
            <table className="dividend-table">
              <thead>
                <tr>
                  <th>Security Code</th>
                  <th>Security Name</th>
                  <th>Type</th>
                  <th>Dividend Rate</th>
                  <th>Unit</th>
                  <th>Ex-Date</th>
                  <th>Record Date</th>
                  <th>Payment Date</th>
                </tr>
              </thead>
              <tbody>
                {dividendList.map((row, idx) => (
                  <tr key={idx}>
                    <td>{row.securityCode}</td>
                    <td>{row.securityName}</td>
                    <td>{row.dividendType}</td>
                    <td>{row.rate}</td>
                    <td>{row.unit}</td>
                    <td>{row.exDate}</td>
                    <td>{row.recordDate}</td>
                    <td>{row.paymentDate ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </MainLayout>
  );
}

export default DividendPage;
