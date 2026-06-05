import React ,{useState,useEffect} from "react";
import { useNavigate, useLocation } from "react-router-dom";

/* ===========================
   BUTTONS
   =========================== */

export function Button({
  children,
  variant = "primary",
  style = {},
  ...props
}) {
  const base = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "8px 16px",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    border: "none",
    cursor: "pointer",
  };

  const variants = {
    primary: {
      background: "#c2185b", // Changed from #4f46e5 to pink/maroon
      color: "#ffffff",
    },
    secondary: {
      background: "#ffffff",
      color: "#374151",
      border: "1px solid #d1d5db",
    },
    ghost: {
      background: "transparent",
      color: "#374151",
    },
  };

  return (
    <button style={{ ...base, ...variants[variant], ...style }} {...props}>
      {children}
    </button>
  );
}

/* ===========================
   CARDS
   =========================== */

export function Card({ children, style = {} }) {
  const base = {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    boxShadow: "0 10px 25px rgba(15, 23, 42, 0.06)",
    padding: 16,
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box",
    overflow: "visible",
  };

  return <div style={{ ...base, ...style }}>{children}</div>;
}

export function StatCard({ label, value, subLabel, style = {} }) {
  const container = {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    color: "#ffffff",
    ...style,
  };

  const labelStyle = {
    fontSize: 11,
    fontWeight: 600,
    opacity: 0.85,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  };

  const valueStyle = {
    fontSize: 24,
    fontWeight: 600,
  };

  const subLabelStyle = {
    fontSize: 11,
    opacity: 0.8,
  };

  return (
    <Card style={container}>
      <span style={labelStyle}>{label}</span>
      <span style={valueStyle}>{value}</span>
      {subLabel && <span style={subLabelStyle}>{subLabel}</span>}
    </Card>
  );
}

/* ===========================
   BADGE / TAG
   =========================== */

export function Badge({ children, variant = "neutral", style = {} }) {
  const base = {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 8px",
    borderRadius: 9999,
    fontSize: 11,
    fontWeight: 500,
  };

  const variants = {
    buy: {
      backgroundColor: "#dcfce7",
      color: "#166534",
    },
    sell: {
      backgroundColor: "#fee2e2",
      color: "#b91c1c",
    },
    neutral: {
      backgroundColor: "#e5e7eb",
      color: "#374151",
    },
  };

  return (
    <span style={{ ...base, ...variants[variant], ...style }}>{children}</span>
  );
}

/* ===========================
   TRANSACTION TYPE CARD
   =========================== */

export function TransactionTypeCard({ children, style = {} }) {
  const cardStyle = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "4px 12px",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    textTransform: "uppercase",
    backgroundColor: "#fce7f3",
    color: "#5a3e2e",
    minWidth: "60px",
    textAlign: "center",
    ...style,
  };

  return <span style={cardStyle}>{children}</span>;
}

/* ===========================
   EXCHANGE CARD
   =========================== */

export function ExchangeCard({ exchange, style = {} }) {
  const cardStyle = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "4px 12px",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    textTransform: "uppercase",
    minWidth: "60px",
    textAlign: "center",
    ...style,
  };

  const variants = {
    NSE: {
      backgroundColor: "#d1fae5",
      color: "#065f46",
    },
    BSE: {
      backgroundColor: "#d1fae5",
      color: "#065f46",
    },
    default: {
      backgroundColor: "#e5e7eb",
      color: "#374151",
    },
  };

  const variant = variants[exchange] || variants.default;

  return <span style={{ ...cardStyle, ...variant, ...style }}>{exchange}</span>;
}

/* ===========================
   FORM INPUTS
   =========================== */

export function TextInput({
  label,
  style = {},
  inputStyle: customInputStyle = {},
  ...props
}) {
  const labelStyle = {
    fontSize: 13,
    fontWeight: 600,
    color: "#374151",
    marginBottom: 8,
    display: "block",
    letterSpacing: 0.01,
  };

  const defaultInputStyle = {
    width: "100%",
    borderRadius: 12,
    border: "2px solid #e5e7eb",
    padding: "12px 14px",
    fontSize: 14,
    color: "#111827",
    boxSizing: "border-box",
    backgroundColor: "#ffffff",
    transition: "all 0.2s ease",
    outline: "none",
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
  };

  const combinedInputStyle = {
    ...defaultInputStyle,
    ...customInputStyle,
    ...style,
  };

  const handleFocus = (e) => {
    e.target.style.borderColor = "#c2185b"; // Changed from #4f46e5
    e.target.style.boxShadow =
      "0 0 0 4px rgba(194, 24, 91, 0.1), 0 4px 12px rgba(194, 24, 91, 0.15)"; // Changed to pink
  };

  const handleBlur = (e) => {
    e.target.style.borderColor = "#e5e7eb";
    e.target.style.boxShadow = "0 1px 3px rgba(0, 0, 0, 0.05)";
  };

  const handleMouseEnter = (e) => {
    if (document.activeElement !== e.target) {
      e.target.style.borderColor = "#f8bbd0"; // Changed from #c7d2fe to light pink
      e.target.style.boxShadow = "0 2px 6px rgba(194, 24, 91, 0.08)"; // Changed to pink
    }
  };

  const handleMouseLeave = (e) => {
    if (document.activeElement !== e.target) {
      e.target.style.borderColor = "#e5e7eb";
      e.target.style.boxShadow = "0 1px 3px rgba(0, 0, 0, 0.05)";
    }
  };

  const { inputStyle, ...restProps } = props;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        position: "relative",
      }}
    >
      {label && <label style={labelStyle}>{label}</label>}
      <input
        {...restProps}
        style={combinedInputStyle}
        onFocus={(e) => {
          handleFocus(e);
          if (restProps.onFocus) restProps.onFocus(e);
        }}
        onBlur={(e) => {
          handleBlur(e);
          if (restProps.onBlur) restProps.onBlur(e);
        }}
        onMouseEnter={(e) => {
          handleMouseEnter(e);
          if (restProps.onMouseEnter) restProps.onMouseEnter(e);
        }}
        onMouseLeave={(e) => {
          handleMouseLeave(e);
          if (restProps.onMouseLeave) restProps.onMouseLeave(e);
        }}
      />
    </div>
  );
}

export function SelectInput({ label, options = [], style = {}, ...props }) {
  const labelStyle = {
    fontSize: 12,
    fontWeight: 500,
    color: "#4b5563",
    marginBottom: 4,
  };

  const selectStyle = {
    width: "100%",
    borderRadius: 6,
    border: "1px solid #e5e7eb",
    padding: "6px 10px",
    fontSize: 12,
    color: "#111827",
    boxSizing: "border-box",
    backgroundColor: "#ffffff",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", marginBottom: 8 }}>
      {label && <label style={labelStyle}>{label}</label>}
      <select style={{ ...selectStyle, ...style }} {...props}>
        {options.map((opt) => (
          <option key={opt.value ?? opt.label} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/* ===========================
   TABLE
   =========================== */

export function Table({ columns = [], data = [], style = {} }) {
  const container = {
    width: "100%",
    maxWidth: "100%",
    overflowX: "auto",
    overflowY: "visible",
    backgroundColor: "transparent",
    boxSizing: "border-box",
    ...style,
  };

  const thStyle = {
    fontSize: 12,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "#6b7280",
    padding: "8px 12px",
    borderBottom: "1px solid #e5e7eb",
    whiteSpace: "nowrap",
  };

  const tdStyle = {
    fontSize: 13,
    color: "#111827",
    padding: "8px 12px",
    borderBottom: "1px solid #f3f4f6",
    whiteSpace: "nowrap",
  };

  return (
    <div style={container}>
      <table
        style={{
          width: "100%",
          minWidth: "max-content",
          borderCollapse: "collapse",
        }}
      >
        <thead style={{ backgroundColor: "#f9fafb" }}>
          <tr>
            {columns.map((col) => (
              <th key={col.key} style={thStyle}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr
              key={i}
              style={{
                backgroundColor: i % 2 === 0 ? "#ffffff" : "#f9fafb",
              }}
            >
              {columns.map((col) => (
                <td key={col.key} style={tdStyle}>
                  {col.render ? col.render(row[col.key], row) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ===========================
   PAGINATION
   =========================== */

export function Pagination({
  currentPage,
  pageSize,
  totalRows = {totalRows:0},
  onPageChange,
  onPageSizeChange,
}) {
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize || 1));

  const containerStyle = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    fontSize: 12,
    color: "#4b5563",
  };

  const controlsStyle = {
    display: "flex",
    alignItems: "center",
    gap: 8,
  };

  const buttonStyle = (disabled) => ({
    padding: "4px 8px",
    borderRadius: 4,
    border: "1px solid #e5e7eb",
    backgroundColor: disabled ? "#f9fafb" : "#ffffff",
    color: disabled ? "#9ca3af" : "#374151",
    fontSize: 11,
    cursor: disabled ? "default" : "pointer",
  });

  const selectStyle = {
    padding: "4px 8px",
    borderRadius: 4,
    border: "1px solid #e5e7eb",
    fontSize: 11,
  };

  const handleFirst = () => !onPageChange || onPageChange(1);
  const handlePrev = () =>
    !onPageChange || onPageChange(Math.max(1, currentPage - 1));
  const handleNext = () =>
    !onPageChange || onPageChange(Math.min(totalPages, currentPage + 1));
  const handleLast = () => !onPageChange || onPageChange(totalPages);

  const disabledPrev = currentPage <= 1;
  const disabledNext = currentPage >= totalPages;

  return (
    <div style={containerStyle}>
      <div style={controlsStyle}>
        <button
          type="button"
          style={buttonStyle(disabledPrev)}
          onClick={!disabledPrev ? handleFirst : undefined}
        >
          « First
        </button>
        <button
          type="button"
          style={buttonStyle(disabledPrev)}
          onClick={!disabledPrev ? handlePrev : undefined}
        >
          ‹ Prev
        </button>
        <span>
          Page <strong>{currentPage}</strong> of <strong>{totalPages}</strong>
        </span>
        <button
          type="button"
          style={buttonStyle(disabledNext)}
          onClick={!disabledNext ? handleNext : undefined}
        >
          Next ›
        </button>
        <button
          type="button"
          style={buttonStyle(disabledNext)}
          onClick={!disabledNext ? handleLast : undefined}
        >
          Last »
        </button>
      </div>

      
    </div>
  );
}

/* ===========================
   LAYOUT (SIDEBAR / TOPBAR)
   =========================== */

export function Sidebar({ items = [], activeKey }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [openKey, setOpenKey] = useState(null);

  // Keep Corporate Actions open when on any of its child routes (Split, Bonus, Dividend)
  const corporateActionPaths = ["/split", "/bonus", "/dividend", "/demerger", "/merger"];
  const isOnCorporateActionChild = corporateActionPaths.includes(location.pathname);

  // Keep any parent dropdown (Corporate Actions, Master, ...) open when on one of its child routes
  useEffect(() => {
    const currentKey =
      location.pathname === "/" ? "dashboard" : location.pathname.replace(/^\//, "");
    const parent = items.find(
      (it) => it.children && it.children.some((c) => c.key === currentKey)
    );
    if (parent) {
      setOpenKey(parent.key);
    }
  }, [location.pathname, items]);

  const sidebarStyle = {
    width: 240,
    flexShrink: 0,
    background: "#8b1538", // Changed to dark pink/maroon (solid color instead of gradient)
    color: "#ffffff",
    minHeight: "100vh",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    boxShadow: "4px 0 20px rgba(0, 0, 0, 0.1)",
    zIndex: 100,
  };

  const headerStyle = {
    padding: "24px 20px 20px",
    fontSize: 24,
    fontWeight: 700,
    color: "#ffffff",
    letterSpacing: "0.5px",
    borderBottom: "1px solid rgba(255, 255, 255, 0.1)",
  };

  const navContainerStyle = {
    flex: 1,
    padding: "16px 0",
    display: "flex",
    flexDirection: "column",
  };

  const itemStyle = (active) => ({
    width: "100%",
    textAlign: "left",
    padding: "14px 20px",
    fontSize: 15,
    border: "none",
    backgroundColor: active ? "rgba(255, 255, 255, 0.15)" : "transparent",
    color: active ? "#ffffff" : "rgba(255, 255, 255, 0.7)",
    cursor: "pointer",
    fontWeight: active ? 600 : 500,
    transition: "all 0.2s ease",
    borderRadius: 0,
    borderLeft: active ? "4px solid #ffffff" : "4px solid transparent",
    marginLeft: active ? "0" : "4px",
  });

  const handleNavigation = (item) => {
    // Parent menu (e.g. Corporate Actions)
    if (item.children) {
      // Do not collapse when already on a child route; just toggle
      if (isOnCorporateActionChild && item.key === "corporate-actions") {
        setOpenKey(openKey === item.key ? null : item.key);
        return;
      }
      setOpenKey(openKey === item.key ? null : item.key);
      return;
    }

    // Child navigation (e.g. Split, Bonus, Dividend)
    if (item.key === "dashboard") {
      navigate("/");
    } else {
      navigate(`/${item.key}`);
    }
  };


  return (
    <aside style={sidebarStyle}>
      <div style={headerStyle}>Menu</div>
      <div style={navContainerStyle}>
        <nav style={{ display: "flex", flexDirection: "column", gap: 4 }}>
  {items.map((item) => {
    const hasChildren = !!item.children;
    const isOpen = openKey === item.key;

    return (
      <div key={item.key}>
        {/* Parent / normal item */}
        <button
          style={itemStyle(
            activeKey === item.key ||
              (item.key === "corporate-actions" && isOnCorporateActionChild)
          )}
          onClick={() => handleNavigation(item)}
        >
          {item.label}
          {hasChildren && (
            <span style={{ float: "right", fontSize: 12 }}>
              {isOpen ? "▾" : "▸"}
            </span>
          )}
        </button>

        {/* CHILDREN (THIS WAS MISSING) */}
        {hasChildren && isOpen && (
          <div style={{ paddingLeft: 18 }}>
            {item.children.map((child) => (
              <button
                key={child.key}
                style={itemStyle(activeKey === child.key)}
                onClick={() => handleNavigation(child)}
              >
                {child.label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  })}
</nav>

      </div>
    </aside>
  );
}

export function Topbar({ title, rightContent }) {
  const bar = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 24px",
    background: "#ffffff", // Changed from gradient to white
    color: "#111827", // Changed from white to dark text
    boxShadow: "0 2px 8px rgba(0, 0, 0, 0.08)", // Lighter shadow
  };

  const titleStyle = { fontSize: 20, fontWeight: 600, color: "#111827" };
  const subtitleStyle = { fontSize: 12, opacity: 0.85 };
  const handleexport = () => {
    console.log("export");
  };

  return (
    <header style={bar}>
      <div>
        <h1 style={titleStyle}>{title}</h1>
      </div>
    </header>
  );
}

export function PageLayout({ sidebar, children }) {
  const layout = {
    display: "flex",
    backgroundColor: "#ffffff", // Changed from #f3f4ff to white
    minHeight: "100vh",
    overflowX: "hidden",
    width: "100%",
    maxWidth: "100vw",
    boxSizing: "border-box",
  };

  const main = {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    overflowX: "hidden",
    width: "100%",
    maxWidth: "100%",
    boxSizing: "border-box",
  };

  return (
    <div style={layout}>
      {sidebar}
      <main style={main}>{children}</main>
    </div>
  );
}
