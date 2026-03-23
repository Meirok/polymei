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
import type { PolymarketClient, Market } from '../polymarket/client.js';
import {
  SNIPE_WINDOW_START,
  SNIPE_WINDOW_END,
  MIN_PRICE_CHANGE_PCT,
  MIN_CONFIDENCE,
  SYMBOLS,
  DEBUG_MODE,
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

  // Debug loop: track when we last sent a 30s status message per symbol
  private lastDebugLog: Map<string, number> = new Map();
  private readonly DEBUG_LOG_INTERVAL_MS = 30_000;

  // Cache the last known market found per symbol (for debug logging + bot.ts tracking)
  private lastKnownMarket: Map<string, Market | null> = new Map();

  // Skip reason tracking per symbol per window
  private skipReason: Map<string, string> = new Map();
  private maxChange: Map<string, number> = new Map();
  private maxSecondsReached: Map<string, number> = new Map();

  // Optional callback for sending log messages to Telegram
  private logFn?: (msg: string) => void;

  constructor(
    private binance: BinanceFeed,
    private polymarket: PolymarketClient
  ) {}

  /** Return the last market found for a symbol (used by bot.ts for market window tracking) */
  getLastKnownMarket(symbol: string): { question: string; expiryMs: number } | null {
    const m = this.lastKnownMarket.get(symbol) ?? null;
    if (!m) return null;
    return { question: m.slug, expiryMs: new Date(m.endDate).getTime() };
  }

  /** Set a callback for sending diagnostic messages to Telegram */
  setLogFn(fn: (msg: string) => void): void {
    this.logFn = fn;
  }

  /**
   * Evaluate a single symbol for a trade signal.
   * Returns a TradeSignal if conditions are met, null otherwise.
   */
  async evaluateTrade(symbol: string): Promise<TradeSignal | null> {
    // ── 1. Get current market from cache (O(1) — no network call) ────────────
    const market = this.polymarket.getActiveMarket(symbol);
    const secondsRemaining = market
      ? this.polymarket.getSecondsUntilClose(market)
      : secondsUntilNext5MinBoundary(); // fallback for debug when cache is empty

    // ── Always log current state to console ───────────────────────────────────
    const priceStateEarly = this.binance.getState(symbol);
    const changeEarly = priceStateEarly?.changePercent ?? 0;
    const momentumEarly = priceStateEarly?.momentum ?? 0;
    const priceEarly = priceStateEarly?.currentPrice ?? 0;

    logger.debug(
      `[Sniper:${symbol}] ` +
      `segs=${secondsRemaining.toFixed(1)}s | ` +
      `cambio=${changeEarly >= 0 ? '+' : ''}${changeEarly.toFixed(3)}% | ` +
      `momentum=${momentumEarly >= 0 ? '+' : ''}${momentumEarly.toFixed(4)} | ` +
      `precio=$${priceEarly.toLocaleString('en-US')}`
    );

    // ── DEBUG MODE: send 30s loop status to Telegram ─────────────────────────
    if (DEBUG_MODE && this.logFn) {
      const lastLog = this.lastDebugLog.get(symbol) ?? 0;
      if (Date.now() - lastLog >= this.DEBUG_LOG_INTERVAL_MS) {
        this.lastDebugLog.set(symbol, Date.now());
        const inWindow = secondsRemaining <= SNIPE_WINDOW_START && secondsRemaining >= SNIPE_WINDOW_END;
        const moveOk = Math.abs(changeEarly) >= MIN_PRICE_CHANGE_PCT;
        const direction = changeEarly > 0 ? 'BUY_YES' : 'BUY_NO';
        const approxConf = moveOk
          ? calculateConfidence(changeEarly, momentumEarly, 0.7, secondsRemaining, direction)
          : 0;
        const confOk = approxConf >= MIN_CONFIDENCE;

        this.logFn(
          `🔄 Loop activo [${symbol}]\n` +
          `- ${symbol}: $${priceEarly > 0 ? priceEarly.toLocaleString('en-US') : 'N/A'} | ` +
          `cambio vela: ${changeEarly >= 0 ? '+' : ''}${changeEarly.toFixed(2)}% | ` +
          `segundos restantes: ${secondsRemaining.toFixed(0)}s\n` +
          `- Mercado: ${market ? `✅ ${market.slug}` : '❌ sin caché'}\n` +
          `- Condición tiempo: ${inWindow ? '✅' : '❌'} (necesita <${SNIPE_WINDOW_START}s, actual: ${secondsRemaining.toFixed(0)}s)\n` +
          `- Condición movimiento: ${moveOk ? '✅' : '❌'} (necesita >${MIN_PRICE_CHANGE_PCT}%, actual: ${changeEarly >= 0 ? '+' : ''}${changeEarly.toFixed(2)}%)\n` +
          `- Condición confianza: ${confOk ? `✅ (aprox ${approxConf})` : `❌ (aprox ${approxConf} < ${MIN_CONFIDENCE})`}`
        );
      }
    }

    // ── Market check ─────────────────────────────────────────────────────────
    if (!market) {
      logger.debug(`[Sniper:${symbol}] SKIP — sin mercado en caché (esperando auto-refresh)`);
      this.skipReason.set(symbol, 'mercado no encontrado en Polymarket');
      return null;
    }

    // ── acceptingOrders check ─────────────────────────────────────────────────
    if (!market.acceptingOrders) {
      logger.debug(`[Sniper:${symbol}] SKIP — mercado no acepta órdenes`);
      this.skipReason.set(symbol, 'mercado no aceptaba órdenes');
      return null;
    }

    // Update last known market for bot.ts market window tracking
    this.lastKnownMarket.set(symbol, market);

    // ── 2. Time window check ─────────────────────────────────────────────────
    const prevMaxSecs = this.maxSecondsReached.get(symbol) ?? 999;
    if (secondsRemaining < prevMaxSecs) {
      this.maxSecondsReached.set(symbol, secondsRemaining);
    }

    if (secondsRemaining > SNIPE_WINDOW_START || secondsRemaining < SNIPE_WINDOW_END) {
      logger.debug(
        `[Sniper:${symbol}] SKIP — fuera de ventana ` +
        `(${secondsRemaining.toFixed(1)}s, ventana: ${SNIPE_WINDOW_END}s–${SNIPE_WINDOW_START}s)`
      );
      const maxChange = this.maxChange.get(symbol) ?? 0;
      this.skipReason.set(
        symbol,
        `movimiento insuficiente (max: +${maxChange.toFixed(2)}%, necesita >${MIN_PRICE_CHANGE_PCT}%)`
      );
      return null;
    }

    // ── 3. Cooldown check ────────────────────────────────────────────────────
    const lastSignal = this.lastSignalTime.get(symbol) ?? 0;
    const msSinceLast = Date.now() - lastSignal;
    if (msSinceLast < this.SIGNAL_COOLDOWN_MS) {
      logger.debug(
        `[Sniper:${symbol}] SKIP — cooldown activo ` +
        `(${((this.SIGNAL_COOLDOWN_MS - msSinceLast) / 1000).toFixed(0)}s restantes)`
      );
      return null;
    }

    // ── 4. Price state check ─────────────────────────────────────────────────
    const priceState = this.binance.getState(symbol);
    if (!priceState || priceState.currentPrice === 0) {
      logger.debug(`[Sniper:${symbol}] SKIP — sin datos de precio Binance`);
      return null;
    }

    const change = priceState.changePercent;
    const momentum = priceState.momentum;

    // Track max absolute change seen
    const prevMaxChange = this.maxChange.get(symbol) ?? 0;
    if (Math.abs(change) > prevMaxChange) {
      this.maxChange.set(symbol, Math.abs(change));
    }

    // ── 5. Direction check ───────────────────────────────────────────────────
    const isLong  = change > MIN_PRICE_CHANGE_PCT;
    const isShort = change < -MIN_PRICE_CHANGE_PCT;

    if (!isLong && !isShort) {
      logger.debug(
        `[Sniper:${symbol}] SKIP — sin dirección clara ` +
        `(cambio=${change >= 0 ? '+' : ''}${change.toFixed(3)}% vs umbral ±${MIN_PRICE_CHANGE_PCT}%, ` +
        `momentum=${momentum >= 0 ? '+' : ''}${momentum.toFixed(4)})`
      );
      const maxChange = this.maxChange.get(symbol) ?? 0;
      this.skipReason.set(
        symbol,
        `movimiento insuficiente (max: ${maxChange >= 0 ? '+' : ''}${maxChange.toFixed(2)}%, necesita >${MIN_PRICE_CHANGE_PCT}%)`
      );
      return null;
    }

    logger.debug(
      `[Sniper:${symbol}] Evaluando señal ${isLong ? 'LONG (YES)' : 'SHORT (NO)'} ` +
      `| cambio=${change >= 0 ? '+' : ''}${change.toFixed(3)}% ` +
      `| ${secondsRemaining.toFixed(1)}s restantes`
    );

    this.logFn?.(
      `🏪 [${symbol}] Mercado: ${market.slug}\n` +
      `- UP: ${market.upPrice.toFixed(3)} | DOWN: ${market.downPrice.toFixed(3)}\n` +
      `- Vence en: ${secondsRemaining.toFixed(0)}s`
    );

    // ── 6. Entry price check ─────────────────────────────────────────────────
    const MAX_ENTRY_PRICE = 0.82;
    let action: TradeAction;
    let polyPrice: number;

    if (isLong) {
      if (market.upPrice >= MAX_ENTRY_PRICE) {
        logger.debug(
          `[Sniper:${symbol}] SKIP — UP ya priceado en ${market.upPrice.toFixed(3)} ≥ ${MAX_ENTRY_PRICE}`
        );
        this.logFn?.(
          `🔍 [${symbol}] Señal evaluada\n` +
          `- Cambio vela: ${change >= 0 ? '+' : ''}${change.toFixed(3)}%\n` +
          `- Segundos restantes: ${secondsRemaining.toFixed(0)}s\n` +
          `- Odds UP: ${market.upPrice.toFixed(3)}\n` +
          `- Resultado: ❌ Rechazada (UP ya priceado ≥ ${MAX_ENTRY_PRICE})`
        );
        this.skipReason.set(symbol, `mercado ya priceado correctamente (odds ≥ ${MAX_ENTRY_PRICE})`);
        return null;
      }
      action = 'BUY_YES';
      polyPrice = market.upPrice;
    } else {
      if (market.downPrice >= MAX_ENTRY_PRICE) {
        logger.debug(
          `[Sniper:${symbol}] SKIP — DOWN ya priceado en ${market.downPrice.toFixed(3)} ≥ ${MAX_ENTRY_PRICE}`
        );
        this.logFn?.(
          `🔍 [${symbol}] Señal evaluada\n` +
          `- Cambio vela: ${change >= 0 ? '+' : ''}${change.toFixed(3)}%\n` +
          `- Segundos restantes: ${secondsRemaining.toFixed(0)}s\n` +
          `- Odds DOWN: ${market.downPrice.toFixed(3)}\n` +
          `- Resultado: ❌ Rechazada (DOWN ya priceado ≥ ${MAX_ENTRY_PRICE})`
        );
        this.skipReason.set(symbol, `mercado ya priceado correctamente (odds ≥ ${MAX_ENTRY_PRICE})`);
        return null;
      }
      action = 'BUY_NO';
      polyPrice = market.downPrice;
    }

    // ── 7. Confidence scoring ─────────────────────────────────────────────────
    const confidence = calculateConfidence(
      change,
      momentum,
      polyPrice,
      secondsRemaining,
      action
    );

    logger.debug(
      `[Sniper:${symbol}] Confianza: ${confidence}/100 ` +
      `(umbral: ${MIN_CONFIDENCE}) | acción: ${action}`
    );

    if (confidence < MIN_CONFIDENCE) {
      logger.debug(`[Sniper:${symbol}] SKIP — confianza ${confidence} < ${MIN_CONFIDENCE}`);
      this.logFn?.(
        `🔍 [${symbol}] Señal evaluada\n` +
        `- Cambio vela: ${change >= 0 ? '+' : ''}${change.toFixed(3)}%\n` +
        `- Segundos restantes: ${secondsRemaining.toFixed(0)}s\n` +
        `- Odds ${action === 'BUY_YES' ? 'YES' : 'NO'}: ${polyPrice.toFixed(3)}\n` +
        `- Confianza: ${confidence}/100\n` +
        `- Resultado: ❌ Rechazada (confianza < mínimo ${MIN_CONFIDENCE})`
      );
      this.skipReason.set(symbol, `confianza baja (max: ${confidence}/100, necesita >${MIN_CONFIDENCE})`);
      return null;
    }

    // ── 8. Signal accepted ────────────────────────────────────────────────────
    this.logFn?.(
      `🔍 [${symbol}] Señal evaluada\n` +
      `- Cambio vela: ${change >= 0 ? '+' : ''}${change.toFixed(3)}%\n` +
      `- Segundos restantes: ${secondsRemaining.toFixed(0)}s\n` +
      `- Odds ${action === 'BUY_YES' ? 'YES' : 'NO'}: ${polyPrice.toFixed(3)}\n` +
      `- Confianza: ${confidence}/100\n` +
      `- Resultado: ✅ Aceptada`
    );

    this.lastSignalTime.set(symbol, Date.now());

    return {
      symbol,
      action,
      confidence,
      binanceChange: change,
      momentum,
      polyYes: market.upPrice,
      polyNo: market.downPrice,
      yesTokenId: market.upTokenId,
      noTokenId: market.downTokenId,
      marketId: market.conditionId,
      question: market.slug,
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

  /** Get the skip reason for a symbol from the current window */
  getSkipReason(symbol: string): string {
    return this.skipReason.get(symbol) ?? 'sin señal en toda la ventana';
  }

  /** Reset per-window tracking for a symbol when a new market window opens */
  resetWindow(symbol: string): void {
    this.skipReason.delete(symbol);
    this.maxChange.delete(symbol);
    this.maxSecondsReached.delete(symbol);
  }
}
