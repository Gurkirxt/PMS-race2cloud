import React, { useState, useEffect, useRef, useMemo } from "react";
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

const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "ERROR", "NO_DATA"];
const isPollingStatus = (s) => !TERMINAL_STATUSES.includes(s);

/** Local wall time as yyyy-mm-dd HH:mm:ss (not locale-specific). */
function formatExportTimestamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function statusBadgeClass(status) {
  if (status === "COMPLETED") return "completed";
  if (status === "FAILED" || status === "ERROR") return "failed";
  return "pending";
}

function CorporateActionTab() {
  /* ---------- SHARED ---------- */
  const [reportMode, setReportMode] = useState("all"); // "all" | one of INDIVIDUAL_TYPES
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  /* ---------- "ALL CORPORATE ACTIONS" (master event export) ---------- */
  const [loading, setLoading] = useState(false);
  const [exportHistory, setExportHistory] = useState([]);

  /* ---------- INDIVIDUAL IMPACT REPORT (async job) ---------- */
  const [impactJobs, setImpactJobs] = useState([]);
  const [impactError, setImpactError] = useState("");
  const [generating, setGenerating] = useState(false);

  const impactJobsRef = useRef(impactJobs);
  impactJobsRef.current = impactJobs;

  const selectedType = INDIVIDUAL_TYPES.find((t) => t.key === reportMode);

  const sortedImpactJobs = useMemo(() => {
    return [...impactJobs].sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
  }, [impactJobs]);

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

  /* ---------- LOAD IMPACT REPORT HISTORY (ON MOUNT / TYPE CHANGE) ---------- */
  useEffect(() => {
    if (!selectedType || !selectedType.supported) return;

    const fetchImpactHistory = async () => {
      try {
        const params = new URLSearchParams({ type: reportMode, limit: "10" });
        const res = await fetch(
          `${BASE_URL}/export/corporate-action/report/history?${params.toString()}`,
          { credentials: "include" }
        );
        const data = await res.json();
        if (Array.isArray(data)) setImpactJobs(data);
      } catch (err) {
        console.error("Failed to load impact report history", err);
      }
    };
    fetchImpactHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportMode]);

  /* ---------- POLL IMPACT REPORT JOB STATUSES ---------- */
  useEffect(() => {
    if (!selectedType || !selectedType.supported) return;

    const interval = setInterval(async () => {
      const currentJobs = impactJobsRef.current;
      const hasPending = currentJobs.some((j) => isPollingStatus(j.status));
      if (!hasPending) return;

      const updated = await Promise.all(
        currentJobs.map(async (job) => {
          if (!isPollingStatus(job.status)) return job;

          try {
            const params = new URLSearchParams({
              type: reportMode,
              fromDate: job.fromDate,
              toDate: job.toDate,
            });
            const res = await fetch(
              `${BASE_URL}/export/corporate-action/report/status?${params.toString()}`,
              { credentials: "include" }
            );
            const data = await res.json();
            if (!data.success || !data.status || data.status === "NOT_STARTED") {
              return job;
            }
            return { ...job, status: data.status };
          } catch {
            return job;
          }
        })
      );

      setImpactJobs(updated);
    }, 15000);

    return () => clearInterval(interval);
  }, [reportMode, selectedType]);

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
        {
          fromDate,
          toDate,
          status: "COMPLETED",
          createdAt: new Date().toISOString(),
        },
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

      setImpactJobs((prev) => {
        const exists = prev.find(
          (j) => j.fromDate === fromDate && j.toDate === toDate
        );
        if (exists) {
          return prev.map((j) =>
            j.fromDate === fromDate && j.toDate === toDate
              ? { ...j, status: data.status, jobName: data.jobName || j.jobName }
              : j
          );
        }
        return [
          {
            jobName: data.jobName,
            fromDate,
            toDate,
            status: data.status || "PENDING",
            createdAt: new Date().toISOString(),
          },
          ...prev,
        ];
      });
    } catch (err) {
      setImpactError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleImpactDownload = async (job) => {
    try {
      const params = new URLSearchParams({
        type: reportMode,
        fromDate: job.fromDate,
        toDate: job.toDate,
      });
      const res = await fetch(
        `${BASE_URL}/export/corporate-action/report/download?${params.toString()}`,
        { credentials: "include" }
      );
      const data = await res.json();
      const url = data.downloadUrl?.signature || data.downloadUrl || "";
      if (url) {
        window.open(url, "_blank");
      } else {
        alert("Report finished but the download link was missing.");
      }
    } catch (err) {
      alert("Failed to fetch the report download link.");
    }
  };

  const anyImpactBusy = generating || sortedImpactJobs.some((j) => isPollingStatus(j.status));

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
                    <th>Timestamp</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {exportHistory.map((row, idx) => (
                    <tr
                      key={`${row.jobName || `${row.fromDate}-${row.toDate}`}-${idx}`}
                    >
                      <td>{row.fromDate}</td>
                      <td>{row.toDate}</td>
                      <td>
                        {row.createdAt
                          ? formatExportTimestamp(row.createdAt)
                          : "-"}
                      </td>
                      <td>
                        <span className={`export-status ${statusBadgeClass(row.status)}`}>
                          {row.status || "COMPLETED"}
                        </span>
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
                  disabled={anyImpactBusy}
                >
                  {generating ? "Starting..." : "Generate Report"}
                </button>
              </div>

              {impactError && (
                <div
                  className="export-status failed"
                  style={{ marginTop: 8 }}
                >
                  {impactError}
                </div>
              )}

              {impactJobs.length > 0 && (
                <div className="export-jobs-container">
                  <h4>Previous Report History</h4>
                  <table className="export-table">
                    <thead>
                      <tr>
                        <th>From Date</th>
                        <th>To Date</th>
                        <th>Timestamp</th>
                        <th>Status</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedImpactJobs.map((job, idx) => (
                        <tr key={job.jobName || `${job.fromDate}-${job.toDate}-${idx}`}>
                          <td>{job.fromDate}</td>
                          <td>{job.toDate}</td>
                          <td>
                            {job.createdAt ? formatExportTimestamp(job.createdAt) : "—"}
                          </td>
                          <td>
                            <span className={`export-status ${statusBadgeClass(job.status)}`}>
                              {job.status}
                            </span>
                          </td>
                          <td>
                            {job.status === "COMPLETED" ? (
                              <button
                                className="export-btn"
                                onClick={() => handleImpactDownload(job)}
                              >
                                Download
                              </button>
                            ) : job.status === "NO_DATA" ? (
                              <span style={{ color: "#9ca3af" }}>No data</span>
                            ) : (
                              <span style={{ color: "#9ca3af" }}>-</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
