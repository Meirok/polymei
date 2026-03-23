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

// ─── PolymarketClient ─────────────────────────────────────────────────────────

export class PolymarketClient {
  private clobClient: ClobClient | null = null;
  private wallet: Wallet | null = null;
  private initialized = false;
  private tickSizeCache = new Map<string, string>();
  private negRiskCache = new Map<string, boolean>();
  // conditionId → market metadata cache (60s TTL)
  private marketCache = new Map<string, { data: GammaMarket; expiresAt: number }>();

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
   * Find active 5-minute markets for a given symbol (BTC, ETH, SOL…).
   *
   * Tries three approaches in order:
   *   1. Gamma API with tag_slug=crypto, filter by symbol + 10-min expiry window
   *   2. Gamma API without tag filter (broader search)
   *   3. Direct CLOB API /markets endpoint as last resort
   *
   * Each step is logged to Telegram so we can see exactly where discovery fails.
   */
  async getActiveCryptoMarkets(symbol: string): Promise<GammaMarket[]> {
    const now = Date.now();
    const windowEnd = now + 10 * 60 * 1000; // 10-minute look-ahead
    const sym = symbol.toUpperCase();

    const filterMarkets = (all: GammaMarket[]): {
      bySymbol: GammaMarket[];
      byExpiry: GammaMarket[];
    } => {
      const bySymbol = all.filter((m) => m.question?.toUpperCase().includes(sym));
      const byExpiry = bySymbol.filter((m) => {
        if (!m.endDateIso) return false;
        const exp = new Date(m.endDateIso).getTime();
        return exp > now && exp <= windowEnd;
      });
      return { bySymbol, byExpiry };
    };

    const queryGamma = async (extraParams: Record<string, string>): Promise<GammaMarket[]> => {
      const params = new URLSearchParams({
        active: 'true',
        closed: 'false',
        order: 'endDateIso',
        ascending: 'true',
        limit: '100',
        ...extraParams,
      });
      const resp = await fetch(`${GAMMA_API}/markets?${params}`);
      if (!resp.ok) throw new Error(`Gamma ${resp.status}: ${resp.statusText}`);
      return (await resp.json()) as GammaMarket[];
    };

    // ── Attempt 1: Gamma with crypto tag ────────────────────────────────────
    try {
      const all = await queryGamma({ tag_slug: 'crypto' });
      const { bySymbol, byExpiry } = filterMarkets(all);

      this.logFn?.(
        `🔍 [${sym}] Gamma (tag=crypto): total=${all.length} | ` +
        `con '${sym}'=${bySymbol.length} | expiran <10min=${byExpiry.length}` +
        (byExpiry[0] ? `\n- Mejor: "${byExpiry[0].question}"` : '')
      );

      if (byExpiry.length > 0) return byExpiry;

      // If tag search found symbol matches but none in window, don't try broader search
      if (bySymbol.length > 0) {
        this.logFn?.(
          `⚠️ [${sym}] ${bySymbol.length} mercados encontrados pero ninguno cierra en <10min\n` +
          `- Próximo cierre: ${bySymbol[0]?.endDateIso ?? 'desconocido'}`
        );
      }
    } catch (err) {
      this.logFn?.(`⚠️ [${sym}] Gamma (tag=crypto) falló: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Attempt 2: Gamma without tag (broader) ───────────────────────────────
    try {
      const all = await queryGamma({});
      const { bySymbol, byExpiry } = filterMarkets(all);

      this.logFn?.(
        `🔍 [${sym}] Gamma (sin tag): total=${all.length} | ` +
        `con '${sym}'=${bySymbol.length} | expiran <10min=${byExpiry.length}` +
        (byExpiry[0] ? `\n- Mejor: "${byExpiry[0].question}"` : '')
      );

      if (byExpiry.length > 0) return byExpiry;
    } catch (err) {
      this.logFn?.(`⚠️ [${sym}] Gamma (sin tag) falló: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Attempt 3: Direct CLOB API ───────────────────────────────────────────
    try {
      const resp = await fetch(`${CLOB_HOST}/markets?active=true&closed=false`);
      if (resp.ok) {
        const data = await resp.json() as any;
        const raw: any[] = Array.isArray(data) ? data : (data?.data ?? data?.markets ?? []);

        // Normalize CLOB market shape to GammaMarket
        const normalized: GammaMarket[] = raw.map((m: any) => ({
          id: m.id ?? m.condition_id ?? '',
          conditionId: m.condition_id ?? m.conditionId ?? m.id ?? '',
          question: m.question ?? '',
          slug: m.slug ?? '',
          active: true,
          closed: false,
          endDateIso: m.end_date_iso ?? m.endDateIso ?? m.expiration ?? '',
          tokens: m.tokens ?? [],
        }));

        const { bySymbol, byExpiry } = filterMarkets(normalized);

        this.logFn?.(
          `🔍 [${sym}] CLOB directo: total=${raw.length} | ` +
          `con '${sym}'=${bySymbol.length} | expiran <10min=${byExpiry.length}` +
          (byExpiry[0] ? `\n- Mejor: "${byExpiry[0].question}"` : '')
        );

        if (byExpiry.length > 0) return byExpiry;
      } else {
        this.logFn?.(`⚠️ [${sym}] CLOB directo: ${resp.status} ${resp.statusText}`);
      }
    } catch (err) {
      this.logFn?.(`⚠️ [${sym}] CLOB directo falló: ${err instanceof Error ? err.message : String(err)}`);
    }

    return [];
  }

  /**
   * Find the single best market for a symbol expiring in the next 5-minute window.
   * Returns the market closest to the next 5-minute boundary.
   * Logs to Telegram when market is found or not found.
   */
  async findCurrentMarket(
    symbol: string,
    type: 'above' | 'below' = 'above'
  ): Promise<GammaMarket | null> {
    const markets = await this.getActiveCryptoMarkets(symbol);

    if (markets.length === 0) {
      const msg =
        `🏪 [${symbol}] Sin mercado activo en los próximos 5 min — saltando\n` +
        `- Dirección buscada: ${type}\n` +
        `- Gamma API devolvió 0 mercados para el símbolo`;
      logger.debug(`[PolymarketClient] ${symbol}: no markets found on Gamma`);
      this.logFn?.(msg);
      return null;
    }

    const now = Date.now();
    const keyword = type === 'above' ? 'ABOVE' : 'BELOW';

    // Prefer markets that contain the directional keyword
    const filtered = markets.filter((m) => {
      const q = m.question.toUpperCase();
      return q.includes(keyword) || q.includes('HIGHER') || q.includes('OVER');
    });

    const pool = filtered.length > 0 ? filtered : markets;

    const market = pool
      .filter((m) => new Date(m.endDateIso).getTime() > now)
      .sort(
        (a, b) =>
          new Date(a.endDateIso).getTime() - new Date(b.endDateIso).getTime()
      )[0] ?? null;

    if (!market) {
      const msg =
        `🏪 [${symbol}] Sin mercado activo en los próximos 5 min — saltando\n` +
        `- Encontrados ${markets.length} mercados pero ninguno válido para dirección '${type}'`;
      logger.debug(`[PolymarketClient] ${symbol}: markets found but none match direction '${type}'`);
      this.logFn?.(msg);
      return null;
    }

    const expiresInSec = Math.round(
      (new Date(market.endDateIso).getTime() - now) / 1000
    );
    logger.debug(
      `[PolymarketClient] ${symbol}: found market '${market.question}' expiring in ${expiresInSec}s`
    );

    return market;
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
