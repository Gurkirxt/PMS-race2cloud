import express from "express";
import {
  previewStockDividend,
  getAllSecuritiesISINs,
  applyStockDividendMaster,
  getDividendApplyStatus,
} from "../../controller/uploader/DividendUploader.js";
import { exportDividendPreviewFile, getDividendExportStatus, downloadDividendExportFile } from "../../controller/export/exportDividend/exportDividendFile.js";
const router = express.Router();
router.get("/getAllSecuritiesList", getAllSecuritiesISINs);
router.post("/preview", previewStockDividend);
router.post("/apply", applyStockDividendMaster);
router.get("/apply-status", getDividendApplyStatus);
router.get("/export-preview", exportDividendPreviewFile);
router.get("/export-status", getDividendExportStatus);
router.get("/export-download", downloadDividendExportFile);





export default router;