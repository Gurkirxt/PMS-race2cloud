# PMS (Portfolio Management System) — Race2Cloud

A full-stack **Portfolio Management System** built on **Zoho Catalyst**, designed for Indian equity portfolio operations: broker transaction ingestion, FIFO-based holdings, corporate actions (split, bonus, dividend, merger, demerger), cash passbook, analytics, and CSV exports.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     react-app (React 19 SPA)                      │
│              HashRouter · localhost:3000                        │
└────────────────────────────┬────────────────────────────────────┘
                             │ REST API (fetch)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│              appsail-nodejs (Express 4, ESM, port 9000)         │
│   catalyst.initialize(req) → req.catalystApp on every request   │
│   15 routers · 28 controllers · 20 util modules                 │
└──────┬──────────────────┬──────────────────┬────────────────────┘
       │ ZCQL             │ Stratus          │ jobScheduling()
       ▼                  ▼                  ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────────────────────┐
│ Data Store   │  │ Object       │  │ functions/ (26 declared,   │
│ 18+ tables   │  │ Storage      │  │ 24 implemented)              │
└──────────────┘  └──────────────┘  └──────────────────────────────┘
```

**Design pattern:** AppSail is a thin **orchestration API**. It reads pre-materialized holdings/cash from Catalyst tables for fast analytics, runs FIFO simulations locally for previews, and pushes all heavy mutations (uploads, corporate actions, exports, cash recalc) to Catalyst serverless functions via job scheduling.

---

## Project Structure

```
PMS-race2cloud/
├── catalyst.json              # Catalyst deploy manifest (client, appsail, functions)
├── react-app/                 # React 19 SPA (56 src files)
├── appsail-nodejs/            # Express REST API (63 JS files)
└── functions/                 # Catalyst serverless jobs (24 folders, 26 declared)
```

| Layer | Technology |
|-------|------------|
| Frontend | React 19, React Router 6 (HashRouter), Create React App |
| Backend API | Node.js, Express 4, ESM, `zcatalyst-sdk-node` |
| Database | Zoho Catalyst Data Store (queried via ZCQL) |
| File storage | Zoho Stratus (S3-like buckets) |
| Background jobs | Catalyst Job Scheduling (4 job pools) |

---

## Backend (`appsail-nodejs`)

Express server deployed as **Zoho Catalyst AppSail**. Listens on `process.env.X_ZOHO_CATALYST_LISTEN_PORT` (default **9000**). Local dev often proxies to port **3001**.

### Request Lifecycle

```
HTTP Request
    │
    ▼
cors (origin: http://localhost:3000, credentials: true)
    │
    ▼
express.json() + urlencoded
    │
    ▼
Catalyst middleware → catalyst.initialize(req) → req.catalystApp
    │
    ▼
Router → Controller
    ├── req.catalystApp.zcql()              → Data Store queries
    ├── req.catalystApp.stratus()           → file upload/download
    ├── req.catalystApp.datastore()         → bulk write jobs
    └── req.catalystApp.jobScheduling()     → async Catalyst functions
```

Every controller null-checks `req.catalystApp` before use.

### Directory Layout

```
appsail-nodejs/
├── index.js                          # Entry point, route mounting, /api/holding-update
├── package.json                      # ESM, express, cors, csv-parser, zcatalyst-sdk-node
│
├── router/                           # 15 routers
│   ├── AnalyticsRouter.js
│   ├── TransactionRouter.js
│   ├── DashboardRouter.js
│   ├── SplitRouter.js, BonusRouter.js, MergerRouter.js, DemergerRouter.js
│   ├── IsinRouter.js
│   ├── clientRouter/ClientRouter.js
│   ├── securityRouter/SecurityRouter.js
│   ├── cashBalanceRouter/CashbalanceRouter.js
│   ├── export/ExportRouter.js
│   └── uploaderRouter/
│       ├── TempTransactionUploaderRouter.js
│       ├── BhavUploaderRouter.js
│       └── DividendUploaderRouter.js
│
├── controller/                       # 28 controllers
│   ├── analytics/tabs/holding/       AnalyticsControllers.js, CashController.js
│   ├── analytics/tabs/transaction/   transaction.js
│   ├── uploader/                     TempTransactionUpload, Split, Bonus, Dividend, Demerger, Bhav
│   ├── export/                       Holdings, transactions, corp actions, cash, dividend exports
│   ├── cashBalance/                  passbook, calculateBalanceOnce, exportCashBalance
│   ├── client/, security/, isin/
│   ├── TransactionController.js, DashboardController.js
│   ├── MergerController.js, BonusController.js
│
└── util/                             # 20 utility modules
    ├── analytics/
    │   ├── holdingsFromTable.js      # Read materialised Holdings table
    │   ├── consolidatedHoldings.js   # Group by Actual_Code
    │   └── transactionHistory/
    │       └── fifo.js               # FIFO engine for previews
    ├── merger/mergerEngine.js, lotFifo.js
    ├── custodian/parseCustodianCsv.js
    ├── export/fifo.js                # (orphan duplicate — unused)
    ├── mapVirtualToActualCodes.js    # clientIds WS→Actual (Split/Bonus preview)
    └── allAccountCodes.js, stratusSignedUrl.js, reportTimestamp.js
```

### API Route Groups

#### Root (`index.js`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Health check |
| GET | `/api/holding-update` | Manually submit `HoldingUpdateManually` jobs (hardcoded account batches) |

#### `/api/analytics`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/getAllAccountCodes` | Virtual account codes from `clientIds` |
| GET | `/getAllActualCodes` | Distinct `Actual_Code` values (consolidated view) |
| GET | `/getHoldingsSummarySimple` | Per-account holdings summary (qty, WAP, market value) |
| GET | `/getHoldingsByIsin` | Cross-account ISIN report from `Holdings` (virtual/actual code, qty, WAP, values) |
| GET | `/getPaginatedTransactions` | Paginated transaction ledger + corp-action rows |
| GET | `/getSecurityNameOptions` | Security name dropdown options |
| GET | `/getCashBalanceSummary` | Latest cash balance from `Cash_Ledger` |

#### `/api/transaction`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/getStockTransactionHistory` | Holdings timeline for account + ISIN |
| GET | `/getAllBuys` | Total buy qty for account + ISIN |
| GET | `/getAllSells` | Total sell qty for account + ISIN |

#### `/api/dashboard`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/getAllTransactions` | Paginated full `Transaction` table (62 columns, 3-query column-split merge) |

#### `/api/split`

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/preview` | Preview stock split impact; includes `accountCode` (virtual) + `actualCode` |
| POST | `/add` | Apply split (insert `Split` row + queue rebuild jobs) |
| GET | `/getAllSecuritiesList` | Security list for dropdown |
| GET | `/export-preview` | Export split preview CSV (`VIRTUAL_CODE`, `ACTUAL_CODE`, holdings, delta) |

#### `/api/bonus`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/getAllSecuritiesList` | Security list |
| POST | `/preview` | Bonus preview from Holdings as-of ex-date; includes `accountCode` (virtual) + `actualCode` |
| POST | `/apply` | Queue `UpdateBonusTable` Catalyst job |
| GET | `/apply-status` | Poll `Jobs` table for apply status |
| GET | `/export-preview` | Export bonus preview CSV (`VIRTUAL_CODE`, `ACTUAL_CODE`, holdings, bonus shares, delta) |

#### `/api/dividend`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/getAllSecuritiesList` | Security list |
| POST | `/preview` | Dividend preview (JSON or multipart + custodian CSV) |
| POST | `/apply` | Queue `UpdateDividendData` job |
| GET | `/apply-status` | Poll apply status |
| GET | `/export-preview` | Schedule dividend export job |
| GET | `/export-status` | Poll export job status |
| GET | `/export-download` | Download exported dividend CSV from Stratus |

#### `/api/merger`

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/preview` | Lot-level merger preview (FIFO replay) |
| POST | `/apply` | Queue `MegerFn` Catalyst job |
| GET | `/apply-status` | Poll apply status |

#### `/api/demerger`

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/preview` | Demerger preview |
| POST | `/apply` | Queue `DemergerFn` job |
| GET | `/apply-status` | Poll apply status |

#### `/api/isin`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/security-list-isins` | ISINs from `Security_List` |
| POST | `/update` | Queue `UpdateISIN` job (rename old ISIN across tables) |
| POST | `/apply-new` | Queue `UpdateISIN` for new ISIN registration |
| GET | `/job-status` | Poll ISIN update job via Catalyst `JOB.getJob()` |

#### `/api/transaction-uploader`

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/upload-temp-file` | Upload broker CSV → Stratus → bulk-write `Transaction` |
| POST | `/bulk-callback` | Optional Catalyst callback on bulk-write completion; poll is primary fallback |
| GET | `/upload-history` | List past uploads from Stratus keys |
| GET | `/upload-history/download` | Download historical upload file (presigned URL) |

#### `/api/bhav`

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/upload-bhav` | Upload bhav CSV to Stratus + bulk-write `Bhav_Copy` |
| POST | `/trigger-bhav-import` | Manual bulk import from existing Stratus file |

#### `/api/cash-balance`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/calculateCashbalanceOnce` | Batch-schedule `CashCalculation` jobs (hardcoded accounts) |
| GET | `/passbook` | Paginated `Cash_Balance_Per_Transaction` passbook |
| GET | `/isins` | ISIN list for account's cash transactions |
| GET | `/export` | Trigger single-client cash export job |
| GET | `/export/history` | Export history from `Jobs` table |
| GET | `/export/status` | Poll export status |
| GET | `/export/download` | Download exported CSV |

#### `/api/export`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/export-all` | Schedule all-clients holdings export job |
| GET | `/export-single` | Sync single-client holdings CSV to Stratus |
| GET | `/export-consolidated` | Consolidated holdings by `Actual_Code` |
| GET | `/export-by-isin` | Sync ISIN holdings CSV (same rows as Analytics ISIN report: Virtual + Actual Code) |
| GET | `/check-status` | Poll export-all job status |
| GET | `/download` | Download export-all CSV |
| GET | `/export-all/history` | Export-all history |
| GET | `/cash-all` | Schedule all-clients cash snapshot export |
| GET | `/cash-all/status` | Poll cash-all status |
| GET | `/cash-all/download` | Download cash-all CSV |
| GET | `/transaction/export-single` | Single-client transaction ledger CSV |
| GET | `/corporate-action/export` | Export corp actions in date range |
| GET | `/corporate-action/history` | In-memory export history (last 10) |

#### `/api/client` and `/api/security`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/client/list` | All clients from `clientIds` |
| GET | `/client/details` | Client details by `accountCode` |
| GET | `/security/list` | Securities from `Security_List` |
| GET | `/security/details` | Full security record by ISIN |

### Core Business Logic

#### FIFO Engines

Three near-duplicate FIFO engines exist (technical debt):

| Module | Used by |
|--------|---------|
| `util/analytics/transactionHistory/fifo.js` | Dividend preview, split/bonus export previews |
| `util/merger/lotFifo.js` + `mergerEngine.js` | Merger preview (mirrors `MegerFn`) |
| `util/export/fifo.js` | **Unused orphan** |

**Same-day event priority:** `TXN → SPLIT → BONUS → DEMERGER → MERGER` (SPLIT before BONUS prevents double-multiplication of post-split bonus shares).

**Date rules:**
- **Buy** effective date: `SETDATE` (settlement date)
- **Sell** effective date: `TRANDATE` (trade date)

#### Holdings

- **Live summary:** `calculateHoldingsSummary()` reads materialised `Holdings` table via `holdingsFromTable.js`, rolls up last snapshot per ISIN, joins `Bhav_Copy` closing price.
- **Read order:** `CREATEDTIME ASC, ROWID ASC` — insert order = FIFO running balance order.
- **Consolidated:** `consolidatedHoldings.js` maps `Actual_Code` → virtual `WS_Account_code`s, sums per ISIN.

Holdings are **written** by Catalyst functions (`CalculateHoldingWorkers`, `RebuildHoldingtable`), not computed on-the-fly in AppSail for analytics reads.

#### Fractional Quantity Handling (normal transactions)

Normal buy/sell transactions can carry **fractional share quantities** (e.g. `5.533`, `0.533`). Because JavaScript floating-point subtraction can leave tiny residue (e.g. `0.533 - 0.533 = 1e-16`), the FIFO engines apply a uniform **epsilon snap** so fully-sold positions settle at exactly `0` and consumed lots leave the buy queue:

```js
const QTY_EPS = 1e-6;
const snapQty = (n) => (Math.abs(Number(n) || 0) < QTY_EPS ? 0 : Number(n) || 0);
```

- **Lot removal:** `if (snapQty(lot.qty) === 0) queue.shift();` (replaces strict `lot.qty === 0`).
- **Running holding:** `holdings = snapQty(holdings - sellQty);` after each sell; cost/WAP reset to 0 when holding hits 0.
- **Open-position reads:** rollups treat `HOLDING <= 1e-6` as **fully sold** (not an open position).

Applied consistently across **every** FIFO engine so all holding-building paths agree:

| Layer | Files |
|-------|-------|
| Serverless (`functions/`) | `CalculateHoldingWorkers`, `CalculateHoldingPerAccount`, `RebuildHoldingtable/holdingsRebuildFromSources.js`, `HoldingUpdateManually`, `UpdateDividendData`, `UpdateBonusTable/fifo.js`, `MegerFn/fifo.js`, `ExportDividendAccounts/fifo.js`, `ExportDifferentialReport/fifo.js`, `ExportAllCustomerHoldingData/holdingsFromTable.js` |
| API (`appsail-nodejs/`) | `util/analytics/transactionHistory/fifo.js`, `util/export/fifo.js`, `util/merger/lotFifo.js`, `util/analytics/holdingsFromTable.js`, dividend/split/bonus eligibility checks |

**Important — this is dust hygiene, not business rounding.** Genuine fractional quantities (e.g. `5.533`) pass through untouched; only near-zero residue snaps to `0`. **Corporate-action rounding is intentional business logic and is NOT changed** — demerger/merger still use `Math.floor((Q1*r1)/r2)`, split/bonus keep their ratio + `round()`/`toFixed` rules.

> Existing wrong Holdings rows are **not** auto-corrected by a code deploy. Run `RebuildHoldingtable` (scoped to the affected `WS_Account_code` + `ISIN`) to rewrite holdings from `Transaction` with the fixed logic.

**UI display:** quantity/holding columns are **type-aware** — normal transactions show real decimals (`maximumFractionDigits: 3`), corporate-action rows keep `Math.floor` whole numbers (`TransactionPage.js`, `HoldingCards.js`, `Analytics/tabs/transaction/TransactionTab.js`).

#### Corporate Actions

| Action | Preview | Apply |
|--------|---------|-------|
| **Split** | Holdings as-of issue date per account | Insert `Split` row → queue `RebuildHoldingtable` (+ optional stale bonus recompute) |
| **Bonus** | Holdings FIFO walk as-of ex-date | Queue `UpdateBonusTable` |
| **Merger** | Lot-level FIFO via `mergerEngine` | Queue `MegerFn` |
| **Demerger** | Holdings-based preview | Queue `DemergerFn` |
| **Dividend** | FIFO engine + optional custodian CSV | Queue `UpdateDividendData` |

All long-running applies use the **preview → apply → poll `Jobs` table** pattern.

#### Transaction Upload Pipeline (`TempTransactionUpload.js`)

The largest backend file (~1067 lines). End-to-end flow:

1. **Validate** 26-column broker CSV header (exact order, spelling, case).
2. **Normalize** CSV: map headers to `Transaction` columns, derive `NETRATE`/`Net_Amount` from filler columns.
3. **Upload** to Stratus bucket `client-transaction-files` (`transactions/TxnUpload-<ms>-<filename>`).
4. **Extract** distinct `(BROKERACID, SYMBOLCODE)` pairs; write JSON manifest to Stratus.
5. **Bulk-write** to `Transaction` table via `datastore().bulkJob("write")` with callback URL.
6. **Background poll** (`pollBulkWriteAndComplete`): after upload response, checks bulk job status every **30s** (15s initial delay, 45 min max) — fallback when Catalyst does not POST to `/bulk-callback`.
7. **On success** (poll or callback → `completeTxnUploadPipeline`), queue **3 downstream jobs** with **10s delay** between each (reduces Dev COMPONENT concurrency burst):

```
UpdatesSecurity_ClientMasters  → unique-accounts/isins JSON on Stratus → clientIds + Security_List stubs
  (wait 10s)
CalculateHoldingMaster         → sliding-window fan-out CalculateHoldingWorkers (≤10 in-flight, baton-pass if needed)
  (wait 10s)
Cal_CB_Append_TxnUpload        → incremental cash passbook append
```

Callback returns **200 immediately** to prevent Catalyst retry duplicate job queuing. Poll and callback both use idempotent `completeTxnUploadPipeline` (only runs when `Jobs.status` is still `RUNNING`). `CalculateHoldingMaster` keeps at most **10** holdings slaves in-flight (Dev COMPONENT pool limit ~15) and re-queues itself when the 15-minute function budget is nearly exhausted.

#### Cash

Two parallel cash systems:

| Table | Purpose | Written by |
|-------|---------|------------|
| `Cash_Balance_Per_Transaction` | Passbook (per-txn running balance) | `Cal_CB_Append_TxnUpload`, `Cal_CB_Per_TNX`, `UpdateDividendData` |
| `Cash_Ledger` | Daily closing balance | `CashCalculation` |

- **Passbook read:** `cashPassbookController` — paginated from `Cash_Balance_Per_Transaction`.
- **Summary read:** `CashController` — latest row from `Cash_Ledger`.
- **Cash effect rules:** `transaction.js:applyCashEffect()` — `CASH_ADD` types (CS+, SL+, DIVIDEND) increase balance; `CASH_SUBTRACT` types (BY-, MGF) decrease; STT deducted where applicable.

#### Exports

| Type | Sync / Async | Stratus bucket |
|------|--------------|----------------|
| Single holding | Sync | `upload-data-bucket` |
| Consolidated holding | Sync | `upload-data-bucket` |
| All holdings | Async → `ExportAllCustomerHoldingData` | `upload-data-bucket` |
| Single transaction | Sync | `export-app-data` |
| Cash (single / all) | Async | `upload-data-bucket` |
| Dividend preview | Async → `ExportDividendAccounts` | `export-app-data` |
| Corp action date range | Sync (AppSail) | streamed CSV |

### Job Scheduling (AppSail → Catalyst)

All jobs use:

```js
req.catalystApp.jobScheduling().JOB.submitJob({
  job_name, jobpool_name, target_name, target_type: "Function",
  params, job_config: { number_of_retries, retry_interval }
});
```

| Job Pool | Functions triggered |
|----------|---------------------|
| **UpdateMasters** | `UpdatesSecurity_ClientMasters`, `EnrichTransactionSecurity`, `CalculateHoldingMaster`, `Cal_CB_Append_TxnUpload`, `HoldingUpdateManually`, `UpdateISIN` |
| **CorporateActions** | `UpdateBonusTable`, `MegerFn`, `DemergerFn`, `RebuildHoldingtable` |
| **Export** | `ExportAllCustomerHoldingData`, `ExportDividendAccounts`, `ExportCashBalance`, `ExportCashBalSingleClient` |
| **Finance** | `CashCalculation` |

**Patterns:**
- **Callback chain** after transaction upload bulk-write completes.
- **`Jobs` table** as state machine — UI polls `jobName` + `status` (PENDING / RUNNING / COMPLETED / FAILED).
- **Batching** — account codes chunked (10 for cash, 250 for holdings rebuild) to stay under Catalyst's ~5000-char job param limit.
- **Idempotent job names** — `BON_<isin>_<date>`, `MRG_<old>_<new>_<date>`, `EA_<date>`, etc.

### Stratus Buckets

| Bucket | Usage |
|--------|-------|
| `client-transaction-files` | Broker transaction CSV uploads, pairs manifest JSON |
| `upload-data-bucket` | Bhav copy, holdings exports, cash exports |
| `export-app-data` | Dividend export, single transaction export |

---

## Frontend (`react-app`)

Create React App SPA (**React 19**, **React Router 6**) deployed via Zoho Catalyst (`zcatalyst-cli-plugin-react`). Uses **HashRouter** so routes work as `/#/analytics`, `/#/split`, etc. — required for static hosting on Catalyst (`client-package.json` sets `"homepage": "index.html"`).

**56 source files** under `src/` (38 JS, 18 CSS). **No global state library** — local `useState` on every page, native `fetch()` for all API calls.

**API base URL:** `constant.js` → `https://backend-50039746698.development.catalystappsail.in/api` (`http://localhost:3001/api` commented for local dev). ISIN page can override via `REACT_APP_ISIN_API_BASE`.

### Bootstrap & Routing

```
index.js (ReactDOM.createRoot, StrictMode)
  └── App.js (HashRouter)
        ├── /                    → DashboardPage
        ├── /analytics           → AnalyticsPage
        ├── /split|bonus|dividend|demerger|merger → Corporate action pages
        ├── /bhav-copy           → BhavCopyUploadPage
        ├── /temp-transaction    → TempTransaction (active txn upload)
        ├── /updateISIN          → UpdateISINPage
        ├── /cash-balance        → CashBalancePage
        ├── /reports             → ReportsPage
        └── /master-client|master-security → Master data pages
```

**Not routed:** `/transaction-upload` → `TransactionUploadPage` (legacy differential report — route commented out in `App.js` and sidebar).

**Modal (not a route):** `TransactionPage` — full-screen overlay opened from Analytics when a holding row is clicked.

### Directory Layout

```
react-app/src/
├── index.js, App.js, constant.js, index.css
├── layouts/
│   └── MainLayout.js              # Sidebar + Topbar wrapper for all pages
├── hooks/
│   ├── GetAllCodes.js             # useAccountCodes(mode) — scheme vs actual codes
│   └── GetHolding.js              # useHoldings() — fetch + race-safe loading
├── components/
│   ├── common/CommonComponents.js # Button, Card, Table, Sidebar, Topbar, Pagination…
│   ├── dashboard/DashboardComponents.js  # Legacy dashboard widgets (partially unused)
│   └── SearchableClientSelect/    # Built but never imported anywhere
└── pages/
    ├── Dashboard/
    ├── Analytics/ + tabs/ (holding, allocation, performance, transaction)
    ├── SplitPage, BonusPage, Dividend/, DemergerPage, MergerPage
    ├── BhavCopyUpload/, TempTransactionUpload/, TransactionUpload/ (legacy)
    ├── TransactionPage/           # Modal overlay
    ├── update-isin/, CashBalancePage/
    ├── Reports/ + tabs/ (Holdings, Transactions, Cash, TopClients, CorporateAction)
    ├── Master/ (ClientPage, SecurityPage)
    └── Holding/HoldingCards.js      # HoldingsGrid table component
```

### Routes Quick Reference

| Hash route | Component | Sidebar label |
|------------|-----------|---------------|
| `/` | `DashboardPage` | Dashboard |
| `/analytics` | `AnalyticsPage` | Analytics |
| `/split` | `SplitPage` | Corporate Actions → Split |
| `/bonus` | `BonusPage` | Corporate Actions → Bonus |
| `/dividend` | `DividendPage` | Corporate Actions → Dividend |
| `/demerger` | `DemergerPage` | Corporate Actions → Demerger |
| `/merger` | `MergerPage` | Corporate Actions → Merger |
| `/bhav-copy` | `BhavCopyUploadPage` | Bhav Copy |
| `/temp-transaction` | `TempTransaction` | Transaction Upload |
| `/updateISIN` | `UpdateISINPage` | Update ISIN |
| `/cash-balance` | `CashBalancePage` | Cash Balance |
| `/reports` | `ReportsPage` | Reports |
| `/master-client` | `ClientPage` | Master → Client |
| `/master-security` | `SecurityPage` | Master → Security |

### Layout & Shared Components

**`MainLayout.js`** — wraps every page with:
- **`Sidebar`** — maroon-themed nav with nested Corporate Actions and Master groups; `getActiveKey()` maps `useLocation().pathname` to highlight
- **`Topbar`** — page title + optional `rightContent` slot
- Content area with consistent padding

**`CommonComponents.js`** — inline-styled design system:
- `Button` (primary maroon `#c2185b`, secondary, ghost)
- `Card`, `StatCard`, `Badge`, `TextInput`, `SelectInput`
- `Table`, `Pagination`, `PageLayout`, `Sidebar`, `Topbar`
- `TransactionTypeCard`, `ExchangeCard`

**Hooks:**
- **`useAccountCodes(mode)`** — fetches `/analytics/getAllAccountCodes` (scheme) or `/getAllActualCodes` (consolidated); dedupes and sorts
- **`useHoldings()`** — fetches `/analytics/getHoldingsSummarySimple`; uses `requestIdRef` to ignore stale responses

### State Management & API Patterns

| Pattern | Where |
|---------|-------|
| Local `useState` | Every page for forms, tables, loading/error |
| Custom hooks | `useHoldings`, `useAccountCodes` |
| `useRef` race guards | `useHoldings`, Analytics cash fetch, TransactionTab |
| `useRef` polling cleanup | Bonus, Dividend, Merger, Demerger, Reports exports, CashBalance |
| `useMemo` / `useCallback` | Filtered dropdowns, pagination, summary cards |
| Tab state | `AnalyticsPage`, `ReportsPage` — local `activeTab` |
| Props drilling | Analytics → tabs; holding click → `TransactionPage` modal |

**No Redux, Context, React Query, or axios.** Ad-hoc `fetch()` per component; no shared API client or interceptors. Some routes use `credentials: "include"` (bonus/dividend apply, cash exports, ISIN).

### Frontend → API Endpoint Map

#### Dashboard (`/`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/dashboard/getAllTransactions?page=&limit=` | GET | Paginated recent trades (only live API call) |

Summary cards, charts, and filter bar are **static/hardcoded** — no API.

#### Analytics (`/analytics`)

| Endpoint | Method | Used by |
|----------|--------|---------|
| `/analytics/getAllAccountCodes` | GET | `useAccountCodes` |
| `/analytics/getHoldingsSummarySimple?accountCode&asOnDate` | GET | `useHoldings` |
| `/analytics/getHoldingsByIsin?isin&asOnDate` | GET | `AnalyticsPage` ISIN report (all accounts holding selected ISIN) |
| `/analytics/getCashBalanceSummary?accountCode&asOnDate` | GET | `AnalyticsPage` |
| `/analytics/getPaginatedTransactions` | GET | `TransactionTab` |
| `/analytics/getSecurityNameOptions` | GET | `TransactionTab` (ISIN filter) |
| `/transaction/getStockTransactionHistory` | GET | `TransactionPage` modal |
| `/transaction/getAllBuys` | GET | `TransactionPage` modal |
| `/transaction/getAllSells` | GET | `TransactionPage` modal |

**Stubs (no API):** `AllocationTab` renders `"allocation"`; `PerformanceTab` renders `"Performance"`.

#### Corporate Actions

| Page | Key endpoints |
|------|---------------|
| **Split** | `GET /split/getAllSecuritiesList`, `POST /split/preview`, `POST /split/add` (sync), `GET /split/export-preview` |
| **Bonus** | `GET /bonus/getAllSecuritiesList`, `POST /bonus/preview`, `POST /bonus/apply`, `GET /bonus/apply-status` (poll 10s), `GET /bonus/export-preview`, `GET /export/bonus-preview` |
| **Dividend** | `GET /dividend/getAllSecuritiesList`, `POST /dividend/preview` (multipart + custodian CSV), `POST /dividend/apply`, `GET /dividend/apply-status` (poll 10s) |
| **Demerger** | `GET /split/getAllSecuritiesList`, `POST /demerger/preview`, `POST /demerger/apply`, `GET /demerger/apply-status` (poll 3s) |
| **Merger** | `GET /isin/security-list-isins` (fallback: `/split/getAllSecuritiesList`), `POST /merger/preview`, `POST /merger/apply`, `GET /merger/apply-status` (poll 3s) |

#### Uploads

| Page | Endpoints |
|------|-----------|
| **Bhav Copy** | `POST /bhav/upload-bhav` (FormData) |
| **Temp Transaction** (active) | `POST /transaction-uploader/upload-temp-file`, `GET /upload-history`, `GET /upload-history/download` |
| **Transaction Upload** (legacy, unrouted) | `/upload-transaction`, `/load-holding`, `/differential-report/*` — **backend routes missing for differential report** |

#### Update ISIN (`/updateISIN`)

| Endpoint | Method | Notes |
|----------|--------|-------|
| `/isin/security-list-isins` | GET | Populates ISIN dropdowns |
| `/isin/update` | POST | Rename old → new ISIN (queues Catalyst job) |
| `/isin/apply-new` | POST | Sync security code/name for new ISIN |

**No job status polling** — UI marks success when job is submitted (`jobId` logged only).

#### Cash Balance (`/cash-balance`)

| Endpoint | Method |
|----------|--------|
| `/analytics/getAllAccountCodes` | GET (via hook) |
| `/cash-balance/isins?accountCode=` | GET |
| `/cash-balance/passbook?accountCode&page&pageSize&…` | GET |
| `/cash-balance/export?…` | GET |
| `/cash-balance/export/status?jobName=` | GET (poll 3s) |
| `/cash-balance/export/download?jobName=` | GET |

#### Reports (`/reports`) — tab dropdown selector

| Tab | Endpoints |
|-----|-----------|
| **Holdings** | `/export/export-single`, `/export/export-consolidated`, `/export/export-by-isin`, `/export/export-all`, `/export/export-all/history`, `/export/check-status` (poll 15s), `/export/download` |
| **Transactions** | `/export/transaction/export-single` |
| **Cash** | `/cash-balance/export/history`, `/export/cash-all`, `/cash-balance/export`, `/export/cash-all/status`, `/cash-balance/export/status` (poll 15s), download URLs |
| **Corporate Action** | `/export/corporate-action/history`, `/export/corporate-action/export` (blob download) |
| **Top Clients** | No API (stub) |

#### Master

| Page | Endpoint |
|------|----------|
| Client | `GET /client/list` |
| Security | `GET /security/list` |

### Job Polling Patterns

| Feature | Poll endpoint | Interval | Terminal statuses |
|---------|---------------|----------|-------------------|
| Bonus apply | `/bonus/apply-status` | 10s | COMPLETED, FAILED, ERROR |
| Dividend apply | `/dividend/apply-status` | 10s | same; resets form on COMPLETED |
| Demerger apply | `/demerger/apply-status` | 3s | same; max 200 attempts |
| Merger apply | `/merger/apply-status` | 3s | same; max 200 attempts |
| Holdings export-all | `/export/check-status` | 15s | COMPLETED, FAILED, ERROR |
| Cash reports export | `/cash-balance/export/status` or `/export/cash-all/status` | 15s | same |
| Cash Balance page export | `/cash-balance/export/status` | 3s | COMPLETED, FAILED, ERROR, NOT_FOUND |
| Diff report (legacy) | `/transaction-uploader/differential-report/status` | 10s | COMPLETED, FAILED |
| Update ISIN | — | — | No polling |
| Bhav upload | — | — | Shows `jobId` only |
| Temp transaction upload | — | — | Synchronous validation response |
| Split apply | — | — | Synchronous POST `/split/add` |

**Dashboard retry:** `RecentTradesSection` retries up to 3 times on HTTP 503 with exponential backoff.

### Page-by-Page Breakdown

#### Dashboard (`DashboardPage`)

Uses `MainLayout` with `SummaryCardsRow`, `ChartsRow`, `FiltersBar`, `RecentTradesSection` from `DashboardComponents.js`. Only **Recent Trades** hits the live API (`/dashboard/getAllTransactions`). Summary cards show hardcoded values (2,65,814 trades, etc.). Charts are static SVG placeholders. **Import File** button has no `onClick`.

#### Analytics (`AnalyticsPage`)

Four tabs: Holding, Allocation, Performance, Transaction.

1. User can search by **ISIN** (cross-account report) or **Account Code** (existing per-account holdings).
2. Optional **as-on date** filter applies to both modes.
3. **ISIN mode (Holding tab):** shows all accounts holding the selected ISIN with Virtual Code, Actual Code, Quantity, WAP, Holding Value, Last Price, Market Value (from `Holdings` + `clientIds` + `Bhav_Copy`). Clicking a row / View opens the same **`TransactionPage` modal** for that virtual account + ISIN.
4. **Account mode (Holding tab):** shows summary table (Total / Equity / Cash %) and `HoldingsGrid` with All/Equity/Cash view modes. Clicking a row opens **`TransactionPage` modal**.
5. **Transaction tab** remains account-code-driven and shows paginated ledger with ISIN/security name filters.
6. Holdings quantities are **type-aware** in `HoldingCards.js` / `TransactionPage.js`: normal transactions show real decimals (e.g. `5.533`), corporate-action rows keep `Math.floor` whole numbers.

#### Corporate Action Pages (common pattern)

1. Load securities ISIN list (searchable dropdown).
2. Fill ratio, dates, and action-specific fields.
3. **Preview** (POST) → paginated preview table.
4. **Apply** (POST) → for Bonus/Dividend/Merger/Demerger: returns `jobName` → poll until COMPLETED.
5. **Split** applies synchronously (no job poll).
6. **Export preview** available on Split/Bonus (CSV download).

**ISIN search:** Split / Bonus / Demerger filter with null-safe `String(field ?? "").toLowerCase()` so rows with null `ISIN` / `Security_Code` / `Security_Name` (e.g. CASH stubs in `Security_List`) do not throw `Cannot read properties of null (reading 'toLowerCase')`. Dropdown keys use `` `${isin || "no-isin"}-${idx}` ``. Dividend and Merger already used optional chaining / `String(...?? "")`.

**Split / Bonus preview columns:** Virtual Code (`accountCode` = `WS_Account_code` from Holdings) and Actual Code (`actualCode` from `clientIds` via `util/mapVirtualToActualCodes.js`, per-code lookup preferring non-empty `Actual_Code` when duplicate rows exist). Same columns appear in Split/Bonus **export-preview** CSVs (`VIRTUAL_CODE`, `ACTUAL_CODE`). Demerger/Merger/Dividend previews unchanged.

**Dividend-specific:** Requires custodian Benefit Collection Report CSV on preview. Shows reconciliation status chips (matched/mismatch/partial). Client-side CSV export of reconciliation grid. `applyMode` and optional `accountCodes` sent on apply.

**Merger-specific:** Multi old-company ISIN input, merge-into new company fields, lot-level preview table with `willSkip` flags.

#### Temp Transaction Upload (`TempTransaction`)

Active upload page at `/temp-transaction`:
- Select CSV → `POST /upload-temp-file` with FormData.
- Rich validation error UI: header mismatch tables, missing columns, date format errors.
- Recent uploads list (last 5) with presigned download via `/upload-history/download`.
- On success, backend bulk-writes `Transaction` and fans out Catalyst jobs (holdings + cash).

#### Bhav Copy Upload

CSV → `POST /bhav/upload-bhav` → shows message + optional `jobId` (no status polling).

#### Cash Balance Page

Account searchable dropdown → optional ISIN filter, date range, free-text search → paginated passbook from `/cash-balance/passbook`. Inline export triggers job with 3s polling + download button when COMPLETED. Tran-type badges color-coded (DIVIDEND, BY-, SL+, CS+, etc.).

#### Reports Page

Dropdown selects report type (Holdings / Transactions / Cash / Top Clients / Corporate Action). Each tab is a self-contained export workflow with job polling where async.

#### Update ISIN Page

Two cards:
1. **Update Script** — rename old ISIN → new ISIN across all tables (`POST /isin/update`).
2. **New ISIN panel** — apply security code/name for existing ISIN (`POST /isin/apply-new`).

ISIN dropdowns populated from `/isin/security-list-isins` with autocomplete. Uses `credentials: "include"`.

#### Master Pages

- **Client** — table from `/client/list`.
- **Security** — table from `/security/list`.

### End-to-End User Flows

```
Transaction upload:
  Select CSV → POST /upload-temp-file → validation result
  → success + refresh history → backend jobs run async

Corporate action:
  Form → Preview → Apply → poll job status → COMPLETED

Holdings export (Reports):
  Select date/mode → GET /export/export-all → poll check-status → download

Analytics drill-down:
  Select account → holdings grid → click row → TransactionPage modal
  → parallel fetch history + buy/sell totals
  (same modal from ISIN report: click account row → history for that virtual code + ISIN)
```

### Styling & Dependencies

| Aspect | Choice |
|--------|--------|
| Framework | CRA (`react-scripts` 5), React 19 |
| Routing | `react-router-dom` v6, `HashRouter` |
| Styling | Inline styles (`CommonComponents`) + per-page CSS files; maroon sidebar theme |
| Deploy plugin | `zcatalyst-cli-plugin-react` |
| Tests | Default `App.test.js`, `setupTests.js` only |

### Stubs / Incomplete / Legacy

| Item | Location | Status |
|------|----------|--------|
| Allocation tab | `Analytics/tabs/allocations/AllocationTab.js` | Renders `"allocation"` only |
| Performance tab | `Analytics/tabs/performance/PerformanceTab.js` | Renders `"Performance"` only |
| Top Clients report | `Reports/tabs/TopClientsTab.js` | "will be available soon" |
| Dashboard widgets | `DashboardComponents.js` | Hardcoded summary + static charts |
| Import File button | `DashboardPage.js` | No handler |
| Transaction Upload route | `App.js` | Commented out; differential report API unwired |
| `SearchableClientSelect` | `components/` | Never imported |
| Duplicate `DashboardPage` | `DashboardComponents.js` | Unused export |
| Topbar export | `CommonComponents.js` | `console.log("export")` stub |
| `App.css` | imported in `App.js` | **File missing** |
| Holdings display | `HoldingCards.js` | Type-aware: fractional for normal txns, `Math.floor` only for corporate actions |
| Update ISIN | `UpdateISINPage.js` | No job completion polling |

### Local Dev & Catalyst Deploy

```bash
cd react-app
npm install
npm start          # http://localhost:3000
```

`constant.js` `BASE_URL` and `TempTransactionUpload.js` `APPSAIL_BASE_URL` both default to the Catalyst AppSail URL (`https://backend-50039746698.development.catalystappsail.in`). For local dev, switch to `http://localhost:3001` / `http://localhost:3001/api` or set `CATALYST_APPSAIL_URL`.

Production deploy is via root `catalyst deploy` (builds React app to static assets on Catalyst hosting). `client-package.json` sets `"homepage": "index.html"` for HashRouter compatibility.

---

## Catalyst Functions (`functions/`)

26 serverless job functions declared in `catalyst.json`. Each deployed folder contains `index.js`, `package.json`, and `catalyst-config.json`. Functions are invoked by **Catalyst Job Scheduling** (`app.jobScheduling().JOB.submitJob`) from AppSail controllers or from other functions.

**Note:** `catalyst.json` lists `HoldingdataUpdate` and `DailyClientHoldingTransaction`, but **no folders exist** for them in the repo — only 24 function directories are present.

### Common Patterns

| Pattern | Details |
|---------|---------|
| **Handler** | `module.exports = async (jobRequest, context) => { ... }` — reads params via `jobRequest.getAllJobParams()`, initializes SDK with `catalyst.initialize(context)`. |
| **Completion** | `context.closeWithSuccess()` or `context.closeWithFailure()` — must be called to end the invocation. |
| **Job pools** | `UpdateMasters` (upload fan-out, ISIN, cash append), `CorporateActions` (bonus/dividend/merger/demerger rebuilds), `Export` (CSV jobs), `Finance` (cash ledger). |
| **Retries** | Typical `job_config`: `{ number_of_retries: 5, retry_interval: 60_000 }`. |
| **Jobs table** | Most long jobs INSERT/UPDATE `Jobs` (`jobName`, `status`) so the React UI can poll status. Terminal values: `COMPLETED`, `FAILED`, `SUCCESS`, `ERROR`. |
| **JobStatusPerAccount** | Corporate-action apply functions track per-account progress (`RUNNING` → `SUCCESS`/`FAILED`) for retry idempotency. |
| **15-min timeout survival** | Large jobs use **baton-pass** (re-submit self with cursor), **chunked fan-out** (master dispatches slaves), or **scoped ISIN rebuilds** (only affected ISINs, not full account). |
| **ZCQL paging** | Batch size ~250–300 rows; keyset pagination (`WHERE ROWID > cursor`) preferred over OFFSET for large tables. |
| **Stratus** | Buckets: `client-transaction-files` (uploads), `upload-data-bucket` (bhav + exports), `export-app-data` (dividend export). |

### Directory Layout

```
functions/
├── CalculateHoldingMaster/       # Orchestrator: fan-out TxnUpload holdings
├── CalculateHoldingWorkers/      # Slave: incremental Holdings append
├── CalculateHoldingPerAccount/   # Full FIFO rebuild (standalone / test)
├── RebuildHoldingtable/        # Full FIFO rebuild (corp actions) + holdingsRebuildFromSources.js
├── HoldingUpdateManually/        # Manual full rebuild (API trigger)
├── UpdatesSecurity_ClientMasters/ # Job: sync clientIds + Security_List from CSV
├── EnrichTransactionSecurity/    # Job: Security_List → Transaction code/name enrich
├── UpdateSecurity_ClientMaster/  # Event: Stratus trigger twin of above
├── Cal_CB_Append_TxnUpload/      # Incremental cash passbook after upload
├── Cal_CB_Per_TNX/               # Full cash passbook rebuild per account
├── CashCalculation/              # Daily Cash_Ledger incremental update
├── UpdateBonusTable/             # Apply bonus + fifo.js
├── UpdateDividendData/           # Apply dividend + inline FIFO + cash rows
├── MegerFn/                      # Apply merger + fifo.js + bulk write
├── DemergerFn/                   # Apply demerger + demergerApplyCore.js
├── UpdateISIN/                   # Orchestrator: rename or apply-new
├── UpdateISINWorker/             # Batched ISIN rename across 16 tables
├── ExportAllCustomerHoldingData/   # All-client holdings CSV + analytics helpers
├── ExportCashBalance/            # All-client cash snapshot CSV
├── ExportCashBalSingleClient/    # Single-client passbook CSV
├── ExportDividendAccounts/       # Dividend eligibility preview CSV
├── ExportDifferentialReport/     # FA vs custodian diff CSV
├── ExportSplitAccountHolding/      # STUB
├── ExportBonusAccountholding/      # STUB
└── DeleteFile/                   # Purge old Jobs rows
```

### System Flow (how functions connect)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  TRANSACTION UPLOAD (bulk write poll or callback from AppSail)          │
│                                                                         │
│  UpdatesSecurity_ClientMasters ──► unique-accounts/isins JSON → clientIds + Security_List stubs │
│         │                                                                                       │
│         └──► EnrichTransactionSecurity (ISIN list → Security_List → UPDATE Transaction)         │
│                                                                                                 │
│         ├──► CalculateHoldingMaster ──► CalculateHoldingWorkers (×N)                            │
│         │         (chunks of 200 pairs)    incremental Holdings append                          │
│         │                                                                                       │
│         └──► Cal_CB_Append_TxnUpload ──► self-continues with lastAccount                        │
│                  incremental Cash_Balance_Per_Transaction append                                │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  CORPORATE ACTIONS (bonus / merger / demerger / split via AppSail)      │
│                                                                         │
│  UpdateBonusTable / MegerFn / DemergerFn                                │
│    → write action records (Bonus, Merger, Demerger tables)              │
│    → queue RebuildHoldingtable (scoped ISINs, 400 accounts/job)         │
│                                                                         │
│  UpdateDividendData                                                   │
│    → write Dividend + Dividend_Record + Cash_Balance_Per_Transaction    │
│    → (no Holdings rebuild — dividend is cash-only)                      │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  ISIN RENAME                                                            │
│                                                                         │
│  UpdateISIN (rename) ──► UpdateISINWorker (batched rename, 16 tables)   │
│    → baton-pass self until all tables drained                           │
│    → rebuild phase ──► RebuildHoldingtable (scoped to new ISIN)         │
│                                                                         │
│  UpdateISIN (apply-new) ──► sync Security_Code/Name in Security_List  │
│                              + Transaction (sync, no worker)          │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  EXPORTS (triggered from Reports / Cash Balance UI via AppSail)         │
│                                                                         │
│  ExportAllCustomerHoldingData / ExportCashBalance /                     │
│  ExportCashBalSingleClient / ExportDividendAccounts /                   │
│  ExportDifferentialReport                                               │
│    → build CSV in memory → upload to Stratus → update Jobs status       │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### Transaction Upload Pipeline

Triggered by AppSail `handleBulkCallback` after `Transaction` bulk write completes. Three parallel jobs in pool `UpdateMasters`:

#### 1. `UpdatesSecurity_ClientMasters` (job)

**Params:** `bucketName`, `objectKey` (CSV in `client-transaction-files/transactions/*.csv`)

**Flow:**
1. Stream-parse the uploaded CSV from Stratus.
2. Collect distinct `BROKERACID` (account codes) and `SYMBOLCODE` (ISINs) in Sets (dedupe only).
3. Write Stratus JSON source-of-truth files, then clear Sets from memory:
   - `transactions-meta/unique-accounts-{stamp}.json`
   - `transactions-meta/unique-isins-{stamp}.json`
4. Reload those arrays from Stratus and bulk-insert stubs into `clientIds` (`WS_Account_code`) and `Security_List` (`ISIN` only).
5. Transaction `Security_code` / `Security_Name` enrich is **not** done here — on success USCM queues **`EnrichTransactionSecurity`** with `isinsObjectKey` (+ `importStartedAtMs`, `lastIsin=""`).

**Twin:** `UpdateSecurity_ClientMaster` is the **event-function** version — same logic but triggered by Stratus object events instead of job params. Upload path uses the job version; the event may still fire on the same Stratus upload (potential duplicate work).

#### 1b. `EnrichTransactionSecurity` (job)

**Params:** `bucketName`, `isinsObjectKey`, `importStartedAtMs`, `lastIsin`, `source=TxnUpload`

**Flow:**
1. Load unique ISINs from Stratus `transactions-meta/unique-isins-*.json`; sort ascending.
2. Skip ISINs `<= lastIsin` (baton-pass cursor; empty on first run).
3. Chunks of ~100: `SELECT` from `Security_List` via `WHERE ISIN IN (...)`.
4. For each ISIN with both `Security_Code` and `Security_Name`, paged `UPDATE Transaction` (`Security_code` / `Security_Name`) where those fields are blank, scoped by `CREATEDTIME >= importFloor` when `importStartedAtMs` is set.
5. Near ~60s remaining: re-queue self with `lastIsin` (baton-pass). Skip ISINs missing master code/name.

**Pool:** `UpdateMasters`. Triggered by `UpdatesSecurity_ClientMasters` after master stubs complete (not by AppSail directly).

#### 2. `CalculateHoldingMaster` → `CalculateHoldingWorkers` (orchestrator + slaves)

**Master params:** `source=TxnUpload`, `pairsObjectKey`, `bucketName`, `importStartedAtMs`

**Master flow (sliding-window + baton-pass):**
1. On first run, read pairs manifest from Stratus (`[[accountCode, ISIN], ...]`) and initialize dispatch state at `transactions-meta/holdings-dispatch-{importStartedAtMs}.json` (`nextChunk`, `totalChunks`, `inFlight`, `failedChunks`).
2. Poll each in-flight slave via `JOB.getJob(jobId)`; remove completed/failed entries.
3. Fill up to **10** concurrent slots: submit `CalculateHoldingWorkers` per 200-pair chunk (`CHS_{chunkIndex}_{ts}`), retry on COMPONENT concurrency errors with backoff.
4. When `context.getRemainingExecutionTimeMs()` drops below ~1 min, persist state and **re-queue** `CalculateHoldingMaster` with the same params (`closeWithSuccess` baton-pass).
5. Complete when all chunks are assigned and `inFlight` is empty (no failed chunks).

**Slave params:** `source=TxnUpload`, `pairsObjectKey`, `bucketName`, `chunkStart`, `chunkCount`, `importStartedAtMs`

**Slave flow (incremental — never deletes Holdings):**
1. Read manifest slice; group pairs by account.
2. Per `(account, ISIN)`: fetch `Transaction` rows with `CREATEDTIME >= importStartedAtMs`.
3. **Buys only** → cheap append from last Holdings row (update running qty/cost/WAP).
4. **Any sell** → reconstruct buy queue from existing Holdings rows, then FIFO-apply new txns and INSERT one Holdings row per txn.
5. Optional `Jobs` / `JobStatusPerAccount` tracking when `jobName` param is set.

**Important:** Bonus / Split / Demerger / Merger are **not** replayed here — only raw transactions. Corporate-action changes require `RebuildHoldingtable`.

**Key design:** Append-only for uploads; full DELETE+INSERT rebuilds are handled by `RebuildHoldingtable` / `CalculateHoldingPerAccount` / `HoldingUpdateManually`.

#### 3. `Cal_CB_Append_TxnUpload` (incremental cash)

**Params:** `source=TxnUpload`, `importStartedAtMs`, `lastAccount` (cursor, empty on first run)

**Flow:**
1. Keyset-page distinct accounts from `Transaction` where `CREATEDTIME >= import floor`.
2. Per account: delete any passbook rows this import already wrote (idempotent retry), then append new cash-affecting txns.
3. Continue `Cash_Balance` and monotonic `Sequence` from last `Cash_Balance_Per_Transaction` row.
4. When near **13-min time budget**, self-submit with `lastAccount=<cursor>` to resume (pool `UpdateMasters`, job name `CCB_{ts}`).

**Cash effect rules:** `CASH_ADD` types (CS+, SL+, DIVIDEND, etc.) increase balance; `CASH_SUBTRACT` types (BY-, MGF, etc.) decrease. STT deducted on applicable types. First `CS+` sets opening balance (not additive).

---

### Holdings Subsystem

Three rebuild strategies coexist:

| Function | Strategy | When used |
|----------|----------|-----------|
| `CalculateHoldingWorkers` | **Append-only** incremental | After transaction CSV upload |
| `RebuildHoldingtable` | **DELETE + full FIFO rebuild** (scoped ISINs optional) | After corporate actions, ISIN rename |
| `CalculateHoldingPerAccount` | **DELETE + full FIFO rebuild** (standalone) | Test / manual / legacy paths |
| `HoldingUpdateManually` | **DELETE + full FIFO rebuild** | API `GET /api/holding-update` trigger |

#### `RebuildHoldingtable`

**Params:** `accountCodesJson` (required), `isinsJson` / `isin` (optional scope), `asOnDate`, `source` (log tag)

**Flow:** Delegates to `holdingsRebuildFromSources.js`:
1. Per account: fetch `Transaction`, `Bonus`, `Split`, `Demerger_Record`, `Merger` (paged).
2. Run inline FIFO engine (same rules as AppSail: SPLIT before BONUS, buy uses SETDATE, sell uses TRANDATE).
3. DELETE existing Holdings for scoped ISINs (or all ISINs if unscoped).
4. INSERT full FIFO timeline into `Holdings`.

**Scoped rebuild:** Corporate-action functions pass `isinsJson` so only affected ISINs are rebuilt — critical for staying under the 15-min timeout on large books. Batched at **400 accounts/job**.

#### `HoldingUpdateManually`

Mirrors `CalculateHoldingPerAccount` FIFO engine inline. Triggered from AppSail with hardcoded account batches. Full DELETE+INSERT per account.

#### `CalculateHoldingPerAccount`

Standalone full rebuild with optional `pairsJson` scoping, `Jobs`/`JobStatusPerAccount` tracking, and config filters (`ACCOUNTS_FILTER`, `ISINS_FILTER`, `DRY_RUN`). Skips ISINs merged away via `Merger.OldISIN`. **Not in the upload pipeline** — upload uses Master+Workers instead.

---

### Corporate Actions

#### `UpdateBonusTable`

**Params:** `isin`, `exDate`, `ratio1`, `ratio2`, `secCode`, `secName`, `jobName`, `jobType`, `recompute`

**Flow:**
1. Update `Jobs` status; per-account `JobStatusPerAccount` tracking.
2. Idempotency: skip if `Bonus` row already exists for (ISIN, account, ExDate).
3. `INSERT Bonus_Record` master row (once).
4. Discover accounts with transactions for ISIN; run `fifo.js` `runFifoEngine` per account.
5. `INSERT Bonus` rows for eligible accounts.
6. Queue `RebuildHoldingtable` jobs (pool `CorporateActions`, 400 accounts/batch, scoped to affected ISIN).

**Helper:** `fifo.js` — shared FIFO engine (SPLIT before BONUS priority).

#### `UpdateDividendData`

**Params:** `isin`, `securityCode`, `securityName`, `rate`, `exDate`, `recordDate`, `paymentDate`, `dividendType`, `accountCodesJson`, `applyMode`, `jobName`

**Flow:**
1. Idempotency on `(ISIN, RecordDate)` in `Dividend`.
2. `INSERT Dividend` master row.
3. Per account (from `accountCodesJson` or auto-discovered): inline FIFO engine (`card` mode) → holding on record date.
4. `INSERT Dividend_Record` per eligible account.
5. `APPEND Cash_Balance_Per_Transaction` per account (running balance + monotonic Sequence).
6. Update `Jobs` to `COMPLETED` / `FAILED`.

**No Holdings rebuild** — dividend apply is cash + record only.

#### `MegerFn`

**Params:** `oldIsin`, `newIsin`, `ratio1`, `ratio2`, `recordDateIso`, `effectiveDateIso`, security fields, `jobName`

**Flow:**
1. Lot-level FIFO via `fifo.js` `runFifoForLots` as-of record date.
2. Ensure `Security_List` row for new ISIN.
3. Bulk-write `Merger` + `Merger_Record` rows (Stratus CSV → Datastore bulk job, polled).
4. Per-account `JobStatusPerAccount` tracking.
5. Queue scoped `RebuildHoldingtable` (old + new ISINs).

**Note:** Function name is `MegerFn` (typo preserved) — must match Catalyst deployment name.

#### `DemergerFn`

**Params:** `oldIsin`, `newIsin`, old/new security code/name, `ratio1`, `ratio2`, `allocationPercent`, `recordDate`, `effectiveDate`, `jobName`

**Flow:** Delegates to `demergerApplyCore.js`:
1. Lot-level preview/apply with cost allocation %.
2. Write `Demerger` + `Demerger_Record` rows.
3. Queue scoped `RebuildHoldingtable` (old + new ISINs, **exact case preserved**).

---

### Cash Subsystem

| Function | Mode | Tables |
|----------|------|--------|
| `Cal_CB_Append_TxnUpload` | Incremental append after upload | R: `Transaction`, `Cash_Balance_Per_Transaction`; W/D: `Cash_Balance_Per_Transaction` |
| `Cal_CB_Per_TNX` | Full DELETE + rebuild per account | R: `Transaction`; W/D: `Cash_Balance_Per_Transaction` |
| `CashCalculation` | Daily `Cash_Ledger` incremental | R: `Transaction`, `Cash_Ledger`; W: `Cash_Ledger`, `Jobs` |

**Two parallel cash systems:** `Cash_Balance_Per_Transaction` (passbook — used by UI, upload append, dividend) vs `Cash_Ledger` (`CashCalculation` — legacy daily ledger). They are **not synchronized**.

#### `Cal_CB_Per_TNX`

**Params:** `accountCodesJson` or `pairsJson`

**Flow:** DELETE all `Cash_Balance_Per_Transaction` rows for account (repeat until empty), then rebuild 2020–2026 in 6-month chunks from cash-affecting `Transaction` rows only. No AppSail submit found — manual/cron only. `LEGACY_CLIENT_IDS` is empty when no params provided.

#### `CashCalculation`

**Params:** `accountCode` (array), `jobName`

**Flow:** For each account, read last `Cash_Ledger` state, then process new `Transaction` rows (keyset `ROWID > lastTranId`). Same-date txns UPDATE ledger row; new dates INSERT. Updates `Jobs` status. Triggered from AppSail `calculateBalanceOnce` with hardcoded account list.

---

### ISIN Management

#### `UpdateISIN` (orchestrator)

Two modes via `mode` param:

| Mode | Params | Behavior |
|------|--------|----------|
| `rename` (default) | `old_isin`, `new_isin`, `status_key` | Opens `Jobs` row; dispatches `UpdateISINWorker` (pool `UpdateMasters`) |
| `apply-new` | `isin`, `security_code`, `security_name` | Syncs code/name in `Security_List` + `Transaction` (per-column skip-if-already-same) |

#### `UpdateISINWorker` (batched renamer)

**Params:** `old_isin`, `new_isin`, `status_key`, `target_index` (resume point), `phase` (`rebuild` for phase 2)

**Phase 1 — Rename:** Walks `ISIN_TARGETS` (16 tables, including Merger/Demerger dual-column tables). Updates 300 rows/batch. When time budget (~12 min) runs low, **baton-pass** self with `target_index`. When all tables drained, submits rebuild phase.

**Phase 2 — Rebuild:** Collects accounts holding the new ISIN from `Holdings`, queues scoped `RebuildHoldingtable` jobs (400 accounts/batch, pool `CorporateActions`). Marks `Jobs` `SUCCESS`.

**Tables renamed:** `Security_List`, `Transaction`, `Bonus`, `Bonus_Record`, `Split`, `Dividend`, `Dividend_Record`, `Temp_Transaction`, `Temp_Custodian`, `Bhav_Copy`, `Cash_Balance_Per_Transaction`, `Holdings`, `Demerger_Record`, `Merger` (ISIN + OldISIN), `Merger_Record` (ISIN + OldISIN), `Demerger` (Old_ISIN + New_ISIN).

---

### Export Functions

All export jobs: build CSV → upload to Stratus → update `Jobs` status. UI polls status then downloads via presigned URL.

| Function | Params | Output | Bucket |
|----------|--------|--------|--------|
| `ExportAllCustomerHoldingData` | `asOnDate`, `fileName`, `jobName`, `mode` (scheme-wise / consolidated) | Holdings CSV per client or consolidated by Actual Code | `upload-data-bucket` |
| `ExportCashBalance` | `asOnDate`, `fileName`, `jobName` | All-clients closing cash snapshot | `upload-data-bucket` |
| `ExportCashBalSingleClient` | `accountCode`, `isin`, `fromDate`, `toDate`, `fileName`, `jobName` | Single-client passbook CSV | `upload-data-bucket` |
| `ExportDividendAccounts` | `isin`, `exDate`, `recordDate`, `rate`, `paymentDate`, `fileName`, `jobName` | Dividend eligibility preview (FIFO, no DB writes) | `export-app-data` |
| `ExportDifferentialReport` | `jobName`, `fileName` | FA vs custodian reconciliation CSV | `upload-data-bucket` |
| `ExportSplitAccountHolding` | — | **STUB** (template only) | — |
| `ExportBonusAccountholding` | — | **STUB** (template only) | — |

**`ExportAllCustomerHoldingData` helpers:** `allAccountCodes.js`, `analyticsController.js`, `holdingsFromTable.js` — mirrors AppSail holdings summary logic.

**`ExportDifferentialReport` helpers:** `differentialExport.js` (orchestrates export), `fifo.js` (holdings calc). `diffLogic.js` exists but is **not imported** by `index.js`.

**Wiring gap:** React `TransactionUploadPage` calls `/transaction-uploader/differential-report/*` but **no matching AppSail routes exist** — function is implemented but trigger API is missing.

---

### Maintenance

#### `DeleteFile`

Scheduled cleanup: deletes `Jobs` rows with `CREATEDTIME` older than **10 days** (IST midnight calculation). Inserts its own `Jobs` tracking row during execution. No `submitJob` reference in repo — likely Catalyst cron/manual schedule. **Misnamed** — cleans `Jobs` table, not Stratus files.

---

### Helper Files Map

| Function folder | Helpers |
|-----------------|---------|
| `RebuildHoldingtable` | `holdingsRebuildFromSources.js` — **canonical** full FIFO rebuild engine |
| `UpdateBonusTable`, `MegerFn`, `ExportDividendAccounts`, `ExportDifferentialReport` | `fifo.js` |
| `DemergerFn` | `demergerApplyCore.js` |
| `ExportDifferentialReport` | `differentialExport.js`, `diffLogic.js` (unused) |
| `ExportAllCustomerHoldingData` | `allAccountCodes.js`, `analyticsController.js`, `holdingsFromTable.js` |

**Inlined FIFO engines** (not separate files): `CalculateHoldingPerAccount`, `HoldingUpdateManually`, `UpdateDividendData`, `CalculateHoldingWorkers` (queue reconstruct only).

---

### Per-Function Reference

| Function | Triggered by | Pool | Child jobs | Status |
|----------|-------------|------|------------|--------|
| `CalculateHoldingMaster` | Bulk callback | `UpdateMasters` | `CalculateHoldingWorkers` | ✅ Full |
| `CalculateHoldingWorkers` | Master / direct | `UpdateMasters` | — | ✅ Full |
| `CalculateHoldingPerAccount` | Manual / test | — | — | ✅ Full |
| `RebuildHoldingtable` | Corp actions, ISIN | `CorporateActions` | — | ✅ Full |
| `HoldingUpdateManually` | API `/holding-update` | `UpdateMasters` | — | ✅ Full |
| `UpdatesSecurity_ClientMasters` | Bulk callback | `UpdateMasters` | `EnrichTransactionSecurity` | ✅ Full |
| `EnrichTransactionSecurity` | USCM on success | `UpdateMasters` | Self (baton-pass) | ✅ Full |
| `UpdateSecurity_ClientMaster` | Stratus event | — | — | ✅ Full |
| `Cal_CB_Append_TxnUpload` | Bulk callback | `UpdateMasters` | Self (continuation) | ✅ Full |
| `Cal_CB_Per_TNX` | Manual / cron | — | — | ✅ Full |
| `CashCalculation` | API cash-balance | `Finance` | — | ✅ Full |
| `UpdateBonusTable` | Bonus apply API | `CorporateActions` | `RebuildHoldingtable` | ✅ Full |
| `UpdateDividendData` | Dividend apply API | `CorporateActions` | — | ✅ Full |
| `MegerFn` | Merger apply API | `CorporateActions` | `RebuildHoldingtable` | ✅ Full |
| `DemergerFn` | Demerger apply API | `CorporateActions` | `RebuildHoldingtable` | ✅ Full |
| `UpdateISIN` | ISIN API | `UpdateMasters` | `UpdateISINWorker` | ✅ Full |
| `UpdateISINWorker` | UpdateISIN | `UpdateMasters` | Self + `RebuildHoldingtable` | ✅ Full |
| `ExportAllCustomerHoldingData` | Reports API | `Export` | — | ✅ Full |
| `ExportCashBalance` | Reports API | `Export` | — | ✅ Full |
| `ExportCashBalSingleClient` | Cash/Reports API | `Export` | — | ✅ Full |
| `ExportDividendAccounts` | Dividend export API | `Export` | — | ✅ Full |
| `ExportDifferentialReport` | Legacy upload page (unwired) | `Export` | — | ✅ Full impl, wiring gap |
| `ExportSplitAccountHolding` | — | — | — | ❌ Stub |
| `ExportBonusAccountholding` | — | — | — | ❌ Stub |
| `DeleteFile` | Scheduled | — | — | ✅ Full |
| `HoldingdataUpdate` | — | — | — | ❌ Missing folder |
| `DailyClientHoldingTransaction` | — | — | — | ❌ Missing folder |

### Shared FIFO Rules (across functions)

All FIFO implementations in functions share these rules (matching AppSail preview controllers):

- **Same-day priority:** `TXN → SPLIT → BONUS → DEMERGER → MERGER` (SPLIT before BONUS prevents double-multiplication).
- **Buy effective date:** `SETDATE` (settlement); **sell effective date:** `TRANDATE` (trade date).
- **Holdings read order:** `CREATEDTIME ASC, ROWID ASC` (insert order = FIFO order).
- **Merger skip:** ISINs in `Merger.OldISIN` are excluded from display/rebuild where applicable.
- **Sell consumption:** FIFO from oldest active buy lot; P/L = proceeds − FIFO cost.
- **Split:** Deactivate old lots; new qty = old × (ratio2/ratio1); total cost preserved.
- **Bonus:** Zero-cost new lot sized from pre-bonus holding.

### Timeout Survival Patterns

| Pattern | Where | Mechanism |
|---------|-------|-----------|
| **Baton-pass (cursor)** | `Cal_CB_Append_TxnUpload` | After 13 min, re-queue with `lastAccount` keyset cursor |
| **Baton-pass (target index)** | `UpdateISINWorker` | After 12 min, re-queue at `target_index`; separate `phase=rebuild` job |
| **Fan-out / sliding window** | `CalculateHoldingMaster` | 200 pairs/slave; ≤10 in-flight slaves; Stratus dispatch state + `getJob` polling; baton-pass master before 15-min timeout |
| **Scoped rebuild** | `RebuildHoldingtable` | `isinsJson` limits ISINs per account |
| **Account batching** | Corp-action → rebuild | 400 accounts/job |
| **Delete loops** | Cash passbook deletes | Repeat DELETE until COUNT=0 (~300 rows/round) |
| **Date chunking** | `Cal_CB_Per_TNX` | 6-month windows 2020–2026 |
| **Bulk write + poll** | `MegerFn` | CSV to Stratus → Catalyst bulk job |

### Function Caveats

- `ExportSplitAccountHolding` and `ExportBonusAccountholding` are **unimplemented Catalyst CLI templates**.
- `HoldingdataUpdate` and `DailyClientHoldingTransaction` are in `catalyst.json` but have **no source code**.
- `CalculateHoldingWorkers` is **TxnUpload-only**; does not replay corporate actions.
- `CalculateHoldingPerAccount` is **not in the upload pipeline** — upload uses Master+Workers.
- Upload holdings path is **append-only**; corp-action changes require `RebuildHoldingtable`.
- Two cash systems (`Cash_Balance_Per_Transaction` vs `Cash_Ledger`) are **not synchronized**.
- `ExportDifferentialReport` has **no AppSail trigger route** in the current codebase.
- Large `Transaction` tables (~10–12 lakh rows) require baton-pass in `UpdateISINWorker` to avoid timeout.
- Job param cap ~**5000 chars** — pairs use Stratus manifest; cash append discovers accounts from DB.
- Catalyst ~**300 rows** per ZCQL SELECT/DELETE; functions loop accordingly.

---

## Data Store Tables (Key)

| Table | Purpose |
|-------|---------|
| `Transaction` | Broker trade ledger (~62 columns) |
| `Holdings` | Materialised FIFO holdings timeline |
| `Security_List` | ISIN master (code, name) |
| `clientIds` | Client master (WS_Account_code, Actual_Code) |
| `Bhav_Copy` | NSE bhav copy (closing prices) |
| `Bonus`, `Bonus_Record` | Bonus corporate actions |
| `Split` | Stock split records |
| `Merger`, `Merger_Record` | Merger records |
| `Demerger`, `Demerger_Record` | Demerger records |
| `Dividend`, `Dividend_Record` | Dividend records |
| `Cash_Balance_Per_Transaction` | Cash passbook |
| `Cash_Ledger` | Daily cash ledger |
| `Jobs` | Async job status (polled by UI) |
| `JobStatusPerAccount` | Per-account corp-action apply progress |
| `Temp_Transaction`, `Temp_Custodian` | Staging / reconciliation tables |

---

## Key Workflows

### 1. Transaction Upload

```
User uploads CSV (React → POST /upload-temp-file)
  → Validate 26-column header
  → Upload to Stratus
  → Bulk-write Transaction table
  → Callback fans out: master sync + holdings + cash jobs
  → UI shows success + upload history
```

### 2. Corporate Action (e.g. Bonus)

```
User fills form → Preview (POST) → table of affected accounts
  → Apply (POST) → Catalyst UpdateBonusTable job
  → UI polls /apply-status every 10s until COMPLETED
  → RebuildHoldingtable runs scoped FIFO rebuild in background
```

### 3. Holdings Export (Reports)

```
User selects date + mode → GET /export/export-all
  → Catalyst ExportAllCustomerHoldingData builds CSV → Stratus
  → UI polls /export/check-status → downloads presigned URL

ISIN export (same as Analytics ISIN report):
  Select ISIN (+ optional as-on date) → GET /export/export-by-isin
  → CSV: VIRTUAL_CODE, ACTUAL_CODE, QUANTITY, WAP, HOLDING_VALUE, LAST_PRICE, MARKET_VALUE
```

### 4. Analytics View

```
User selects account + as-on date
  → GET /getHoldingsSummarySimple (reads Holdings + Bhav_Copy)
  → GET /getCashBalanceSummary (reads Cash_Ledger)
  → Click holding row → TransactionPage modal (stock history)
```

---

## Local Development

### Prerequisites

- Node.js 16+
- Zoho Catalyst CLI (`npm install -g zcatalyst-cli`)
- Catalyst project linked (`catalyst.json`)

### Run locally

```bash
# Backend (AppSail) — default port 9000, often proxied to 3001
cd appsail-nodejs
npm install
node index.js

# Frontend — port 3000
cd react-app
npm install
npm start
```

Update `react-app/src/constant.js` `BASE_URL` to match your AppSail URL.

### Deploy

```bash
catalyst deploy
```

Deploys `react-app` (static client), `appsail-nodejs` (API), and all `functions/`.

---

## Known Limitations

- **Stubs:** `ExportSplitAccountHolding`, `ExportBonusAccountholding` (Catalyst CLI templates); Analytics Allocation/Performance tabs; Reports Top Clients tab; Dashboard hardcoded widgets.
- **Missing code:** `HoldingdataUpdate`, `DailyClientHoldingTransaction` declared in `catalyst.json` but no source folders.
- **Function wiring gaps:** `ExportDifferentialReport` implemented but no AppSail trigger route; `DeleteFile` and `Cal_CB_Per_TNX` have no in-repo submitter (cron/manual); `UpdateSecurity_ClientMaster` event may duplicate job-based master sync on upload.
- **Architecture:** Upload holdings path (`CalculateHoldingWorkers`) is append-only and does not replay corporate actions; two cash systems (`Cash_Balance_Per_Transaction` vs `Cash_Ledger`) are not synchronized.
- **Technical debt:** 3 duplicate FIFO engines in AppSail; duplicate `calculateHoldingsSummary`; orphan util modules; hardcoded account lists in `index.js` and `calculateBalanceOnce.js`; `diffLogic.js` in `ExportDifferentialReport` unused.
- **Config:** CORS locked to `localhost:3000` (commented); `APPSAIL_BASE_URL` defaults to Catalyst AppSail URL (bulk-write callback); SQL via string interpolation (not parameterized).
- **UI gaps:** Update ISIN does not poll job completion; legacy `TransactionUploadPage` not routed. `Security_List` may contain null ISIN/code/name rows (e.g. CASH); Split/Bonus/Demerger ISIN dropdowns tolerate these via null-safe search filters.
- **No automated tests** in backend, frontend, or functions.

---

## Dependencies

### Backend (`appsail-nodejs`)

- `express` ^4.18, `cors` ^2.8, `csv-parser` ^3.2, `express-fileupload` ^1.5, `zcatalyst-sdk-node` ^3.1

### Frontend (`react-app`)

- `react` ^19, `react-dom` ^19, `react-router-dom` ^6, `react-scripts` 5
