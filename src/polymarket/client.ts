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
import { Wallet, ethers } from 'ethers';
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

// Gamma API market shape (minimal fields we need)
interface GammaMarket {
  id: string;
  conditionId: string;
  question: string;
  slug: string;
  active: boolean;
  closed: boolean;
  endDateIso: string;
  tokens: Array<{
    token_id: string;
    outcome: string;
    price: number;
  }>;
}

// Gamma API event shape (wraps markets, returned by /events?slug=)
interface GammaEvent {
  id: string;
  slug: string;
  title?: string;
  markets: GammaMarket[];
}

/** Structured market object returned by timestamp-based discovery. */
export interface ActiveMarket {
  symbol: string;
  slug: string;
  timestamp: number;   // Unix seconds — market close time
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  yesPrice: number;
  noPrice: number;
  question: string;
}

// ─── Timestamp Helpers ────────────────────────────────────────────────────────

/** Round up current time to next 5-minute boundary (the closing timestamp of
 *  the market that is currently open). */
export function getCurrentMarketTimestamp(): number {
  const now = Math.floor(Date.now() / 1000);
  return Math.ceil(now / 300) * 300;
}

/** Close timestamp of the market that opens after the current one. */
export function getNextMarketTimestamp(): number {
  return getCurrentMarketTimestamp() + 300;
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

  // Timestamp-based market cache: SYMBOL → ActiveMarket
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

  async getUsdcBalance(): Promise<number> {
    if (!this.wallet) return -1;
    try {
      // USDC on Polygon Mainnet (native USDC)
      const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
      const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
      const usdc = new ethers.Contract(
        USDC_POLYGON,
        ['function balanceOf(address owner) view returns (uint256)'],
        provider
      );
      const raw: ethers.BigNumber = await usdc.balanceOf(this.wallet.address);
      return parseFloat(ethers.utils.formatUnits(raw, 6));
    } catch {
      // Try USDC.e (bridged) as fallback
      try {
        const USDCE_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
        const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
        const usdc = new ethers.Contract(
          USDCE_POLYGON,
          ['function balanceOf(address owner) view returns (uint256)'],
          provider
        );
        const raw: ethers.BigNumber = await usdc.balanceOf(this.wallet.address);
        return parseFloat(ethers.utils.formatUnits(raw, 6));
      } catch {
        return -1;
      }
    }
  }

  // ─── Market Discovery ──────────────────────────────────────────────────────

  /**
   * Fetch a single market from Gamma /events?slug= using the known slug pattern.
   */
  private async fetchMarketBySlug(
    symbol: string,
    slug: string,
    timestamp: number
  ): Promise<ActiveMarket | null> {
    const url = `${GAMMA_API}/events?slug=${encodeURIComponent(slug)}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      logger.debug(`[PolymarketClient] ${symbol}: /events?slug=${slug} → HTTP ${resp.status}`);
      return null;
    }

    const raw = await resp.json();
    const events: GammaEvent[] = Array.isArray(raw) ? raw : [raw as GammaEvent];
    const event = events[0];

    if (!event?.markets?.length) {
      logger.debug(`[PolymarketClient] ${symbol}: no markets in event for slug ${slug}`);
      return null;
    }

    const market = event.markets[0];
    const yesToken = market.tokens?.find((t) => t.outcome.toLowerCase() === 'yes');
    const noToken  = market.tokens?.find((t) => t.outcome.toLowerCase() === 'no');

    if (!yesToken || !noToken) {
      logger.debug(`[PolymarketClient] ${symbol}: YES/NO tokens not found for slug ${slug}`);
      return null;
    }

    return {
      symbol,
      slug,
      timestamp,
      conditionId: market.conditionId,
      yesTokenId: yesToken.token_id,
      noTokenId: noToken.token_id,
      yesPrice: Number(yesToken.price),
      noPrice: Number(noToken.price),
      question: market.question ?? slug,
    };
  }

  /**
   * Discover the active 5-minute market for a symbol using the timestamp-based
   * slug: {symbol}-updown-5m-{unix_timestamp}
   *
   * Tries the current 5-min boundary first, then the next one.
   * Updates the internal cache; use getActiveMarket() for fast cache reads.
   */
  async getActiveCryptoMarkets(symbol: string): Promise<ActiveMarket[]> {
    const sym = symbol.toUpperCase();
    const symLower = sym.toLowerCase();
    const timestamps = [getCurrentMarketTimestamp(), getNextMarketTimestamp()];

    for (const ts of timestamps) {
      const slug = `${symLower}-updown-5m-${ts}`;
      try {
        const market = await this.fetchMarketBySlug(sym, slug, ts);
        if (market) {
          this.activeMarketsCache.set(sym, market);
          logger.debug(`[PolymarketClient] ${sym}: cached market ${slug}`);
          return [market];
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.debug(`[PolymarketClient] ${sym}: error fetching ${slug} — ${msg}`);
        this.logFn?.(`⚠️ [${sym}] Error al obtener ${slug}: ${msg}`);
      }
    }

    this.logFn?.(
      `❌ No se pudo obtener mercado para ${sym}\n` +
      `- Slugs probados: ${timestamps.map((ts) => `${symLower}-updown-5m-${ts}`).join(', ')}`
    );
    return [];
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
