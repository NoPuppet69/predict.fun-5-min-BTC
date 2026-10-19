# Predict.fun 5-minute bot (BTC / ETH / BNB)

Strategy from the proposal: in each 5-minute Up/Down window, buy the **first side whose ask reaches the trigger**
(default 0.90) with a slippage-capped buy, **hold to resolution**, one entry per market per window.
Dashboard controls the bot and switches between three modes.

| Mode | Data | Orders | Money |
|---|---|---|---|
| **shadow** | live **mainnet** books | none; fills simulated against the live ask book after a latency delay, fees estimated | virtual bankroll |
| **test** | **testnet** | real signed orders | testnet collateral |
| **live** | **mainnet** | real signed orders | real assets (needs `ALLOW_LIVE=true` + typing LIVE) |

Each mode logs to `data/<mode>/events.jsonl` (entries, window results, resolutions, claims, halts). Stats are rebuilt
from that file on restart, and unresolved entries are picked back up for scoring.

## Run
```
npm install
cp .env.example .env        # shadow only needs API_KEY
npm start                   # prints http://127.0.0.1:8787/?t=<token>
```
The dashboard binds to localhost and every API call needs the printed token.

## Validate before risking money
1. **Backtest**: download the dataset parquet files, then
   `python3 backtest/backtest.py --data-dir ./dataset --coins btc,eth,bnb --sweep`
   It prints win rate vs breakeven, ROI under three fee models, first-half vs second-half, weekly ROI.
2. **Shadow** for a week or more on Predict.fun. Compare its win rate to the backtest.
3. **Test** mode: confirm real fills, fees, settlement and claim behave as assumed.
4. **Live** with $1 clips.

## Economics in one line
Buying at ~0.91 pays +0.09 on a win and loses 0.91 on a miss, so you need a win rate above roughly 91-92% just to
break even. Fees at these prices are small (~0.2c/share); the win rate is what decides it.

## Deviations from the proposal
- Books come from the **WebSocket** (no rate-limit cost, lower latency). A REST orderbook probe every 5 s feeds the lag guard.
- "Market buy" is a **fill-or-kill limit at trigger x (1 + slippage%)** (0.90 -> 0.918): an ask that gaps past the cap is skipped, matching the proposal's 0.90-0.92 fill band.
- Claim check uses balance before/after `redeem`, not the positions endpoint.
- P&L % is measured against the equity captured at first start in that mode.

## Unverified assumptions (check on testnet)
- Discovery: `CRYPTO_UP_DOWN` categories with `startsAt`/`endsAt` ~300 s apart, asset matched by regex on slug/title/variantDetails. The dashboard shows "no window discovered" if this misses.
- Resolution: `GET /v1/markets/{id}` exposes `outcomes[].status == "WON"` (or `resolution`). If not, the bot infers the winner from the last book (winner bid >= 0.95) after 150 s and flags it `inferred`; inferred wins are never auto-claimed.
- Fees: estimated (`feeRateBps` shape or Polymarket-crypto formula). Real fee and whether it reduces shares or collateral is unknown.
- Share-quantity precision (rounded to 0.01), minimum order size, `ChainId.BnbTestnet`, testnet WS URL.
- `redeemPositions` argument shapes; neg-risk redeem is not implemented (5-minute markets are expected to be standard).
- `npm run typecheck` was not run end-to-end (no dependencies could be installed in the authoring sandbox); the dashboard JS parses and the backtest was smoke-tested on synthetic data only.
