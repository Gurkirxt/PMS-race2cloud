import React, { useCallback, useEffect, useState } from "react";
import MainLayout from "../../layouts/MainLayout";
import { BASE_URL } from "../../constant";
import "./TempTransaction.css";

/** Show only the most recent N uploads — no pagination. */
const HISTORY_LIMIT = 5;

/** "1.23 MB" / "456 KB" / "78 B" — null/undefined → "—". */
function formatBytes(bytes) {
    if (bytes == null || Number.isNaN(Number(bytes))) return "—";
    const n = Number(bytes);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** ISO string → "12 May 2026, 4:53 pm" (locale). */
function formatUploadedAt(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString();
}

/**
 * @typedef {Object} HeaderMismatch
 * @property {number} columnIndex
 * @property {string} expected
 * @property {string} actual
 */

/**
 * @typedef {Object} UploadErrorDetail
 * @property {string} message
 * @property {string} [code]
 * @property {string} [kind]
 * @property {string[]} [missingHeaders]
 * @property {HeaderMismatch[]} [mismatches]
 * @property {number} [expectedCount]
 * @property {number} [actualCount]
 * @property {string[]} [expectedHeaders]
 * @property {string} [hint]
 * @property {string[]} [fields]
 * @property {string[]} [headerNamesToFix]
 * @property {number} [row]
 * @property {number} [dataRowIndex]
 * @property {number} [sampleRowsValidated]
 */

const TempTransaction = () => {
    const [file, setFile] = useState(null);
    const [uploadLoading, setUploadLoading] = useState(false);
    const [uploadMessage, setUploadMessage] = useState("");
    const [uploadError, setUploadError] = useState("");
    /** @type {[UploadErrorDetail | null, React.Dispatch<React.SetStateAction<UploadErrorDetail | null>>]} */
    const [uploadErrorDetail, setUploadErrorDetail] = useState(null);

    /** @type {[Array<{ key: string; originalFileName: string; uploadedAt: string; uploadedAtMs: number; sizeBytes: number; }>, React.Dispatch<React.SetStateAction<any[]>>]} */
    const [historyItems, setHistoryItems] = useState([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyError, setHistoryError] = useState("");
    const [downloadingKey, setDownloadingKey] = useState("");

    const handleFileChange = (e) => {
        setFile(e.target.files[0] || null);
        setUploadError("");
        setUploadErrorDetail(null);
        setUploadMessage("");
    };

    const refreshHistory = useCallback(async () => {
        setHistoryLoading(true);
        setHistoryError("");
        try {
            const res = await fetch(
                `${BASE_URL}/transaction-uploader/upload-history?limit=${HISTORY_LIMIT}`
            );
            const text = await res.text();
            let data = {};
            try {
                data = text ? JSON.parse(text) : {};
            } catch {
                throw new Error(
                    "Could not read upload history (server did not return JSON)."
                );
            }
            if (!res.ok || data?.success === false) {
                throw new Error(
                    data?.message || `Failed to load upload history (${res.status}).`
                );
            }
            setHistoryItems(Array.isArray(data.items) ? data.items.slice(0, HISTORY_LIMIT) : []);
        } catch (err) {
            const isNetwork =
                err instanceof TypeError ||
                String(err?.message || "").toLowerCase().includes("failed to fetch");
            setHistoryError(
                isNetwork
                    ? "Could not reach the upload server."
                    : err.message || "Failed to load upload history"
            );
            setHistoryItems([]);
        } finally {
            setHistoryLoading(false);
        }
    }, []);

    useEffect(() => {
        refreshHistory();
    }, [refreshHistory]);

    const handleHistoryDownload = useCallback(async (item) => {
        if (!item?.key) return;
        setDownloadingKey(item.key);
        try {
            const res = await fetch(
                `${BASE_URL}/transaction-uploader/upload-history/download?key=${encodeURIComponent(item.key)}`
            );
            const text = await res.text();
            let data = {};
            try {
                data = text ? JSON.parse(text) : {};
            } catch {
                throw new Error("Could not read download response.");
            }
            if (!res.ok || data?.success === false || !data?.downloadUrl) {
                throw new Error(
                    data?.message || `Could not get download link (${res.status}).`
                );
            }
            // Open the presigned URL in a new tab so the user keeps the page state.
            window.open(data.downloadUrl, "_blank", "noopener,noreferrer");
        } catch (err) {
            setHistoryError(err.message || "Failed to download file");
        } finally {
            setDownloadingKey("");
        }
    }, []);

    const handleUpload = async () => {
        setUploadError("");
        setUploadErrorDetail(null);
        setUploadMessage("");

        if (!file) {
            setUploadError("Please choose a transaction CSV file first.");
            return;
        }

        setUploadLoading(true);

        try {
            const formData = new FormData();
            formData.append("file", file);

            const res = await fetch(
                `${BASE_URL}/transaction-uploader/upload-temp-file`,
                {
                    method: "POST",
                    body: formData,
                }
            );

            let data = {};
            try {
                const text = await res.text();
                if (text) {
                    data = JSON.parse(text);
                }
            } catch {
                data = {};
            }

            if (!res.ok) {
                /** @type {UploadErrorDetail} */
                const detail = {
                    message:
                        data?.message ||
                        `Upload failed (${res.status}). Please try again.`,
                    code: data?.code,
                    kind: data?.kind,
                    missingHeaders: data?.missingHeaders,
                    mismatches: data?.mismatches,
                    expectedCount: data?.expectedCount,
                    actualCount: data?.actualCount,
                    expectedHeaders: data?.expectedHeaders,
                    hint: data?.hint,
                    fields: data?.fields,
                    headerNamesToFix: data?.headerNamesToFix,
                    row: data?.row,
                    dataRowIndex: data?.dataRowIndex,
                    sampleRowsValidated: data?.sampleRowsValidated,
                };
                setUploadErrorDetail(detail);
                setUploadError(detail.message);
                return;
            }

            setUploadMessage("File uploaded successfully.");
            refreshHistory();
        } catch (err) {
            const isNetwork =
                err instanceof TypeError ||
                String(err?.message || "").toLowerCase().includes("failed to fetch");
            setUploadError(
                isNetwork
                    ? "Could not reach the upload server."
                    : err.message || "Upload failed"
            );
            setUploadErrorDetail(null);
        } finally {
            setUploadLoading(false);
        }
    };

    return (
        <MainLayout title="Transaction Upload">
            <div className="temp-transaction-container">
                <div className="temp-transaction-card">
                    <h3>Transaction File (.csv)</h3>
                    <div className="upload-controls">
                        <div className="file-input-wrapper">
                            <input
                                type="file"
                                accept=".csv"
                                onChange={handleFileChange}
                                id="file-upload"
                            />
                        </div>
                        <button
                            className="upload-button"
                            onClick={handleUpload}
                            disabled={!file || uploadLoading}
                        >
                            {uploadLoading ? "Uploading..." : "Upload Transaction"}
                        </button>
                    </div>

                    {uploadMessage && (
                        <p style={{ marginTop: '20px', color: '#059669', fontSize: '14px', padding: '10px', backgroundColor: '#f0fdf4', borderRadius: '8px' }}>
                            {uploadMessage}
                        </p>
                    )}

                    {uploadError && (
                        <div
                            role="alert"
                            style={{
                                marginTop: "20px",
                                color: "#b91c1c",
                                fontSize: "14px",
                                padding: "12px",
                                backgroundColor: "#fee2e2",
                                borderRadius: "8px",
                            }}
                        >
                            <p style={{ margin: "0 0 8px", whiteSpace: "pre-line" }}>
                                {uploadError}
                            </p>
                            {uploadErrorDetail?.code === "WRONG_COLUMN_ORDER" &&
                            uploadErrorDetail?.kind === "COUNT" &&
                            uploadErrorDetail.expectedCount != null &&
                            uploadErrorDetail.actualCount != null ? (
                                <p style={{ margin: "8px 0 0", fontSize: "13px" }}>
                                    <strong>Template columns:</strong>{" "}
                                    {uploadErrorDetail.expectedCount} &nbsp;|&nbsp;{" "}
                                    <strong>Your row 1 columns:</strong>{" "}
                                    {uploadErrorDetail.actualCount}
                                </p>
                            ) : null}
                            {uploadErrorDetail?.mismatches?.length ? (
                                <div style={{ marginTop: "12px" }}>
                                    <strong style={{ display: "block", marginBottom: "8px" }}>
                                        Wrong column order or header name — fix these positions
                                        (column # = left to right in row 1):
                                    </strong>
                                    <table
                                        style={{
                                            width: "100%",
                                            borderCollapse: "collapse",
                                            fontSize: "13px",
                                            background: "#fef2f2",
                                            borderRadius: "6px",
                                            overflow: "hidden",
                                        }}
                                    >
                                        <thead>
                                            <tr style={{ textAlign: "left", background: "#fecaca" }}>
                                                <th style={{ padding: "8px" }}>#</th>
                                                <th style={{ padding: "8px" }}>Expected header</th>
                                                <th style={{ padding: "8px" }}>Your header</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {uploadErrorDetail.mismatches.map((m) => (
                                                <tr key={m.columnIndex}>
                                                    <td style={{ padding: "8px", fontWeight: 600 }}>
                                                        {m.columnIndex}
                                                    </td>
                                                    <td style={{ padding: "8px" }}>
                                                        <code
                                                            style={{
                                                                background: "#fee2e2",
                                                                padding: "2px 6px",
                                                                borderRadius: "4px",
                                                            }}
                                                        >
                                                            {m.expected}
                                                        </code>
                                                    </td>
                                                    <td style={{ padding: "8px" }}>
                                                        <code
                                                            style={{
                                                                background: "#fecaca",
                                                                padding: "2px 6px",
                                                                borderRadius: "4px",
                                                            }}
                                                        >
                                                            {m.actual || "(empty)"}
                                                        </code>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            ) : null}
                            {uploadErrorDetail?.missingHeaders?.length ? (
                                <div style={{ marginTop: "10px" }}>
                                    <strong style={{ display: "block", marginBottom: "6px" }}>
                                        Update row 1 — use these headers exactly (same spelling and
                                        capital letters):
                                    </strong>
                                    <ul
                                        style={{
                                            margin: 0,
                                            paddingLeft: "1.25rem",
                                            lineHeight: 1.5,
                                        }}
                                    >
                                        {uploadErrorDetail.missingHeaders.map((h) => (
                                            <li key={h}>
                                                <code
                                                    style={{
                                                        background: "#fecaca",
                                                        padding: "2px 6px",
                                                        borderRadius: "4px",
                                                        fontSize: "13px",
                                                    }}
                                                >
                                                    {h}
                                                </code>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ) : null}
                            {uploadErrorDetail?.fields?.length ? (
                                <div style={{ margin: "10px 0 0", fontSize: "13px" }}>
                                    <p style={{ margin: "0 0 6px" }}>
                                        <strong>Date columns to fix:</strong>{" "}
                                        {uploadErrorDetail.fields.map((f) => (
                                            <code
                                                key={f}
                                                style={{
                                                    background: "#fecaca",
                                                    padding: "2px 6px",
                                                    borderRadius: "4px",
                                                    marginRight: "6px",
                                                }}
                                            >
                                                {f}
                                            </code>
                                        ))}
                                    </p>
                                    {uploadErrorDetail.code === "INVALID_DATE_FORMAT" ? (
                                        <p style={{ margin: 0, opacity: 0.95 }}>
                                            {uploadErrorDetail.sampleRowsValidated != null ? (
                                                <span>
                                                    Checked first{" "}
                                                    <strong>{uploadErrorDetail.sampleRowsValidated}</strong>{" "}
                                                    data row(s).{" "}
                                                </span>
                                            ) : null}
                                            {uploadErrorDetail.dataRowIndex != null &&
                                            uploadErrorDetail.row != null ? (
                                                <span>
                                                    Issue in sample data row{" "}
                                                    <strong>{uploadErrorDetail.dataRowIndex}</strong> (CSV line{" "}
                                                    <strong>{uploadErrorDetail.row}</strong>).
                                                </span>
                                            ) : uploadErrorDetail.row != null ? (
                                                <span>CSV line {uploadErrorDetail.row}.</span>
                                            ) : null}
                                        </p>
                                    ) : null}
                                </div>
                            ) : null}
                            {uploadErrorDetail?.hint &&
                            !uploadErrorDetail?.expectedHeaders?.length ? (
                                <p
                                    style={{
                                        marginTop: "12px",
                                        marginBottom: 0,
                                        padding: "12px",
                                        background: "#fff7ed",
                                        border: "1px solid #fed7aa",
                                        borderRadius: "8px",
                                        fontSize: "13px",
                                        color: "#9a3412",
                                    }}
                                >
                                    <strong>Action required:</strong> {uploadErrorDetail.hint}
                                </p>
                            ) : null}
                            {uploadErrorDetail?.expectedHeaders?.length ? (
                                <details style={{ marginTop: "12px", fontSize: "13px" }}>
                                    <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                                        Official header order (1 → {uploadErrorDetail.expectedHeaders.length})
                                    </summary>
                                    <pre
                                        style={{
                                            margin: "8px 0 0",
                                            padding: "10px",
                                            background: "#fef2f2",
                                            borderRadius: "6px",
                                            overflowX: "auto",
                                            fontSize: "12px",
                                            lineHeight: 1.5,
                                        }}
                                    >
                                        {uploadErrorDetail.expectedHeaders
                                            .map((h, i) => `${i + 1}. ${h}`)
                                            .join("\n")}
                                    </pre>
                                    {uploadErrorDetail.hint ? (
                                        <p style={{ margin: "8px 0 0", opacity: 0.9 }}>
                                            {uploadErrorDetail.hint}
                                        </p>
                                    ) : null}
                                </details>
                            ) : null}
                        </div>
                    )}
                </div>

                <div className="temp-transaction-card upload-history-card">
                    <h3>Recent Uploads</h3>

                    {historyError && (
                        <p className="upload-history-error" role="alert">
                            {historyError}
                        </p>
                    )}

                    <div className="upload-history-table-wrapper">
                        <table className="upload-history-table">
                            <thead>
                                <tr>
                                    <th>Uploaded date</th>
                                    <th>File name</th>
                                    <th className="num">Size</th>
                                    <th className="action">Download</th>
                                </tr>
                            </thead>
                            <tbody>
                                {historyLoading && historyItems.length === 0 ? (
                                    <tr>
                                        <td colSpan={4} className="empty-cell">
                                            Loading…
                                        </td>
                                    </tr>
                                ) : historyItems.length === 0 ? (
                                    <tr>
                                        <td colSpan={4} className="empty-cell">
                                            {historyError ? "—" : "No uploads yet."}
                                        </td>
                                    </tr>
                                ) : (
                                    historyItems.map((item) => (
                                        <tr key={item.key}>
                                            <td>{formatUploadedAt(item.uploadedAt)}</td>
                                            <td className="filename-cell" title={item.originalFileName}>
                                                {item.originalFileName}
                                            </td>
                                            <td className="num">{formatBytes(item.sizeBytes)}</td>
                                            <td className="action">
                                                <button
                                                    type="button"
                                                    className="upload-history-download-btn"
                                                    onClick={() => handleHistoryDownload(item)}
                                                    disabled={downloadingKey === item.key}
                                                >
                                                    {downloadingKey === item.key ? "Preparing…" : "Download"}
                                                </button>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </MainLayout>
    );
};

export default TempTransaction;