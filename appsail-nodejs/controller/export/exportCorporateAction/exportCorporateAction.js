// appsail-nodejs/controller/export/exportCorporateAction/exportCorporateAction.js

const BATCH_SIZE = 200;

const esc = (s) => String(s ?? "").replace(/'/g, "''");

const parseCatalystTime = (ct) => {
  if (!ct) return 0;
  // Catalyst CREATEDTIME is an IST (UTC+05:30) wall-clock string like
  // "2026-06-19 17:41:28:675". Parse explicitly as IST so the AppSail server's
  // own timezone (UTC) doesn't shift it +5:30.
  const iso = String(ct).trim().replace(" ", "T").replace(/:(\d{3})$/, ".$1");
  const ms = new Date(`${iso}+05:30`).getTime();
  return isNaN(ms) ? 0 : ms;
};

/** Query param → yyyy-mm-dd without shifting calendar day when value is already ISO date. */
function toIsoDateParam(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().split("T")[0];
}

/** Exclusive end for range filters: first calendar day after toISO. */
function addOneCalendarDayUtc(iso) {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function pickFirstDefined(obj, keys) {
  for (const k of keys) {
    if (!obj || !(k in obj)) continue;
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}

export const getCorporateActionHistory = async (req, res) => {
  try {
    if (!req.catalystApp) {
      return res.status(500).json([]);
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 20);
    const zcql = req.catalystApp.zcql();

    const rows = await zcql.executeZCQLQuery(
      `SELECT jobName, status, CREATEDTIME FROM Jobs WHERE jobName LIKE 'CAALL_*' ORDER BY ROWID DESC LIMIT ${limit}`
    );

    const list = rows.map((row) => {
      const jobName = row.Jobs.jobName;
      const status = row.Jobs.status;
      const createdAtMs = parseCatalystTime(row.Jobs.CREATEDTIME);

      // jobName shape: CAALL_<fromISO>_<toISO>_<epochMs>
      const parts = jobName.split("_");
      const fromDate = parts[1] || "";
      const toDate = parts[2] || "";

      return {
        jobName,
        fromDate,
        toDate,
        status,
        createdAt:
          createdAtMs > 0
            ? new Date(createdAtMs).toISOString()
            : new Date().toISOString(),
      };
    });

    return res.json(list);
  } catch (err) {
    console.error("CORPORATE ACTION HISTORY ERROR:", err);
    return res.status(500).json([]);
  }
};

export const exportCorporateAction = async (req, res) => {
  try {
    if (!req.catalystApp) {
      return res.status(500).json({ success: false, message: "Catalyst not initialized" });
    }

    const { fromDate, toDate } = req.query;

    if (!fromDate || !toDate) {
      return res.status(400).json({
        success: false,
        message: "fromDate and toDate are required",
      });
    }

    const fromISO = toIsoDateParam(fromDate);
    const toISO = toIsoDateParam(toDate);

    if (!fromISO || !toISO) {
      return res.status(400).json({
        success: false,
        message: "fromDate and toDate must be valid dates (yyyy-mm-dd)",
      });
    }

    if (fromISO > toISO) {
      return res.status(400).json({
        success: false,
        message: "fromDate must be less than or equal to toDate",
      });
    }

    const catalystApp = req.catalystApp;
    const zcql = catalystApp.zcql();
    const dayAfterToISO = addOneCalendarDayUtc(toISO);

    /* ---------- BONUS ROWS from Bonus_Record (ExDate between fromDate and toDate) ---------- */
    const bonusRows = [];
    let offset = 0;

    while (true) {
      const rows = await zcql.executeZCQLQuery(`
        SELECT SecurityCode, SecurityName, Ratio1, Ratio2, ExDate, ISIN, EXCHG, SCHEMENAME
        FROM Bonus_Record
        WHERE ExDate >= '${fromISO}' AND ExDate <= '${toISO}'
        ORDER BY ExDate ASC, ROWID ASC
        LIMIT ${BATCH_SIZE} OFFSET ${offset}
      `);

      if (!rows.length) break;
      bonusRows.push(...rows);
      if (rows.length < BATCH_SIZE) break;
      offset += BATCH_SIZE;
    }

    /* ---------- SPLIT ROWS (Issue_Date between fromDate and toDate) ---------- */
    const splitRows = [];
    offset = 0;

    while (true) {
      const rows = await zcql.executeZCQLQuery(`
        SELECT ISIN, Issue_Date, Ratio1, Ratio2, Security_Code, Security_Name
        FROM Split
        WHERE Issue_Date >= '${fromISO}' AND Issue_Date <= '${toISO}'
        ORDER BY Issue_Date ASC, ROWID ASC
        LIMIT ${BATCH_SIZE} OFFSET ${offset}
      `);

      if (!rows.length) break;
      splitRows.push(...rows);
      if (rows.length < BATCH_SIZE) break;
      offset += BATCH_SIZE;
    }
     /* ---------- DIVIDEND ROWS (ExDate between fromDate and toDate) ---------- */
     const dividendRows = [];
     offset = 0;
 
     while (true) {
       const rows = await zcql.executeZCQLQuery(`
         SELECT SecurityCode, Security_Name, ISIN, Rate, ExDate, RecordDate, PaymentDate, Dividend_Type
         FROM Dividend
         WHERE RecordDate>= '${fromISO}' AND RecordDate <= '${toISO}'
         ORDER BY RecordDate ASC, ROWID ASC
         LIMIT ${BATCH_SIZE} OFFSET ${offset}
       `);
 
       if (!rows.length) break;
       dividendRows.push(...rows);
       if (rows.length < BATCH_SIZE) break;
       offset += BATCH_SIZE;
     }

    /* ---------- DEMERGER MASTER (Effective_Date between fromDate and toDate) ---------- */
    const demergerRows = [];
    offset = 0;

    while (true) {
      const rows = await zcql.executeZCQLQuery(`
        SELECT Old_ISIN, Old_Security_Code, Old_Security_Name, New_ISIN, New_Security_Code, New_Security_Name,
               Ratio1, Ratio2, Effective_Date, Record_Date, Allocation_To_New_Pct
        FROM Demerger
        WHERE (Effective_Date >= '${fromISO}' AND Effective_Date < '${dayAfterToISO}')
           OR (Record_Date >= '${fromISO}' AND Record_Date < '${dayAfterToISO}')
        ORDER BY ROWID ASC
        LIMIT ${BATCH_SIZE} OFFSET ${offset}
      `);

      if (!rows.length) break;
      demergerRows.push(...rows);
      if (rows.length < BATCH_SIZE) break;
      offset += BATCH_SIZE;
    }

    /* ---------- MERGER master row per apply (Merger_Record, TRANDATE in range) ---------- */
    const mergerRecordRows = [];
    offset = 0;

    while (true) {
      const rows = await zcql.executeZCQLQuery(`
        SELECT ISIN, Security_Code, Security_Name, OldISIN, Ratio1, Ratio2, TRANDATE, SETDATE
        FROM Merger_Record
        WHERE TRANDATE >= '${fromISO}' AND TRANDATE <= '${toISO}'
        ORDER BY TRANDATE ASC, ROWID ASC
        LIMIT ${BATCH_SIZE} OFFSET ${offset}
      `);

      if (!rows.length) break;
      mergerRecordRows.push(...rows);
      if (rows.length < BATCH_SIZE) break;
      offset += BATCH_SIZE;
    }

    /* ---------- DEDUPE BONUS BY (ExDate, SecurityCode, SecurityName, ISIN) ---------- */
    const bonusByEvent = {};
    for (const r of bonusRows) {
      const b = r.Bonus_Record || r;
      const exDate = b.ExDate ?? "";
      const securityCode = b.SecurityCode ?? "";
      const securityName = b.SecurityName ?? "";
      const isin = b.ISIN ?? "";
      const key = `${exDate}|${securityCode}|${securityName}|${isin}`;
      if (!bonusByEvent[key]) {
        const isinNorm = String(isin ?? "").trim();
        bonusByEvent[key] = {
          date: exDate,
          ratio1: b.Ratio1 ?? "",
          ratio2: b.Ratio2 ?? "",
          type: "bonus",
          securityCode: securityCode || "-",
          securityName: securityName || "-",
          oldIsin: isinNorm && isinNorm !== "-" ? isinNorm : "",
          newIsin: "",
          effectiveDate: exDate,
          recordDate: "",
          allocationToNewPct: "",
        };
      }
    }
    const bonusEvents = Object.values(bonusByEvent);

    /* ---------- NORMALIZE SPLIT ROWS ---------- */
    const splitEvents = [];
    for (const r of splitRows) {
      const s = r.Split || r;
      const securityCode = s.Security_Code ?? "";
      const securityName = s.Security_Name ?? "";
      const splitIsin = String(s.ISIN ?? "").trim();
      splitEvents.push({
        date: s.Issue_Date ?? "",
        ratio1: s.Ratio1 ?? "",
        ratio2: s.Ratio2 ?? "",
        type: "split",
        securityCode: securityCode || "-",
        securityName: securityName || "-",
        oldIsin: splitIsin && splitIsin !== "-" ? splitIsin : "",
        newIsin: "",
        effectiveDate: s.Issue_Date ?? "",
        recordDate: "",
        allocationToNewPct: "",
      });
    }
    /* ---------- NORMALIZE DIVIDEND ROWS ---------- */
    const dividendEvents = [];
    for (const r of dividendRows) {
      const d = r.Dividend || r;
      const divIsin = String(d.ISIN ?? "").trim();
      dividendEvents.push({
        date: d.RecordDate ?? "",
        ratio1: "",
        ratio2: "",
        type: "dividend",
        securityCode: d.SecurityCode ?? "-",
        securityName: d.Security_Name ?? "-",
        rate: d.Rate ?? "",
        paymentDate: d.PaymentDate ?? "",
        dividendType: d.Dividend_Type ?? "",
        oldIsin: divIsin && divIsin !== "-" ? divIsin : "",
        newIsin: "",
        effectiveDate: d.ExDate ?? "",
        recordDate: d.RecordDate ?? "",
        allocationToNewPct: "",
      });
    }

    /* ---------- NORMALIZE DEMERGER (master Demerger table; dedupe by event key) ---------- */
    const demergerByEvent = {};
    for (const r of demergerRows) {
      const d = r.Demerger || r;
      const eff = String(
        pickFirstDefined(d, [
          "Effective_Date",
          "effective_date",
          "EFFECTIVE_DATE",
        ]),
      ).trim();
      const oldIsin = String(
        pickFirstDefined(d, ["Old_ISIN", "old_isin", "OLD_ISIN"]),
      ).trim();
      const newIsin = String(
        pickFirstDefined(d, ["New_ISIN", "new_isin", "NEW_ISIN"]),
      ).trim();
      const recordDt = String(
        pickFirstDefined(d, ["Record_Date", "record_date", "RECORD_DATE"]),
      ).trim();
      const rowId = d.ROWID ?? d.rowid ?? "";
      const key = `${eff}|${recordDt}|${oldIsin}|${newIsin}|${rowId}`;
      if (!demergerByEvent[key]) {
        const oldName = String(
          pickFirstDefined(d, [
            "Old_Security_Name",
            "old_security_name",
            "OLD_SECURITY_NAME",
          ]),
        ).trim();
        const newName = String(
          pickFirstDefined(d, [
            "New_Security_Name",
            "new_security_name",
            "NEW_SECURITY_NAME",
          ]),
        ).trim();
        const alloc = pickFirstDefined(d, [
          "Allocation_To_New_Pct",
          "allocation_to_new_pct",
          "ALLOCATION_TO_NEW_PCT",
        ]);
        const allocOut =
          alloc !== "" && alloc != null && !Number.isNaN(Number(alloc)) ? String(alloc) : "";
        const sortDate = eff || recordDt;
        const oldCode = String(
          pickFirstDefined(d, [
            "Old_Security_Code",
            "old_security_code",
            "OLD_SECURITY_CODE",
          ]),
        ).trim();
        const r1 = pickFirstDefined(d, ["Ratio1", "ratio1", "RATIO1"]);
        const r2 = pickFirstDefined(d, ["Ratio2", "ratio2", "RATIO2"]);
        demergerByEvent[key] = {
          date: sortDate,
          ratio1: r1 !== "" && r1 != null ? r1 : "",
          ratio2: r2 !== "" && r2 != null ? r2 : "",
          type: "demerger",
          securityCode: oldCode || "-",
          securityName: newName ? `${oldName || "-"} / ${newName}` : oldName || "-",
          rate: "",
          paymentDate: "",
          dividendType: "",
          oldIsin: oldIsin || "",
          newIsin: newIsin || "",
          effectiveDate: eff,
          recordDate: recordDt,
          allocationToNewPct: allocOut,
        };
      }
    }
    const demergerEvents = Object.values(demergerByEvent);

    /* ---------- NORMALIZE MERGER (Merger_Record; dedupe by event key) ---------- */
    const mergerByEvent = {};
    for (const r of mergerRecordRows) {
      const m = r.Merger_Record || r;
      const td = m.TRANDATE ?? "";
      const newIsin = m.ISIN ?? "";
      const oldIsin = m.OldISIN ?? "";
      const key = `${td}|${newIsin}|${oldIsin}|${m.Ratio1 ?? ""}|${m.Ratio2 ?? ""}`;
      if (!mergerByEvent[key]) {
        const secName = m.Security_Name ?? "";
        mergerByEvent[key] = {
          date: td,
          ratio1: m.Ratio1 ?? "",
          ratio2: m.Ratio2 ?? "",
          type: "merger",
          securityCode: m.Security_Code ?? "-",
          securityName: oldIsin
            ? `${secName || "-"} [merged from ${oldIsin}]`
            : secName || "-",
          rate: "",
          paymentDate: "",
          dividendType: "",
          oldIsin: oldIsin || "",
          newIsin: newIsin || "",
          effectiveDate: td,
          recordDate: m.SETDATE ?? td,
          allocationToNewPct: "",
        };
      }
    }
    const mergerEvents = Object.values(mergerByEvent);

    /* ---------- SINGLE TABLE: MERGE AND SORT BY DATE ---------- */
    const allRows = [
      ...bonusEvents,
      ...splitEvents,
      ...dividendEvents,
      ...demergerEvents,
      ...mergerEvents,
    ].sort((a, b) => (a.date || "").localeCompare(b.date || ""));

    /* ---------- BUILD CSV ---------- */
    const csvHeader =
      "DATE,OLD_ISIN,RATIO1,RATIO2,TYPE,SECURITY_CODE,SECURITY_NAME,Rate,PaymentDate,DividendType," +
      "NEW_ISIN,EFFECTIVE_DATE,RECORD_DATE,ALLOCATION_TO_NEW_PCT\n";
    let csv = csvHeader;
    for (const row of allRows) {
      csv += [
        row.date ? row.date : "",
        row.oldIsin != null && row.oldIsin !== "" ? row.oldIsin : "",
        row.ratio1 ? row.ratio1 : "",
        row.ratio2 ? row.ratio2 : "",
        row.type ? row.type : "",
        row.securityCode ? row.securityCode : "",
        row.securityName ? row.securityName : "",
        row.rate ? row.rate : "",
        row.paymentDate ? row.paymentDate : "",
        row.dividendType ? row.dividendType : "",
        row.newIsin != null && row.newIsin !== "" ? row.newIsin : "",
        row.effectiveDate != null && row.effectiveDate !== "" ? row.effectiveDate : "",
        row.recordDate != null && row.recordDate !== "" ? row.recordDate : "",
        row.allocationToNewPct != null && row.allocationToNewPct !== ""
          ? row.allocationToNewPct
          : "",
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(",") + "\n";
    }

    /* ---------- PERSIST TO HISTORY (Jobs table, survives restarts) ---------- */
    try {
      const jobName = `CAALL_${fromISO}_${toISO}_${Date.now()}`;
      await zcql.executeZCQLQuery(
        `INSERT INTO Jobs (jobName, status) VALUES ('${esc(jobName)}', 'COMPLETED')`
      );
    } catch (historyErr) {
      // Don't fail the export just because the history row couldn't be written.
      console.error("CORPORATE ACTION HISTORY WRITE ERROR:", historyErr);
    }

    /* ---------- RETURN CSV DIRECTLY (same-origin download, no signed URL) ---------- */
    const fileName = `corporate-action-export-${fromISO}-${toISO}.csv`;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    return res.send(csv);
  } catch (err) {
    console.error("EXPORT CORPORATE ACTION ERROR:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Internal server error",
    });
  }
};