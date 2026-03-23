# Polymarket Crypto Price Sniper Bot

A TypeScript/Node.js bot that exploits the **Binance → Polymarket price lag** in 5-minute crypto markets.

## Strategy

Polymarket's 5-minute crypto markets (BTC, ETH, SOL, …) update slower than Binance spot prices. In the **last 30–45 seconds** of a 5-minute candle, if Binance moves significantly, Polymarket odds haven't adjusted yet. The bot buys YES/NO tokens at mispriced odds before the candle closes.

```
Binance moves +0.4% in last 35s → YES priced at 0.71 on Polymarket → Buy YES → Resolves at 0.97
```

## Architecture

```
src/
├── feeds/binance.ts          WebSocket real-time price feed (kline_1m)
├── polymarket/client.ts      Polymarket CLOB integration + market discovery
├── strategies/sniper.ts      Core signal logic + confidence scoring
├── risk/manager.ts           Position sizing (Kelly), P&L tracking, limits
├── notifications/telegram.ts Trade alerts + /pause /resume /stop commands
├── dashboard.ts              Live terminal dashboard
├── bot.ts                    Main loop, orchestration, graceful shutdown
└── utils/logger.ts           Winston logger → console + logs/bot-YYYY-MM-DD.log
config.ts                     All config from .env
```

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env — at minimum set POLYMARKET_PRIVATE_KEY
```

> **Important**: Keep `DRY_RUN=true` until you've validated the strategy produces good signals.

### 3. Run in dry-run mode

```bash
npm start
```

The terminal dashboard refreshes every 2 seconds showing:
- Live BTC/ETH/SOL prices + % candle change
- Countdown to next 5-min boundary + snipe window indicator
- Open positions + P&L
- Bot status

### 4. Go live (when ready)

```bash
# In .env:
DRY_RUN=false
```

Make sure your wallet has USDC on Polygon mainnet.

---

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `POLYMARKET_PRIVATE_KEY` | — | Polygon wallet private key |
| `SYMBOLS` | `BTC,ETH,SOL` | Symbols to watch |
| `SNIPE_WINDOW_START` | `45` | Seconds before close to start |
| `SNIPE_WINDOW_END` | `5` | Seconds before close to stop |
| `MIN_PRICE_CHANGE_PCT` | `0.3` | Min % move to trigger signal |
| `MIN_CONFIDENCE` | `65` | Min confidence to place order |
| `MAX_POSITION_USD` | `10` | Max $ per position |
| `MAX_CONCURRENT_POSITIONS` | `3` | Max open positions at once |
| `DAILY_LOSS_LIMIT_USD` | `25` | Hard stop loss for the day |
| `DRY_RUN` | `true` | Paper trading mode |
| `TELEGRAM_BOT_TOKEN` | — | Optional Telegram alerts |
| `TELEGRAM_CHAT_ID` | — | Your Telegram chat ID |

---

## Telegram Setup (Optional but Recommended)

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token
2. Message [@userinfobot](https://t.me/userinfobot) → copy your chat ID
3. Add both to `.env`

**Commands:**
- `/status` — open positions, P&L, win rate
- `/pause` — pause trading (continues monitoring)
- `/resume` — resume trading
- `/stop` — full shutdown
- `/config` — show current config

---

## Confidence Scoring

Signals scored 0–100 based on:

| Factor | Weight | Notes |
|---|---|---|
| Price move magnitude | 35% | Larger move = more confident |
| Momentum | 25% | Accelerating in trade direction |
| Polymarket mispricing | 25% | How far below fair value |
| Time window | 15% | Sweet spot: 20–40s remaining |

Only signals ≥ `MIN_CONFIDENCE` (default 65) trigger orders.

---

## Position Sizing: Kelly Criterion

```
f = (b * p - q) / b
```
Where:
- `b` = net odds at current price
- `p` = estimated win probability (from confidence score)
- `q` = 1 - p

Uses **1/4 Kelly** (conservative). Capped at `MAX_POSITION_USD`.

---

## Polymarket Wallet Setup

1. Go to [polymarket.com](https://polymarket.com) and connect your wallet
2. Deposit USDC via the Polygon bridge
3. Approve USDC spending in the Polymarket interface at least once (sets allowance)
4. Export your private key and set `POLYMARKET_PRIVATE_KEY` in `.env`

> Your wallet must have completed at least one trade on Polymarket to have API credentials derived.

---

## Risk Warnings

- **This is financial software. Use at your own risk.**
- Always start with `DRY_RUN=true` to validate signal quality
- Polymarket markets may not always be available for the current 5-min window
- Slippage and fees reduce real-world returns vs dry-run simulations
- The strategy works best in volatile, trending market conditions

---

## License

MIT