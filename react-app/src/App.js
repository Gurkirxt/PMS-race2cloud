import "./App.css";
import { HashRouter, Routes, Route } from "react-router-dom";
import DashboardPage from "./pages/Dashboard/DashboardPage";
import AnalyticsPage from "./pages/Analytics/AnalyticsPage";
import SplitPage from "./pages/SplitPage/SplitPage";
import BhavCopyUploadPage from "./pages/BhavCopyUpload/BhavCopyUploadPage";
import TransactionUploadPage from "./pages/TransactionUpload/TransactionUploadPage";
import ReportsPage from "./pages/Reports/ReportsPage";
import BonusPage from "./pages/BonusPage/BonusPage";
import DividendPage from "./pages/Dividend/DividendPage";
import DemergerPage from "./pages/DemergerPage/DemergerPage";
import MergerPage from "./pages/MergerPage/MergerPage";
import TempTransaction from "./pages/TempTransactionUpload/TempTransaction";
import UpdateISINPage from "./pages/update-isin/UpdateISINPage";
import CashBalancePage from "./pages/CashBalancePage/CashBalancePage";
import ClientPage from "./pages/Master/ClientPage";
import SecurityPage from "./pages/Master/SecurityPage";

function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/split" element={<SplitPage />} />
        <Route path="/bonus" element={<BonusPage />} />
        <Route path="/dividend" element={<DividendPage />} />
        <Route path="/demerger" element={<DemergerPage />} />
        <Route path="/merger" element={<MergerPage />} />
        <Route path="/bhav-copy" element={<BhavCopyUploadPage />} />
        {/* <Route path="/transaction-upload" element={<TransactionUploadPage />} /> */}
        <Route path="/temp-transaction" element={<TempTransaction />} />
        <Route path="/updateISIN" element={<UpdateISINPage />} />
        <Route path="/cash-balance" element={<CashBalancePage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/master-client" element={<ClientPage />} />
        <Route path="/master-security" element={<SecurityPage />} />
      </Routes>
    </HashRouter>
  );
}

export default App;
