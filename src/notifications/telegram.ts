/**
 * src/notifications/telegram.ts
 *
 * Telegram bot integration for trade alerts and bot control commands.
 *
 * Commands:
 *   /status  — current open positions & P&L
 *   /pause   — pause trading (monitoring continues)
 *   /resume  — resume trading
 *   /stop    — full stop
 *   /config  — show current config
 *
 * Notifications sent automatically:
 *   🎯 Signal detected
 *   ✅ Order placed
 *   💰 Win
 *   ❌ Loss
 *   ⚠️  Risk alert
 *   📊 Daily summary (midnight)
 *   🔴 Bot stopped
 */

import TelegramBot from 'node-telegram-bot-api';
import {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  DRY_RUN,
  MAX_POSITION_USD,
  DAILY_LOSS_LIMIT_USD,
  MAX_CONCURRENT_POSITIONS,
  MIN_CONFIDENCE,
  SYMBOLS,
} from '../../config.js';
import { logger } from '../utils/logger.js';
import type { TradeSignal } from '../strategies/sniper.js';
import type { ManagedPosition, RiskSnapshot } from '../risk/manager.js';
import { botState, resetPeriodCounters } from '../state.js';

// ─── Types ───────────────────────────────────────────────────────────────────

type BotCommand = 'pause' | 'resume' | 'stop' | 'status' | 'config';
type CommandHandler = () => string | Promise<string>;

// ─── TelegramNotifier ─────────────────────────────────────────────────────────

export class TelegramNotifier {
  private bot: TelegramBot | null = null;
  private chatId: string = TELEGRAM_CHAT_ID;
  private commandHandlers: Map<BotCommand, CommandHandler> = new Map();
  private enabled: boolean;
  private dailySummaryTimer: NodeJS.Timeout | null = null;
  private fiveMinSummaryTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.enabled = !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  initialize(): void {
    if (!this.enabled) {
      logger.warn('[Telegram] No token/chat ID — notifications disabled');
      return;
    }

    this.bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

    this.bot.on('message', (msg) => {
      const text = msg.text?.trim() ?? '';
      const chatId = msg.chat.id.toString();

      // Only respond to the configured chat
      if (chatId !== this.chatId) return;

      this.handleCommand(chatId, text);
    });

    this.bot.on('polling_error', (err) => {
      logger.error('[Telegram] Polling error', err);
    });

    logger.info('[Telegram] Bot initialized');
    this.scheduleDailySummary();
  }

  shutdown(): void {
    if (this.bot) {
      this.bot.stopPolling();
    }
    if (this.dailySummaryTimer) {
      clearTimeout(this.dailySummaryTimer);
    }
    if (this.fiveMinSummaryTimer) {
      clearInterval(this.fiveMinSummaryTimer);
    }
  }

  // ─── Command Registration ─────────────────────────────────────────────────

  registerCommand(command: BotCommand, handler: CommandHandler): void {
    this.commandHandlers.set(command, handler);
  }

  private async handleCommand(chatId: string, text: string): Promise<void> {
    const cmd = text.toLowerCase().replace('/', '').trim() as BotCommand;
    const handler = this.commandHandlers.get(cmd);

    if (!handler) {
      this.send(
        `Unknown command: ${text}\nAvailable: /status /pause /resume /stop /config`
      );
      return;
    }

    try {
      const response = await handler();
      this.sendTo(chatId, response);
    } catch (err) {
      this.sendTo(chatId, `Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Notification Methods ─────────────────────────────────────────────────

  notifySignal(signal: TradeSignal): void {
    const dry = DRY_RUN ? ' [DRY RUN]' : '';
    const dir = signal.action === 'BUY_YES' ? '📈' : '📉';
    const polyPrice = signal.action === 'BUY_YES' ? signal.polyYes : signal.polyNo;

    this.send(
      `🎯 SIGNAL DETECTED${dry}\n` +
      `${dir} [${signal.symbol}] ${signal.action}\n` +
      `Change: ${signal.binanceChange >= 0 ? '+' : ''}${signal.binanceChange.toFixed(3)}%\n` +
      `Poly odds: ${polyPrice.toFixed(3)}\n` +
      `Confidence: ${signal.confidence}%\n` +
      `Time left: ${signal.secondsRemaining.toFixed(0)}s`
    );
  }

  notifyOrderPlaced(
    signal: TradeSignal,
    position: ManagedPosition
  ): void {
    const dry = DRY_RUN ? ' [DRY RUN]' : '';
    const dir = signal.action === 'BUY_YES' ? '📈' : '📉';

    this.send(
      `✅ ORDER PLACED${dry}\n` +
      `${dir} [${signal.symbol}] Bought ${position.side} $${position.costUsd.toFixed(2)} @ ${position.entryPrice.toFixed(3)}\n` +
      `Market closes in ${signal.secondsRemaining.toFixed(0)}s\n` +
      `Q: ${signal.question}`
    );
  }

  notifyWin(position: ManagedPosition): void {
    const dry = DRY_RUN ? ' [DRY RUN]' : '';
    const pnl = position.pnlUsd ?? 0;

    this.send(
      `💰 WIN${dry}\n` +
      `[${position.symbol}] +$${pnl.toFixed(2)} profit\n` +
      `Position closed at ${(position.exitPrice ?? 1).toFixed(3)}`
    );
  }

  notifyLoss(position: ManagedPosition): void {
    const dry = DRY_RUN ? ' [DRY RUN]' : '';
    const pnl = position.pnlUsd ?? 0;

    this.send(
      `❌ LOSS${dry}\n` +
      `[${position.symbol}] -$${Math.abs(pnl).toFixed(2)} loss\n` +
      `Resolved against ${position.side} position`
    );
  }

  notifyRiskAlert(message: string): void {
    this.send(`⚠️ RISK ALERT\n${message}`);
  }

  notifyBotStopped(reason: string): void {
    this.send(`🔴 BOT STOPPED\nReason: ${reason}`);
  }

  notifyBotStarted(): void {
    const mode = DRY_RUN ? '🧪 DRY RUN' : '🔴 LIVE';
    this.send(
      `🟢 SNIPER BOT STARTED\n` +
      `Mode: ${mode}\n` +
      `Symbols: ${SYMBOLS.join(', ')}\n` +
      `Max position: $${MAX_POSITION_USD}\n` +
      `Daily limit: $${DAILY_LOSS_LIMIT_USD}`
    );
  }

  notifyDailySummary(snapshot: RiskSnapshot): void {
    const pnlEmoji = snapshot.dailyPnl >= 0 ? '💚' : '🔴';

    this.send(
      `📊 DAILY SUMMARY\n` +
      `${pnlEmoji} P&L: ${snapshot.dailyPnl >= 0 ? '+' : ''}$${snapshot.dailyPnl.toFixed(2)}\n` +
      `Trades: ${snapshot.totalTrades} | W: ${snapshot.wins} / L: ${snapshot.losses}\n` +
      `Win rate: ${snapshot.winRate.toFixed(1)}%\n` +
      `Session P&L: ${snapshot.sessionPnl >= 0 ? '+' : ''}$${snapshot.sessionPnl.toFixed(2)}`
    );
  }

  // ─── Status / Config Helpers ──────────────────────────────────────────────

  buildStatusMessage(
    snapshot: RiskSnapshot,
    openPositions: ManagedPosition[]
  ): string {
    const dry = DRY_RUN ? ' [DRY RUN MODE]' : '';
    const status = snapshot.halted ? '🔴 HALTED' : '🟢 ACTIVE';

    let msg = `📊 BOT STATUS${dry}\n${status}\n\n`;
    msg += `Today P&L: ${snapshot.dailyPnl >= 0 ? '+' : ''}$${snapshot.dailyPnl.toFixed(2)}\n`;
    msg += `Win rate: ${snapshot.winRate.toFixed(1)}% (${snapshot.wins}W/${snapshot.losses}L)\n`;
    msg += `Open positions: ${snapshot.openPositions}/${MAX_CONCURRENT_POSITIONS}\n\n`;

    if (openPositions.length > 0) {
      msg += 'Open positions:\n';
      for (const p of openPositions) {
        msg += `  • [${p.symbol}] ${p.side} $${p.costUsd.toFixed(2)} @ ${p.entryPrice.toFixed(3)}\n`;
      }
    } else {
      msg += 'No open positions';
    }

    return msg;
  }

  buildConfigMessage(): string {
    return (
      `⚙️ CURRENT CONFIG\n` +
      `Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n` +
      `Symbols: ${SYMBOLS.join(', ')}\n` +
      `Max position: $${MAX_POSITION_USD}\n` +
      `Max concurrent: ${MAX_CONCURRENT_POSITIONS}\n` +
      `Daily loss limit: $${DAILY_LOSS_LIMIT_USD}\n` +
      `Min confidence: ${MIN_CONFIDENCE}%`
    );
  }

  // ─── 5-Minute Summary ─────────────────────────────────────────────────────

  /**
   * Builds and sends a 5-minute rolling summary message, resets period counters,
   * and (on first call) schedules itself to run every 5 minutes via setInterval.
   */
  sendFiveMinuteSummary(): void {
    const now = new Date();
    const hh = now.getHours().toString().padStart(2, '0');
    const mm = now.getMinutes().toString().padStart(2, '0');

    const s = botState;

    const pnlSign = s.pnlPeriod >= 0 ? '+' : '-';
    const pnlStr = `${pnlSign}$${Math.abs(s.pnlPeriod).toFixed(2)}`;

    const pctChange = (current: number, prev: number): string => {
      if (prev <= 0) return '+0.00%';
      const pct = ((current - prev) / prev) * 100;
      return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
    };

    const fmtPrice = (p: number): string =>
      p > 0 ? Math.round(p).toLocaleString('en-US') : '0';

    const mode = DRY_RUN ? 'DRY RUN' : 'LIVE';

    const msg =
      `📊 *Resumen últimos 5 min*\n` +
      `🕐 ${hh}:${mm}\n` +
      `🔍 Señales detectadas: ${s.signalsDetected}\n` +
      `✅ Órdenes ejecutadas: ${s.ordersPlaced}\n` +
      `❌ Órdenes rechazadas (baja confianza): ${s.ordersRejected}\n` +
      `💰 P&L del período: ${pnlStr}\n` +
      `📈 Posiciones abiertas: ${s.openPositions}\n` +
      `BTC: $${fmtPrice(s.currentPrices.BTC)} (${pctChange(s.currentPrices.BTC, s.prevPrices.BTC)})\n` +
      `ETH: $${fmtPrice(s.currentPrices.ETH)} (${pctChange(s.currentPrices.ETH, s.prevPrices.ETH)})\n` +
      `SOL: $${fmtPrice(s.currentPrices.SOL)} (${pctChange(s.currentPrices.SOL, s.prevPrices.SOL)})\n` +
      `🟢 Bot activo | ${mode}`;

    this.send(msg);
    resetPeriodCounters();

    // Start the recurring interval on first call
    if (!this.fiveMinSummaryTimer) {
      this.fiveMinSummaryTimer = setInterval(
        () => this.sendFiveMinuteSummary(),
        300_000
      );
    }
  }

  // ─── Low-level Send ────────────────────────────────────────────────────────

  send(message: string): void {
    if (!this.enabled || !this.bot) {
      logger.info(`[Telegram] (disabled) ${message}`);
      return;
    }
    this.sendTo(this.chatId, message);
  }

  private sendTo(chatId: string, message: string): void {
    if (!this.bot) return;
    this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' }).catch((err) => {
      logger.error('[Telegram] sendMessage error', err);
    });
  }

  // ─── Daily Summary Scheduler ──────────────────────────────────────────────

  private scheduleDailySummary(): void {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0); // next midnight
    const msUntilMidnight = midnight.getTime() - now.getTime();

    this.dailySummaryTimer = setTimeout(() => {
      // Will be called externally by bot.ts with the snapshot
      this.scheduleDailySummary(); // reschedule
    }, msUntilMidnight);
  }
}
