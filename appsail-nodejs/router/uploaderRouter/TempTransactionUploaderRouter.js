import express from "express";
import fileUpload from "express-fileupload";

import {
  uploadTempTransaction,
  listUploadHistory,
  downloadUploadHistory,
} from "../../controller/uploader/TempTransactionUpload.js";

const router = express.Router();

// router.use(fileUpload());

// POST /api/transaction-uploader/upload-temp-file
router.post("/upload-temp-file", uploadTempTransaction);

// GET /api/transaction-uploader/upload-history?limit=&cursor=&search=
router.get("/upload-history", listUploadHistory);

// GET /api/transaction-uploader/upload-history/download?key=…
router.get("/upload-history/download", downloadUploadHistory);

export default router;
