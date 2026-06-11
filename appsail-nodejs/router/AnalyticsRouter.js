import Express from "express";
import {
  getAllAccountCodes,
  getAllActualCodes,
  getHoldingsSummarySimple,
} from "../controller/analytics/tabs/holding/AnalyticsControllers.js";
import {
  getPaginatedTransactions,
  getSecurityNameOptions,
} from "../controller/analytics/tabs/transaction/transaction.js";
import { getCashBalanceSummary } from "../controller/analytics/tabs/holding/CashController.js";
const router = Express.Router();

router.get("/getAllAccountCodes", getAllAccountCodes);
router.get("/getAllActualCodes", getAllActualCodes);
router.get("/getHoldingsSummarySimple", getHoldingsSummarySimple);
router.get("/getPaginatedTransactions", getPaginatedTransactions);
router.get("/getSecurityNameOptions", getSecurityNameOptions);
router.get("/getCashBalanceSummary", getCashBalanceSummary);
router.get("/", async (req, res) => {
  res.status(200).json({
    status: "success",
    message: "Analytics API working",
  });
});

export default router;
