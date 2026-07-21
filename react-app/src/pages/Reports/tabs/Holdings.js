import React, { useEffect, useRef, useState, useMemo } from "react";
import { useAccountCodes } from "../../../hooks/GetAllCodes.js";
import { BASE_URL } from "../../../constant.js";

/** Local wall time as yyyy-mm-dd HH:mm:ss (not locale-specific). */
function formatExportTimestamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function HoldingsTab() {
  // "scheme" = per virtual code (existing); "consolidated" = grouped by Actual Code.
  const [reportMode, setReportMode] = useState("scheme");
  const [exportType, setExportType] = useState("all");
  const [asOnDate, setAsOnDate] = useState("");
  const [accountCode, setAccountCode] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [isinOptions, setIsinOptions] = useState([]);
  const [isinQuery, setIsinQuery] = useState("");
  const [selectedIsin, setSelectedIsin] = useState("");
  const [showIsinDropdown, setShowIsinDropdown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState("");

  const [exportJobs, setExportJobs] = useState([]);

  const isConsolidated = reportMode === "consolidated";

  const dropdownRef = useRef(null);
  const isinDropdownRef = useRef(null);
  const exportJobsRef = useRef(exportJobs);
  exportJobsRef.current = exportJobs;
  // Consolidated mode lists Actual Codes; scheme-wise lists virtual codes.
  const { clientOptions } = useAccountCodes(isConsolidated ? "actual" : "scheme");

  /* Reset the picked account when switching report mode — the code lists differ. */
  const handleReportModeChange = (mode) => {
    setReportMode(mode);
    setSearchQuery("");
    setAccountCode("");
    setShowDropdown(false);
    setDownloadUrl("");
  };

  const handleExportTypeChange = (type) => {
    setExportType(type);
    setDownloadUrl("");
    setShowDropdown(false);
    setShowIsinDropdown(false);
    if (type !== "single") {
      setSearchQuery("");
      setAccountCode("");
    }
    if (type !== "isin") {
      setIsinQuery("");
      setSelectedIsin("");
    }
  };

  /* ---------------- FILTERED OPTIONS ---------------- */
  const filteredOptions = useMemo(() => {
    return clientOptions.filter((opt) =>
      opt.label.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [clientOptions, searchQuery]);

  const filteredIsinOptions = useMemo(() => {
    const q = String(isinQuery ?? "").toLowerCase().trim();
    if (!q) return isinOptions;
    return isinOptions.filter(
      (opt) =>
        String(opt?.isin ?? "").toLowerCase().includes(q) ||
        String(opt?.securityCode ?? "").toLowerCase().includes(q) ||
        String(opt?.securityName ?? "").toLowerCase().includes(q)
    );
  }, [isinOptions, isinQuery]);

  const sortedExportJobs = useMemo(() => {
    return [...exportJobs].sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
  }, [exportJobs]);

  /* ---------------- CLOSE DROPDOWN ---------------- */
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
      if (isinDropdownRef.current && !isinDropdownRef.current.contains(e.target)) {
        setShowIsinDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (exportType !== "isin") return;

    const fetchSecurityList = async () => {
      try {
        const response = await fetch(`${BASE_URL}/security/list`);
        const data = await response.json();
        const rows = Array.isArray(data?.data) ? data.data : [];
        setIsinOptions(
          rows
            .map((row) => ({
              isin: String(row?.isin ?? "").trim(),
              securityCode: String(row?.securityCode ?? "").trim(),
              securityName: String(row?.securityName ?? "").trim(),
            }))
            .filter((row) => row.isin)
        );
      } catch (error) {
        console.error("Failed to load securities list:", error);
        setIsinOptions([]);
      }
    };

    fetchSecurityList();
  }, [exportType]);

  /* ---------------- ACCOUNT SELECT ---------------- */
  const handleAccountSelect = (option) => {
    setSearchQuery(option.label);
    setAccountCode(option.value);
    setShowDropdown(false);
  };

  const clearAccountSelection = () => {
    setSearchQuery("");
    setAccountCode("");
    setShowDropdown(false);
  };

  const handleIsinSelect = (option) => {
    const label = option.securityName
      ? `${option.isin} - ${option.securityName}`
      : option.isin;
    setIsinQuery(label);
    setSelectedIsin(option.isin);
    setShowIsinDropdown(false);
  };

  const clearIsinSelection = () => {
    setIsinQuery("");
    setSelectedIsin("");
    setShowIsinDropdown(false);
  };

  /* ===================== EXPORT HANDLER ===================== */
  const handleExport = async () => {
    try {
      /* ---------- ISIN EXPORT (same shape as Analytics ISIN report) ---------- */
      if (exportType === "isin") {
        if (!selectedIsin) {
          alert("Please select an ISIN");
          return;
        }

        setLoading(true);
        setDownloadUrl("");

        const params = new URLSearchParams({ isin: selectedIsin });
        if (asOnDate) params.append("asOnDate", asOnDate);

        const response = await fetch(
          `${BASE_URL}/export/export-by-isin?${params.toString()}`,
          { method: "GET", credentials: "include" }
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.message);

        const url =
          data.downloadUrl?.signature || data.downloadUrl || "";
        if (!url) throw new Error("Download URL missing from export response");
        setDownloadUrl(url);
        setLoading(false);
        return;
      }

      /* ---------- SINGLE CLIENT EXPORT ---------- */
      if (exportType === "single") {
        if (!accountCode) {
          alert(
            isConsolidated
              ? "Please select an actual code"
              : "Please select an account code"
          );
          return;
        }

        setLoading(true);
        setDownloadUrl("");

        const params = new URLSearchParams();
        if (asOnDate) params.append("asOnDate", asOnDate);

        // Consolidated -> roll up all virtual codes under the actual code.
        let url;
        if (isConsolidated) {
          params.append("actualCode", accountCode);
          url = `${BASE_URL}/export/export-consolidated?${params.toString()}`;
        } else {
          params.append("accountCode", accountCode);
          url = `${BASE_URL}/export/export-single?${params.toString()}`;
        }

        const response = await fetch(url, {
          method: "GET",
          credentials: "include",
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.message);

        setDownloadUrl(data.downloadUrl.signature);
        setLoading(false);
        return;
      }

      /* ---------- EXPORT ALL CLIENTS (JOB BASED) ---------- */
      if (!asOnDate) {
        alert("Please select As On Date");
        return;
      }

      setLoading(true);

      const allParams = new URLSearchParams({ asOnDate });
      if (isConsolidated) allParams.append("mode", "consolidated");

      const response = await fetch(
        `${BASE_URL}/export/export-all?${allParams.toString()}`,
        { method: "GET", credentials: "include" }
      );

      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Failed to start export");

      // Update or add the job in the list
      setExportJobs((prev) => {
        const exists = prev.find((j) => j.jobName === data.jobName);
        if (exists) {
          return prev.map((j) =>
            j.jobName === data.jobName
              ? {
                  ...j,
                  status: data.status,
                  ...(data.createdAt ? { createdAt: data.createdAt } : {}),
                }
              : j
          );
        }
        return [
          {
            jobName: data.jobName,
            asOnDate: data.asOnDate || asOnDate,
            mode: data.mode || (isConsolidated ? "consolidated" : "scheme"),
            status: data.status,
            createdAt: data.createdAt || new Date().toISOString(),
          },
          ...prev,
        ];
      });

      setLoading(false);
    } catch (error) {
      alert(error.message);
      setLoading(false);
    }
  };

  /* ===================== LOAD LAST 10 EXPORTS (ON MOUNT) ===================== */
  useEffect(() => {
    if (exportType !== "all") return;

    const fetchHistory = async () => {
      try {
        const res = await fetch(
          `${BASE_URL}/export/export-all/history?limit=10`,
          { credentials: "include" }
        );
        const data = await res.json();

        if (Array.isArray(data)) {
          setExportJobs(data);
        }
      } catch (err) {
        console.error("Failed to load export history", err);
      }
    };

    fetchHistory();
  }, [exportType]);

  /* ===================== SAFE POLLING (ONLY RUNNING JOBS) ===================== */
  useEffect(() => {
    const terminalStatuses = ["COMPLETED", "FAILED", "ERROR"];

    const interval = setInterval(async () => {
      const currentJobs = exportJobsRef.current;
      if (!currentJobs.length) return;

      const hasRunningJobs = currentJobs.some(
        (j) => !terminalStatuses.includes(j.status)
      );
      if (!hasRunningJobs) return;

      const updated = await Promise.all(
        currentJobs.map(async (job) => {
          if (terminalStatuses.includes(job.status)) {
            return job;
          }

          try {
            const statusParams = new URLSearchParams({ asOnDate: job.asOnDate });
            if (job.mode === "consolidated") statusParams.append("mode", "consolidated");
            const res = await fetch(
              `${BASE_URL}/export/check-status?${statusParams.toString()}`,
              { credentials: "include" }
            );
            const data = await res.json();

            if (!data.status || data.status === "NOT_STARTED") {
              return job;
            }

            return { ...job, status: data.status };
          } catch {
            return job;
          }
        })
      );

      setExportJobs(updated);
    }, 15000);

    return () => clearInterval(interval);
  }, []);

  /* ===================== DOWNLOAD EXPORT ===================== */
  const handleExportAllDownload = async (date, mode) => {
    try {
      const dlParams = new URLSearchParams({ asOnDate: date });
      if (mode === "consolidated") dlParams.append("mode", "consolidated");
      const res = await fetch(
        `${BASE_URL}/export/download?${dlParams.toString()}`,
        { credentials: "include" }
      );
      const data = await res.json();
      if (data.downloadUrl && data.downloadUrl.signature) {
        window.open(data.downloadUrl.signature, "_blank");
      } else if (data.downloadUrl) {
        window.open(data.downloadUrl, "_blank");
      }
    } catch (err) {
      alert("Failed to download export file");
    }
  };

  /* ===================== UI ===================== */
  return (
    <>
      <h3 className="section-heading">Holdings Export</h3>

      <div className="export-type">
        <label>
          <input
            type="radio"
            name="report-mode"
            checked={reportMode === "scheme"}
            onChange={() => handleReportModeChange("scheme")}
          />
          Scheme Wise
        </label>

        <label>
          <input
            type="radio"
            name="report-mode"
            checked={reportMode === "consolidated"}
            onChange={() => handleReportModeChange("consolidated")}
          />
          Consolidated
        </label>
      </div>

      <div className="export-type">
        <label>
          <input
            type="radio"
            checked={exportType === "all"}
            onChange={() => handleExportTypeChange("all")}
          />
          Export All Clients
        </label>

        <label>
          <input
            type="radio"
            checked={exportType === "single"}
            onChange={() => handleExportTypeChange("single")}
          />
          Export Single Client
        </label>

        <label>
          <input
            type="radio"
            checked={exportType === "isin"}
            onChange={() => handleExportTypeChange("isin")}
          />
          ISIN
        </label>
      </div>

      <div className="form-grid">
        {exportType === "single" && (
          <div className="account-code-search" ref={dropdownRef}>
            <label className="search-label">
              {isConsolidated ? "Actual Code" : "Account Code"}
            </label>

            <div className="search-input-wrapper">
              <span className="search-icon">🔍</span>

              <input
                type="text"
                className="search-input"
                placeholder={
                  isConsolidated
                    ? "Search Actual Code..."
                    : "Search Account Code..."
                }
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setShowDropdown(true);
                }}
                onFocus={() => setShowDropdown(true)}
              />

              {searchQuery && (
                <span className="clear-icon" onClick={clearAccountSelection}>
                  ✕
                </span>
              )}

              <span className="arrow-icon">▾</span>
            </div>

            {showDropdown && filteredOptions.length > 0 && (
              <div className="search-dropdown">
                <div className="dropdown-header">
                  {isConsolidated
                    ? "Search Actual Code..."
                    : "Search Account Code..."}
                </div>

                <div className="dropdown-options">
                  {filteredOptions.map((opt) => (
                    <div
                      key={opt.value}
                      className="dropdown-option"
                      onClick={() => handleAccountSelect(opt)}
                    >
                      {opt.label}
                    </div>
                  ))}
                </div>

                <div className="dropdown-footer">
                  {filteredOptions.length} of {clientOptions.length} options
                </div>
              </div>
            )}
          </div>
        )}

        {exportType === "isin" && (
          <div className="account-code-search" ref={isinDropdownRef}>
            <label className="search-label">ISIN</label>

            <div className="search-input-wrapper">
              <span className="search-icon">🔍</span>

              <input
                type="text"
                className="search-input"
                placeholder="Search ISIN / Security..."
                value={isinQuery}
                onChange={(e) => {
                  setIsinQuery(e.target.value);
                  setShowIsinDropdown(true);
                }}
                onFocus={() => setShowIsinDropdown(true)}
              />

              {isinQuery && (
                <span className="clear-icon" onClick={clearIsinSelection}>
                  ✕
                </span>
              )}

              <span className="arrow-icon">▾</span>
            </div>

            {showIsinDropdown && filteredIsinOptions.length > 0 && (
              <div className="search-dropdown">
                <div className="dropdown-header">Search ISIN / Name...</div>

                <div className="dropdown-options">
                  {filteredIsinOptions.map((opt, idx) => (
                    <div
                      key={`${opt.isin || "no-isin"}-${idx}`}
                      className="dropdown-option"
                      onClick={() => handleIsinSelect(opt)}
                    >
                      {opt.isin}
                      {opt.securityName ? ` - ${opt.securityName}` : ""}
                    </div>
                  ))}
                </div>

                <div className="dropdown-footer">
                  {filteredIsinOptions.length} of {isinOptions.length} options
                </div>
              </div>
            )}
          </div>
        )}

        <div className="form-field">
          <label>As On Date</label>
          <input
            type="date"
            value={asOnDate}
            onChange={(e) => setAsOnDate(e.target.value)}
          />
        </div>
      </div>

      <div className="action-footer">
        {!downloadUrl ? (
          <button
            className="export-btn"
            onClick={handleExport}
            disabled={loading}
          >
            {loading ? "Generating..." : "Export"}
          </button>
        ) : (
          <a
            href={downloadUrl}
            className="export-btn"
            download
            target="_blank"
            rel="noreferrer"
          >
            Download CSV
          </a>
        )}
      </div>

      {exportType === "all" && exportJobs.length > 0 && (
        <div className="export-jobs-container">
          <h4>Previous Export History</h4>

          <table className="export-table">
            <thead>
              <tr>
                <th>File Name</th>
                <th>Type</th>
                <th>Timestamp</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {sortedExportJobs.map((job) => (
                <tr key={job.jobName}>
                  <td>{job.jobName}</td>
                  <td>
                    {job.mode === "consolidated" ? "Consolidated" : "Scheme Wise"}
                  </td>
                  <td>
                    {job.createdAt ? formatExportTimestamp(job.createdAt) : "—"}
                  </td>
                  <td>
                    <span
                      className={`export-status ${job.status === "COMPLETED"
                          ? "completed"
                          : job.status === "FAILED" || job.status === "ERROR"
                            ? "failed"
                            : "pending"
                        }`}
                    >
                      {job.status}
                    </span>
                  </td>
                  <td>
                    {job.status === "COMPLETED" ? (
                      <button
                        className="export-btn"
                        onClick={() => handleExportAllDownload(job.asOnDate, job.mode)}
                      >
                        Download
                      </button>
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
  );
}

export default HoldingsTab;
