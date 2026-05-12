import { Readable } from "stream";
import csvParser from "csv-parser";

/**
 * Custodian Benefit Collection Report parser.
 *
 * Reads a CSV uploaded from the Dividend page (or a similar custodian
 * benefits report), tolerating header variations between custodians by
 * matching on a normalised header form.
 *
 * Returns:
 *   { rows: NormalisedRow[], headerMap: { logicalKey: rawHeader } }
 *
 * NormalisedRow shape:
 *   {
 *     accountCode, clientName, isin, isinName, caRef,
 *     exDate, recordDate, paymentDate,
 *     rate, holding, gross, tds, net,
 *     status, caType,
 *   }
 *
 * Dates are normalised to ISO yyyy-mm-dd.
 * ISIN strips a trailing currency suffix (e.g. INE467B01029-INR -> INE467B01029).
 * Numeric cells tolerate commas/spaces.
 */

const HEADER_ALIASES = {
  accountCode: ["Client UCC Code", "UCC Code", "UCC", "Account Code", "WS_Account_Code", "WS Account Code"],
  clientName: ["Client Name", "Account Name", "ClientName"],
  isin: ["ISIN", "Isin"],
  isinName: ["ISIN Name", "Security Name", "Isin Name", "Scrip Name"],
  caRef: ["CA Ref. No.", "CA Ref No", "CA Reference Number", "CA Ref No.", "CA Ref"],
  exDate: ["Ex-Date", "Ex Date", "ExDate"],
  recordDate: ["Record Date", "RecordDate", "Book Closure To Date"],
  paymentDate: [
    "Tentative Payment Date",
    "Payment Date",
    "PaymentDate",
    "Received Date",
    "Pay Date",
  ],
  rate: ["Dividend Rate", "Rate", "Per Share Rate"],
  holding: ["Holding Qty", "Holding Quantity", "Holding", "Quantity"],
  gross: ["CA Amount", "Gross Amount", "Dividend Amount", "Gross"],
  tds: ["CA TaxAmt", "Tax Amount", "TDS", "TDS Amount", "Tax"],
  net: ["Received Amount", "Net Amount", "Net"],
  status: ["Event Status", "Status"],
  caType: ["CA Type Description", "CA Type", "Event Type"],
};

const normaliseHeader = (h) =>
  String(h || "")
    .trim()
    .toLowerCase()
    .replace(/[\s.\-_/()]+/g, "");

const buildHeaderMap = (rawHeaders) => {
  const map = {};
  const normalised = rawHeaders.map((h) => ({ raw: h, norm: normaliseHeader(h) }));
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const aliasNorms = aliases.map(normaliseHeader);
    const found = normalised.find((h) => aliasNorms.includes(h.norm));
    if (found) map[key] = found.raw;
  }
  return map;
};

const stripIsinSuffix = (s) => {
  const str = String(s || "").trim();
  if (!str) return "";
  // Most depositories suffix ISIN with currency e.g. INE467B01029-INR
  const dashIdx = str.indexOf("-");
  return dashIdx > 0 ? str.slice(0, dashIdx) : str;
};

const parseDate = (s) => {
  if (s == null) return null;
  const str = String(s).trim();
  if (!str) return null;

  // ISO-like: 2026-01-17 or 2026-01-17 00:00:00
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  // dd/mm/yyyy or dd-mm-yyyy
  const dmyMatch = str.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})/);
  if (dmyMatch) {
    const [, d, m, y] = dmyMatch;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  // Last resort: Date.parse
  const dt = new Date(str);
  if (!Number.isNaN(dt.getTime())) {
    return dt.toISOString().split("T")[0];
  }
  return null;
};

const num = (s) => {
  if (s == null || s === "") return 0;
  const n = Number(String(s).replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

export const parseCustodianCsv = (buffer) =>
  new Promise((resolve, reject) => {
    const rows = [];
    let headerMap = null;
    let headerSeen = false;

    Readable.from(buffer)
      .pipe(csvParser())
      .on("headers", (headers) => {
        headerMap = buildHeaderMap(headers);
        headerSeen = true;
      })
      .on("data", (row) => {
        if (!headerMap) return;
        const get = (key) => (headerMap[key] ? row[headerMap[key]] : undefined);
        const accountCode = String(get("accountCode") || "").trim();
        if (!accountCode) return;
        rows.push({
          accountCode,
          clientName: String(get("clientName") || "").trim(),
          isin: stripIsinSuffix(get("isin")),
          isinName: String(get("isinName") || "").trim(),
          caRef: String(get("caRef") || "").trim(),
          exDate: parseDate(get("exDate")),
          recordDate: parseDate(get("recordDate")),
          paymentDate: parseDate(get("paymentDate")),
          rate: num(get("rate")),
          holding: num(get("holding")),
          gross: num(get("gross")),
          tds: num(get("tds")),
          net: num(get("net")),
          status: String(get("status") || "").trim(),
          caType: String(get("caType") || "").trim(),
        });
      })
      .on("end", () => {
        if (!headerSeen) {
          reject(new Error("CSV appears to be empty or has no headers"));
          return;
        }
        resolve({ rows, headerMap });
      })
      .on("error", (err) => reject(err));
  });
