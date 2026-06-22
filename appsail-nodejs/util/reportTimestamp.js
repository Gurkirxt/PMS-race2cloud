/**
 * Generation timestamp stamped into exported reports: "YYYY-MM-DD HH:MM:SS IST".
 * Uses a fixed IST (UTC+5:30) offset so it doesn't depend on the server's
 * timezone or ICU data.
 */
export function reportTimestamp(date = new Date()) {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().replace("T", " ").slice(0, 19) + " IST";
}
