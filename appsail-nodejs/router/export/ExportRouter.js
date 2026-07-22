import express from "express";
import { exportDataPerAccount } from "../../controller/export/exportHolding/exportSingleClientHolding.js";
import { exportConsolidatedPerActual } from "../../controller/export/exportHolding/exportConsolidatedHolding.js";
import { exportHoldingsByIsin } from "../../controller/export/exportHolding/exportByIsin.js";
import {
  exportAllData,
  getExportAllJobStatus,
  downloadExportFile,
  getExportAllHistory,
} from "../../controller/export/exportHolding/ExportAllHolding.js";
import { exportTransactionPerAccount } from "../../controller/export/exportTransaction/exportSingleClient.js";
import {
  exportCorporateAction,
  getCorporateActionHistory,
} from "../../controller/export/exportCorporateAction/exportCorporateAction.js";
import {
  startCaImpactReport,
  getCaImpactStatus,
  downloadCaImpactReport,
} from "../../controller/export/exportCorporateAction/exportCaImpactReport.js";
import {
  exportAllClientsCash,
  getAllClientsCashExportStatus,
  downloadAllClientsCashExport,
} from "../../controller/export/exportCashBalance/exportAllClientsCash.js";

const router = express.Router();

// holding export
router.get("/export-all", exportAllData);
router.get("/export-single", exportDataPerAccount);
router.get("/export-consolidated", exportConsolidatedPerActual);
router.get("/export-by-isin", exportHoldingsByIsin);
router.get("/check-status", getExportAllJobStatus);
router.get("/download", downloadExportFile);
router.get("/export-all/history", getExportAllHistory);

// all-clients cash balance snapshot (as on date)
router.get("/cash-all", exportAllClientsCash);
router.get("/cash-all/status", getAllClientsCashExportStatus);
router.get("/cash-all/download", downloadAllClientsCashExport);

// transaction export
router.get("/transaction/export-single", exportTransactionPerAccount);
// corporate action export (fromDate, toDate)
router.get("/corporate-action/export", exportCorporateAction);
router.get("/corporate-action/history", getCorporateActionHistory);

// corporate action per-client impact report (type, fromDate, toDate) — async job
router.get("/corporate-action/report/export", startCaImpactReport);
router.get("/corporate-action/report/status", getCaImpactStatus);
router.get("/corporate-action/report/download", downloadCaImpactReport);

export default router;
