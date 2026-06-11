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
  ["203NREAYAN", "205NREAYAN", "206NREAYAN", "209NREAYAN"],

  ["AYAN059", "AYAN064", "AYAN040", "AYAN046", "AYAN033", "AYAN034"],

  ["AYAN061", "AYAN001", "AYAN092", "AYAN009", "219NREAYAN", "AYAN104"],

  ["AYAN119", "AYAN040", "AYAN046", "AYAN058", "AYAN047", "AYAN107"],

  ["AYAN045", "TAYAN012", "AYAN033", "AYAN034", "AYAN061", "AYAN001"],
];

// function holdingUpdate(){
//   const scheduling = req.catalystApp.jobScheduling();
//   const ts = Date.now();

//   async function holdingUpdate(){
//   const scheduling = req.catalystApp.jobScheduling();
//   const ts = Date.now();

//   for (let i = 0; i < accounts.length; i++) {
//     await scheduling.JOB.submitJob({
//       job_name: `HUM_${ts}_${i}`.slice(0, 50),
//       jobpool_name: "UpdateMasters",
//       target_name: "HoldingUpdateManually",
//       target_type: "Function",
//       job_config: { number_of_retries: 1, retry_interval: 60 * 1000 },
//       params: { accountCodesJson: JSON.stringify(accounts[i]) },
//     });
//   }
// }

// holdingUpdate();

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
  console.log(`http://localhost:${port}/`);
});
