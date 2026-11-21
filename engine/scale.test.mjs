// Scale test: hundreds of random template certificates (all 3 templates, random params, costs, coins, windows,
// missing candles) -> grade -> attest -> rerun must MATCH; a random tamper of each must MISMATCH.
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { rerun } from "./rerun.mjs";
import { composeTemplate, gradeTemplate, TEMPLATES } from "./strategyTemplates.js";
const H = 3600; let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const series = (start, end, p0, gapRate) => { let p = p0; const rows = []; for (let t = start; t <= end; t += H) { p *= 1 + (rnd() - 0.5) * 0.02; if (rnd() < gapRate) continue; rows.push([t, p * (1 - rnd() * 0.005), p * (1 + rnd() * 0.005), p, p * (1 + (rnd() - 0.5) * 0.004), 1 + rnd() * 10]); } return rows; };
const COINS = ["BTC", "ETH", "SOL", "PAXG"];
let match = 0, voids = 0, caught = 0, n = 0;
for (let i = 0; i < 300; i++) {
  const tpl = Object.keys(TEMPLATES)[i % 3];
  const params = Object.fromEntries(TEMPLATES[tpl].params.map((p) => [p.key, p.min + Math.floor(rnd() * ((Math.min(p.max, p.min + 100 * p.step) - p.min) / p.step + 1)) * p.step]));
  if (tpl === "momentum" && params.fast >= params.slow) params.slow = params.fast + 4;
  const assets = TEMPLATES[tpl].legs === 2 ? [COINS[i % 2], COINS[2 + (i % 2)]] : [COINS[i % 4]];
  const spec = { template: tpl, assets, params, costBps: Math.floor(rnd() * 60) };
  const lockTs = 1790000000 + Math.floor(rnd() * 5e6), days = [7, 14, 30][i % 3], endTs = lockTs + days * 86400;
  const gap = i % 25 === 0 ? 0.08 : 0.01;
  const data = Object.fromEntries(assets.map((a) => [a, series(Math.floor((lockTs - 800 * H) / H) * H, endTs + 3 * H, 100 + rnd() * 50000, gap)]));
  const candles = async (sym, s, e) => data[sym].filter((r) => r[0] >= s && r[0] < e).reverse();
  let r; try { r = await gradeTemplate(spec, lockTs, endTs, candles); } catch (e) { continue; } // invalid random params are rejected by normalizeSpec
  n++;
  const text = composeTemplate(spec), strategyHash = ethers.keccak256(ethers.toUtf8Bytes(text));
  const mk = (over = {}) => {
    const d = { type: "aevum-strategy-template-result-v1", commitmentId: String(i), strategyHash, submitter: "0x1", lockTs, windowEnd: endTs, priceSource: "x", ...r, ...over };
    const raw = JSON.stringify(d);
    const cert = { commitmentId: BigInt(i), strategyHash, resultsHash: ethers.keccak256(ethers.toUtf8Bytes(raw)), returnBps: BigInt(d.returnBps ?? 0), attestationNote: `t DATA ${raw}`, revoked: false };
    return { commitment: async () => ({ strategyHash, commitTimestamp: BigInt(lockTs), windowEnd: BigInt(endTs), certificateId: 1n }), certificate: async () => cert };
  };
  const ok = await rerun({ commitmentId: i, read: mk(), candles, lockedText: async (h) => (h === strategyHash.toLowerCase() ? text : null) });
  assert.equal(ok.verdict, "match", `case ${i} ${tpl} ${JSON.stringify(ok.steps.at(-1))}`);
  match++; if (r.result !== "GRADED") voids++;
  if (r.result === "GRADED") {
    const k = ["netReturn", "maxDrawdown", "sharpe", "trades", "benchmarkReturn"][i % 5];
    const bad = await rerun({ commitmentId: i, lockedText: text, read: mk({ [k]: typeof r[k] === "number" ? r[k] + (k === "trades" ? 1 : 0.01) : r[k] }), candles });
    assert.equal(bad.verdict, "mismatch", `tamper ${k} not caught in case ${i}`); caught++;
  }
}
console.log(`scale: ${n} random certificates (momentum / mean reversion / pairs, 7-30 days, 0-0.59% costs, ${voids} VOID from missing candles): ${match} MATCH, ${caught}/${n - voids} tampered results caught`);
