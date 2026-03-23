/**
 * src/dashboard.ts
 *
 * Terminal dashboard — refreshes every 2s showing:
 *   - Live prices + % change per symbol
 *   - Seconds remaining in current 5-min candle (countdown)
 *   - Open positions
 *   - Today's P&L and trade count
 *   - Bot status (ACTIVE / PAUSED / DRY RUN / HALTED)
 */

import chalk from 'chalk';
import type { BinanceFeed } from './feeds/binance.js';
import type { RiskManager } from './risk/manager.js';
import { secondsUntilNext5MinBoundary } from './strategies/sniper.js';
import { SYMBOLS, DRY_RUN, SNIPE_WINDOW_START, SNIPE_WINDOW_END } from '../config.js';

// ─── Dashboard ────────────────────────────────────────────────────────────────

export class Dashboard {
  private timer: NodeJS.Timeout | null = null;
  private paused = false;
  private startTime = Date.now();

  constructor(
    private binance: BinanceFeed,
    private risk: RiskManager,
    private getStatus: () => 'ACTIVE' | 'PAUSED' | 'HALTED'
  ) {}

  start(intervalMs = 2000): void {
    this.render();
    this.timer = setInterval(() => this.render(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  private render(): void {
    const now = new Date();
    const secondsLeft = secondsUntilNext5MinBoundary();
    const snapshot = this.risk.getSnapshot();
    const openPositions = this.risk.getOpenPositions();
    const status = this.getStatus();
    const uptimeMs = Date.now() - this.startTime;
    const uptimeSec = Math.floor(uptimeMs / 1000);
    const uptimeStr = this.formatUptime(uptimeSec);

    const isInWindow = secondsLeft <= SNIPE_WINDOW_START && secondsLeft >= SNIPE_WINDOW_END;

    // ── Header ───────────────────────────────────────────────────────────────
    const lines: string[] = [];
    lines.push('');
    lines.push(
      chalk.bold.cyan('╔══════════════════════════════════════════════════╗')
    );
    lines.push(
      chalk.bold.cyan('║') +
      chalk.bold.white('       POLYMARKET CRYPTO SNIPER BOT               ') +
      chalk.bold.cyan('║')
    );
    lines.push(
      chalk.bold.cyan('╚══════════════════════════════════════════════════╝')
    );

    // ── Status bar ───────────────────────────────────────────────────────────
    const statusColor =
      status === 'ACTIVE' ? chalk.green :
      status === 'PAUSED' ? chalk.yellow : chalk.red;

    const modeStr = DRY_RUN ? chalk.yellow('[DRY RUN]') : chalk.red('[LIVE]');

    lines.push(
      `  ${statusColor.bold(status)}  ${modeStr}  ` +
      chalk.gray(`Uptime: ${uptimeStr}`) +
      chalk.gray(`  Time: ${now.toTimeString().slice(0, 8)} UTC`)
    );
    lines.push('');

    // ── Candle countdown ──────────────────────────────────────────────────────
    const candleBar = this.buildCandleBar(secondsLeft);
    const windowLabel = isInWindow
      ? chalk.bgYellow.black(' ⚡ SNIPE WINDOW ACTIVE ')
      : chalk.gray(`  Next window in ${(secondsLeft - SNIPE_WINDOW_END).toFixed(0)}s`);

    lines.push(`  5-min Candle: ${candleBar}  ${chalk.bold(secondsLeft.toFixed(1) + 's')}  ${windowLabel}`);
    lines.push('');

    // ── Price table ───────────────────────────────────────────────────────────
    lines.push(chalk.bold('  PRICES'));
    lines.push(chalk.gray('  ' + '─'.repeat(50)));

    const headerRow =
      chalk.gray('  ') +
      chalk.bold(padR('Symbol', 8)) +
      chalk.bold(padR('Price', 14)) +
      chalk.bold(padR('Change', 10)) +
      chalk.bold(padR('Momentum', 10)) +
      chalk.bold('Volume');
    lines.push(headerRow);
    lines.push(chalk.gray('  ' + '─'.repeat(50)));

    for (const sym of SYMBOLS) {
      const state = this.binance.getState(sym);
      if (!state || state.currentPrice === 0) {
        lines.push(chalk.gray(`  ${padR(sym, 8)}${chalk.italic('waiting...')}`));
        continue;
      }

      const priceStr = this.formatPrice(sym, state.currentPrice);
      const changeStr = this.formatChange(state.changePercent);
      const momStr = this.formatMomentum(state.momentum);
      const volStr = this.formatVolume(state.volume);

      lines.push(
        `  ${chalk.bold(padR(sym, 8))}${padR(priceStr, 14)}${padR(changeStr, 10)}${padR(momStr, 10)}${volStr}`
      );
    }

    lines.push('');

    // ── Open Positions ────────────────────────────────────────────────────────
    lines.push(chalk.bold('  POSITIONS'));
    lines.push(chalk.gray('  ' + '─'.repeat(50)));

    if (openPositions.length === 0) {
      lines.push(chalk.gray('  No open positions'));
    } else {
      for (const pos of openPositions) {
        const age = Math.floor((Date.now() - pos.placedAt) / 1000);
        const sideColor = pos.side === 'YES' ? chalk.green : chalk.red;
        lines.push(
          `  [${chalk.bold(pos.symbol)}] ${sideColor(pos.side)} ` +
          `$${pos.costUsd.toFixed(2)} @ ${pos.entryPrice.toFixed(3)} ` +
          chalk.gray(`(${age}s ago)`)
        );
      }
    }

    lines.push('');

    // ── P&L Panel ─────────────────────────────────────────────────────────────
    lines.push(chalk.bold('  TODAY\'S STATS'));
    lines.push(chalk.gray('  ' + '─'.repeat(50)));

    const pnlColor = snapshot.dailyPnl >= 0 ? chalk.green : chalk.red;
    const pnlStr = `${snapshot.dailyPnl >= 0 ? '+' : ''}$${snapshot.dailyPnl.toFixed(2)}`;
    const limitPct = (snapshot.dailyLimitUsed * 100).toFixed(0);
    const limitBar = this.buildLimitBar(snapshot.dailyLimitUsed);

    lines.push(
      `  P&L: ${pnlColor.bold(pnlStr)}   ` +
      `Trades: ${snapshot.totalTrades}   ` +
      `Win Rate: ${snapshot.winRate.toFixed(1)}%   ` +
      `W/L: ${snapshot.wins}/${snapshot.losses}`
    );
    lines.push(`  Daily limit: ${limitBar} ${limitPct}% used`);
    lines.push('');

    // ── Footer ────────────────────────────────────────────────────────────────
    lines.push(chalk.gray('  Commands: pause (p)  resume (r)  stop (s)  status  config'));
    lines.push('');

    // Render
    console.clear();
    console.log(lines.join('\n'));
  }

  // ─── Formatters ───────────────────────────────────────────────────────────

  private formatPrice(sym: string, price: number): string {
    if (sym === 'BTC') return `$${price.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    if (sym === 'ETH') return `$${price.toLocaleString('en-US', { maximumFractionDigits: 1 })}`;
    return `$${price.toFixed(3)}`;
  }

  private formatChange(pct: number): string {
    const s = `${pct >= 0 ? '+' : ''}${pct.toFixed(3)}%`;
    return pct > 0.3 ? chalk.green(s) : pct < -0.3 ? chalk.red(s) : chalk.white(s);
  }

  private formatMomentum(m: number): string {
    const s = `${m >= 0 ? '▲' : '▼'}${Math.abs(m).toFixed(4)}`;
    return m > 0 ? chalk.green(s) : m < 0 ? chalk.red(s) : chalk.gray(s);
  }

  private formatVolume(v: number): string {
    if (v > 1000) return chalk.gray(`${(v / 1000).toFixed(1)}K`);
    return chalk.gray(v.toFixed(1));
  }

  private buildCandleBar(secondsLeft: number): string {
    const total = 300; // 5 min = 300s
    const filled = total - secondsLeft;
    const barLen = 30;
    const filledLen = Math.round((filled / total) * barLen);
    const bar = '█'.repeat(filledLen) + '░'.repeat(barLen - filledLen);

    const isInWindow = secondsLeft <= SNIPE_WINDOW_START && secondsLeft >= SNIPE_WINDOW_END;
    return isInWindow ? chalk.yellow(bar) : chalk.gray(bar);
  }

  private buildLimitBar(fraction: number): string {
    const barLen = 20;
    const filledLen = Math.round(Math.min(fraction, 1) * barLen);
    const bar = '█'.repeat(filledLen) + '░'.repeat(barLen - filledLen);
    return fraction > 0.8 ? chalk.red(bar) : fraction > 0.5 ? chalk.yellow(bar) : chalk.green(bar);
  }

  private formatUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h${m.toString().padStart(2, '0')}m${s.toString().padStart(2, '0')}s`;
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function padR(s: string | number, width: number): string {
  return String(s).padEnd(width);
}
