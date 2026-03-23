/**
 * src/bot.ts
 *
 * Main bot entry point.
 *
 * Lifecycle:
 *   1. Initialize all modules (Binance WS, Polymarket client, Risk, Telegram)
 *   2. Start evaluation loop every 500ms
 *   3. On signal → validate risk → size position → place order → track
 *   4. On position resolution → record P&L → notify Telegram
 *   5. Graceful shutdown on SIGINT / SIGTERM
 */

import 'dotenv/config';
import readline from 'readline';
import { BinanceFeed } from './feeds/binance.js';
import { PolymarketClient } from './polymarket/client.js';
import { Sniper, secondsUntilNext5MinBoundary } from './strategies/sniper.js';
import { RiskManager } from './risk/manager.js';
import { TelegramNotifier } from './notifications/telegram.js';
import { Dashboard } from './dashboard.js';
import { logger } from './utils/logger.js';
import { botState } from './state.js';
import type { PriceState } from './feeds/binance.js';
import {
  EVAL_INTERVAL_MS,
  DASHBOARD_INTERVAL_MS,
  DRY_RUN,
  DAILY_LOSS_LIMIT_USD,
  SYMBOLS,
  MAX_POSITION_USD,
  MAX_CONCURRENT_POSITIONS,
  MIN_PRICE_CHANGE_PCT,
  MIN_CONFIDENCE,
  SNIPE_WINDOW_START,
  SNIPE_WINDOW_END,
} from '../config.js';
import type { ManagedPosition } from './risk/manager.js';
import type { TradeSignal } from './strategies/sniper.js';

// ─── Bot State ────────────────────────────────────────────────────────────────

type BotStatus = 'ACTIVE' | 'PAUSED' | 'HALTED';

let botStatus: BotStatus = 'ACTIVE';
let evalTimer: NodeJS.Timeout | null = null;

// ─── Module Initialization ────────────────────────────────────────────────────

const binance = new BinanceFeed(SYMBOLS);
const polymarket = new PolymarketClient();
const sniper = new Sniper(binance, polymarket);
const risk = new RiskManager();
const telegram = new TelegramNotifier();
const dashboard = new Dashboard(binance, risk, () => botStatus);

// ─── Telegram Command Handlers ─────────────────────────────────────────────

function setupTelegramCommands(): void {
  telegram.registerCommand('status', () => {
    const snapshot = risk.getSnapshot();
    const positions = risk.getOpenPositions();
    return telegram.buildStatusMessage(snapshot, positions);
  });

  telegram.registerCommand('pause', () => {
    if (botStatus === 'HALTED') return '❌ Bot is halted (daily loss limit). Use /resume to override.';
    botStatus = 'PAUSED';
    logger.info('[Bot] Paused via Telegram');
    return '⏸ Trading paused. Use /resume to restart.';
  });

  telegram.registerCommand('resume', () => {
    if (risk.isHalted()) risk.resume();
    botStatus = 'ACTIVE';
    logger.info('[Bot] Resumed via Telegram');
    return '▶️ Trading resumed.';
  });

  telegram.registerCommand('stop', () => {
    const reason = 'Manual stop via Telegram';
    logger.info(`[Bot] ${reason}`);
    telegram.notifyBotStopped(reason);
    setTimeout(() => gracefulShutdown('Telegram /stop'), 1000);
    return '🔴 Bot stopping...';
  });

  telegram.registerCommand('config', () => telegram.buildConfigMessage());
}

// ─── Position Resolution Monitor ──────────────────────────────────────────────

/**
 * Check all open positions against Polymarket to see if they've resolved.
 * This is called in the evaluation loop.
 *
 * In live mode we'd query CLOB for filled/settled state.
 * In DRY_RUN mode we simulate resolution: position resolves when the
 * 5-minute candle closes, outcome = whether Binance price confirms our direction.
 */
async function checkPositionResolution(): Promise<void> {
  const openPositions = risk.getOpenPositions();
  if (openPositions.length === 0) return;

  const secondsLeft = secondsUntilNext5MinBoundary();

  for (const position of openPositions) {
    try {
      if (DRY_RUN) {
        await resolvePositionDryRun(position, secondsLeft);
      } else {
        await resolvePositionLive(position);
      }
    } catch (err) {
      logger.error(`[Bot] Error resolving position ${position.id}`, err);
    }
  }
}

async function resolvePositionDryRun(
  position: ManagedPosition,
  secondsLeft: number
): Promise<void> {
  // Only resolve when candle closes (< 2s left)
  if (secondsLeft > 2) return;

  // Get final Binance price and determine if our bet was right
  const priceState = binance.getState(position.symbol);
  if (!priceState) return;

  const priceAtResolution = priceState.currentPrice;
  const entryPrice = priceState.candleOpen;
  const finalChange = entryPrice > 0
    ? ((priceAtResolution - entryPrice) / entryPrice) * 100
    : 0;

  // YES wins if price went up, NO wins if price went down
  const won =
    (position.side === 'YES' && finalChange > 0) ||
    (position.side === 'NO' && finalChange < 0);

  const exitPrice = won ? 0.97 : 0.03; // approximate resolution price
  const closed = risk.closePosition(position.id, exitPrice, won);
  if (!closed) return;

  botState.pnlPeriod += closed.pnlUsd ?? 0;
  botState.openPositions = risk.getSnapshot().openPositions;

  if (won) {
    telegram.notifyWin(closed);
  } else {
    telegram.notifyLoss(closed);
  }

  sniper.resetCooldown(position.symbol);

  // Risk alerts
  const snapshot = risk.getSnapshot();
  if (snapshot.halted) {
    const msg = `Daily loss limit hit: -$${Math.abs(snapshot.dailyPnl).toFixed(2)} / $${DAILY_LOSS_LIMIT_USD}`;
    telegram.notifyRiskAlert(msg);
    botStatus = 'HALTED';
    telegram.notifyBotStopped('Daily loss limit reached');
  } else if (snapshot.dailyLimitUsed > 0.8) {
    telegram.notifyRiskAlert(
      `Daily loss limit approaching: -$${Math.abs(snapshot.dailyPnl).toFixed(2)}/$${DAILY_LOSS_LIMIT_USD}`
    );
  }
}

async function resolvePositionLive(position: ManagedPosition): Promise<void> {
  // Query CLOB for order status
  const openOrders = await polymarket.getOpenOrders();
  const isStillOpen = openOrders.some((o: any) => o.id === position.orderId);

  if (isStillOpen) return; // still alive

  // Order is gone — either filled+resolved or cancelled
  // Try to determine resolution from Polymarket
  // In the absence of a direct resolution endpoint in the CLOB client,
  // we check if the market end time has passed
  const now = Date.now();
  const marketExpired = true; // simplified — real impl would check market.endDateIso

  if (!marketExpired) return;

  // Determine outcome from final Binance price
  const priceState = binance.getState(position.symbol);
  const finalChange = priceState
    ? ((priceState.currentPrice - priceState.candleOpen) / priceState.candleOpen) * 100
    : 0;

  const won =
    (position.side === 'YES' && finalChange > 0) ||
    (position.side === 'NO' && finalChange < 0);

  const exitPrice = won ? 0.97 : 0.03;
  const closed = risk.closePosition(position.id, exitPrice, won);
  if (!closed) return;

  botState.pnlPeriod += closed.pnlUsd ?? 0;
  botState.openPositions = risk.getSnapshot().openPositions;

  if (won) {
    telegram.notifyWin(closed);
  } else {
    telegram.notifyLoss(closed);
  }

  sniper.resetCooldown(position.symbol);
}

// ─── Evaluation Loop ──────────────────────────────────────────────────────────

async function evaluationTick(): Promise<void> {
  if (botStatus !== 'ACTIVE') return;
  if (risk.isHalted()) {
    botStatus = 'HALTED';
    return;
  }

  // Check if any positions have resolved
  await checkPositionResolution();

  // Evaluate new signals
  const signals = await sniper.evaluateAll();

  for (const signal of signals) {
    await processSignal(signal);
  }
}

async function processSignal(signal: TradeSignal): Promise<void> {
  logger.info(
    `[Bot] Signal: ${signal.symbol} ${signal.action} | ` +
    `Change: ${signal.binanceChange.toFixed(3)}% | ` +
    `Confidence: ${signal.confidence} | ` +
    `${signal.secondsRemaining.toFixed(0)}s left`
  );

  botState.signalsDetected++;
  telegram.notifySignal(signal);

  // Risk check
  const { allowed, reason } = risk.canOpenPosition();
  if (!allowed) {
    logger.warn(`[Bot] Position blocked: ${reason}`);
    botState.ordersRejected++;
    return;
  }

  // Already have a position in this market?
  if (risk.getOpenPositionByMarket(signal.marketId)) {
    logger.debug(`[Bot] Already have position in ${signal.marketId}`);
    return;
  }

  // Size the position
  const positionUsd = risk.calcPositionSize(signal);
  const tokenId = signal.action === 'BUY_YES' ? signal.yesTokenId : signal.noTokenId;
  const entryPrice = signal.action === 'BUY_YES' ? signal.polyYes : signal.polyNo;

  // Place order
  const result = await polymarket.placeOrder({
    tokenId,
    side: 'BUY',
    price: entryPrice,
    sizeUsd: positionUsd,
    marketId: signal.marketId,
    symbol: signal.symbol,
  });

  if (!result.success) {
    logger.error(`[Bot] Order failed: ${result.errorMsg}`);
    return;
  }

  // Register with risk manager
  const position = risk.openPosition(
    signal,
    result.orderId!,
    result.price,
    result.sizeShares,
    positionUsd
  );

  botState.ordersPlaced++;
  botState.openPositions = risk.getSnapshot().openPositions;
  telegram.notifyOrderPlaced(signal, position);

  logger.info(
    `[Bot] Order placed: ${signal.symbol} ${signal.action} ` +
    `$${positionUsd.toFixed(2)} @ ${result.price.toFixed(3)} ` +
    `(orderId=${result.orderId})`
  );
}

// ─── Console Command Handler ──────────────────────────────────────────────────

function setupConsoleCommands(): void {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', (input) => {
    try {
      const cmd = input.trim().toLowerCase();
      switch (cmd) {
        case 'pause':
        case 'p':
          botStatus = 'PAUSED';
          logger.info('[Bot] Paused via console');
          process.stdout.write('⏸ Bot pausado\n');
          break;

        case 'resume':
        case 'r':
          if (risk.isHalted()) risk.resume();
          botStatus = 'ACTIVE';
          logger.info('[Bot] Resumed via console');
          process.stdout.write('▶️ Bot reanudado\n');
          break;

        case 'stop':
        case 's':
          process.stdout.write('🔴 Deteniendo...\n');
          setTimeout(() => gracefulShutdown('console stop'), 1000);
          break;

        case 'status': {
          const snapshot = risk.getSnapshot();
          const positions = risk.getOpenPositions();
          const prices = botState.currentPrices;
          const posStr = positions.length === 0
            ? 'none'
            : positions.map((p) => `${p.symbol} ${p.side} $${p.costUsd.toFixed(2)}`).join(', ');
          process.stdout.write(
            `Status: ${botStatus} | Paused: ${botStatus === 'PAUSED'} | ` +
            `Positions: ${posStr} | ` +
            `P&L: ${snapshot.dailyPnl >= 0 ? '+' : ''}$${snapshot.dailyPnl.toFixed(2)} | ` +
            `BTC: $${prices.BTC.toLocaleString()} ETH: $${prices.ETH.toFixed(1)} SOL: $${prices.SOL.toFixed(3)}\n`
          );
          break;
        }

        case 'config':
          process.stdout.write(
            `Config — DRY_RUN: ${DRY_RUN} | SYMBOLS: ${SYMBOLS.join(',')} | ` +
            `MAX_POSITION_USD: $${MAX_POSITION_USD} | MAX_CONCURRENT: ${MAX_CONCURRENT_POSITIONS} | ` +
            `DAILY_LOSS_LIMIT: $${DAILY_LOSS_LIMIT_USD} | MIN_CHANGE: ${MIN_PRICE_CHANGE_PCT}% | ` +
            `MIN_CONFIDENCE: ${MIN_CONFIDENCE} | SNIPE_WINDOW: ${SNIPE_WINDOW_START}s–${SNIPE_WINDOW_END}s | ` +
            `EVAL: ${EVAL_INTERVAL_MS}ms | DASHBOARD: ${DASHBOARD_INTERVAL_MS}ms\n`
          );
          break;

        default:
          if (cmd) {
            process.stdout.write(
              `Unknown command: "${cmd}". Available: pause (p), resume (r), stop (s), status, config\n`
            );
          }
          break;
      }
    } catch (err) {
      logger.error('[Bot] Console command error', err);
    }
  });
}

// ─── Startup ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const modeStr = DRY_RUN ? 'DRY RUN' : 'LIVE';
  logger.info(`[Bot] Starting Polymarket Sniper — mode: ${modeStr}`);
  logger.info(`[Bot] Symbols: ${SYMBOLS.join(', ')}`);

  // Initialize Polymarket client
  try {
    await polymarket.initialize();
  } catch (err) {
    if (!DRY_RUN) {
      logger.error('[Bot] Failed to initialize Polymarket client', err);
      process.exit(1);
    } else {
      logger.warn('[Bot] Polymarket init failed but DRY_RUN=true, continuing');
    }
  }

  // Set up Telegram
  setupTelegramCommands();
  telegram.initialize();
  telegram.notifyBotStarted();
  telegram.sendFiveMinuteSummary();

  // Start Binance feed
  binance.connect();
  binance.on('connected', () => {
    logger.info('[Bot] Binance WebSocket connected');
  });
  binance.on('error', (err: Error) => {
    logger.error('[Bot] Binance feed error', err);
  });
  binance.on('update', (ps: PriceState) => {
    const sym = ps.symbol as keyof typeof botState.currentPrices;
    if (sym in botState.currentPrices) {
      botState.currentPrices[sym] = ps.currentPrice;
    }
  });

  // Wait briefly for initial price data
  logger.info('[Bot] Waiting 3s for initial price data...');
  await sleep(3000);

  // Start evaluation loop
  logger.info(`[Bot] Starting evaluation loop (every ${EVAL_INTERVAL_MS}ms)`);
  evalTimer = setInterval(async () => {
    try {
      await evaluationTick();
    } catch (err) {
      logger.error('[Bot] Evaluation tick error', err);
    }
  }, EVAL_INTERVAL_MS);

  // Start dashboard
  dashboard.start(DASHBOARD_INTERVAL_MS);

  // Set up console keyboard commands
  setupConsoleCommands();

  // Daily summary at midnight
  scheduleDailySummary();

  logger.info('[Bot] Bot running — press Ctrl+C to stop');
}

function scheduleDailySummary(): void {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 30, 0); // 00:00:30 UTC next day
  const ms = midnight.getTime() - now.getTime();

  setTimeout(() => {
    const snapshot = risk.getSnapshot();
    telegram.notifyDailySummary(snapshot);
    scheduleDailySummary(); // repeat
  }, ms);
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function gracefulShutdown(reason = 'SIGINT'): Promise<void> {
  logger.info(`[Bot] Shutting down: ${reason}`);

  if (evalTimer) clearInterval(evalTimer);
  dashboard.stop();
  binance.disconnect();
  telegram.shutdown();

  const snapshot = risk.getSnapshot();
  logger.info(
    `[Bot] Session summary — P&L: ${snapshot.sessionPnl >= 0 ? '+' : ''}$${snapshot.sessionPnl.toFixed(2)} ` +
    `Trades: ${snapshot.totalTrades} Win rate: ${snapshot.winRate.toFixed(1)}%`
  );

  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logger.error('[Bot] Uncaught exception', err);
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error('[Bot] Unhandled rejection', { reason });
});

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Run ──────────────────────────────────────────────────────────────────────

main().catch((err) => {
  logger.error('[Bot] Fatal startup error', err);
  process.exit(1);
});
