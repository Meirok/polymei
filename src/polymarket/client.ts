// Using native fetch from Node 18+
// Do NOT import fetch from 'node-fetch'

/**
 * src/polymarket/client.ts
 *
 * Polymarket CLOB integration.
 *
 * Responsibilities:
 *   - Authenticate via private key (L1 + L2)
 *   - Discover active 5-minute crypto price markets
 *   - Fetch order books (YES/NO prices)
 *   - Place / cancel limit + market orders
 *   - Track open positions
 *
 * Market naming convention on Polymarket:
 *   "Will BTC be above $X at HH:MM UTC?"
 *   We find the market expiring closest to the next 5-minute boundary.
 */

import {
  ClobClient,
  Side as ClobSide,
  OrderType as ClobOrderType,
  Chain,
} from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import {
  POLYMARKET_PRIVATE_KEY,
  CLOB_HOST,
  GAMMA_API,
  POLYGON_CHAIN_ID,
  DRY_RUN,
  SLIPPAGE_BUFFER,
} from '../../config.js';
import { logger } from '../utils/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PolymarketOdds {
  yes: number; // 0-1 probability
  no: number;  // 0-1 probability
  yesTokenId: string;
  noTokenId: string;
  marketId: string; // conditionId
  question: string;
}

export interface OrderBook {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  bestBid: number;
  bestAsk: number;
}

export interface PlaceOrderParams {
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  sizeUsd: number; // dollar amount to spend
  marketId: string;
  symbol: string;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  price: number;
  sizeShares: number;
  errorMsg?: string;
}

export interface Position {
  orderId: string;
  marketId: string;
  symbol: string;
  side: 'YES' | 'NO';
  tokenId: string;
  entryPrice: number;
  sizeShares: number;
  costUsd: number;
  placedAt: number;
  status: 'OPEN' | 'FILLED' | 'CANCELLED';
}

// Gamma API event shape (slug endpoint)
interface GammaSlugEvent {
  id: string;
  slug: string;
  title?: string;
  closed: boolean;
  markets: Array<{
    conditionId: string;
    clobTokenIds: string;   // JSON string: ["tokenId1", "tokenId2"]
    outcomePrices: string;  // JSON string: ["0.51", "0.49"]
    acceptingOrders: boolean;
    endDate: string;        // ISO string
    question?: string;
  }>;
}

// Legacy GammaMarket shape — used by findCurrentMarket() for backward compat
interface GammaMarket {
  id: string;
  conditionId: string;
  question: string;
  slug: string;
  active: boolean;
  closed: boolean;
  endDateIso: string;
  endDate?: string;
  tokens: Array<{
    token_id: string;
    outcome: string;
    price: number;
  }>;
}

/** Structured market object returned by timestamp-based discovery. */
export interface ActiveMarket {
  symbol: string;
  slug: string;
  timestamp: number;        // Unix seconds — market close time
  conditionId: string;
  yesTokenId: string;       // "Up" outcome token
  noTokenId: string;        // "Down" outcome token
  yesPrice: number;         // Up price (0-1)
  noPrice: number;          // Down price (0-1)
  question: string;
  acceptingOrders: boolean; // Only trade when true
  endDate: string;          // ISO string
}

// ─── Timestamp Helpers ────────────────────────────────────────────────────────

/**
 * Calculate the close timestamp of the currently open 5-minute market.
 *
 * Markets close at exact 5-minute marks in ET (UTC-4 / EDT).
 * ET midnight = 04:00 UTC → offset = 4 * 3600 seconds.
 * We round up in ET space then convert back to UTC unix seconds.
 */
export function getCurrentMarketCloseTimestamp(): number {
  const nowSec = Math.floor(Date.now() / 1000);
  const etOffset = 4 * 3600;         // EDT = UTC-4
  const etNow = nowSec - etOffset;   // shift to ET
  const nextBoundaryET = Math.ceil(etNow / 300) * 300;
  return nextBoundaryET + etOffset;  // shift back to UTC unix
}

/** Alias kept for backward compatibility (used by startAutoRefresh). */
export function getCurrentMarketTimestamp(): number {
  return getCurrentMarketCloseTimestamp();
}

/** Close timestamp of the market that opens after the current one. */
export function getNextMarketTimestamp(): number {
  return getCurrentMarketCloseTimestamp() + 300;
}

/** Log timestamp math to console so we can verify correctness on startup. */
export function logTimestampVerification(): void {
  const now = new Date();
  const ts = getCurrentMarketCloseTimestamp();
  console.log(`[TimestampCheck] Now UTC: ${now.toISOString()}`);
  console.log(`[TimestampCheck] Next market close timestamp: ${ts}`);
  console.log(`[TimestampCheck] Next market close UTC: ${new Date(ts * 1000).toISOString()}`);
  console.log(`[TimestampCheck] Slugs to try: btc-updown-5m-${ts}, btc-updown-5m-${ts + 300}`);
}

// ─── PolymarketClient ─────────────────────────────────────────────────────────

export class PolymarketClient {
  private clobClient: ClobClient | null = null;
  private wallet: Wallet | null = null;
  private initialized = false;
  private tickSizeCache = new Map<string, string>();
  private negRiskCache = new Map<string, boolean>();
  // conditionId → market metadata cache (60s TTL)
  private marketCache = new Map<string, { data: GammaMarket; expiresAt: number }>();

  // SYMBOL → ActiveMarket (invalidated when < 10s to close)
  private activeMarketsCache = new Map<string, ActiveMarket>();
  // Last 5-min boundary timestamp seen during auto-refresh
  private lastKnownTimestamp = 0;
  // Auto-refresh interval handle
  private refreshTimer: NodeJS.Timeout | null = null;
  // Optional callback for sending log messages to Telegram
  private logFn?: (msg: string) => void;

  /** Set a callback for sending diagnostic messages to Telegram */
  setLogFn(fn: (msg: string) => void): void {
    this.logFn = fn;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!POLYMARKET_PRIVATE_KEY) {
      if (DRY_RUN) {
        logger.warn('[PolymarketClient] No private key — running in DRY RUN mode only');
        this.initialized = true;
        return;
      }
      throw new Error('POLYMARKET_PRIVATE_KEY is required for live trading');
    }

    this.wallet = new Wallet(POLYMARKET_PRIVATE_KEY);
    logger.info(`[PolymarketClient] Wallet address: ${this.wallet.address}`);

    // L1 auth
    this.clobClient = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID as Chain, this.wallet);

    // Derive or create L2 API key
    const creds = await this.deriveOrCreateApiKey();

    // L2 auth
    this.clobClient = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID as Chain, this.wallet, {
      key: creds.key,
      secret: creds.secret,
      passphrase: creds.passphrase,
    });

    this.initialized = true;
    logger.info('[PolymarketClient] Initialized');
  }

  private async deriveOrCreateApiKey(): Promise<{ key: string; secret: string; passphrase: string }> {
    const derived = await this.clobClient!.deriveApiKey();
    if (derived?.key) return derived;
    const created = await this.clobClient!.createApiKey();
    if (!created?.key) throw new Error('Could not derive or create Polymarket API key');
    return created;
  }

  private ensureClient(): ClobClient {
    if (!this.clobClient) throw new Error('PolymarketClient not initialized');
    return this.clobClient;
  }

  // ─── Wallet / Balance ─────────────────────────────────────────────────────

  getWalletAddress(): string | null {
    return this.wallet?.address ?? null;
  }

  // ─── Market Discovery ──────────────────────────────────────────────────────

  /**
   * Discover the active 5-minute market for a symbol using timestamp-based
   * exact slug lookup against the Gamma API.
   *
   * Tries current window + next 3 windows + previous window as fallback.
   * Results are cached until < 10s before close.
   */
  async getActiveCryptoMarkets(symbol: string): Promise<ActiveMarket[]> {
    const sym = symbol.toUpperCase();

    // Return from cache if still valid (> 10s to close)
    const cached = this.activeMarketsCache.get(sym);
    if (cached) {
      const secs = this.getSecondsUntilClose(cached);
      if (secs >= 10) {
        return [cached];
      }
      logger.debug(`[PolymarketClient] ${sym}: cache near expiry (${secs}s), refreshing`);
    }

    try {
      const market = await this.findCurrentMarketBySlug(sym);
      if (market) {
        this.activeMarketsCache.set(sym, market);
        logger.info(
          `[PolymarketClient] ${sym}: found market ${market.slug} ` +
          `(closes in ${this.getSecondsUntilClose(market)}s, acceptingOrders=${market.acceptingOrders})`
        );
        return [market];
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[PolymarketClient] ${sym}: findCurrentMarketBySlug error — ${msg}`);
      this.logFn?.(`⚠️ [${sym}] Error buscando mercado: ${msg}`);
    }

    return [];
  }

  /**
   * Try candidate slugs derived from the current ET-aligned close timestamp.
   * Candidates: [-1, 0, +1, +2] windows (5-min intervals).
   *
   * Accepts a market if its endDate is not more than 60s in the past.
   */
  private async findCurrentMarketBySlug(sym: string): Promise<ActiveMarket | null> {
    const symLower = sym.toLowerCase();
    const nowSec = Math.floor(Date.now() / 1000);
    const etOffset = 4 * 3600;
    const etNow = nowSec - etOffset;
    const base = Math.ceil(etNow / 300) * 300 + etOffset;

    const candidates = [-1, 0, 1, 2].map((i) => base + i * 300);

    for (const ts of candidates) {
      const slug = `${symLower}-updown-5m-${ts}`;
      const url = `https://gamma-api.polymarket.com/events?slug=${slug}`;

      console.log(`[${sym}] Trying: ${url}`);

      try {
        const response = await fetch(url);
        const text = await response.text();

        console.log(`[${sym}] Status: ${response.status}`);
        console.log(`[${sym}] Raw response (200 chars): ${text.slice(0, 200)}`);

        if (!text || text === '[]' || text === 'null') {
          console.log(`[${sym}] Empty response, trying next...`);
          continue;
        }

        const data = JSON.parse(text);

        if (!Array.isArray(data) || data.length === 0) {
          console.log(`[${sym}] No array or empty array`);
          continue;
        }

        const event = data[0];
        console.log(`[${sym}] Event found: ${event.slug}, closed: ${event.closed}`);

        const market = event.markets?.[0];
        if (!market) {
          console.log(`[${sym}] No markets array in event`);
          continue;
        }

        console.log(`[${sym}] Market: acceptingOrders=${market.acceptingOrders}, endDate=${market.endDate}`);

        const clobTokenIds: string[] = JSON.parse(market.clobTokenIds || '[]');
        const outcomePrices: string[] = JSON.parse(market.outcomePrices || '["0.5","0.5"]');

        const endDate = new Date(market.endDate);
        const secondsUntilClose = Math.floor((endDate.getTime() - Date.now()) / 1000);

        console.log(`[${sym}] secondsUntilClose: ${secondsUntilClose}`);

        if (secondsUntilClose < -60) {
          console.log(`[${sym}] Market already closed, trying next...`);
          continue;
        }

        if (!clobTokenIds[0] || !clobTokenIds[1]) {
          console.log(`[${sym}] Missing token IDs: ${market.clobTokenIds}`);
          continue;
        }

        console.log(`[${sym}] ✅ Market found and valid!`);

        const yesPrice = parseFloat(outcomePrices[0]);
        const noPrice = parseFloat(outcomePrices[1]);
        const timestamp = Math.floor(endDate.getTime() / 1000);

        return {
          symbol: sym,
          slug,
          timestamp,
          conditionId: market.conditionId,
          yesTokenId: clobTokenIds[0],
          noTokenId: clobTokenIds[1],
          yesPrice: isNaN(yesPrice) ? 0.5 : yesPrice,
          noPrice: isNaN(noPrice) ? 0.5 : noPrice,
          question: market.question ?? event.title ?? slug,
          acceptingOrders: market.acceptingOrders === true,
          endDate: market.endDate,
        };
      } catch (e: any) {
        console.log(`[${sym}] Exception on ${slug}: ${e.message}`);
        console.log(e.stack);
      }
    }

    console.log(`[${sym}] ❌ All candidates failed`);
    logger.warn(`[PolymarketClient] ${sym}: no valid market found — tried timestamps: ${candidates.join(', ')}`);
    this.logFn?.(`❌ [${sym}] No encontrado — timestamps probados: ${candidates.join(', ')}`);
    return null;
  }

  /** Return candidate close timestamps for a diagnostic display (no network call). */
  getCandidateTimestamps(): number[] {
    const base = getCurrentMarketCloseTimestamp();
    return [0, 1, 2, 3, -1].map((i) => base + i * 300);
  }

  /**
   * Return the cached ActiveMarket for a symbol (O(1) — no network call).
   * Populate the cache first by calling getActiveCryptoMarkets() or startAutoRefresh().
   */
  getActiveMarket(symbol: string): ActiveMarket | null {
    return this.activeMarketsCache.get(symbol.toUpperCase()) ?? null;
  }

  /**
   * Compute the live seconds-until-close for a market (always fresh, not stale).
   */
  getSecondsUntilClose(market: ActiveMarket): number {
    return Math.max(0, market.timestamp - Math.floor(Date.now() / 1000));
  }

  /**
   * Start a background 30-second loop that detects new 5-minute windows and
   * refreshes all markets. Sends a Telegram notification when a new window opens.
   */
  startAutoRefresh(symbols: string[]): void {
    if (this.refreshTimer) return;

    // Seed the initial timestamp so the first tick doesn't fire a false "new window" alert
    this.lastKnownTimestamp = getCurrentMarketTimestamp();

    const doRefresh = async () => {
      const newTs = getCurrentMarketTimestamp();
      if (newTs === this.lastKnownTimestamp) return; // same window, nothing to do
      this.lastKnownTimestamp = newTs;

      logger.info(`[PolymarketClient] New 5-min window: ts=${newTs}`);

      const results = await Promise.all(
        symbols.map(async (sym) => {
          try {
            const markets = await this.getActiveCryptoMarkets(sym);
            const market = markets[0];
            if (market) {
              const secs = this.getSecondsUntilClose(market);
              const mins = Math.floor(secs / 60);
              const secPad = String(secs % 60).padStart(2, '0');
              return `- ${sym}: ${market.slug} | YES: ${market.yesPrice.toFixed(2)} | Cierra en: ${mins}m ${secPad}s`;
            }
            return `- ${sym}: ❌ No se pudo obtener mercado`;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `- ${sym}: ❌ Error — ${msg}`;
          }
        })
      );

      this.logFn?.(['🏪 Nuevo mercado abierto', ...results].join('\n'));
    };

    this.refreshTimer = setInterval(() => {
      doRefresh().catch((err) =>
        logger.error('[PolymarketClient] Auto-refresh error', err)
      );
    }, 30_000);

    logger.info('[PolymarketClient] Auto-refresh started (30s interval)');
  }

  /**
   * Find the single best market for a symbol.
   * Thin wrapper around getActiveCryptoMarkets() that returns a GammaMarket-shaped
   * object for backward compatibility.
   */
  async findCurrentMarket(
    symbol: string,
    _type: 'above' | 'below' = 'above'
  ): Promise<GammaMarket | null> {
    const markets = await this.getActiveCryptoMarkets(symbol);
    if (markets.length === 0) return null;
    const m = markets[0];
    return {
      id: m.conditionId,
      conditionId: m.conditionId,
      question: m.question,
      slug: m.slug,
      active: true,
      closed: false,
      endDateIso: new Date(m.timestamp * 1000).toISOString(),
      tokens: [
        { token_id: m.yesTokenId, outcome: 'Yes', price: m.yesPrice },
        { token_id: m.noTokenId,  outcome: 'No',  price: m.noPrice },
      ],
    };
  }

  // ─── Order Book & Odds ─────────────────────────────────────────────────────

  /**
   * Get YES/NO odds for a market from the CLOB order book.
   * Falls back to Gamma token prices if CLOB unavailable.
   * Logs a warning to Telegram if liquidity is too low.
   */
  async getPolymarketOdds(market: GammaMarket): Promise<PolymarketOdds | null> {
    try {
      const yesToken = market.tokens?.find((t) => t.outcome === 'Yes');
      const noToken = market.tokens?.find((t) => t.outcome === 'No');

      if (!yesToken || !noToken) return null;

      // Try to get live order book prices
      if (this.clobClient) {
        try {
          const [yesBook, noBook] = await Promise.all([
            this.clobClient.getOrderBook(yesToken.token_id),
            this.clobClient.getOrderBook(noToken.token_id),
          ]);

          const yesBestAsk = yesBook?.asks?.[0]?.price ?? yesToken.price;
          const noBestAsk = noBook?.asks?.[0]?.price ?? noToken.price;

          // Check liquidity: warn if order book is empty or very thin
          const yesAskSize = Number(yesBook?.asks?.[0]?.size ?? 0);
          const noAskSize = Number(noBook?.asks?.[0]?.size ?? 0);
          const MIN_LIQUIDITY_SHARES = 10; // minimum shares in best ask

          if (yesAskSize < MIN_LIQUIDITY_SHARES || noAskSize < MIN_LIQUIDITY_SHARES) {
            const lowSide = yesAskSize < MIN_LIQUIDITY_SHARES ? `YES (${yesAskSize} shares)` : `NO (${noAskSize} shares)`;
            logger.debug(
              `[PolymarketClient] Low liquidity on '${market.question}': ${lowSide}`
            );
            this.logFn?.(
              `🏪 Liquidez baja en '${market.question}'\n` +
              `- ${lowSide} en mejor ask\n` +
              `- Mínimo requerido: ${MIN_LIQUIDITY_SHARES} shares`
            );
          }

          return {
            yes: Number(yesBestAsk),
            no: Number(noBestAsk),
            yesTokenId: yesToken.token_id,
            noTokenId: noToken.token_id,
            marketId: market.conditionId,
            question: market.question,
          };
        } catch {
          // Fall through to Gamma prices
        }
      }

      // Use Gamma token prices as fallback
      return {
        yes: yesToken.price,
        no: noToken.price,
        yesTokenId: yesToken.token_id,
        noTokenId: noToken.token_id,
        marketId: market.conditionId,
        question: market.question,
      };
    } catch (err) {
      logger.error('[PolymarketClient] getPolymarketOdds error', err);
      return null;
    }
  }

  async getOrderBook(tokenId: string): Promise<OrderBook | null> {
    if (!this.clobClient) return null;
    try {
      const book = await this.clobClient.getOrderBook(tokenId);
      const bids = (book.bids ?? []).map((b) => ({
        price: Number(b.price),
        size: Number(b.size),
      }));
      const asks = (book.asks ?? []).map((a) => ({
        price: Number(a.price),
        size: Number(a.size),
      }));
      return {
        bids,
        asks,
        bestBid: bids[0]?.price ?? 0,
        bestAsk: asks[0]?.price ?? 0,
      };
    } catch {
      return null;
    }
  }

  // ─── Order Placement ────────────────────────────────────────────────────────

  /**
   * Place a limit order. In DRY_RUN mode, simulates the order.
   * sizeUsd is the dollar amount to spend; converted to shares via price.
   */
  async placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
    const { tokenId, side, price, sizeUsd, marketId } = params;

    // Convert dollar amount to shares
    const sizeShares = Math.floor(sizeUsd / price);
    // Minimum 5 shares, minimum $1 value
    const effectiveSize = Math.max(sizeShares, 5);
    const effectivePrice = Math.min(Math.max(price + SLIPPAGE_BUFFER, 0.01), 0.99);

    if (DRY_RUN) {
      const fakeId = `dry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      logger.info(
        `[DRY RUN] ${side} ${effectiveSize} shares @ ${effectivePrice} on ${marketId}`
      );
      return {
        success: true,
        orderId: fakeId,
        price: effectivePrice,
        sizeShares: effectiveSize,
      };
    }

    const client = this.ensureClient();

    try {
      const [tickSize, negRisk] = await Promise.all([
        this.getTickSize(tokenId),
        this.isNegRisk(tokenId),
      ]);

      const result = await client.createAndPostOrder(
        {
          tokenID: tokenId,
          side: side === 'BUY' ? ClobSide.BUY : ClobSide.SELL,
          price: effectivePrice,
          size: effectiveSize,
          expiration: 0,
        },
        { tickSize: tickSize as any, negRisk },
        ClobOrderType.GTC
      );

      const success =
        result.success === true ||
        (result.orderID !== undefined && result.orderID !== '');

      if (!success) {
        const errMsg = result.errorMsg ?? 'unknown error';
        this.logFn?.(
          `⚠️ ERROR: polymarket\n` +
          `- Módulo: polymarket\n` +
          `- Detalle: Order rejected — ${errMsg}\n` +
          `- Acción: skipping trade`
        );
      }

      return {
        success,
        orderId: result.orderID,
        price: effectivePrice,
        sizeShares: effectiveSize,
        errorMsg: success ? undefined : result.errorMsg,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[PolymarketClient] placeOrder error', { msg });
      this.logFn?.(
        `⚠️ ERROR: polymarket\n` +
        `- Módulo: polymarket\n` +
        `- Detalle: placeOrder failed — ${msg}\n` +
        `- Acción: skipping trade`
      );
      return { success: false, price: effectivePrice, sizeShares: effectiveSize, errorMsg: msg };
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    if (DRY_RUN) return true;
    const client = this.ensureClient();
    try {
      const result = await client.cancelOrder({ orderID: orderId });
      return result.canceled ?? false;
    } catch {
      return false;
    }
  }

  async getOpenOrders(): Promise<any[]> {
    if (!this.clobClient) return [];
    try {
      return await this.clobClient.getOpenOrders();
    } catch {
      return [];
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async getTickSize(tokenId: string): Promise<string> {
    if (this.tickSizeCache.has(tokenId)) return this.tickSizeCache.get(tokenId)!;
    const ts = await this.clobClient!.getTickSize(tokenId);
    this.tickSizeCache.set(tokenId, ts);
    return ts;
  }

  private async isNegRisk(tokenId: string): Promise<boolean> {
    if (this.negRiskCache.has(tokenId)) return this.negRiskCache.get(tokenId)!;
    const nr = await this.clobClient!.getNegRisk(tokenId);
    this.negRiskCache.set(tokenId, nr);
    return nr;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}
