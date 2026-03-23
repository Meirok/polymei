/**
 * src/strategies/sniper.ts
 *
 * Core Binance → Polymarket lag arbitrage sniper.
 *
 * Strategy:
 *   In the last SNIPE_WINDOW_START..SNIPE_WINDOW_END seconds of a 5-minute candle:
 *   - If Binance price moved strongly UP   and Polymarket YES is still cheap → BUY YES
 *   - If Binance price moved strongly DOWN and Polymarket NO  is still cheap → BUY NO
 *
 * Confidence score drives position sizing via Kelly criterion.
 */

import type { BinanceFeed } from '../feeds/binance.js';
import type { PolymarketClient, PolymarketOdds } from '../polymarket/client.js';
import {
  SNIPE_WINDOW_START,
  SNIPE_WINDOW_END,
  MIN_PRICE_CHANGE_PCT,
  MIN_CONFIDENCE,
  SYMBOLS,
} from '../../config.js';
import { logger } from '../utils/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type TradeAction = 'BUY_YES' | 'BUY_NO';

export interface TradeSignal {
  symbol: string;
  action: TradeAction;
  confidence: number;       // 0-100
  binanceChange: number;    // % change from candle open
  momentum: number;
  polyYes: number;          // current YES price (0-1)
  polyNo: number;           // current NO price  (0-1)
  yesTokenId: string;
  noTokenId: string;
  marketId: string;
  question: string;
  secondsRemaining: number;
  currentPrice: number;
}

// ─── Candle Timing ────────────────────────────────────────────────────────────

/**
 * Returns seconds remaining until the next 5-minute UTC boundary.
 * Polymarket 5-minute markets typically resolve on :00, :05, :10… UTC minutes.
 */
export function secondsUntilNext5MinBoundary(): number {
  const now = Date.now();
  const fiveMinMs = 5 * 60 * 1000;
  const msIntoBoundary = now % fiveMinMs;
  return (fiveMinMs - msIntoBoundary) / 1000;
}

/**
 * Returns seconds elapsed since last 5-minute boundary.
 */
export function secondsIntoCandle(): number {
  const now = Date.now();
  const fiveMinMs = 5 * 60 * 1000;
  return (now % fiveMinMs) / 1000;
}

// ─── Confidence Scoring ───────────────────────────────────────────────────────

/**
 * Compute a 0-100 confidence score.
 *
 * Factors:
 * 1. Price move magnitude   (bigger = more confident)
 * 2. Momentum strength      (accelerating in the right direction = more confident)
 * 3. Polymarket mispricing  (further below 0.85 = more edge)
 * 4. Time window sweetspot  (20-40s remaining is ideal)
 */
export function calculateConfidence(
  changePercent: number,
  momentum: number,
  polyPrice: number,   // price of the token we'd buy (YES or NO)
  secondsRemaining: number,
  action: TradeAction
): number {
  let score = 0;

  // ── 1. Price move magnitude (max 35 pts) ──────────────────────────────────
  const absMoveMin = MIN_PRICE_CHANGE_PCT;
  const absMoveMax = 1.5; // ≥1.5% → full score
  const absMoveNorm = Math.min(
    Math.max((Math.abs(changePercent) - absMoveMin) / (absMoveMax - absMoveMin), 0),
    1
  );
  score += absMoveNorm * 35;

  // ── 2. Momentum (max 25 pts) ───────────────────────────────────────────────
  const momentumDir = action === 'BUY_YES' ? 1 : -1;
  const momentumAligned = momentum * momentumDir; // positive if momentum in trade direction
  const momentumScore = Math.min(Math.max(momentumAligned / 0.1, 0), 1); // normalize to 0.1%
  score += momentumScore * 25;

  // ── 3. Polymarket mispricing (max 25 pts) ─────────────────────────────────
  // The "fair" price given binance signal is close to 1 (should win)
  // The lower polyPrice is vs fair, the more edge we have
  const fairPrice = 0.90; // what we think true probability should be
  const mispricing = Math.max(fairPrice - polyPrice, 0);
  const mispricingNorm = Math.min(mispricing / 0.30, 1); // up to 30% gap = full score
  score += mispricingNorm * 25;

  // ── 4. Time window (max 15 pts) ──────────────────────────────────────────
  // Sweetspot: 20-40s remaining
  const sweetspotLow = 20;
  const sweetspotHigh = 40;
  let timeFactor: number;
  if (secondsRemaining >= sweetspotLow && secondsRemaining <= sweetspotHigh) {
    timeFactor = 1.0;
  } else if (secondsRemaining > sweetspotHigh) {
    // Too early — decayed signal
    timeFactor = Math.max(0, 1 - (secondsRemaining - sweetspotHigh) / 20);
  } else {
    // Very last seconds — some risk of missing resolution
    timeFactor = secondsRemaining / sweetspotLow;
  }
  score += timeFactor * 15;

  return Math.round(Math.max(0, Math.min(100, score)));
}

// ─── Sniper ───────────────────────────────────────────────────────────────────

export class Sniper {
  // Cooldown per symbol to avoid double-firing
  private lastSignalTime: Map<string, number> = new Map();
  private readonly SIGNAL_COOLDOWN_MS = 30_000; // 30s between signals for same symbol

  constructor(
    private binance: BinanceFeed,
    private polymarket: PolymarketClient
  ) {}

  /**
   * Evaluate a single symbol for a trade signal.
   * Returns a TradeSignal if conditions are met, null otherwise.
   */
  async evaluateTrade(symbol: string): Promise<TradeSignal | null> {
    const secondsRemaining = secondsUntilNext5MinBoundary();

    // Only snipe inside the configured window
    if (secondsRemaining > SNIPE_WINDOW_START || secondsRemaining < SNIPE_WINDOW_END) {
      return null;
    }

    // Cooldown check
    const lastSignal = this.lastSignalTime.get(symbol) ?? 0;
    if (Date.now() - lastSignal < this.SIGNAL_COOLDOWN_MS) {
      return null;
    }

    const priceState = this.binance.getState(symbol);
    if (!priceState || priceState.currentPrice === 0) return null;

    const change = priceState.changePercent;
    const momentum = priceState.momentum;

    // Determine direction
    const isLong = change > MIN_PRICE_CHANGE_PCT && momentum >= 0;
    const isShort = change < -MIN_PRICE_CHANGE_PCT && momentum <= 0;
    if (!isLong && !isShort) return null;

    // Get Polymarket odds
    const market = await this.polymarket.findCurrentMarket(
      symbol,
      isLong ? 'above' : 'below'
    );
    if (!market) {
      logger.debug(`[Sniper] No active market found for ${symbol}`);
      return null;
    }

    const odds = await this.polymarket.getPolymarketOdds(market);
    if (!odds) return null;

    // Evaluate entry prices
    // Long: buy YES if YES price is still cheap (mispriced low)
    // Short: buy NO  if NO  price is still cheap (mispriced low)
    const MAX_ENTRY_PRICE = 0.82;

    let action: TradeAction;
    let polyPrice: number;

    if (isLong) {
      if (odds.yes >= MAX_ENTRY_PRICE) return null; // already priced in
      action = 'BUY_YES';
      polyPrice = odds.yes;
    } else {
      if (odds.no >= MAX_ENTRY_PRICE) return null;
      action = 'BUY_NO';
      polyPrice = odds.no;
    }

    const confidence = calculateConfidence(
      change,
      momentum,
      polyPrice,
      secondsRemaining,
      action
    );

    if (confidence < MIN_CONFIDENCE) {
      logger.debug(
        `[Sniper] ${symbol} confidence ${confidence} < ${MIN_CONFIDENCE} threshold — skip`
      );
      return null;
    }

    // Mark cooldown
    this.lastSignalTime.set(symbol, Date.now());

    return {
      symbol,
      action,
      confidence,
      binanceChange: change,
      momentum,
      polyYes: odds.yes,
      polyNo: odds.no,
      yesTokenId: odds.yesTokenId,
      noTokenId: odds.noTokenId,
      marketId: odds.marketId,
      question: odds.question,
      secondsRemaining,
      currentPrice: priceState.currentPrice,
    };
  }

  /**
   * Evaluate all configured symbols. Returns array of signals (usually 0 or 1).
   */
  async evaluateAll(): Promise<TradeSignal[]> {
    const signals: TradeSignal[] = [];
    for (const sym of SYMBOLS) {
      try {
        const signal = await this.evaluateTrade(sym);
        if (signal) signals.push(signal);
      } catch (err) {
        logger.error(`[Sniper] evaluateTrade error for ${sym}`, err);
      }
    }
    return signals;
  }

  /** Reset cooldown for a symbol (e.g. after position closes) */
  resetCooldown(symbol: string): void {
    this.lastSignalTime.delete(symbol);
  }
}
