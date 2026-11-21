/**
 * Execution terms shared by the VBO page (compose/restore) and /api/record (public terms box).
 */
// Execution terms (Nov 10, from r/VerifiedTrading feedback): a strategy can be "right" on paper and still be
// impossible to follow once sizing, timing and costs are counted. These four terms are frozen in the locked text
// (and so in the on-chain fingerprint) together with the rules, so they can't be changed after results come in.
export const TERMS_HEADER = "\n\n--- EXECUTION TERMS (locked) ---\n";
export const TERM_FIELDS = [
  ["sizing", "Position sizing", "e.g. 2% of account equity per trade, max 3 open positions"],
  ["timing", "Entry and exit timing", "e.g. market orders at the close of the 1-hour candle that triggers the signal"],
  ["costs", "Costs assumed (fees + slippage)", "e.g. 0.6% per round trip (Coinbase taker fees) + 0.1% slippage"],
  ["benchmark", "Benchmark", "e.g. buy-and-hold BTC over the same window"],
];
export function composeLocked(rules, terms) {
  const r = (rules || "").trimEnd();
  if (!r) return "";
  return r + TERMS_HEADER + TERM_FIELDS.map(([k, label]) => `${label}: ${(terms?.[k] || "").trim()}`).join("\n");
}
export function parseLocked(text) {
  const t = text || "";
  const i = t.indexOf(TERMS_HEADER);
  const terms = { sizing: "", timing: "", costs: "", benchmark: "" };
  if (i < 0) return { rules: t, terms };
  for (const line of t.slice(i + TERMS_HEADER.length).split("\n")) {
    const f = TERM_FIELDS.find(([, label]) => line.startsWith(label + ": "));
    if (f) terms[f[0]] = line.slice(f[1].length + 2);
  }
  return { rules: t.slice(0, i), terms };
}
