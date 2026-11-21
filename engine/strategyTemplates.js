/**
 * Aevum strategy templates (v1): pick a template, set parameters, lock it, and Aevum runs and grades it
 * automatically over the forward window on public Coinbase prices. Pure functions, no network: the VBO page
 * (compose + preview), the record/certificate pages (anyone can re-run the grading in their browser) and the
 * attestor script (aevum-contracts/scripts/gradeTemplate.js) all use THIS file, so everyone gets the same result.
 *
 * Locked text = composeTemplate(spec). It is human-readable, ends with the four execution terms, and contains one
 * machine line "Spec: {json}". The grader re-composes the text from the parsed spec and refuses to grade unless it
 * matches byte for byte, so the plain-words description can never drift from what is actually run.
 *
 * Mechanics (same for every template):
 *  - Bars: Coinbase <SYM>-USD 1-hour candles. A bar's close is known at (candle start + 1 hour).
 *  - Decisions are made at each hourly close inside the window, using only closes up to and including that bar
 *    (indicators may use bars from before the lock: that data was public at lock time). The new position is held
 *    until the next hourly close. No look-ahead.
 *  - First decision: the first hourly close at or after the lock. Last: the last hourly close at or before the
 *    window end; the position is closed there (exit cost charged).
 *  - Hours with no Coinbase trades have no candle: the previous close is carried forward. More than 5% of window
 *    hours missing, or no candle in the hour before the first decision = VOID.
 *  - Costs: costBps per side, charged on every change in position size (|new - old| x cost), per leg.
 *  - Long/flat templates never use leverage (position 0 or 1). Pairs is market-neutral (half long, half short).
 *  - Metrics: net return, benchmark return (buy-and-hold the asset; pairs: cash), max drawdown, Sharpe
 *    (hourly returns, annualized with sqrt(24 x 365), no risk-free rate), trades (entries), time in market.
 */
import { TERMS_HEADER, TERM_FIELDS } from "./executionTerms.js";

export const TEMPLATE_PREFIX = "AEVUM STRATEGY TEMPLATE v1";
export const TEMPLATE_ENGINE = "aevum-templates-v1";
export const HOUR = 3600;
const ANN = Math.sqrt(24 * 365);

export const TEMPLATES = {
  momentum: {
    name: "Momentum (trend following)",
    blurb: "Hold the coin while its short-term average is above its long-term average; sit in cash otherwise.",
    params: [
      { key: "fast", label: "Fast average (hours)", min: 2, max: 168, def: 12, step: 1 },
      { key: "slow", label: "Slow average (hours)", min: 4, max: 720, def: 48, step: 1 },
    ],
    legs: 1,
  },
  meanReversion: {
    name: "Mean reversion",
    blurb: "Buy when price falls far below its recent average (a z-score), sell when it comes back.",
    params: [
      { key: "lookback", label: "Lookback (hours)", min: 6, max: 720, def: 48, step: 1 },
      { key: "entryZ", label: "Buy when z-score is below minus", min: 0.5, max: 4, def: 2, step: 0.1 },
      { key: "exitZ", label: "Sell when z-score is back above minus", min: 0, max: 3, def: 0, step: 0.1 },
    ],
    legs: 1,
  },
  pairs: {
    name: "Pairs (relative value)",
    blurb: "Trade the gap between two coins: when one gets unusually expensive versus the other, short it and buy the other; close when the gap normalizes.",
    params: [
      { key: "lookback", label: "Lookback (hours)", min: 12, max: 720, def: 72, step: 1 },
      { key: "entryZ", label: "Open when the gap's z-score passes", min: 0.5, max: 4, def: 2, step: 0.1 },
      { key: "exitZ", label: "Close when the z-score is back inside", min: 0, max: 3, def: 0.5, step: 0.1 },
    ],
    legs: 2,
  },
};

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const pct = (x, d = 2) => (Math.abs(x) < 5e-5 ? (0).toFixed(d) + "%" : `${x > 0 ? "+" : "-"}${Math.abs(x * 100).toFixed(d)}%`);

/** Validate + normalize a spec. Throws with a plain-words message. */
export function normalizeSpec(spec) {
  const t = TEMPLATES[spec && spec.template];
  if (!t) throw new Error("Unknown template");
  const sym = (s) => String(s || "").toUpperCase().replace(/-USD$/, "");
  const assets = (spec.assets || []).map(sym).filter(Boolean);
  if (assets.length !== t.legs || !assets.every((a) => /^[A-Z0-9]{1,12}$/.test(a))) throw new Error(t.legs === 2 ? "Pick two coins" : "Pick a coin");
  if (t.legs === 2 && assets[0] === assets[1]) throw new Error("Pick two different coins");
  const params = {};
  for (const p of t.params) {
    const v = Number(spec.params && spec.params[p.key] != null ? spec.params[p.key] : p.def);
    if (!Number.isFinite(v) || v < p.min || v > p.max) throw new Error(`${p.label}: between ${p.min} and ${p.max}`);
    params[p.key] = p.step >= 1 ? Math.round(v) : Math.round(v * 10) / 10;
  }
  if (spec.template === "momentum" && params.fast >= params.slow) throw new Error("The fast average must be shorter than the slow one");
  if (spec.template !== "momentum" && params.exitZ >= params.entryZ) throw new Error("The close level must be inside the open level");
  const costBps = Math.round(Number(spec.costBps ?? 25));
  if (!Number.isFinite(costBps) || costBps < 0 || costBps > 200) throw new Error("Costs: 0 to 2% per side");
  return { v: 1, template: spec.template, assets, params, costBps, bar: "1h" };
}

export function warmupBars(spec) {
  const p = spec.params;
  return spec.template === "momentum" ? p.slow : p.lookback;
}

function describe(s) {
  const p = s.params, [a, b] = s.assets, c = (s.costBps / 100).toFixed(2);
  if (s.template === "momentum") return [
    `At every hourly close, compare the ${p.fast}-hour and ${p.slow}-hour simple moving averages of the ${a}-USD close.`,
    `If the ${p.fast}-hour average is above the ${p.slow}-hour average, hold ${a} (100% of the test account). Otherwise hold cash.`,
    `Long or cash only. No leverage, no shorting.`,
  ];
  if (s.template === "meanReversion") return [
    `At every hourly close, compute the z-score of the ${a}-USD close: (close - ${p.lookback}-hour average) / ${p.lookback}-hour standard deviation.`,
    `If in cash and the z-score is below -${p.entryZ}, buy ${a} (100% of the test account).`,
    `If holding and the z-score is back above -${p.exitZ}, sell to cash.`,
    `Long or cash only. No leverage, no shorting.`,
  ];
  return [
    `At every hourly close, compute the gap = ln(${a}-USD close) - ln(${b}-USD close) and its z-score over the last ${p.lookback} hours.`,
    `If flat and the z-score is above +${p.entryZ}: short ${a} and buy ${b}, half the test account each. If below -${p.entryZ}: buy ${a} and short ${b}, half each.`,
    `If in a position and the z-score is back inside +/-${p.exitZ}, close both legs.`,
    `Market-neutral paper test (includes a short leg). No leverage beyond the two half-size legs.`,
  ];
}

/** The exact text that gets locked (its keccak256 is the on-chain fingerprint). */
export function composeTemplate(input) {
  const s = normalizeSpec(input);
  const t = TEMPLATES[s.template], c = (s.costBps / 100).toFixed(2);
  const pair = s.assets.map((x) => `${x}-USD`).join(" / ");
  const lines = [
    TEMPLATE_PREFIX,
    `Template: ${t.name}`,
    `Market: ${pair} (Coinbase), 1-hour candles`,
    `Spec: ${JSON.stringify(s)}`,
    "",
    "Rules:",
    ...describe(s).map((x) => `- ${x}`),
    "",
    "Graded automatically by Aevum over the forward window that starts at the lock, on public Coinbase 1-hour candles, with the engine " + TEMPLATE_ENGINE + ". The same engine runs in the browser on the public record, so anyone can re-run the grading.",
  ];
  const terms = {
    sizing: s.template === "pairs" ? "Half the test account per leg (one long, one short) while a position is open; flat otherwise." : `100% of the test account in ${s.assets[0]} while the signal is on, 0% (cash) otherwise. No leverage.`,
    timing: "Signals at each hourly close (UTC); the new position is held from that close to the next hourly close. Closed at the last hourly close of the window.",
    costs: `${c}% per side on every change in position size, per leg.`,
    benchmark: s.template === "pairs" ? "Cash (0%), since the strategy is market-neutral." : `Buy-and-hold ${s.assets[0]} over the same hours.`,
  };
  return lines.join("\n") + TERMS_HEADER + TERM_FIELDS.map(([k, label]) => `${label}: ${terms[k]}`).join("\n");
}

/** Parse a locked text. Returns the normalized spec if (and only if) the text is exactly a template text. */
export function parseTemplate(text) {
  const t = String(text || "");
  if (!t.startsWith(TEMPLATE_PREFIX + "\n")) return null;
  const m = t.match(/\nSpec: (\{[^\n]*\})\n/);
  if (!m) return null;
  try {
    const spec = normalizeSpec(JSON.parse(m[1]));
    return composeTemplate(spec) === t ? spec : null;
  } catch { return null; }
}

/** Coinbase candle rows ([time, low, high, open, close, volume], any order) or {time, close} -> sorted {time, close}. */
export function toBars(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const time = Array.isArray(r) ? Number(r[0]) : Number(r.time);
    const close = Array.isArray(r) ? Number(r[4]) : Number(r.close);
    if (Number.isFinite(time) && close > 0) out.set(time, close);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([time, close]) => ({ time, close }));
}

// Close series on an hourly grid of bar-close times [first..last], forward-filled. Returns { closes, missing }.
function grid(bars, firstClose, lastClose, windowStartClose) {
  const byClose = new Map(bars.map((b) => [b.time + HOUR, b.close]));
  let prev = null;
  for (const b of bars) if (b.time + HOUR <= firstClose) prev = b.close; // last close before the grid
  const closes = [];
  let missing = 0;
  for (let t = firstClose; t <= lastClose; t += HOUR) {
    const c = byClose.get(t);
    if (c != null) prev = c; else if (t >= windowStartClose) missing++;
    closes.push(prev);
  }
  return { closes, missing };
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };

/**
 * Run a template over [lockTs, endTs] (unix seconds). barsByAsset: { SYM: [{time, close}] } hourly bars that must
 * cover warmup + window. Returns { result: "GRADED" | "VOID", ... metrics }.
 */
export function runTemplate(input, barsByAsset, lockTs, endTs, opts = {}) {
  const s = normalizeSpec(input);
  const first = Math.ceil(lockTs / HOUR) * HOUR;          // first decision = first hourly close at/after the lock
  const last = Math.floor(endTs / HOUR) * HOUR;           // last hourly close at/before the window end
  const W = warmupBars(s);
  const nWin = Math.round((last - first) / HOUR) + 1;
  if (nWin < 2) return { result: "VOID", reason: "window shorter than two hourly closes" };
  const gStart = first - W * HOUR;
  const series = [];
  for (const a of s.assets) {
    const bars = toBars(barsByAsset[a]);
    const g = grid(bars, gStart, last, first);
    if (g.closes[W] == null) return { result: "VOID", reason: `no ${a}-USD price at the first decision` };
    if (g.missing > 0.05 * nWin) return { result: "VOID", reason: `${a}-USD: ${g.missing} of ${nWin} window hours have no candle (> 5%)` };
    if (g.closes.slice(0, W + 1).some((x) => x == null)) return { result: "VOID", reason: `${a}-USD: not enough history before the lock for the indicator` };
    series.push(g.closes);
  }
  const p = s.params, cost = s.costBps / 1e4;
  const pos = [];          // pos[k] = per-leg weights held from decision k to k+1
  let cur = s.assets.map(() => 0);
  for (let k = 0; k < nWin; k++) {
    const i = W + k;       // index of this decision's close in the grid
    let next = cur;
    if (s.template === "momentum") {
      const c = series[0];
      const f = mean(c.slice(i - p.fast + 1, i + 1)), sl = mean(c.slice(i - p.slow + 1, i + 1));
      next = [f > sl ? 1 : 0];
    } else if (s.template === "meanReversion") {
      const win = series[0].slice(i - p.lookback + 1, i + 1), d = sd(win);
      const z = d > 0 ? (series[0][i] - mean(win)) / d : 0;
      if (cur[0] === 0 && z < -p.entryZ) next = [1];
      else if (cur[0] === 1 && z > -p.exitZ) next = [0];
    } else {
      const gap = series[0].slice(i - p.lookback + 1, i + 1).map((x, j) => Math.log(x) - Math.log(series[1][i - p.lookback + 1 + j]));
      const d = sd(gap), z = d > 0 ? (gap[gap.length - 1] - mean(gap)) / d : 0;
      const open = cur[0] !== 0;
      if (!open && z > p.entryZ) next = [-0.5, 0.5];
      else if (!open && z < -p.entryZ) next = [0.5, -0.5];
      else if (open && Math.abs(z) < p.exitZ) next = [0, 0];
    }
    if (k === nWin - 1) next = s.assets.map(() => 0); // close everything at the last hourly close
    pos.push(next);
    cur = next;
  }
  // Equity: costs at each decision, then hold to the next close.
  let eq = 1, peak = 1, maxDD = 0, trades = 0, inMkt = 0, held = s.assets.map(() => 0), turnover = 0;
  const rets = [], tradeList = [];
  let open = null; // B4: round trips (flat -> in the market -> flat), costs included
  for (let k = 0; k < nWin; k++) {
    const i = W + k, w = pos[k];
    const tc = w.reduce((a, x, j) => a + Math.abs(x - held[j]), 0);
    if (held.every((x) => x === 0) && w.some((x) => x !== 0)) { trades++; open = { k, eq, side: w }; }
    turnover += tc;
    let r = -tc * cost;
    if (k < nWin - 1) {
      r += w.reduce((a, x, j) => a + x * (series[j][i + 1] / series[j][i] - 1), 0);
      if (w.some((x) => x !== 0)) inMkt++;
    }
    eq *= 1 + r;
    if (k < nWin - 1 || tc > 0) rets.push(r);
    peak = Math.max(peak, eq); maxDD = Math.min(maxDD, eq / peak - 1);
    if (open && k > open.k && w.every((x) => x === 0)) {
      tradeList.push({ entry: first + open.k * HOUR, exit: first + k * HOUR, hours: k - open.k, side: open.side, ret: eq / open.eq - 1 });
      open = null;
    }
    held = w;
  }
  const hours = nWin - 1;
  const bench = s.template === "pairs" ? 0 : series[0][W + hours] / series[0][W] - 1;
  const sdev = rets.length > 1 ? sd(rets) : 0;
  const ret = eq - 1;
  return {
    result: "GRADED", engine: TEMPLATE_ENGINE, spec: s,
    firstDecision: first, lastDecision: last, hours,
    netReturn: r4(ret), benchmarkReturn: r4(bench), excessReturn: r4(ret - bench),
    maxDrawdown: r4(maxDD), sharpe: sdev > 0 ? Math.round((mean(rets) / sdev) * ANN * 100) / 100 : 0,
    trades, timeInMarket: hours ? r4(inMkt / hours) : 0, turnover: r4(turnover),
    returnBps: Math.trunc(ret * 1e4),
    priceStart: series.map((c) => c[W]), priceEnd: series.map((c) => c[W + hours]),
    // Only when asked (certificate page, B17): the attested result data stays exactly as before.
    ...(opts.trades ? { tradeList: tradeList.map((t) => ({ ...t, ret: r4(t.ret) })), tradeStats: tradeStatsOf(tradeList) } : {}),
  };
}

/**
 * B4 trade stats from round-trip returns (fractions, costs included). Pure; also usable for other trade lists.
 * profitFactor = sum of winning returns / |sum of losing returns| (null when there is no losing trade).
 * `few` = fewer than 5 trades: show the numbers, but they say little.
 */
export function tradeStatsOf(list) {
  const r = (list || []).map((t) => t.ret).filter((x) => Number.isFinite(x));
  if (!r.length) return { n: 0 };
  const wins = r.filter((x) => x > 0), losses = r.filter((x) => x < 0);
  const sum = (a) => a.reduce((x, y) => x + y, 0), avg = (a) => (a.length ? sum(a) / a.length : null);
  const hrs = (list || []).map((t) => t.hours).filter((x) => Number.isFinite(x));
  return {
    n: r.length, wins: wins.length, losses: losses.length, winRate: r4(wins.length / r.length),
    avgWin: wins.length ? r4(avg(wins)) : null, avgLoss: losses.length ? r4(Math.abs(avg(losses))) : null,
    best: r4(Math.max(...r)), worst: r4(Math.min(...r)),
    profitFactor: losses.length ? Math.round((sum(wins) / Math.abs(sum(losses))) * 100) / 100 : null,
    avgHoldHours: hrs.length ? Math.round((sum(hrs) / hrs.length) * 10) / 10 : null,
    few: r.length < 5,
  };
}

export function summaryLine(r) {
  if (!r || r.result !== "GRADED") return `VOID (${(r && r.reason) || "no data"})`;
  const b = r.spec.template === "pairs" ? "vs cash 0.00%" : `vs buy-and-hold ${pct(r.benchmarkReturn)}`;
  return `Net return ${pct(r.netReturn)} ${b}; max drawdown ${pct(r.maxDrawdown)}; Sharpe ${r.sharpe.toFixed(2)}; ${r.trades} trade${r.trades === 1 ? "" : "s"}; in the market ${(r.timeInMarket * 100).toFixed(0)}% of hours`;
}

/** Fetch hourly candles [from, to) in pages of 299 (Coinbase max 300 per request). `get(sym, startSec, endSec)` returns Coinbase rows. */
export async function fetchHourly(sym, from, to, get) {
  const rows = [];
  for (let s = Math.floor(from / HOUR) * HOUR; s < to; s += 299 * HOUR) {
    const e = Math.min(to, s + 299 * HOUR);
    rows.push(...(await get(sym, s, e)));
  }
  return toBars(rows);
}

/** Everything a runner needs: fetch warmup + window bars for each leg, then run. */
export async function gradeTemplate(input, lockTs, endTs, get, opts = {}) {
  const s = normalizeSpec(input);
  const from = Math.ceil(lockTs / HOUR) * HOUR - (warmupBars(s) + 2) * HOUR - HOUR;
  const bars = {};
  for (const a of s.assets) bars[a] = await fetchHourly(a, from, endTs + 1, get);
  return runTemplate(s, bars, lockTs, endTs, opts);
}
