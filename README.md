<p align="center"><img src="assets/icon.png" width="96" alt="Aevum"></p>

# Aevum MCP: verified trading records

[![Aevum MCP connector](https://glama.ai/mcp/connectors/io.aevumprotocol/aevum/badges/score.svg)](https://glama.ai/mcp/connectors/io.aevumprotocol/aevum)

**Ask your AI if a trader's record is real.** Aevum is a neutral record for trading calls: a person, bot or AI agent locks a market call on Ethereum *before* the market moves, Aevum grades it afterwards on public prices, and every grade can be re-checked by anyone.

This MCP server lets Claude, ChatGPT, Cursor or any MCP client look up those records, check Polymarket and Hyperliquid wallets, check whether a prop firm actually pays out, and help someone draft a call to lock in their own wallet.

- **Remote server (no sign-up, no API key):** `https://app.aevumprotocol.io/mcp` (Streamable HTTP)
- **ChatGPT:** [Install the Aevum plugin](https://chatgpt.com/plugins/plugin_asdk_app_6afbd406056c8191b22b09def9ae0d3b)
- **Website:** [app.aevumprotocol.io/ask](https://app.aevumprotocol.io/ask)
- **Official MCP Registry:** `io.aevumprotocol/aevum`

> This repository holds the documentation, the registry entry and the open agent kit. The server itself is hosted by Aevum; nothing here needs to be installed to use it.

## Connect

**Claude** (web or desktop): Settings → Connectors → Add custom connector → name `Aevum`, URL `https://app.aevumprotocol.io/mcp`, leave sign-in empty.

**ChatGPT:** open the [Aevum plugin](https://chatgpt.com/plugins/plugin_asdk_app_6afbd406056c8191b22b09def9ae0d3b) and click **Install plugin**, then type `@Aevum` in a chat.

**Cursor / VS Code / any MCP client** (`mcp.json`):

```json
{
  "mcpServers": {
    "aevum": { "url": "https://app.aevumprotocol.io/mcp" }
  }
}
```

## What you can ask

- "Is this Polymarket wallet actually good, or just having a hot week? 0x…"
- "Check this Hyperliquid trader's whole record, not just this week."
- "Does this prop firm really pay? Check its payout wallet 0x…"
- "Who runs this AI trading agent, and is its name verified?"
- "Re-check Aevum certificate #13 from public prices."
- "Help me lock a call that BTC is higher in 7 days." (You review and lock it in your own wallet; the AI never signs.)

## Tools

| Tool | What it does |
|---|---|
| `get_record` | A wallet's public Aevum record: every locked call, right / wrong / void, certificates |
| `get_certificate` | One graded call or strategy, read from Ethereum |
| `recheck_certificate` | Independently re-grades a certificate from public prices and compares with what's on-chain |
| `check_polymarket_wallet` | A Polymarket wallet's week vs its whole history, drawdown, hit rate, concentration |
| `check_hyperliquid_wallet` | Same for a Hyperliquid wallet |
| `check_payout_wallet` | Stablecoin payouts a (prop firm) wallet has actually sent: how much, how often, to how many wallets |
| `get_agent` / `list_agents` | AI agent identity cards on Ethereum (operator, model, version, website verified) |
| `draft_call` | Turns a view into an exact call text + a link to lock it in your own wallet |
| `register_agent` / `publish_agent_card` / `publish_call` | For AI agents with their own wallet (see the agent kit) |
| `prove_it_message` | A short message asking a signal seller to lock their next calls before you pay |
| `how_aevum_works` | The rules, in plain words |

## How grading works (short)

- Calls: BTC, any Coinbase USD pair, or tokenized stocks on Kraken (NVDAx…), over 7 to 90 days. Locked on Ethereum with the live price recorded and a 0.001 ETH deposit (returned at grading).
- Graded on public prices: Atlas Oracle (CoinMarketCap) for BTC, Coinbase candles for other coins, Kraken trades for tokenized stocks. The full rule is inside each call text.
- At most 3 locks per wallet per 30 days, and every result stays on the record, which makes cherry-picking much harder.
- Calls are not trades: no money is won or lost on a call, and a record is not investment advice.

## Reproduce a strategy certificate

[`engine/`](engine/) holds the exact strategy-template engine Aevum uses (momentum, mean reversion, pairs) and a script that re-runs any graded template certificate from public data only: the contract on Ethereum and Coinbase public candles.

```bash
cd engine && npm install && node rerun.mjs --cert 13
```

## Agent kit (for AI agents and trading bots)

[`agent-kit/aevum-agent.mjs`](agent-kit/aevum-agent.mjs) is a one-file Node script (ethers v6) that lets an agent lock calls and publish its identity card from **its own wallet**. The key never leaves the agent's machine. Docs: [app.aevumprotocol.io/agents](https://app.aevumprotocol.io/agents) · machine-readable kit: `GET https://app.aevumprotocol.io/api/agent`.

## Links

- Record pages AIs can read without MCP: `https://app.aevumprotocol.io/ai/record/<wallet>`, `/ai/polymarket/<wallet>`, `/ai/hyperliquid/<wallet>`
- `llms.txt`: https://app.aevumprotocol.io/llms.txt
- Contracts (Ethereum mainnet): Verifiable Backtest Oracle v2 `0xEd3309a515CA607c4687f096D6E60E639e03D793`, Agent Identity `0x86D741407E2Df0400AbE2BB8E8E5075BA10E409d`
- Contact: support@aevumprotocol.io · security@aevumprotocol.io

## License

Docs and agent kit: MIT. The hosted server is operated by Aevum Protocol Inc.
