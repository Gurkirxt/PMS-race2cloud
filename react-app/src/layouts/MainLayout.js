import React from "react";
import { useLocation } from "react-router-dom";
import {
  PageLayout,
  Sidebar,
  Topbar,
} from "../components/common/CommonComponents";

function MainLayout({ title, rightContent, children }) {
  const location = useLocation();

  // Determine active key based on current route
  const getActiveKey = () => {
    if (location.pathname === "/analytics") {
      return "analytics";
    }
    if (location.pathname === "/split") {
      return "split";
    }
    if (location.pathname === "/bonus") {
      return "bonus";
    }
    if (location.pathname === "/dividend") {
      return "dividend";
    }
    if (location.pathname === "/demerger") {
      return "demerger";
    }
    if (location.pathname === "/merger") {
      return "merger";
    }
    if (location.pathname === "/bhav-copy") {
      return "bhav-copy";
    }
    if (location.pathname === "/transaction-upload") {
      return "transaction-upload";
    }
    if (location.pathname === "/temp-transaction") {
      return "temp-transaction";
    }
    if (location.pathname === "/updateISIN") {
      return "updateISIN";
    }
    if (location.pathname === "/cash-balance") {
      return "cash-balance";
    }
    if (location.pathname === "/reports") {
      return "reports";
    }
    if (location.pathname === "/master-client") {
      return "master-client";
    }
    if (location.pathname === "/master-security") {
      return "master-security";
    }

    return "dashboard";
  };

  const items = [
    { key: "dashboard", label: "Dashboard" },
    { key: "analytics", label: "Analytics" },
    {
      key: "corporate-actions", label: "Corporate Actions", children: [
        { key: "split", label: "Split" },
        { key: "bonus", label: "Bonus" },
        { key: "dividend", label: "Dividend" },
        { key: "demerger", label: "Demerger" },
        { key: "merger", label: "Merger" },
      ]
    },
    { key: "bhav-copy", label: "Bhav Copy" },
    // { key: "transaction-upload", label: "Transaction Upload" },
    { key: "temp-transaction", label: "Transaction Upload" },
    { key: "updateISIN", label: "Update ISIN" },
    { key: "cash-balance", label: "Cash Balance" },
    { key: "reports", label: "Reports" },
    {
      key: "master", label: "Master", children: [
        { key: "master-client", label: "Client" },
        { key: "master-security", label: "Security" },
      ]
    },
  ];

  const contentStyle = {
    paddingTop: 16,
    paddingBottom: 24,
    paddingLeft: 16, // space between sidebar and cards
    paddingRight: 12, // small inner right padding (less than before)
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box",
    overflowX: "visible",
  };

  return (
    <PageLayout sidebar={<Sidebar items={items} activeKey={getActiveKey()} />}>
      <Topbar title={title} rightContent={rightContent} />
      <div style={contentStyle}>{children}</div>
    </PageLayout>
  );
}

export default MainLayout;
