import { useEffect, useState } from "react";
import { BASE_URL } from "../constant.js";

/**
 * Account-code options for the export dropdowns.
 * `mode = "actual"` lists distinct Actual Codes (consolidated export);
 * anything else lists virtual codes / WS_Account_code (scheme-wise export).
 */
export function useAccountCodes(mode = "scheme") {
  const [clientOptions, setClientOptions] = useState([]);

  useEffect(() => {
    fetchClientIds();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const fetchClientIds = async () => {
    try {
      const endpoint =
        mode === "actual"
          ? `${BASE_URL}/analytics/getAllActualCodes`
          : `${BASE_URL}/analytics/getAllAccountCodes`;
      const res = await fetch(endpoint);
      const data = await res.json();

      const seen = new Set();
      const options = (data.data || [])
        .map((row) => {
          const code = (row.clientIds?.WS_Account_code ?? row.WS_Account_code ?? "").toString().trim();
          return { value: code, label: code };
        })
        .filter((opt) => {
          if (!opt.value || seen.has(opt.value)) return false;
          seen.add(opt.value);
          return true;
        })
        .sort((a, b) => (a.label || "").localeCompare(b.label || ""));

      setClientOptions(options);
    } catch (err) {
      console.error("Failed to fetch account codes:", err);
    }
  };

  return {
    clientOptions,
  };
}
