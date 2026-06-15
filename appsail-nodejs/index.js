import Express from "express";
const app = Express();
const port = process.env.X_ZOHO_CATALYST_LISTEN_PORT || 9000;
import cors from "cors";

import AnalyticsRouter from "./router/AnalyticsRouter.js";
import TransactionsRouter from "./router/TransactionRouter.js";
import DashboardRouter from "./router/DashboardRouter.js";
import SplitRouter from "./router/SplitRouter.js";
import ExportRouter from "./router/export/ExportRouter.js";
import catalyst from "zcatalyst-sdk-node";
import BhavUploaderRouter from "./router/uploaderRouter/BhavUploaderRouter.js";
import TempTransactionUploaderRouter from "./router/uploaderRouter/TempTransactionUploaderRouter.js";
import CashBalanceRouter from "./router/cashBalanceRouter/CashbalanceRouter.js";
import BonusRouter from "./router/BonusRouter.js";
import DividendUploaderRouter from "./router/uploaderRouter/DividendUploaderRouter.js";
import IsinRouter from "./router/IsinRouter.js";
import DemergerRouter from "./router/DemergerRouter.js";
import MergerRouter from "./router/MergerRouter.js";
import ClientRouter from "./router/clientRouter/ClientRouter.js";
import SecurityRouter from "./router/securityRouter/SecurityRouter.js";

app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use(Express.json());
app.use(Express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  try {
    const app = catalyst.initialize(req);
    req.catalystApp = app;
    next();
  } catch (err) {
    console.error("Catalyst initialization error:", err);
    req.catalystApp = null;
    next();
  }
});

app.get("/", (req, res) => {
  // Catalyst app is already available via middleware (req.catalystApp)
  res.status(200).json({
    status: "ok",
    service: "server",
    message: "Catalyst Express backend is running",
  });
});

app.use("/api/analytics", AnalyticsRouter);
app.use("/api/transaction", TransactionsRouter);
app.use("/api/dashboard", DashboardRouter);
app.use("/api/split", SplitRouter);
app.use("/api/export", ExportRouter);
app.use("/api/bhav", BhavUploaderRouter);
app.use("/api/transaction-uploader", TempTransactionUploaderRouter);
app.use("/api/cash-balance", CashBalanceRouter);
app.use("/api/bonus", BonusRouter);
app.use("/api/dividend", DividendUploaderRouter);
app.use("/api/isin", IsinRouter);
app.use("/api/demerger", DemergerRouter);
app.use("/api/merger", MergerRouter);
app.use("/api/client", ClientRouter);
app.use("/api/security", SecurityRouter);

// Fill each row with account codes. One job is triggered per row, 10 at a time.
const accounts = [
  [
    "SVAYAN009",
    "SVAYAN010",
    "SVAYAN011",
    "SVAYAN012",
    "SVAYAN013",
    "SVAYAN014",
    "TAYAN001",
    "TAYAN002",
    "TAYAN003",
    "TAYAN004",
  ],

  [
    "TAYAN005",
    "TAYAN006",
    "TAYAN007",
    "TAYAN008",
    "TAYAN009",
    "TAYAN010",
    "TAYAN011",
    "TAYAN012",
    "TAYAN013",
    "TAYAN014",
  ],

  [
    "TAYAN015",
    "TAYAN016",
    "TAYAN017",
    "TAYAN018",
    "TAYAN019",
    "TAYAN020",
    "TAYAN021",
    "TAYAN022",
    "TAYAN023",
    "TAYAN024",
  ],

  [
    "TAYAN025",
    "TAYAN026",
    "TAYAN027",
    "TAYAN028",
    "TAYAN029",
    "TAYAN030",
    "TAYAN031",
    "TAYAN032",
    "TAYAN033",
    "TMAYAN001",
  ],

  [
    "TMAYAN002",
    "TMAYAN003",
    "TMAYAN004",
    "TMAYAN005",
    "TMAYAN006",
    "TMAYAN007",
    "TMAYAN008",
    "TMAYAN009",
    "TMAYAN010",
    "TMAYAN011",
  ],

  ["TMAYAN012", "TMNRE01", "TMNRE02", "TMNRE04", "WAYAN01", "WAYAN02"],
];

// Hit this route to manually trigger the holding update jobs.
// One job is submitted per row in `accounts`.
app.get("/api/holding-update", async (req, res) => {
  try {
    if (!req.catalystApp) {
      return res
        .status(500)
        .json({ status: "error", message: "Catalyst app not initialized" });
    }

    const scheduling = req.catalystApp.jobScheduling();
    const ts = Date.now();
    const submittedJobs = [];

    for (let i = 0; i < accounts.length; i++) {
      const job = await scheduling.JOB.submitJob({
        job_name: `HUM_${ts}_${i}`.slice(0, 50),
        jobpool_name: "UpdateMasters",
        target_name: "HoldingUpdateManually",
        target_type: "Function",
        job_config: { number_of_retries: 1, retry_interval: 60 * 1000 },
        params: { accountCodesJson: JSON.stringify(accounts[i]) },
      });
      submittedJobs.push(job);
    }

    res.status(200).json({
      status: "ok",
      message: `Submitted ${submittedJobs.length} holding update job(s)`,
      count: submittedJobs.length,
    });
  } catch (err) {
    console.error("Holding update error:", err);
    res.status(500).json({
      status: "error",
      message: err.message || "Failed to submit jobs",
    });
  }
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
  console.log(`http://localhost:${port}/`);
});
