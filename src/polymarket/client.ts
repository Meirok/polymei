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

// ─── PolymarketClient ─────────────────────────────────────────────────────────

export class PolymarketClient {
  private clobClient: ClobClient | null = null;
  private wallet: Wallet | null = null;
  private initialized = false;
  private tickSizeCache = new Map<string, string>();
  private negRiskCache = new Map<string, boolean>();
  // conditionId → market metadata cache (60s TTL)
  private marketCache = new Map<string, { data: GammaMarket; expiresAt: number }>();

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

  // ─── Market Discovery ──────────────────────────────────────────────────────

  /**
   * Find active 5-minute markets for a given symbol (BTC, ETH, SOL…).
   * Queries Gamma API, filters by question keywords and near-term expiry.
   */
  async getActiveCryptoMarkets(symbol: string): Promise<GammaMarket[]> {
    try {
      const now = Date.now();
      const fiveMin = 5 * 60 * 1000;
      // Look ahead 15 minutes
      const windowEnd = now + 15 * 60 * 1000;

      const params = new URLSearchParams({
        active: 'true',
        closed: 'false',
        order: 'endDateIso',
        ascending: 'true',
        limit: '50',
        tag_slug: 'crypto',
      });

      const url = `${GAMMA_API}/markets?${params}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Gamma API ${resp.status}: ${resp.statusText}`);
      const markets = await resp.json() as GammaMarket[];

      // Filter: must mention the symbol and expire within the next 15 minutes
      return markets.filter((m) => {
        if (!m.question) return false;
        const q = m.question.toUpperCase();
        if (!q.includes(symbol.toUpperCase())) return false;
        if (!m.endDateIso) return false;
        const expiry = new Date(m.endDateIso).getTime();
        return expiry > now && expiry < windowEnd;
      });
    } catch (err) {
      logger.error(`[PolymarketClient] getActiveCryptoMarkets error`, err);
      return [];
    }
  }

  /**
   * Find the single best market for a symbol expiring in the next 5-minute window.
   * Returns the market closest to the next 5-minute boundary.
   */
  async findCurrentMarket(
    symbol: string,
    type: 'above' | 'below' = 'above'
  ): Promise<GammaMarket | null> {
    const markets = await this.getActiveCryptoMarkets(symbol);
    if (markets.length === 0) return null;

    const now = Date.now();
    const keyword = type === 'above' ? 'ABOVE' : 'BELOW';

    // Prefer markets that contain the directional keyword
    const filtered = markets.filter((m) => {
      const q = m.question.toUpperCase();
      return q.includes(keyword) || q.includes('HIGHER') || q.includes('OVER');
    });

    const pool = filtered.length > 0 ? filtered : markets;

    // Return the one expiring soonest (but not in the past)
    return pool
      .filter((m) => new Date(m.endDateIso).getTime() > now)
      .sort(
        (a, b) =>
          new Date(a.endDateIso).getTime() - new Date(b.endDateIso).getTime()
      )[0] ?? null;
  }

  // ─── Order Book & Odds ─────────────────────────────────────────────────────

  /**
   * Get YES/NO odds for a market from the CLOB order book.
   * Falls back to Gamma token prices if CLOB unavailable.
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
