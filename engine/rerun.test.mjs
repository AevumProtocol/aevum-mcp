import assert from "node:assert/strict";
import fs from "node:fs";
import { ethers } from "ethers";
import { rerun, splitNote } from "./rerun.mjs";
import { composeTemplate, gradeTemplate } from "./strategyTemplates.js";

// 1. The real certificate #13 (commitment #18): fingerprints check out offline
const fx = JSON.parse(fs.readFileSync(new URL("./fixture-commitment-18.json", import.meta.url)));
const { dataRaw } = splitNote(fx.note);
assert.equal(ethers.keccak256(ethers.toUtf8Bytes(dataRaw)), fx.resultsHash, "attested data hashes to resultsHash");
assert.equal(ethers.keccak256(ethers.toUtf8Bytes(composeTemplate(fx.spec))), fx.strategyHash, "rebuilt locked text hashes to the on-chain strategyHash");

// 2. Synthetic certificate: full match, then tampering is caught
const H = 3600, lockTs = 1794429047, endTs = lockTs + 7 * 86400;
let p = 70000; const rows = [];
for (let t = Math.floor((lockTs - 200 * H) / H) * H; t <= endTs + 2 * H; t += H) { p *= 1 + Math.sin(t / 50000) * 0.004; rows.push([t, p * 0.997, p * 1.003, p, p * (1 + Math.cos(t / 9000) * 0.002), 10]); }
const candles = async (sym, s, e) => rows.filter((r) => r[0] >= s && r[0] < e).reverse();
const spec = { template: "momentum", assets: ["BTC"], params: { fast: 12, slow: 48 }, costBps: 25 };
const r = await gradeTemplate(spec, lockTs, endTs, candles);
assert.equal(r.result, "GRADED");
const text = composeTemplate(spec), strategyHash = ethers.keccak256(ethers.toUtf8Bytes(text));
const mk = (over = {}) => {
  const data = { type: "aevum-strategy-template-result-v1", commitmentId: "99", strategyHash, submitter: "0x1", lockTs, windowEnd: endTs, priceSource: "x", ...r, ...over };
  const raw = JSON.stringify(data);
  const cert = { commitmentId: 99n, strategyHash, resultsHash: ethers.keccak256(ethers.toUtf8Bytes(raw)), returnBps: BigInt(data.returnBps), attestationNote: `Strategy template: test. DATA ${raw}`, revoked: false };
  const c = { strategyHash, commitTimestamp: BigInt(lockTs), windowEnd: BigInt(endTs), certificateId: 7n };
  return { commitment: async () => c, certificate: async () => cert };
};
let out = await rerun({ commitmentId: 99, read: mk(), candles });
assert.equal(out.verdict, "match", JSON.stringify(out.steps));
out = await rerun({ certId: 7, read: mk(), candles });
assert.equal(out.verdict, "match");
out = await rerun({ commitmentId: 99, read: mk({ netReturn: r.netReturn + 0.05 }), candles });
assert.equal(out.verdict, "mismatch", "an inflated return is caught");
out = await rerun({ commitmentId: 99, read: mk({ spec: { ...r.spec, params: { fast: 6, slow: 48 } } }), candles });
assert.equal(out.verdict, "mismatch", "grading different rules than the locked ones is caught");
const bad = mk(); const cc = await bad.certificate(); cc.attestationNote = cc.attestationNote.replace('"trades":', '"trades" :');
out = await rerun({ commitmentId: 99, read: { commitment: bad.commitment, certificate: async () => cc }, candles });
assert.equal(out.verdict, "mismatch", "edited attestation data is caught");
console.log("rerun: all checks passed (real #13 fingerprints + synthetic match/mismatch)");
