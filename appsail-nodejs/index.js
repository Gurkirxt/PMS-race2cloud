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
import TransactionUploaderRouter from "./router/uploaderRouter/TransactionUploaderRouter.js";
import TempTransactionUploaderRouter from "./router/uploaderRouter/TempTransactionUploaderRouter.js";
import CashBalanceRouter from "./router/cashBalanceRouter/CashbalanceRouter.js";
import BonusRouter from "./router/BonusRouter.js";
import DividendUploaderRouter from "./router/uploaderRouter/DividendUploaderRouter.js";
import IsinRouter from "./router/IsinRouter.js";
import DemergerRouter from "./router/DemergerRouter.js";
import MergerRouter from "./router/MergerRouter.js";

app.use(cors());
app.use(Express.json());
app.use(Express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

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
app.use("/api/transaction-uploader", TransactionUploaderRouter);
app.use("/api/transaction-uploader", TempTransactionUploaderRouter);
app.use("/api/cash-balance", CashBalanceRouter);
app.use("/api/bonus", BonusRouter);
app.use("/api/dividend", DividendUploaderRouter);
app.use("/api/isin", IsinRouter);
app.use("/api/demerger", DemergerRouter);
app.use("/api/merger", MergerRouter);

app.put("/update", async (req, res) => {
  console.log("Update started");
  let count = 0;
  const app = catalyst.initialize(req);
  const zcql = app.zcql();
  for (let i = 0; i < 25; i++) {
    await zcql.executeZCQLQuery(`
  UPDATE Transaction
SET executionPriority = 3
WHERE Tran_Type IN ('SL+', 'TDO', 'DIO', 'RD0')
AND executionPriority IS NULL
    `);
    console.log(count);
  }
  res.status(200).json({ message: "Update successful" });
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
  console.log(`http://localhost:${port}/`);
});
