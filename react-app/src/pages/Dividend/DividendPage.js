import React, { useState, useEffect, useRef } from "react";
import MainLayout from "../../layouts/MainLayout";
import { Card } from "../../components/common/CommonComponents";
import "./DividendPage.css";
import { BASE_URL } from "../../constant";

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

  const [previewData, setPreviewData] = useState([]);
  const [showPreview, setShowPreview] = useState(false);
  const [previewEmptyMessage, setPreviewEmptyMessage] = useState("");
  const PAGE_SIZE = 10;
  const [page, setPage] = useState(1);

  const [exportDownloadUrl, setExportDownloadUrl] = useState("");
  const [exportLoading, setExportLoading] = useState(false);

  const [applyJobName, setApplyJobName] = useState(null);
  const [applyStatus, setApplyStatus] = useState(null);

  const [custodianFile, setCustodianFile] = useState(null);
  const custodianInputRef = useRef(null);

  const dropdownRef = useRef(null);

  useEffect(() => setPage(1), [previewData]);
  const totalPages = Math.ceil(previewData.length / PAGE_SIZE);
  const paginatedPreview = previewData.slice(
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
            setShowPreview(false);
            setPreviewEmptyMessage("");
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
    setShowPreview(false);
    setPreviewEmptyMessage("");
    /* Record Date is used for calculation (holdings as on record date); Ex-Date kept for UI/display */
    if (!isin || !recordDate || !rate || Number(rate) <= 0 || !paymentDate) {
      setError("ISIN, Record Date, Dividend Rate and Payment Date are required for preview.");
      return;
    }
    setPreviewLoading(true);
    try {
      const res = await fetch(`${BASE_URL}/dividend/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isin,
          recordDate,
          rate: Number(rate),
          paymentDate,
        }),
      });
      const data = await res.json();
      if (data.success) {
        const rows = data.data || [];
        setPreviewData(rows);
        if (rows.length > 0) {
          setShowPreview(true);
          setPreviewEmptyMessage("");
        } else {
          setShowPreview(false);
          setPreviewEmptyMessage("No accounts with dividend entitlement.");
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
  const handleApply = async () => {
    setError(null);
    if (!symbol || !companyName || !recordDate || !paymentDate) {
      setError("Security Code, Security Name, Record Date and Payment Date are required.");
      return;
    }
    if (!rate || Number(rate) <= 0) {
      setError("Dividend Rate is required and must be greater than 0.");
      return;
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
    };
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
              Upload Custodian File
            </button>

            {custodianFile && (
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
            )}

            <button
              type="button"
              className="dividend-preview-btn"
              disabled={!isin || !recordDate || !rate || Number(rate) <= 0 || !paymentDate || previewLoading}
              onClick={fetchPreview}
            >
              {previewLoading ? "Fetching…" : "Fetch Affected Accounts"}
            </button>
          </div>
        </form>
      </Card>

      {showPreview && previewData.length > 0 && (
        <Card style={{ marginTop: 24 }} className="dividend-preview-card">
          <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>
            Dividend Preview
          </h3>

          <div className="dividend-preview-table-wrapper">
                <table className="dividend-table dividend-preview-table">
                  <thead>
                    <tr>
                      <th>Account Code</th>
                      <th>Holding (Record Date)</th>
                      <th>Dividend Rate</th>
                      <th>Payment Date</th>
                      <th>Dividend Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedPreview.map((row) => (
                      <tr key={row.accountCode}>
                        <td>{row.accountCode}</td>
                        <td>{row.holdingAsOnRecordDate}</td>
                        <td>{row.rate}</td>
                        <td>{row.paymentDate ?? "—"}</td>
                        <td style={{ fontWeight: 600 }}>{row.dividendAmount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <div className="dividend-pagination">
                  <button
                    type="button"
                    disabled={page === 1}
                    onClick={() => setPage(page - 1)}
                  >
                    Prev
                  </button>
                  <span>
                    Page {page} of {totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={page === totalPages}
                    onClick={() => setPage(page + 1)}
                  >
                    Next
                  </button>
                </div>
              )}

              {success && (
                <div className="alert success" style={{ marginBottom: 16 }}>
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
                <button
                  type="button"
                  className="dividend-submit"
                  disabled={loading}
                  onClick={handleApply}
                >
                  {loading ? "Applying…" : "Confirm & Apply Dividend"}
                </button>
              </div>
        </Card>
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
