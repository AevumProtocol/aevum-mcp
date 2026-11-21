# Aevum strategy-template engine

The exact engine Aevum uses to run and grade **strategy templates** (momentum, mean reversion, pairs), plus a script that re-runs any graded template certificate from public data. Same file the Aevum website runs in your browser and the Aevum grader runs before writing a certificate on Ethereum.

## Reproduce a certificate

```bash
cd engine
npm install
node rerun.mjs --cert 13          # or: node rerun.mjs --commitment 18
```

Optional: `--rpc <your Ethereum mainnet RPC URL>` (or env `AEVUM_RPC_URL`; a public RPC is used by default), `--json` for machine-readable output. Node 18+.

It uses no Aevum server. Step by step:

1. Reads the commitment and certificate from the Aevum VBO v2 contract on Ethereum mainnet (`0xEd3309a515CA607c4687f096D6E60E639e03D793`).
2. Checks the results data Aevum wrote on-chain against the on-chain `resultsHash`.
3. Rebuilds the exact locked text from the strategy spec and checks it against the on-chain `strategyHash`: the rules graded are the rules locked before the window opened.
4. Downloads Coinbase public 1-hour candles, runs `strategyTemplates.js` over the same window and compares every metric (net return, benchmark, excess return, max drawdown, Sharpe, trades, time in market, turnover) with what Aevum attested.

Exit code `0` = match, `1` = mismatch, `2` = could not check.

## How the engine works

Documented at the top of `strategyTemplates.js`. In short:

- **Bars:** Coinbase `<SYM>-USD` 1-hour candles. Decisions at each hourly close, using only closes up to and including that bar. No look-ahead.
- **Window:** first decision at the first hourly close at or after the lock; the position is closed at the last hourly close at or before the window end.
- **Costs:** a fixed cost per side in basis points, part of the locked text, charged on every change in position size, per leg.
- **Missing data:** hours without trades carry the previous close forward; more than 5% missing, or no candle in the hour before the first decision, makes the result VOID.
- **Metrics:** net return, benchmark (buy-and-hold the asset; pairs: cash), max drawdown, Sharpe (hourly returns, annualized, no risk-free rate), trades, time in market.

## Files

- `strategyTemplates.js`: the engine (pure functions, no network).
- `executionTerms.js`: the locked execution terms block every strategy lock ends with.
- `rerun.mjs`: the re-run script.
- `rerun.test.mjs` + `fixture-commitment-18.json`: offline test (`npm test`): certificate #13's on-chain fingerprints, plus checks that an inflated return, different rules or edited data are caught.

MIT licensed, like the rest of this repo. A certificate shows what a locked strategy did over its window; it is not investment advice or a promise about future results.
