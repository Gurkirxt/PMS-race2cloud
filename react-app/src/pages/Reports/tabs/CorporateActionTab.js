import React, { useState, useEffect } from "react";
import { BASE_URL } from "../../../constant.js";

/* Individual per-client impact reports. Only `split` is wired to a backend
   handler today; the rest are listed so the dropdown reflects the full set and
   are gated behind a "coming soon" note until their handlers ship. */
const INDIVIDUAL_TYPES = [
  { key: "split", label: "Split", supported: true },
  { key: "bonus", label: "Bonus", supported: true },
  { key: "dividend", label: "Dividend", supported: true },
  { key: "merger", label: "Merger", supported: false },
  { key: "demerger", label: "Demerger", supported: false },
];

const isPollingStatus = (s) => s === "PENDING" || s === "RUNNING";

function CorporateActionTab() {
  /* ---------- SHARED ---------- */
  const [reportMode, setReportMode] = useState("all"); // "all" | one of INDIVIDUAL_TYPES
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  /* ---------- "ALL CORPORATE ACTIONS" (master event export) ---------- */
  const [loading, setLoading] = useState(false);
  const [exportHistory, setExportHistory] = useState([]);

  /* ---------- INDIVIDUAL IMPACT REPORT (async job) ---------- */
  const [impactJob, setImpactJob] = useState(null); // { type, fromDate, toDate }
  const [impactStatus, setImpactStatus] = useState(null);
  const [impactDownloadUrl, setImpactDownloadUrl] = useState("");
  const [impactError, setImpactError] = useState("");
  const [generating, setGenerating] = useState(false);

  const selectedType = INDIVIDUAL_TYPES.find((t) => t.key === reportMode);

  /* ---------- LOAD LAST 10 "ALL" EXPORTS (ON MOUNT) ---------- */
  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const res = await fetch(
          `${BASE_URL}/export/corporate-action/history?limit=10`,
          { credentials: "include" }
        );
        const data = await res.json();
        if (Array.isArray(data)) setExportHistory(data);
      } catch (err) {
        console.error("Failed to load export history", err);
      }
    };
    fetchHistory();
  }, []);

  /* ---------- POLL IMPACT REPORT JOB STATUS ---------- */
  useEffect(() => {
    if (!impactJob || !isPollingStatus(impactStatus)) return;

    const params = new URLSearchParams({
      type: impactJob.type,
      fromDate: impactJob.fromDate,
      toDate: impactJob.toDate,
    });

    const interval = setInterval(async () => {
      try {
        const res = await fetch(
          `${BASE_URL}/export/corporate-action/report/status?${params.toString()}`,
          { credentials: "include" }
        );
        const data = await res.json();
        if (!data.success) return;

        setImpactStatus(data.status);

        if (data.status === "COMPLETED") {
          clearInterval(interval);
          fetchImpactDownload(impactJob);
        } else if (data.status === "NO_DATA") {
          clearInterval(interval);
        } else if (data.status === "FAILED" || data.status === "ERROR") {
          clearInterval(interval);
          setImpactError("Report generation failed. Please try again.");
        }
      } catch {
        // ignore transient polling errors
      }
    }, 5000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [impactJob, impactStatus]);

  /* ---------- HANDLERS: "ALL" MODE ---------- */
  const handleExport = async () => {
    if (!fromDate || !toDate) {
      alert("Please select From Date and To Date");
      return;
    }
    if (fromDate > toDate) {
      alert("From Date must be before or equal to To Date");
      return;
    }

    try {
      setLoading(true);
      const params = new URLSearchParams({ fromDate, toDate });
      const response = await fetch(
        `${BASE_URL}/export/corporate-action/export?${params.toString()}`,
        { method: "GET", credentials: "include" }
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || data.error || "Export failed");
      }

      const blob = await response.blob();
      triggerBlobDownload(
        blob,
        `corporate-action-export-${fromDate}-${toDate}.csv`
      );

      setExportHistory((prev) => [
        { fromDate, toDate, requestedAt: new Date().toISOString() },
        ...prev.slice(0, 9),
      ]);
    } catch (error) {
      alert(error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleHistoryDownload = async (row) => {
    try {
      const params = new URLSearchParams({
        fromDate: row.fromDate,
        toDate: row.toDate,
      });
      const response = await fetch(
        `${BASE_URL}/export/corporate-action/export?${params.toString()}`,
        { method: "GET", credentials: "include" }
      );
      if (!response.ok) throw new Error("Download failed");
      const blob = await response.blob();
      triggerBlobDownload(
        blob,
        `corporate-action-export-${row.fromDate}-${row.toDate}.csv`
      );
    } catch (err) {
      alert(err.message);
    }
  };

  /* ---------- HANDLERS: INDIVIDUAL IMPACT REPORT ---------- */
  const handleModeChange = (e) => {
    setReportMode(e.target.value);
    // Reset any in-flight/finished impact report when switching report type.
    setImpactJob(null);
    setImpactStatus(null);
    setImpactDownloadUrl("");
    setImpactError("");
  };

  const handleGenerateImpact = async () => {
    if (!fromDate || !toDate) {
      alert("Please select From Date and To Date");
      return;
    }
    if (fromDate > toDate) {
      alert("From Date must be before or equal to To Date");
      return;
    }

    setImpactError("");
    setImpactDownloadUrl("");
    setGenerating(true);

    try {
      const params = new URLSearchParams({ type: reportMode, fromDate, toDate });
      const res = await fetch(
        `${BASE_URL}/export/corporate-action/report/export?${params.toString()}`,
        { credentials: "include" }
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || "Failed to start report");
      }
      setImpactJob({ type: reportMode, fromDate, toDate });
      setImpactStatus(data.status || "PENDING");
    } catch (err) {
      setImpactError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const fetchImpactDownload = async (job) => {
    try {
      const params = new URLSearchParams({
        type: job.type,
        fromDate: job.fromDate,
        toDate: job.toDate,
      });
      const res = await fetch(
        `${BASE_URL}/export/corporate-action/report/download?${params.toString()}`,
        { credentials: "include" }
      );
      const data = await res.json();
      const url = data.downloadUrl?.signature || data.downloadUrl || "";
      if (url) setImpactDownloadUrl(url);
      else setImpactError("Report finished but the download link was missing.");
    } catch (err) {
      setImpactError("Failed to fetch the report download link.");
    }
  };

  const impactBusy = generating || isPollingStatus(impactStatus);
  const statusClass =
    impactStatus === "COMPLETED"
      ? "completed"
      : impactStatus === "FAILED" || impactStatus === "ERROR"
      ? "failed"
      : "pending";

  return (
    <>
      <h3 className="section-heading">Corporate Action Report</h3>

      {/* Report selector: all events vs a single action's per-client impact */}
      <div className="report-type-dropdown-wrap">
        <label className="report-type-label">Report</label>
        <select
          className="report-type-select"
          value={reportMode}
          onChange={handleModeChange}
          aria-label="Corporate action report type"
        >
          <option value="all">All Corporate Actions (event export)</option>
          {INDIVIDUAL_TYPES.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label} — client impact{t.supported ? "" : " (coming soon)"}
            </option>
          ))}
        </select>
      </div>

      {/* Shared date range */}
      <div className="form-grid">
        <div className="form-field">
          <label>From Date</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </div>
        <div className="form-field">
          <label>To Date</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
          />
        </div>
      </div>

      {/* ===================== ALL CORPORATE ACTIONS ===================== */}
      {reportMode === "all" && (
        <>
          <div className="action-footer">
            <button
              className="export-btn"
              onClick={handleExport}
              disabled={loading}
            >
              {loading ? "Generating..." : "Export CSV"}
            </button>
          </div>

          {exportHistory.length > 0 && (
            <div className="export-jobs-container">
              <h4>Previous Export History</h4>
              <table className="export-table">
                <thead>
                  <tr>
                    <th>From Date</th>
                    <th>To Date</th>
                    <th>Exported At</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {exportHistory.map((row, idx) => (
                    <tr
                      key={`${row.fromDate}-${row.toDate}-${row.requestedAt}-${idx}`}
                    >
                      <td>{row.fromDate}</td>
                      <td>{row.toDate}</td>
                      <td>
                        {row.requestedAt
                          ? new Date(row.requestedAt).toLocaleString()
                          : "-"}
                      </td>
                      <td>
                        <button
                          className="export-btn"
                          onClick={() => handleHistoryDownload(row)}
                        >
                          Download
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ===================== INDIVIDUAL IMPACT REPORT ===================== */}
      {reportMode !== "all" && (
        <>
          <p style={{ color: "#6b7280", fontSize: 13, marginTop: 4 }}>
            Per-client impact of every {selectedType?.label.toLowerCase()} in the
            selected period (one row per affected account).
          </p>

          {selectedType && !selectedType.supported ? (
            <div className={`export-status pending`} style={{ marginTop: 8 }}>
              {selectedType.label} client-impact reports are coming soon.
            </div>
          ) : (
            <>
              <div className="action-footer">
                <button
                  className="export-btn"
                  onClick={handleGenerateImpact}
                  disabled={impactBusy}
                >
                  {generating
                    ? "Starting..."
                    : isPollingStatus(impactStatus)
                    ? "Generating..."
                    : "Generate Report"}
                </button>
              </div>

              {impactStatus === "NO_DATA" && (
                <div className="export-empty" style={{ marginTop: 8 }}>
                  No corporate action found for the selected period.
                </div>
              )}

              {impactStatus && impactStatus !== "NO_DATA" && (
                <div
                  className={`export-status ${statusClass}`}
                  style={{ marginTop: 8 }}
                >
                  Status: {impactStatus}
                </div>
              )}

              {impactError && (
                <div
                  className="export-status failed"
                  style={{ marginTop: 8 }}
                >
                  {impactError}
                </div>
              )}

              {impactDownloadUrl && (
                <div className="action-footer" style={{ marginTop: 8 }}>
                  <a
                    className="export-btn"
                    href={impactDownloadUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Download CSV
                  </a>
                </div>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

/* Shared: turn a fetched blob into a browser download. */
function triggerBlobDownload(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}

export default CorporateActionTab;
