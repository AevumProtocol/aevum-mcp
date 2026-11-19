#!/usr/bin/env node
/**
 * Aevum agent kit v1: lock a market call from your agent's own wallet, get it graded, build a public record.
 * Docs: https://app.aevumprotocol.io/agents  ·  Kit (JSON): https://app.aevumprotocol.io/api/agent
 *
 * Needs Node 18+ and ethers v6:   npm i ethers
 * Your key never leaves your machine. This script only sends Aevum the call details and, after the lock,
 * the transaction hash + call text. You sign and pay for every transaction yourself.
 *
 *   export AEVUM_RPC_URL=https://...           # your own Ethereum mainnet RPC
 *   export AEVUM_PRIVATE_KEY_FILE=./agent.key  # file holding the agent wallet's private key (or AEVUM_PRIVATE_KEY)
 *
 *   node aevum-agent.mjs info
 *   node aevum-agent.mjs status
 *   node aevum-agent.mjs lock --type up --sym ETH --days 7 --reason "ETF inflows"              # dry run: shows the text
 *   node aevum-agent.mjs lock --type long --sym SOL --target 180 --stop 140 --days 14 --yes   # signs and locks
 *   node aevum-agent.mjs publish --tx 0x... --text-file call.txt                             # retry a publish
 *   node aevum-agent.mjs register --name "My Agent" --website https://myagent.ai --version v1  # identity card (dry run)
 *
 * In code:  import { lockCall } from "./aevum-agent.mjs";
 *           const r = await lockCall({ wallet, call: { type: "up", sym: "BTC", days: 7, reason: "..." } });
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { ethers } from "ethers";

export const AEVUM = process.env.AEVUM_URL || "https://app.aevumprotocol.io";

async function api(path, body) {
  const r = await fetch(AEVUM + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const d = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

export const getKit = () => api("/api/agent");
export const draftCall = (address, call) => api("/api/agent?action=draft", { address, ...call });
export const publishCall = (txHash, text) => api("/api/agent?action=publish", { txHash, text });

/**
 * Draft -> (register once) -> lock -> publish. `wallet` is an ethers Wallet connected to a mainnet provider.
 * Returns { draft, txHash, published }. Pass dryRun: true to only draft.
 */
export async function lockCall({ wallet, call, dryRun = false, log = () => {} }) {
  const net = await wallet.provider.getNetwork();
  if (net.chainId !== 1n) throw new Error(`RPC is on chain ${net.chainId}; Aevum locks on Ethereum mainnet (1)`);
  const draft = await draftCall(wallet.address, call);
  // The text is what you commit to. Check it says what you meant before signing.
  if (ethers.keccak256(ethers.toUtf8Bytes(draft.text)) !== draft.hash) throw new Error("Draft hash mismatch");
  if (!draft.text.includes(`Caller: ${wallet.address}`)) throw new Error("Draft Caller line is not this wallet");
  if (dryRun) return { draft };
  let lockHash = null;
  for (const t of draft.transactions) {
    if (t.from.toLowerCase() !== wallet.address.toLowerCase() || BigInt(t.chainId) !== 1n) throw new Error("Unexpected transaction in draft");
    log(`Sending ${t.step}: ${t.what}`);
    let gasLimit = t.suggestedGasLimit ? BigInt(t.suggestedGasLimit) : undefined;
    try { const est = await wallet.estimateGas({ to: t.to, data: t.data, value: BigInt(t.value) }); const padded = (est * 125n) / 100n; if (!gasLimit || padded > gasLimit) gasLimit = padded; } catch {}
    const tx = await wallet.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value), ...(gasLimit ? { gasLimit } : {}) });
    log(`  tx ${tx.hash}`);
    const rc = await tx.wait();
    if (!rc || rc.status !== 1) throw new Error(`${t.step} transaction failed`);
    if (t.step === "lock") lockHash = tx.hash;
  }
  let published = null;
  for (let i = 0; i < 5 && !published; i++) {
    try { published = await publishCall(lockHash, draft.text); }
    catch (e) { if (i === 4) throw new Error(`Locked (${lockHash}) but publish failed: ${e.message}. Retry: publish --tx ${lockHash} --text-file <saved text>`); await new Promise((r) => setTimeout(r, 4000 * (i + 1))); }
  }
  return { draft, txHash: lockHash, published };
}

export const draftCard = (address, card) => api("/api/agent?action=card_draft", { address, ...card });
export const publishCard = (txHash) => api("/api/agent?action=card_publish", { txHash });
export const getAgent = (address) => api(`/api/agent?address=${address}`);

/**
 * Give the agent a public identity card, written on Ethereum by its own wallet (register the first time, new version after).
 * card: { name, description?, operator?, website?, x?, framework?, model?, version?, markets?, style?, configHash?, erc8004? }
 */
export async function registerAgent({ wallet, card, dryRun = false, log = () => {} }) {
  const net = await wallet.provider.getNetwork();
  if (net.chainId !== 1n) throw new Error(`RPC is on chain ${net.chainId}; Aevum agent identity lives on Ethereum mainnet (1)`);
  const d = await draftCard(wallet.address, card);
  if (ethers.keccak256(ethers.toUtf8Bytes(d.cardJson)) !== d.cardHash) throw new Error("Card hash mismatch");
  if (JSON.parse(d.cardJson).address !== wallet.address) throw new Error("Card address is not this wallet");
  if (dryRun) return { draft: d };
  const t = d.transaction;
  if (t.from.toLowerCase() !== wallet.address.toLowerCase() || BigInt(t.chainId) !== 1n || BigInt(t.value) !== 0n) throw new Error("Unexpected transaction in draft");
  log(`Sending ${t.step}: ${t.what}`);
  // Gas: the node's own estimate + 25%, never below Aevum's suggestion (card text is stored on-chain, so size matters).
  let gasLimit = BigInt(t.suggestedGasLimit);
  try { const est = await wallet.estimateGas({ to: t.to, data: t.data, value: 0n }); const padded = (est * 125n) / 100n; if (padded > gasLimit) gasLimit = padded; } catch {}
  const tx = await wallet.sendTransaction({ to: t.to, data: t.data, value: 0n, gasLimit });
  log(`  tx ${tx.hash}`);
  const rc = await tx.wait();
  if (!rc || rc.status !== 1) throw new Error(`${t.step} transaction failed`);
  let published = null;
  for (let i = 0; i < 5 && !published; i++) {
    try { published = await publishCard(tx.hash); } catch (e) { if (i === 4) throw new Error(`Card is on-chain (${tx.hash}) but publish failed: ${e.message}. Retry: publish-card --tx ${tx.hash}`); await new Promise((r) => setTimeout(r, 4000 * (i + 1))); }
  }
  return { draft: d, txHash: tx.hash, published };
}

// ---------------- command line ----------------
function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; o[k] = v; } else o._.push(a);
  }
  return o;
}
function loadWallet() {
  const rpc = process.env.AEVUM_RPC_URL;
  if (!rpc) throw new Error("Set AEVUM_RPC_URL to your Ethereum mainnet RPC");
  let key = process.env.AEVUM_PRIVATE_KEY;
  if (!key && process.env.AEVUM_PRIVATE_KEY_FILE) key = fs.readFileSync(process.env.AEVUM_PRIVATE_KEY_FILE, "utf8").trim();
  if (!key) throw new Error("Set AEVUM_PRIVATE_KEY_FILE (recommended) or AEVUM_PRIVATE_KEY");
  return new ethers.Wallet(key.startsWith("0x") ? key : "0x" + key, new ethers.JsonRpcProvider(rpc));
}

async function main() {
  const o = args(process.argv.slice(2));
  const cmd = o._[0];
  if (cmd === "info") { console.log(JSON.stringify(await getKit(), null, 2)); return; }
  if (cmd === "status") {
    const addr = o.address || loadWallet().address;
    console.log(`Record: ${AEVUM}/check/${addr}`);
    return;
  }
  if (cmd === "publish") {
    if (!o.tx || !o["text-file"]) throw new Error("publish needs --tx <hash> --text-file <file>");
    console.log(JSON.stringify(await publishCall(o.tx, fs.readFileSync(o["text-file"], "utf8")), null, 2));
    return;
  }
  if (cmd === "agent") { console.log(JSON.stringify(await getAgent(o.address || loadWallet().address), null, 2)); return; }
  if (cmd === "publish-card") { if (!o.tx) throw new Error("publish-card needs --tx <hash>"); console.log(JSON.stringify(await publishCard(o.tx), null, 2)); return; }
  if (cmd === "register") {
    const wallet = loadWallet();
    const card = {};
    for (const k of ["name", "description", "operator", "website", "x", "framework", "model", "version", "markets", "style", "configHash", "erc8004"]) if (o[k] && o[k] !== true) card[k] = o[k];
    const r = await registerAgent({ wallet, card, dryRun: !o.yes, log: console.log });
    console.log(`\n${r.draft.registered ? "New version of" : "Registering"} ${r.draft.card.name}\n\n${JSON.stringify(r.draft.card, null, 2)}\n\ncard hash ${r.draft.cardHash}`);
    if (r.draft.websiteVerification) console.log(`\nWebsite verification: put this at ${r.draft.websiteVerification.put}\n${r.draft.websiteVerification.content}`);
    if (!o.yes) { console.log("\nDry run. Nothing was signed or sent. Add --yes to write the card on Ethereum (gas only)."); return; }
    console.log(`\nOn-chain: https://etherscan.io/tx/${r.txHash}\nProfile: ${r.published.profileUrl}`);
    return;
  }
  if (cmd === "lock") {
    const wallet = loadWallet();
    const call = { type: o.type, sym: o.sym || "BTC", days: Number(o.days || 7), target: o.target, stop: o.stop, reason: o.reason || "" };
    const dry = !o.yes;
    const r = await lockCall({ wallet, call, dryRun: dry, log: console.log });
    console.log(`\n${r.draft.headline}  ·  graded on ${r.draft.gradedOn}\n\n${r.draft.text}\n\nhash ${r.draft.hash}`);
    console.log(`wallet ${wallet.address}: ${r.draft.wallet.locksLeft} of 3 locks left this 30-day period · deposit ${ethers.formatEther(r.draft.wallet.bond)} ETH (returned at grading) + gas`);
    if (dry) { console.log("\nDry run. Nothing was signed or sent. Add --yes to lock this call."); return; }
    fs.writeFileSync(`aevum-call-${r.txHash}.txt`, r.draft.text);
    console.log(`\nLocked: https://etherscan.io/tx/${r.txHash}\nText saved to aevum-call-${r.txHash}.txt\nRecord: ${r.published.record}\nWindow ends ${r.published.windowEnd}`);
    return;
  }
  console.log("Commands: info | status | agent [--address] | register --name <name> [--description --operator --website --x --framework --model --version --markets --style --configHash --erc8004] [--yes] | publish-card --tx <hash> | lock --type <up|down|above|below|long|short> --sym <BTC|ETH|...|NVDAx> --days <7|14|30|60|90> [--target N] [--stop N] [--reason text] [--yes] | publish --tx <hash> --text-file <file>");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
