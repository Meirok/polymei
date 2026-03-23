/**
 * config.ts
 * Central configuration loaded from environment variables via dotenv.
 */

import 'dotenv/config';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

// ─── Polymarket ──────────────────────────────────────────────────────────────
export const POLYMARKET_PRIVATE_KEY = optionalEnv('POLYMARKET_PRIVATE_KEY', '');
export const CLOB_HOST = 'https://clob.polymarket.com';
export const GAMMA_API = 'https://gamma-api.polymarket.com';
export const POLYGON_CHAIN_ID = 137;

// ─── Binance ─────────────────────────────────────────────────────────────────
export const BINANCE_WS_URL = optionalEnv(
  'BINANCE_WS_URL',
  'wss://stream.binance.com:9443/stream'
);

// Symbols to trade (maps to Polymarket market slugs)
export const SYMBOLS: string[] = optionalEnv('SYMBOLS', 'BTC,ETH,SOL')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

// ─── Sniper windows ──────────────────────────────────────────────────────────
/** Seconds before 5-min candle end to START looking for entries */
export const SNIPE_WINDOW_START = parseInt(optionalEnv('SNIPE_WINDOW_START', '120'), 10);
/** Seconds before 5-min candle end to STOP entering (avoid settlement lag) */
export const SNIPE_WINDOW_END = parseInt(optionalEnv('SNIPE_WINDOW_END', '3'), 10);
/** Minimum % price move from candle open to trigger signal */
export const MIN_PRICE_CHANGE_PCT = parseFloat(optionalEnv('MIN_PRICE_CHANGE_PCT', '0.1'));
/** Minimum confidence score (0-100) before placing order */
export const MIN_CONFIDENCE = parseInt(optionalEnv('MIN_CONFIDENCE', '40'), 10);

// ─── Risk ────────────────────────────────────────────────────────────────────
export const MAX_POSITION_USD = parseFloat(optionalEnv('MAX_POSITION_USD', '10'));
export const MAX_CONCURRENT_POSITIONS = parseInt(
  optionalEnv('MAX_CONCURRENT_POSITIONS', '3'),
  10
);
export const DAILY_LOSS_LIMIT_USD = parseFloat(optionalEnv('DAILY_LOSS_LIMIT_USD', '25'));

// ─── Execution ───────────────────────────────────────────────────────────────
/** Paper trading mode — no real orders */
export const DRY_RUN = optionalEnv('DRY_RUN', 'true') !== 'false';
/** Slippage buffer added to best ask when placing limit orders */
export const SLIPPAGE_BUFFER = parseFloat(optionalEnv('SLIPPAGE_BUFFER', '0.02'));
/** How often the evaluation loop runs (ms) */
export const EVAL_INTERVAL_MS = 500;
/** Dashboard refresh interval (ms) */
export const DASHBOARD_INTERVAL_MS = 2000;

// ─── Telegram ────────────────────────────────────────────────────────────────
export const TELEGRAM_BOT_TOKEN = optionalEnv('TELEGRAM_BOT_TOKEN', '');
export const TELEGRAM_CHAT_ID = optionalEnv('TELEGRAM_CHAT_ID', '');

// ─── Debug ───────────────────────────────────────────────────────────────────
/** When true, send 30-second loop status messages to Telegram for diagnostics */
export const DEBUG_MODE = optionalEnv('DEBUG_MODE', 'false') !== 'false';

// ─── Logging ─────────────────────────────────────────────────────────────────
export const LOG_LEVEL = optionalEnv('LOG_LEVEL', 'info');
