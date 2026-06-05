import express from "express";
import fileUpload from "express-fileupload";

import {
  uploadTempTransaction,
  handleBulkCallback,
  listUploadHistory,
  downloadUploadHistory,
} from "../../controller/uploader/TempTransactionUpload.js";

const router = express.Router();

// File upload middleware — required for the upload-temp-file route.
router.use(fileUpload());

// POST /api/transaction-uploader/upload-temp-file
router.post("/upload-temp-file", uploadTempTransaction);

// POST /api/transaction-uploader/bulk-callback
// Catalyst calls this automatically when the bulk write job completes.
router.post("/bulk-callback", handleBulkCallback);

// GET /api/transaction-uploader/upload-history?limit=&cursor=&search=
router.get("/upload-history", listUploadHistory);

// GET /api/transaction-uploader/upload-history/download?key=…
router.get("/upload-history/download", downloadUploadHistory);

export default router;
