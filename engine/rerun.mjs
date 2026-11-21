#!/usr/bin/env node
/**
 * Re-run an Aevum strategy-template certificate yourself, from public data only.
 *
 *   npm install            (ethers v6)
 *   node rerun.mjs --commitment 18
 *   node rerun.mjs --cert 13
 *   options: --rpc <your Ethereum mainnet RPC URL>   (or env AEVUM_RPC_URL; default: a public RPC)
 *            --json                                   (machine-readable output)
 *
 * What it checks, step by step (no Aevum server is used):
 *   1. Reads the commitment and certificate from the Aevum VBO v2 contract on Ethereum mainnet.
 *   2. Takes the results data Aevum wrote on-chain (the attestation note) and checks it against the on-chain resultsHash.
 *   3. Rebuilds the exact locked text from the strategy spec and checks it against the on-chain strategyHash,
 *      i.e. these are the rules that were fixed BEFORE the window opened.
 *   4. Downloads Coinbase public 1-hour candles and runs the same engine (strategyTemplates.js in this folder)
 *      over the same window, then compares every metric with what Aevum attested.
 * Exit code 0 = match, 1 = mismatch, 2 = could not check.
 */
import { ethers } from "ethers";
import { composeTemplate, parseTemplate, gradeTemplate, summaryLine, TEMPLATE_ENGINE } from "./strategyTemplates.js";

export const VBO = "0xEd3309a515CA607c4687f096D6E60E639e03D793";
export const VBO_ABI = [
  "function getCommitment(uint256) view returns (tuple(address submitter, bytes32 strategyHash, uint256 commitBlock, uint256 commitTimestamp, uint256 windowStart, uint256 windowEnd, uint256 bondAmount, uint256 priceAtCommit, uint256 priceAtCommitTimestamp, uint8 status, uint256 certificateId))",
  "function getCertificate(uint256) view returns (tuple(uint256 id, uint256 commitmentId, address agent, uint256 agentId, bytes32 strategyHash, bytes32 resultsHash, uint256 windowStart, uint256 windowEnd, uint256 issuedAt, uint8 regime, int256 returnBps, uint256 priceAtCommit, uint256 priceAtWindowEnd, bool atlasVerified, uint256 submissionCount, string metadataURI, string attestationNote, bool revoked))",
];
const DEFAULT_RPC = "https://ethereum-rpc.publicnode.com";
const CB = "https://api.exchange.coinbase.com";
// Metrics compared with the attested data. Decimals: tolerance for floating-point differences between machines.
const NUM = ["netReturn", "benchmarkReturn", "excessReturn", "maxDrawdown", "sharpe", "timeInMarket"];
const INT = ["trades", "turnover", "hours", "firstDecision", "lastDecision"];

export function splitNote(note = "") {
  const i = note.indexOf(" DATA ");
  return i < 0 ? { text: note, dataRaw: null } : { text: note.slice(0, i), dataRaw: note.slice(i + 6) };
}

export async function coinbaseHourly(sym, start, end, fetchImpl = fetch) {
  const iso = (t) => new Date(t * 1000).toISOString();
  for (let tries = 1; ; tries++) {
    const r = await fetchImpl(`${CB}/products/${sym}-USD/candles?granularity=3600&start=${iso(start)}&end=${iso(end)}`, { headers: { "User-Agent": "aevum-rerun" } });
    if (r.ok) { await new Promise((ok) => setTimeout(ok, 150)); return r.json(); }
    if (tries >= 5) throw new Error(`Coinbase candles ${sym}-USD: HTTP ${r.status}`);
    await new Promise((ok) => setTimeout(ok, 1000 * tries));
  }
}

/**
 * Core check (pure apart from the injected readers, so it can be tested offline).
 * read: { commitment(id), certificate(id) } -> contract tuples;  candles: (sym, startSec, endSec) -> Coinbase rows
 */
export async function rerun({ commitmentId, certId, read, candles }) {
  const steps = []; const add = (label, ok, detail) => { steps.push({ label, ok, detail }); return ok; };
  let cert, c;
  if (certId) { cert = await read.certificate(certId); commitmentId = Number(cert.commitmentId); }
  c = await read.commitment(commitmentId);
  if (!certId) { certId = Number(c.certificateId); if (!certId) return { verdict: "error", steps, headline: `Commitment #${commitmentId} has no certificate yet (still running or not graded).` }; cert = await read.certificate(certId); }
  add("Read from Ethereum", true, `commitment #${commitmentId}, certificate #${certId}, contract ${VBO}`);
  if (cert.revoked) return { verdict: "error", steps, headline: "This certificate was revoked." };
  if (String(cert.strategyHash).toLowerCase() !== String(c.strategyHash).toLowerCase()) { add("Certificate belongs to the commitment", false, "strategyHash differs"); return { verdict: "mismatch", steps, headline: "Certificate and commitment do not match." }; }

  const { text, dataRaw } = splitNote(cert.attestationNote);
  if (!dataRaw) return { verdict: "error", steps, headline: "No results data in the attestation note (not a strategy-template certificate)." };
  const okData = ethers.keccak256(ethers.toUtf8Bytes(dataRaw)).toLowerCase() === String(cert.resultsHash).toLowerCase();
  if (!add("Results data matches the on-chain resultsHash", okData, okData ? "keccak256(data) = resultsHash" : "the note's data does not hash to resultsHash")) return { verdict: "mismatch", steps, headline: "Attested data does not match its fingerprint." };
  const data = JSON.parse(dataRaw);
  if (data.type !== "aevum-strategy-template-result-v1") return { verdict: "error", steps, headline: `Not a strategy-template certificate (type ${data.type}).` };

  const locked = composeTemplate(data.spec);
  const okRules = ethers.keccak256(ethers.toUtf8Bytes(locked)).toLowerCase() === String(c.strategyHash).toLowerCase() && !!parseTemplate(locked);
  if (!add("Rules were locked before the window", okRules, okRules ? `rebuilt locked text hashes to strategyHash; locked at ${new Date(Number(c.commitTimestamp) * 1000).toISOString()}` : "rebuilt text does not hash to strategyHash")) return { verdict: "mismatch", steps, headline: "The graded rules are not the locked rules." };
  const lockTs = Number(c.commitTimestamp), endTs = Number(c.windowEnd);
  if (data.lockTs !== lockTs || data.windowEnd !== endTs) { add("Window matches the chain", false, `data ${data.lockTs}-${data.windowEnd} vs chain ${lockTs}-${endTs}`); return { verdict: "mismatch", steps, headline: "Attested window differs from the on-chain window." }; }

  const mine = await gradeTemplate(data.spec, lockTs, endTs, candles);
  add("Re-ran the engine on Coinbase 1-hour candles", true, `${TEMPLATE_ENGINE}: ${summaryLine(mine)}`);
  if (mine.result !== data.result) { add("Result", false, `${mine.result} vs attested ${data.result}`); return { verdict: "mismatch", steps, headline: "Different result." }; }
  const diffs = [];
  for (const k of NUM) if (data[k] != null && Math.abs(Number(mine[k]) - Number(data[k])) > 1e-4 * Math.max(1, Math.abs(Number(data[k])))) diffs.push(`${k}: ${mine[k]} vs ${data[k]}`);
  for (const k of INT) if (data[k] != null && Number(mine[k]) !== Number(data[k])) diffs.push(`${k}: ${mine[k]} vs ${data[k]}`);
  if (data.returnBps != null && Number(mine.returnBps) !== Number(data.returnBps)) diffs.push(`returnBps: ${mine.returnBps} vs ${data.returnBps}`);
  if (Number(cert.returnBps) !== Number(data.returnBps ?? cert.returnBps)) diffs.push(`on-chain returnBps ${cert.returnBps} vs data ${data.returnBps}`);
  const ok = add("Every metric matches what Aevum attested", diffs.length === 0, diffs.length ? diffs.join("; ") : NUM.concat(INT, ["returnBps"]).join(", "));
  return { verdict: ok ? "match" : "mismatch", steps, attested: text, mine, headline: ok ? `Certificate #${certId} reproduced: ${summaryLine(mine)}` : `Certificate #${certId} did NOT reproduce (${diffs.length} difference(s)).` };
}

function chainReader(rpc) {
  const provider = new ethers.JsonRpcProvider(rpc, 1, { staticNetwork: true });
  const vbo = new ethers.Contract(VBO, VBO_ABI, provider);
  return { commitment: (id) => vbo.getCommitment(id), certificate: (id) => vbo.getCertificate(id) };
}

async function main() {
  const a = process.argv.slice(2), arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const commitmentId = Number(arg("--commitment") || 0), certId = Number(arg("--cert") || 0);
  if (!commitmentId && !certId) { console.log("Usage: node rerun.mjs --commitment <id> | --cert <id> [--rpc <url>] [--json]"); process.exit(2); }
  const rpc = arg("--rpc") || process.env.AEVUM_RPC_URL || DEFAULT_RPC;
  try {
    const r = await rerun({ commitmentId, certId, read: chainReader(rpc), candles: (s, x, y) => coinbaseHourly(s, x, y) });
    if (a.includes("--json")) console.log(JSON.stringify(r, null, 2));
    else { for (const s of r.steps) console.log(`${s.ok ? "✓" : "✗"} ${s.label}: ${s.detail}`); console.log(`\n${r.verdict.toUpperCase()}: ${r.headline}`); }
    process.exit(r.verdict === "match" ? 0 : r.verdict === "mismatch" ? 1 : 2);
  } catch (e) { console.error("Could not check:", e.message); process.exit(2); }
}
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("rerun.mjs")) main();
