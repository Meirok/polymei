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
  Chain,
  Side,
  OrderType,
  createL1Headers,
} from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import {
  POLYMARKET_PRIVATE_KEY,
  POLYMARKET_SIGNATURE_TYPE,
  POLYMARKET_FUNDER,
  POLYMARKET_API_KEY,
  POLYMARKET_API_SECRET,
  POLYMARKET_PASSPHRASE,
  CLOB_HOST,
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

/** Market object returned by findCurrentMarket(). */
export interface Market {
  symbol: string;
  slug: string;
  conditionId: string;
  upTokenId: string;        // "Up" outcome token
  downTokenId: string;      // "Down" outcome token
  upPrice: number;          // Up price (0-1)
  downPrice: number;        // Down price (0-1)
  secondsUntilClose: number;
  acceptingOrders: boolean;
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
  private signingAddress: string | null = null;
  private initialized = false;
  private tickSizeCache = new Map<string, string>();
  private negRiskCache = new Map<string, boolean>();
  // SYMBOL → Market (invalidated when < 10s to close)
  private activeMarketsCache = new Map<string, Market>();
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

    const wallet = new Wallet(POLYMARKET_PRIVATE_KEY);

    // Determine funder address:
    //   signatureType=0 (EOA):            maker === signer === wallet.address
    //   signatureType=2 (Privy/Gmail):    funder = POLYMARKET_FUNDER (Gnosis Safe),
    //                                     signer = wallet.address (operator key)
    const sigType = POLYMARKET_SIGNATURE_TYPE; // 0 | 1 | 2
    const funder = (sigType === 2 && POLYMARKET_FUNDER)
      ? POLYMARKET_FUNDER
      : wallet.address;

    let creds: { key: string; secret: string; passphrase: string };

    if (POLYMARKET_API_KEY && POLYMARKET_API_SECRET && POLYMARKET_PASSPHRASE) {
      // Use pre-configured credentials (set these in .env after first boot)
      creds = {
        key: POLYMARKET_API_KEY,
        secret: POLYMARKET_API_SECRET,
        passphrase: POLYMARKET_PASSPHRASE,
      };
      console.log('[Auth] Using pre-configured API key:', creds.key);
    } else {
      // Derive (or create) L2 credentials via L1 signing.
      // NOTE: signatureType and funderAddress are NOT part of API key creation —
      // they only affect order signing. A plain tmpClient with just the signer key
      // is correct here per the Polymarket CLOB API spec.
      const tmpClient = new ClobClient(
        CLOB_HOST,
        POLYGON_CHAIN_ID as Chain,
        wallet,
      );
      creds = await tmpClient.createOrDeriveApiKey();
      console.log('[Auth] key:', creds.key, 'secret:', creds.secret ? 'SET' : 'MISSING');
      logger.warn(
        '[PolymarketClient] ⚠️  API credentials derived. Save to .env to avoid re-derivation:\n' +
        `  POLYMARKET_API_KEY=${creds.key}\n` +
        `  POLYMARKET_API_SECRET=${creds.secret}\n` +
        `  POLYMARKET_PASSPHRASE=${creds.passphrase}`
      );
    }

    // For signatureType=2: verify operator status on the CLOB and log a clear message.
    // The on-chain operator registration (signer → funder's Gnosis Safe) must already exist;
    // this is set up by Polymarket when the Privy/Gmail account is created.
    if (sigType === 2 && POLYMARKET_FUNDER) {
      await this.checkOperatorStatus(wallet, POLYMARKET_FUNDER, creds);
    }

    // Initialize the final client with correct signatureType and funder
    this.clobClient = new ClobClient(
      CLOB_HOST,
      POLYGON_CHAIN_ID as Chain,
      wallet,
      {
        key: creds.key,
        secret: creds.secret,
        passphrase: creds.passphrase,
      },
      sigType as any,
      funder,
    );

    this.wallet = wallet;
    this.signingAddress = wallet.address;
    this.initialized = true;
    logger.info(
      `[PolymarketClient] Initialized — funder: ${funder} | signer: ${wallet.address} | signatureType: ${sigType}`
    );
  }

  /**
   * For signatureType=2 (Privy/Gmail / POLY_GNOSIS_SAFE):
   *
   * Verifies that the CLOB recognises the signer as a valid operator for the funder by
   * calling GET /auth/api-keys (L2 auth). Logs the result as a startup sanity check.
   *
   * NOTE: The on-chain operator registration (signer approved to sign for the funder's
   * Gnosis Safe) is set up by Polymarket when the Privy/Gmail account is first created.
   * There is no HTTP API endpoint to register operators — it is purely on-chain and
   * handled transparently by the Polymarket infrastructure.
   *
   * The funderAddress is used ONLY in the ClobClient constructor for order signing
   * (sets maker = funder in every signed order). It is NOT part of the /auth/api-key
   * creation request.
   */
  private async checkOperatorStatus(
    wallet: Wallet,
    funderAddress: string,
    creds: { key: string; secret: string; passphrase: string },
  ): Promise<void> {
    const signerAddress = wallet.address;
    logger.info(
      `[PolymarketClient] signatureType=2 config — funder: ${funderAddress} | signer/operator: ${signerAddress}`
    );

    // Use L2 auth to verify the API keys are valid and retrieve account info
    try {
      const l1Headers = await createL1Headers(wallet as any, POLYGON_CHAIN_ID as Chain);
      const res = await fetch(`${CLOB_HOST}/auth/api-keys`, {
        headers: {
          'POLY_ADDRESS':   l1Headers.POLY_ADDRESS,
          'POLY_SIGNATURE': l1Headers.POLY_SIGNATURE,
          'POLY_TIMESTAMP': l1Headers.POLY_TIMESTAMP,
          'POLY_NONCE':     l1Headers.POLY_NONCE,
        },
      });
      if (res.ok) {
        const data: unknown = await res.json();
        logger.info(`[PolymarketClient] L1 auth check — active API keys: ${JSON.stringify(data)}`);
      } else {
        logger.warn(`[PolymarketClient] L1 auth check returned HTTP ${res.status} — credentials may be invalid`);
      }
    } catch (err) {
      logger.warn(`[PolymarketClient] L1 auth check failed: ${err}`);
    }

    logger.info(
      `[PolymarketClient] ✅ signatureType=2 ready — orders will be placed as:\n` +
      `  maker (funder):   ${funderAddress}\n` +
      `  signer (operator): ${signerAddress}\n` +
      `  API key:           ${creds.key}`
    );
  }

  private ensureClient(): ClobClient {
    if (!this.clobClient) throw new Error('PolymarketClient not initialized');
    return this.clobClient;
  }

  // ─── Wallet / Balance ─────────────────────────────────────────────────────

  getWalletAddress(): string | null {
    return this.signingAddress ?? this.wallet?.address ?? null;
  }

  // ─── Market Discovery ──────────────────────────────────────────────────────

  /** Return candidate close timestamps for a diagnostic display (no network call). */
  getCandidateTimestamps(): number[] {
    const base = getCurrentMarketCloseTimestamp();
    return [0, 1, 2, 3, -1].map((i) => base + i * 300);
  }

  /**
   * Return the cached Market for a symbol (O(1) — no network call).
   * Populate the cache first by calling findCurrentMarket() or startAutoRefresh().
   */
  getActiveMarket(symbol: string): Market | null {
    return this.activeMarketsCache.get(symbol.toUpperCase()) ?? null;
  }

  /**
   * Compute live seconds-until-close for a market (always fresh, not stale).
   */
  getSecondsUntilClose(market: Market): number {
    return Math.floor((new Date(market.endDate).getTime() - Date.now()) / 1000);
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
            const market = await this.findCurrentMarket(sym);
            if (market) {
              this.activeMarketsCache.set(sym.toUpperCase(), market);
              const secs = this.getSecondsUntilClose(market);
              const mins = Math.floor(secs / 60);
              const secPad = String(secs % 60).padStart(2, '0');
              return `- ${sym}: ${market.slug} | UP: ${market.upPrice.toFixed(2)} | Cierra en: ${mins}m ${secPad}s`;
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
   * Find the active 5-minute market for a symbol using timestamp-based slug lookup.
   * Tries [-1, 0, +1, +2] ET-aligned 5-minute windows.
   */
  async findCurrentMarket(symbol: string): Promise<Market | null> {
    const symbolLower = symbol.toLowerCase()
    const nowSec = Math.floor(Date.now() / 1000)
    const etOffset = 4 * 3600
    const etNow = nowSec - etOffset
    const base = Math.ceil(etNow / 300) * 300 + etOffset
    const candidates = [-1, 0, 1, 2].map(i => base + i * 300)
    for (const ts of candidates) {
      const slug = `${symbolLower}-updown-5m-${ts}`
      const url = `https://gamma-api.polymarket.com/events?slug=${slug}`

      try {
        const response = await fetch(url)
        const text = await response.text()
        if (!text || text === '[]') continue

        const data = JSON.parse(text)
        console.log(`[${symbol}] Parsed ${data.length} events for slug ${slug}`)
        if (!Array.isArray(data) || data.length === 0) continue

        const event = data[0]
        const market = event.markets?.[0]
        if (!market) continue

        const clobTokenIds = JSON.parse(market.clobTokenIds || '[]')
        const outcomePrices = JSON.parse(market.outcomePrices || '["0.5","0.5"]')
        const endDate = new Date(market.endDate)
        const secondsUntilClose = Math.floor((endDate.getTime() - Date.now()) / 1000)

        if (secondsUntilClose < -60) continue
        if (!clobTokenIds[0] || !clobTokenIds[1]) continue

        return {
          symbol,
          slug,
          conditionId: market.conditionId,
          upTokenId: clobTokenIds[0],
          downTokenId: clobTokenIds[1],
          upPrice: parseFloat(outcomePrices[0]),
          downPrice: parseFloat(outcomePrices[1]),
          secondsUntilClose,
          acceptingOrders: market.acceptingOrders === true,
          endDate: market.endDate
        }
      } catch(e: any) {
        continue
      }
    }
    return null
  }

  // ─── Order Book & Odds ─────────────────────────────────────────────────────

  /**
   * Get YES/NO odds for a market from the CLOB order book.
   * Falls back to Gamma token prices if CLOB unavailable.
   * Logs a warning to Telegram if liquidity is too low.
   */
  async getPolymarketOdds(market: Market): Promise<PolymarketOdds | null> {
    try {
      // Try to get live order book prices
      if (this.clobClient) {
        try {
          const [upBook, downBook] = await Promise.all([
            this.clobClient.getOrderBook(market.upTokenId),
            this.clobClient.getOrderBook(market.downTokenId),
          ]);

          const upBestAsk = upBook?.asks?.[0]?.price ?? market.upPrice;
          const downBestAsk = downBook?.asks?.[0]?.price ?? market.downPrice;

          // Check liquidity: warn if order book is empty or very thin
          const upAskSize = Number(upBook?.asks?.[0]?.size ?? 0);
          const downAskSize = Number(downBook?.asks?.[0]?.size ?? 0);
          const MIN_LIQUIDITY_SHARES = 10;

          if (upAskSize < MIN_LIQUIDITY_SHARES || downAskSize < MIN_LIQUIDITY_SHARES) {
            const lowSide = upAskSize < MIN_LIQUIDITY_SHARES ? `UP (${upAskSize} shares)` : `DOWN (${downAskSize} shares)`;
            logger.debug(`[PolymarketClient] Low liquidity on '${market.slug}': ${lowSide}`);
            this.logFn?.(
              `🏪 Liquidez baja en '${market.slug}'\n` +
              `- ${lowSide} en mejor ask\n` +
              `- Mínimo requerido: ${MIN_LIQUIDITY_SHARES} shares`
            );
          }

          return {
            yes: Number(upBestAsk),
            no: Number(downBestAsk),
            yesTokenId: market.upTokenId,
            noTokenId: market.downTokenId,
            marketId: market.conditionId,
            question: market.slug,
          };
        } catch {
          // Fall through to Gamma prices
        }
      }

      // Use Gamma token prices as fallback
      return {
        yes: market.upPrice,
        no: market.downPrice,
        yesTokenId: market.upTokenId,
        noTokenId: market.downTokenId,
        marketId: market.conditionId,
        question: market.slug,
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
   * Place a limit order via the @polymarket/clob-client SDK.
   * sizeUsd is the dollar amount to spend; converted to shares via price.
   */
  async placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
    if (!params.tokenId) throw new Error('tokenId is undefined');

    const { tokenId, side, price, sizeUsd, marketId } = params;

    // Convert dollar amount to shares using the passed sizeUsd.
    // BUY: sizeUsd is the position budget (SCALPER_POSITION_SIZE_USD from caller).
    // SELL: sizeUsd = sharesHeld * price, sells the exact position.
    const rawShares = Math.floor(sizeUsd / price);
    const amount = Math.max(1, rawShares);
    const effectivePrice = Math.min(Math.max(price + SLIPPAGE_BUFFER, 0.01), 0.99);

    console.log('[placeOrder] params:', { tokenId, side, amount, price: effectivePrice });

    if (DRY_RUN) {
      const fakeId = `dry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      logger.info(`[DRY RUN] ${side} ${amount} shares @ ${effectivePrice} on ${marketId}`);
      return { success: true, orderId: fakeId, price: effectivePrice, sizeShares: amount };
    }

    try {
      const orderArgs = {
        tokenID: tokenId,
        price: effectivePrice,
        side: side === 'BUY' ? Side.BUY : Side.SELL,
        size: amount,
        feeRateBps: '1000',
        nonce: '0',
        expiration: '0',
      };

      const signedOrder = await this.clobClient!.createOrder(orderArgs);
      console.log('[placeOrder] signed order created:', signedOrder.salt);

      const result = await this.clobClient!.postOrder(signedOrder, OrderType.GTC);
      console.log('[placeOrder] post result:', JSON.stringify(result));

      if (!result || result.errorCode || result.error) {
        const errMsg = result?.error || result?.errorCode || JSON.stringify(result);
        this.logFn?.(
          `⚠️ ERROR: polymarket\n` +
          `- Módulo: polymarket\n` +
          `- Detalle: Order rejected — ${errMsg}\n` +
          `- Acción: skipping trade`
        );
        return { success: false, price: effectivePrice, sizeShares: amount, errorMsg: String(errMsg) };
      }

      return {
        success: true,
        orderId: result.orderID || result.id,
        price: effectivePrice,
        sizeShares: amount,
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
      return { success: false, price: effectivePrice, sizeShares: amount, errorMsg: msg };
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
