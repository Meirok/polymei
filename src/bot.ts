/**
 * src/bot.ts
 *
 * Main bot entry point.
 *
 * Lifecycle:
 *   1. Initialize all modules (Binance WS, Polymarket client, Risk, Telegram)
 *   2. On new 5-min market window → scalper.onNewMarket() buys the near-50/50 side
 *   3. Every 2 seconds → scalper.monitorPositions() checks for target/force-sell
 *   4. On market close → scalper.onMarketClose() + send summary to Telegram
 *   5. Graceful shutdown on SIGINT / SIGTERM
 */

import 'dotenv/config';
import readline from 'readline';
import { BinanceFeed } from './feeds/binance.js';
import { PolymarketClient, logTimestampVerification, getCurrentMarketCloseTimestamp } from './polymarket/client.js';
import { Scalper } from './strategies/scalper.js';
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
  MAX_CONCURRENT_POSITIONS,
  SCALPER_POSITION_SIZE_USD,
  SCALPER_PROFIT_TARGET,
  SCALPER_MAX_ENTRY_PRICE,
  SCALPER_FORCE_SELL_SECONDS,
} from '../config.js';

// ─── Market Window Tracking ───────────────────────────────────────────────────

interface MarketWindow {
  symbol: string;
  question: string;
  expiryMs: number;
  betPlaced: boolean;
  positionId: string | null;
  side?: 'YES' | 'NO';
  betAmount?: number;
  betOdds?: number;
  noTradeReasons: string[];
  closeSummarySent: boolean;
}

const marketWindows = new Map<string, MarketWindow>();

// ─── Bot State ────────────────────────────────────────────────────────────────

type BotStatus = 'ACTIVE' | 'PAUSED' | 'HALTED';

let botStatus: BotStatus = 'ACTIVE';
let evalTimer: NodeJS.Timeout | null = null;
let monitorTimer: NodeJS.Timeout | null = null;

// Last known 5-min market close timestamp — used to detect new windows
let lastMarketTimestamp = 0;

// ─── Module Initialization ────────────────────────────────────────────────────

const binance = new BinanceFeed(SYMBOLS);
const polymarket = new PolymarketClient();
const risk = new RiskManager();
const telegram = new TelegramNotifier();
const scalper = new Scalper(polymarket, risk, (msg: string) => telegram.sendLog(msg));
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

// ─── Evaluation Loop ──────────────────────────────────────────────────────────

/**
 * Runs every EVAL_INTERVAL_MS (500ms).
 * Detects new 5-minute market windows and calls scalper.onNewMarket().
 * Also sends market-close summaries when windows expire.
 */
async function evaluationTick(): Promise<void> {
  if (botStatus !== 'ACTIVE') return;
  if (risk.isHalted()) {
    botStatus = 'HALTED';
    return;
  }

  botState.openPositions = scalper.getOpenPositionsCount();

  // ── Detect new 5-minute market window ────────────────────────────────────
  const currentTs = getCurrentMarketCloseTimestamp();
  if (currentTs !== lastMarketTimestamp) {
    lastMarketTimestamp = currentTs;
    logger.info(`[Bot] New 5-min market window detected: ts=${currentTs}`);

    // Fetch fresh markets and trigger scalper entry for each symbol
    for (const sym of SYMBOLS) {
      try {
        const market = await polymarket.findCurrentMarket(sym);
        if (!market) {
          logger.warn(`[Bot] No market found for ${sym} at window open`);
          continue;
        }

        const expiryMs = new Date(market.endDate).getTime();

        // Reset window tracking for this symbol
        scalper.resetWindow(sym);
        marketWindows.set(sym, {
          symbol: sym,
          question: market.slug,
          expiryMs,
          betPlaced: false,
          positionId: null,
          noTradeReasons: [],
          closeSummarySent: false,
        });

        // Ask scalper to open a position if conditions are met
        await scalper.onNewMarket(sym, market);

        // Capture bet info if scalper opened a position
        const pos = scalper.getOpenPosition(sym);
        const win = marketWindows.get(sym);
        if (win && pos) {
          win.betPlaced = true;
          win.positionId = pos.riskPositionId;
          win.side = pos.side === 'UP' ? 'YES' : 'NO';
          win.betAmount = pos.usdInvested;
          win.betOdds = pos.entryPrice;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[Bot] Error handling new market for ${sym}`, err);
        telegram.notifyError('bot', msg, 'skipping symbol');
      }
    }
  }

  // ── Check for market expirations → send close summaries ──────────────────
  const now = Date.now();
  for (const [sym, win] of marketWindows.entries()) {
    if (win.closeSummarySent || now < win.expiryMs) continue;

    const priceState = binance.getState(sym);
    const priceAtClose = priceState?.currentPrice ?? 0;
    const snapshot = risk.getSnapshot();

    // Notify scalper: market closed (handles any un-sold position)
    await scalper.onMarketClose(sym, priceAtClose);

    const expiryDate = new Date(win.expiryMs);
    const marketTime =
      `${expiryDate.getUTCHours().toString().padStart(2, '0')}:` +
      `${expiryDate.getUTCMinutes().toString().padStart(2, '0')} UTC`;

    const noTradeReason = win.betPlaced
      ? undefined
      : scalper.getSkipReason(sym);

    telegram.notifyMarketClose({
      symbol: sym,
      marketTime,
      question: win.question,
      betPlaced: win.betPlaced,
      betSide: win.side,
      betAmount: win.betAmount,
      betOdds: win.betOdds,
      result: win.betPlaced ? 'pending' : undefined,
      noTradeReason,
      priceAtClose,
      dailyPnl: snapshot.dailyPnl,
    });

    win.closeSummarySent = true;
    // Clean up old windows after a minute
    setTimeout(() => marketWindows.delete(sym), 60_000);
  }
}

// ─── Monitor Loop (every 2 seconds) ──────────────────────────────────────────

async function monitorTick(): Promise<void> {
  if (botStatus !== 'ACTIVE') return;

  try {
    await scalper.monitorPositions((sym) => polymarket.getActiveMarket(sym));
    botState.openPositions = scalper.getOpenPositionsCount();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[Bot] Monitor tick error', err);
    telegram.notifyError('bot', msg, 'skipping monitor cycle');
  }

  // Check if daily limit was hit by a position close
  if (risk.isHalted() && botStatus === 'ACTIVE') {
    const snapshot = risk.getSnapshot();
    const msg = `Daily loss limit hit: -$${Math.abs(snapshot.dailyPnl).toFixed(2)} / $${DAILY_LOSS_LIMIT_USD}`;
    telegram.notifyRiskAlert(msg);
    botStatus = 'HALTED';
    telegram.notifyBotStopped('Daily loss limit reached');
  }
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
            `POSITION_SIZE: $${SCALPER_POSITION_SIZE_USD} | MAX_CONCURRENT: ${MAX_CONCURRENT_POSITIONS} | ` +
            `DAILY_LOSS_LIMIT: $${DAILY_LOSS_LIMIT_USD} | PROFIT_TARGET: +${SCALPER_PROFIT_TARGET} | ` +
            `MAX_ENTRY: ${SCALPER_MAX_ENTRY_PRICE} | FORCE_SELL: ${SCALPER_FORCE_SELL_SECONDS}s | ` +
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

// ─── Startup Diagnostic ───────────────────────────────────────────────────────

async function runStartupDiagnostic(): Promise<void> {
  const lines: string[] = ['🔧 DIAGNÓSTICO'];
  let allMarketsOk = true;

  // ── Markets per symbol ────────────────────────────────────────────────────
  for (const sym of ['BTC', 'ETH', 'SOL']) {
    try {
      const market = await polymarket.findCurrentMarket(sym);
      if (market) {
        const secs = market.secondsUntilClose;
        const mins = Math.floor(secs / 60);
        const secPad = String(secs % 60).padStart(2, '0');
        lines.push(
          `- ${sym}: ✅ ${market.slug} | UP: ${market.upPrice.toFixed(2)} | DOWN: ${market.downPrice.toFixed(2)} | ` +
          `cierra en ${mins}min ${secPad}s | acepta órdenes: ${market.acceptingOrders ? '✅' : '❌'}`
        );
      } else {
        const candidates = polymarket.getCandidateTimestamps();
        const tsStr = candidates.join(', ');
        lines.push(`- ${sym}: ❌ No encontrado — timestamps probados: ${tsStr}`);
        allMarketsOk = false;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(`- ${sym}: ❌ ${msg}`);
      allMarketsOk = false;
    }
  }

  // ── Binance prices ─────────────────────────────────────────────────────────
  const btcState = binance.getState('BTC');
  const ethState = binance.getState('ETH');
  const solState = binance.getState('SOL');

  const fmtBinance = (sym: string, price: number): string => {
    if (price <= 0) return '❌ N/A';
    if (sym === 'BTC' || sym === 'ETH') return `$${Math.round(price).toLocaleString('en-US')} ✅`;
    return `$${price.toFixed(2)} ✅`;
  };

  lines.push(`- Binance BTC: ${fmtBinance('BTC', btcState?.currentPrice ?? 0)}`);
  lines.push(`- Binance ETH: ${fmtBinance('ETH', ethState?.currentPrice ?? 0)}`);
  lines.push(`- Binance SOL: ${fmtBinance('SOL', solState?.currentPrice ?? 0)}`);

  // ── Wallet ─────────────────────────────────────────────────────────────────
  const walletAddr = polymarket.getWalletAddress();
  const addrStr = walletAddr
    ? `0x${walletAddr.slice(2, 6)}...${walletAddr.slice(-4)}`
    : 'N/A';
  lines.push(`- Wallet: ${addrStr} ${walletAddr ? '✅' : '❌'}`);

  // ── Summary ────────────────────────────────────────────────────────────────
  lines.push(allMarketsOk ? '- ✅ Listo para operar' : '- ⚠️ Revisar errores antes de operar');

  telegram.sendLog(lines.join('\n'));
}

// ─── Startup ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const modeStr = DRY_RUN ? 'DRY RUN' : 'LIVE';
  logger.info(`[Bot] Starting Polymarket Scalper — mode: ${modeStr}`);
  logger.info(`[Bot] Symbols: ${SYMBOLS.join(', ')}`);

  // Initialize Polymarket client
  try {
    await polymarket.initialize();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!DRY_RUN) {
      logger.error('[Bot] Failed to initialize Polymarket client', err);
      telegram.notifyError('polymarket', msg, 'stopping');
      process.exit(1);
    } else {
      logger.warn('[Bot] Polymarket init failed but DRY_RUN=true, continuing');
      telegram.notifyError('polymarket', msg, 'continuing in DRY RUN');
    }
  }

  // Set up Telegram
  setupTelegramCommands();
  telegram.initialize();

  // Wire up Telegram log callback for polymarket diagnostics
  const logFn = (msg: string) => telegram.sendLog(msg);
  polymarket.setLogFn(logFn);

  telegram.notifyBotStarted();

  // Start Binance feed
  binance.connect();
  binance.on('connected', () => {
    logger.info('[Bot] Binance WebSocket connected');
  });
  binance.on('error', (err: Error) => {
    logger.error('[Bot] Binance feed error', err);
    telegram.notifyError('binance', err.message, 'reconnecting');
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

  // Log timestamp math so we can verify ET-alignment
  logTimestampVerification();

  // Run startup diagnostic and send to Telegram
  logger.info('[Bot] Running startup diagnostic...');
  await runStartupDiagnostic();

  // Seed lastMarketTimestamp so the first tick doesn't fire a spurious "new window"
  lastMarketTimestamp = getCurrentMarketCloseTimestamp();

  // Start auto-refresh of markets every 30s (keeps cache fresh for monitoring)
  polymarket.startAutoRefresh(SYMBOLS);

  // Start evaluation loop (new window detection + market close summaries)
  logger.info(`[Bot] Starting evaluation loop (every ${EVAL_INTERVAL_MS}ms)`);
  evalTimer = setInterval(async () => {
    try {
      await evaluationTick();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Bot] Evaluation tick error', err);
      telegram.notifyError('bot', msg, 'skipping cycle');
    }
  }, EVAL_INTERVAL_MS);

  // Start position monitoring loop (checks target/force-sell every 2s)
  logger.info('[Bot] Starting position monitor loop (every 2000ms)');
  monitorTimer = setInterval(async () => {
    try {
      await monitorTick();
    } catch (err) {
      logger.error('[Bot] Monitor timer error', err);
    }
  }, 2000);

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
  if (monitorTimer) clearInterval(monitorTimer);
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
