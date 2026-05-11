import express from "express";
import {
  previewDemerger,
  applyDemerger,
  getDemergerApplyStatus,
} from "../controller/uploader/DemergerController.js";

const router = express.Router();

router.post("/preview", previewDemerger);
router.post("/apply", applyDemerger);
router.get("/apply-status", getDemergerApplyStatus);

export default router;
