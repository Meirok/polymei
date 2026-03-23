/**
 * src/risk/manager.ts
 *
 * Risk manager: position sizing, P&L tracking, limits enforcement.
 *
 * Implements:
 *   - Kelly criterion for position sizing
 *   - Max concurrent position cap
 *   - Daily loss limit hard stop
 *   - Session and daily P&L tracking
 */

import {
  MAX_POSITION_USD,
  MAX_CONCURRENT_POSITIONS,
  DAILY_LOSS_LIMIT_USD,
} from '../../config.js';
import { logger } from '../utils/logger.js';
import type { TradeSignal } from '../strategies/sniper.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type PositionStatus = 'OPEN' | 'WIN' | 'LOSS' | 'CANCELLED';

export interface ManagedPosition {
  id: string;
  symbol: string;
  side: 'YES' | 'NO';
  tokenId: string;
  marketId: string;
  question: string;
  orderId: string;
  entryPrice: number;
  sizeShares: number;
  costUsd: number;
  placedAt: number;
  closedAt?: number;
  exitPrice?: number;
  pnlUsd?: number;
  status: PositionStatus;
}

export interface TradeRecord {
  id: string;
  symbol: string;
  side: 'YES' | 'NO';
  entryPrice: number;
  exitPrice: number;
  sizeShares: number;
  costUsd: number;
  pnlUsd: number;
  won: boolean;
  timestamp: number;
}

export interface RiskSnapshot {
  openPositions: number;
  dailyPnl: number;
  sessionPnl: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  dailyLimitUsed: number; // 0-1 fraction of daily limit used
  halted: boolean;
}

// ─── RiskManager ──────────────────────────────────────────────────────────────

export class RiskManager {
  private openPositions: Map<string, ManagedPosition> = new Map();
  private closedTrades: TradeRecord[] = [];
  private dailyPnl = 0;
  private sessionPnl = 0;
  private dailyResetDate = this.todayKey();
  private halted = false;
  private positionCounter = 0;

  // ─── Gate Checks ──────────────────────────────────────────────────────────

  /**
   * Returns true if we're allowed to open a new position.
   * Checks: halt flag, daily loss limit, concurrent position cap.
   */
  canOpenPosition(): { allowed: boolean; reason?: string } {
    this.checkDailyReset();

    if (this.halted) {
      return { allowed: false, reason: 'Bot halted (daily loss limit hit)' };
    }

    if (this.dailyPnl <= -DAILY_LOSS_LIMIT_USD) {
      this.halted = true;
      logger.error(
        `[RiskManager] Daily loss limit hit: ${this.dailyPnl.toFixed(2)} USD — halting`
      );
      return { allowed: false, reason: `Daily loss limit hit: $${Math.abs(this.dailyPnl).toFixed(2)}` };
    }

    if (this.openPositions.size >= MAX_CONCURRENT_POSITIONS) {
      return {
        allowed: false,
        reason: `Max concurrent positions (${MAX_CONCURRENT_POSITIONS}) reached`,
      };
    }

    return { allowed: true };
  }

  /**
   * Kelly criterion position sizing.
   *
   * Kelly formula: f = (b*p - q) / b
   *   b = net odds (how much we win per dollar risked = (1 - entryPrice) / entryPrice)
   *   p = estimated win probability (derived from confidence + entry price)
   *   q = 1 - p
   *
   * We cap at MAX_POSITION_USD and use a fractional Kelly (0.25x) to be conservative.
   */
  calcPositionSize(signal: TradeSignal): number {
    const confidence = signal.confidence / 100;
    const entryPrice = signal.action === 'BUY_YES' ? signal.polyYes : signal.polyNo;

    // Estimated win probability from confidence score
    const p = 0.5 + confidence * 0.4; // maps 0→0.5, 1→0.9
    const q = 1 - p;

    // Net odds: if we buy at 0.70 and win, we get $1 back → net = 0.30 / 0.70
    const b = (1 - entryPrice) / entryPrice;

    // Kelly fraction
    const kelly = (b * p - q) / b;
    const fractionalKelly = Math.max(kelly * 0.25, 0); // 1/4 Kelly

    // Scale to max position
    const positionUsd = Math.min(fractionalKelly * MAX_POSITION_USD * 4, MAX_POSITION_USD);

    // Ensure minimum viable order ($1 minimum on Polymarket)
    return Math.max(positionUsd, 1);
  }

  // ─── Position Lifecycle ───────────────────────────────────────────────────

  openPosition(
    signal: TradeSignal,
    orderId: string,
    entryPrice: number,
    sizeShares: number,
    costUsd: number
  ): ManagedPosition {
    const id = `pos-${++this.positionCounter}-${Date.now()}`;
    const side = signal.action === 'BUY_YES' ? 'YES' : 'NO';
    const tokenId = signal.action === 'BUY_YES' ? signal.yesTokenId : signal.noTokenId;

    const position: ManagedPosition = {
      id,
      symbol: signal.symbol,
      side,
      tokenId,
      marketId: signal.marketId,
      question: signal.question,
      orderId,
      entryPrice,
      sizeShares,
      costUsd,
      placedAt: Date.now(),
      status: 'OPEN',
    };

    this.openPositions.set(id, position);
    logger.info(`[RiskManager] Position opened: ${id} — ${signal.symbol} ${side} $${costUsd.toFixed(2)}`);
    return position;
  }

  /**
   * Close a position and record P&L.
   * exitPrice: 1.0 if won (resolved YES/NO in our favor), 0.0 if lost.
   */
  closePosition(
    positionId: string,
    exitPrice: number,
    won: boolean
  ): ManagedPosition | null {
    const pos = this.openPositions.get(positionId);
    if (!pos) return null;

    const proceeds = exitPrice * pos.sizeShares;
    const pnlUsd = proceeds - pos.costUsd;

    pos.status = won ? 'WIN' : 'LOSS';
    pos.exitPrice = exitPrice;
    pos.pnlUsd = pnlUsd;
    pos.closedAt = Date.now();

    this.openPositions.delete(positionId);

    // Update P&L
    this.dailyPnl += pnlUsd;
    this.sessionPnl += pnlUsd;

    this.closedTrades.push({
      id: pos.id,
      symbol: pos.symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      sizeShares: pos.sizeShares,
      costUsd: pos.costUsd,
      pnlUsd,
      won,
      timestamp: Date.now(),
    });

    logger.info(
      `[RiskManager] Position closed: ${positionId} — ${won ? 'WIN' : 'LOSS'} ` +
      `P&L: ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)}`
    );

    // Check if daily limit now hit
    if (this.dailyPnl <= -DAILY_LOSS_LIMIT_USD) {
      this.halted = true;
    }

    return pos;
  }

  cancelPosition(positionId: string): void {
    const pos = this.openPositions.get(positionId);
    if (pos) {
      pos.status = 'CANCELLED';
      this.openPositions.delete(positionId);
    }
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  getOpenPositions(): ManagedPosition[] {
    return Array.from(this.openPositions.values());
  }

  getOpenPositionByMarket(marketId: string): ManagedPosition | undefined {
    return Array.from(this.openPositions.values()).find(
      (p) => p.marketId === marketId
    );
  }

  getSnapshot(): RiskSnapshot {
    this.checkDailyReset();
    const total = this.closedTrades.length;
    const wins = this.closedTrades.filter((t) => t.won).length;
    const losses = total - wins;

    return {
      openPositions: this.openPositions.size,
      dailyPnl: this.dailyPnl,
      sessionPnl: this.sessionPnl,
      totalTrades: total,
      wins,
      losses,
      winRate: total > 0 ? (wins / total) * 100 : 0,
      dailyLimitUsed: Math.abs(Math.min(this.dailyPnl, 0)) / DAILY_LOSS_LIMIT_USD,
      halted: this.halted,
    };
  }

  getTodayTrades(): TradeRecord[] {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return this.closedTrades.filter((t) => t.timestamp >= todayStart.getTime());
  }

  resume(): void {
    this.halted = false;
    logger.info('[RiskManager] Bot resumed');
  }

  halt(reason: string): void {
    this.halted = true;
    logger.warn(`[RiskManager] Bot halted: ${reason}`);
  }

  isHalted(): boolean {
    return this.halted;
  }

  // ─── Daily Reset ─────────────────────────────────────────────────────────

  private todayKey(): string {
    return new Date().toISOString().split('T')[0];
  }

  private checkDailyReset(): void {
    const today = this.todayKey();
    if (today !== this.dailyResetDate) {
      logger.info('[RiskManager] New day — resetting daily P&L');
      this.dailyPnl = 0;
      this.dailyResetDate = today;
      // Unhalt on new day (let user decide)
      if (this.halted) {
        logger.info('[RiskManager] Auto-unhalting on new day');
        this.halted = false;
      }
    }
  }
}
