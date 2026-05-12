import express from "express";
import fileUpload from "express-fileupload";
import {
  previewStockDividend,
  getAllSecuritiesISINs,
  applyStockDividendMaster,
  getDividendApplyStatus,
} from "../../controller/uploader/DividendUploader.js";
import { exportDividendPreviewFile, getDividendExportStatus, downloadDividendExportFile } from "../../controller/export/exportDividend/exportDividendFile.js";
const router = express.Router();
router.get("/getAllSecuritiesList", getAllSecuritiesISINs);
/*
 * /preview accepts EITHER application/json OR multipart/form-data
 * (when a custodian CSV is attached). express-fileupload auto-parses
 * multipart bodies; JSON bodies pass straight through.
 */
router.post(
  "/preview",
  fileUpload({
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB cap
    abortOnLimit: true,
  }),
  previewStockDividend,
);
router.post("/apply", applyStockDividendMaster);
router.get("/apply-status", getDividendApplyStatus);
router.get("/export-preview", exportDividendPreviewFile);
router.get("/export-status", getDividendExportStatus);
router.get("/export-download", downloadDividendExportFile);





export default router;