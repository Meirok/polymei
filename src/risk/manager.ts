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
  MAX_CONCURRENT_POSITIONS,
  DAILY_LOSS_LIMIT_USD,
  WALLET_BUDGET_USD,
} from '../../config.js';
import { logger } from '../utils/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Parameters required to open a new managed position. */
export interface PositionOpenParams {
  symbol: string;
  side: 'YES' | 'NO';
  tokenId: string;
  marketId: string;
  question: string;
}

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
  private committedUsd = 0;

  // ─── Gate Checks ──────────────────────────────────────────────────────────

  /**
   * Returns whether we're allowed to open a new position.
   * Checks: halt flag, daily loss limit, concurrent position cap, wallet budget.
   * @param sizeUsd - USD amount of the position about to be opened
   */
  canOpenPosition(sizeUsd = 0): { allowed: boolean; reason?: string } {
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

    if (sizeUsd > 0 && this.committedUsd + sizeUsd > WALLET_BUDGET_USD) {
      return {
        allowed: false,
        reason: `Wallet budget exceeded: committed $${this.committedUsd.toFixed(2)} + $${sizeUsd.toFixed(2)} > budget $${WALLET_BUDGET_USD.toFixed(2)}`,
      };
    }

    return { allowed: true };
  }

  // ─── Position Lifecycle ───────────────────────────────────────────────────

  openPosition(
    params: PositionOpenParams,
    orderId: string,
    entryPrice: number,
    sizeShares: number,
    costUsd: number
  ): ManagedPosition {
    const id = `pos-${++this.positionCounter}-${Date.now()}`;

    const position: ManagedPosition = {
      id,
      symbol: params.symbol,
      side: params.side,
      tokenId: params.tokenId,
      marketId: params.marketId,
      question: params.question,
      orderId,
      entryPrice,
      sizeShares,
      costUsd,
      placedAt: Date.now(),
      status: 'OPEN',
    };

    this.openPositions.set(id, position);
    this.committedUsd += costUsd;
    logger.info(`[RiskManager] Position opened: ${id} — ${params.symbol} ${params.side} $${costUsd.toFixed(2)} (committed: $${this.committedUsd.toFixed(2)})`);
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
    this.committedUsd = Math.max(0, this.committedUsd - pos.costUsd);

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
      this.committedUsd = Math.max(0, this.committedUsd - pos.costUsd);
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
