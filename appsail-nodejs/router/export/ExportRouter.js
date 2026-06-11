import express from "express";
import { exportDataPerAccount } from "../../controller/export/exportHolding/exportSingleClientHolding.js";
import { exportConsolidatedPerActual } from "../../controller/export/exportHolding/exportConsolidatedHolding.js";
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
  exportAllClientsCash,
  getAllClientsCashExportStatus,
  downloadAllClientsCashExport,
} from "../../controller/export/exportCashBalance/exportAllClientsCash.js";

const router = express.Router();

// holding export
router.get("/export-all", exportAllData);
router.get("/export-single", exportDataPerAccount);
router.get("/export-consolidated", exportConsolidatedPerActual);
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

export default router;
