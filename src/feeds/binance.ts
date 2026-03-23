/**
 * src/feeds/binance.ts
 *
 * Binance WebSocket real-time price feed.
 *
 * Connects to combined stream for 1m klines across all configured symbols.
 * Tracks:
 *   - Current price (latest tick)
 *   - Candle open price (start of current 1m candle)
 *   - % change from candle open
 *   - Momentum: rate of change acceleration over last ~10s ticks
 *
 * Auto-reconnects with exponential backoff on disconnect.
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { BINANCE_WS_URL, SYMBOLS } from '../../config.js';
import { logger } from '../utils/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PriceState {
  symbol: string;
  currentPrice: number;
  candleOpen: number;
  candleHigh: number;
  candleLow: number;
  changePercent: number; // % from candle open
  momentum: number;      // acceleration (positive = accelerating up)
  volume: number;
  lastUpdated: number;
}

interface BinanceKlineEvent {
  e: string; // event type
  E: number; // event time
  s: string; // symbol
  k: {
    t: number;  // kline start time
    T: number;  // kline close time
    s: string;  // symbol
    i: string;  // interval
    o: string;  // open price
    c: string;  // close price
    h: string;  // high price
    l: string;  // low price
    v: string;  // base asset volume
    x: boolean; // is this kline closed?
  };
}

// ─── BinanceFeed ─────────────────────────────────────────────────────────────

export class BinanceFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private priceStates: Map<string, PriceState> = new Map();
  // Rolling price history per symbol for momentum calculation (last 20 ticks)
  private priceHistory: Map<string, number[]> = new Map();
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30_000;
  private stopped = false;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(private symbols: string[] = SYMBOLS) {
    super();
    // Initialize state for each symbol
    for (const sym of symbols) {
      this.priceStates.set(sym, {
        symbol: sym,
        currentPrice: 0,
        candleOpen: 0,
        candleHigh: 0,
        candleLow: 0,
        changePercent: 0,
        momentum: 0,
        volume: 0,
        lastUpdated: 0,
      });
      this.priceHistory.set(sym, []);
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /** Current live price for a symbol (e.g. "BTC") */
  getCurrentPrice(symbol: string): number {
    return this.priceStates.get(symbol)?.currentPrice ?? 0;
  }

  /** % change from current 1m candle open */
  getCandleChange(symbol: string): number {
    return this.priceStates.get(symbol)?.changePercent ?? 0;
  }

  /**
   * Momentum score — positive means price accelerating upward, negative downward.
   * Calculated as the slope of the last 10 price ticks vs the previous 10.
   */
  getMomentum(symbol: string): number {
    return this.priceStates.get(symbol)?.momentum ?? 0;
  }

  getState(symbol: string): PriceState | undefined {
    return this.priceStates.get(symbol);
  }

  getAllStates(): Map<string, PriceState> {
    return this.priceStates;
  }

  // ─── Connection ────────────────────────────────────────────────────────────

  connect(): void {
    const streams = this.symbols
      .map((s) => `${s.toLowerCase()}usdt@kline_1m`)
      .join('/');

    const url = `${BINANCE_WS_URL}?streams=${streams}`;
    logger.info(`[BinanceFeed] Connecting to ${url}`);

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      logger.info('[BinanceFeed] WebSocket connected');
      this.reconnectDelay = 1000; // reset backoff
      this.emit('connected');
      this.startPing();
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as { stream: string; data: BinanceKlineEvent };
        this.handleKlineMessage(msg.data);
      } catch (err) {
        logger.warn('[BinanceFeed] Failed to parse message', err);
      }
    });

    this.ws.on('error', (err) => {
      logger.error('[BinanceFeed] WebSocket error', err);
      this.emit('error', err);
    });

    this.ws.on('close', (code, reason) => {
      logger.warn(`[BinanceFeed] Disconnected (code=${code}, reason=${reason})`);
      this.stopPing();
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('pong', () => {
      // Connection alive
    });
  }

  disconnect(): void {
    this.stopped = true;
    this.stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private handleKlineMessage(event: BinanceKlineEvent): void {
    const rawSymbol = event.s; // e.g. "BTCUSDT"
    const symbol = rawSymbol.replace('USDT', '');

    if (!this.priceStates.has(symbol)) return;

    const k = event.k;
    const currentPrice = parseFloat(k.c);
    const candleOpen = parseFloat(k.o);
    const changePercent = candleOpen > 0
      ? ((currentPrice - candleOpen) / candleOpen) * 100
      : 0;

    // Update rolling price history
    const history = this.priceHistory.get(symbol)!;
    history.push(currentPrice);
    if (history.length > 20) history.shift();

    // Calculate momentum: diff of avg(last 10) vs avg(prev 10)
    const momentum = this.calcMomentum(history);

    const state: PriceState = {
      symbol,
      currentPrice,
      candleOpen,
      candleHigh: parseFloat(k.h),
      candleLow: parseFloat(k.l),
      changePercent,
      momentum,
      volume: parseFloat(k.v),
      lastUpdated: event.E,
    };

    this.priceStates.set(symbol, state);
    this.emit('update', state);
  }

  private calcMomentum(history: number[]): number {
    if (history.length < 4) return 0;

    const mid = Math.floor(history.length / 2);
    const recent = history.slice(mid);
    const older = history.slice(0, mid);

    const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
    const avgOlder = older.reduce((a, b) => a + b, 0) / older.length;

    // Return % acceleration (positive = price speeding up upward)
    return avgOlder > 0 ? ((avgRecent - avgOlder) / avgOlder) * 100 : 0;
  }

  private scheduleReconnect(): void {
    const delay = this.reconnectDelay;
    logger.info(`[BinanceFeed] Reconnecting in ${delay}ms...`);
    setTimeout(() => {
      if (!this.stopped) {
        this.connect();
      }
    }, delay);
    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 20_000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
