/**
 * src/strategies/scalper.ts
 *
 * Scalping strategy for Polymarket 5-minute crypto markets.
 *
 * Strategy:
 *   On every new 5-minute market window opening:
 *   1. Buy YES if upPrice <= SCALPER_MAX_ENTRY_PRICE
 *      OR Buy NO if downPrice <= SCALPER_MAX_ENTRY_PRICE
 *      → Always pick the cheaper side (closer to 0.50)
 *   2. Monitor the position every 2 seconds
 *   3. Sell immediately when price rises >= PROFIT_TARGET
 *   4. Force sell if secondsUntilClose <= FORCE_SELL_SECONDS regardless of P&L
 */

import type { PolymarketClient, Market } from '../polymarket/client.js';
import type { RiskManager, PositionOpenParams } from '../risk/manager.js';
import {
  SCALPER_PROFIT_TARGET,
  SCALPER_MAX_ENTRY_PRICE,
  SCALPER_FORCE_SELL_SECONDS,
  SCALPER_POSITION_SIZE_USD,
} from '../../config.js';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface OpenPosition {
  symbol: string;
  tokenId: string;
  entryPrice: number;
  sharesAmount: number;
  usdInvested: number;
  side: 'UP' | 'DOWN';
  marketSlug: string;
  marketId: string;
  boughtAt: number;
  targetPrice: number;
  riskPositionId: string;
}

// ─── Scalper ──────────────────────────────────────────────────────────────────

export class Scalper {
  private openPositions: Map<string, OpenPosition> = new Map();
  private skipReasons: Map<string, string> = new Map();

  constructor(
    private polymarket: PolymarketClient,
    private risk: RiskManager,
    private sendTelegram: (msg: string) => void
  ) {}

  /**
   * Called by bot.ts when a new 5-minute market window opens.
   * Buys the cheaper side if odds are near 50/50.
   */
  async onNewMarket(symbol: string, market: Market): Promise<void> {
    // Skip if already have open position for this symbol
    if (this.openPositions.has(symbol)) return;

    // Check risk gate (halt + daily loss limit)
    const { allowed, reason } = this.risk.canOpenPosition(SCALPER_POSITION_SIZE_USD);
    if (!allowed) {
      const msg = `riesgo bloqueado: ${reason}`;
      this.skipReasons.set(symbol, msg);
      logger.warn(`[Scalper:${symbol}] Skipping — ${msg}`);
      return;
    }

    // Pick cheaper side
    const buyUp =
      market.upPrice <= market.downPrice &&
      market.upPrice <= SCALPER_MAX_ENTRY_PRICE;
    const buyDown =
      !buyUp &&
      market.downPrice < market.upPrice &&
      market.downPrice <= SCALPER_MAX_ENTRY_PRICE;

    if (!buyUp && !buyDown) {
      const skipMsg = `odds demasiado altas (UP=${market.upPrice.toFixed(3)} DOWN=${market.downPrice.toFixed(3)})`;
      this.skipReasons.set(symbol, skipMsg);
      this.sendTelegram(
        `⏭ [${symbol}] Skip — odds demasiado altas\n` +
        `UP: ${market.upPrice.toFixed(3)} | DOWN: ${market.downPrice.toFixed(3)}\n` +
        `Máximo entrada: ${SCALPER_MAX_ENTRY_PRICE}`
      );
      logger.debug(`[Scalper:${symbol}] Skip — ${skipMsg}`);
      return;
    }

    const side = buyUp ? 'UP' : 'DOWN';
    const tokenId = buyUp ? market.upTokenId : market.downTokenId;
    const entryPrice = buyUp ? market.upPrice : market.downPrice;

    try {
      const result = await this.polymarket.placeOrder({
        tokenId,
        side: 'BUY',
        price: entryPrice + 0.01,
        sizeUsd: SCALPER_POSITION_SIZE_USD,
        marketId: market.conditionId,
        symbol,
      });

      if (!result.success) {
        this.sendTelegram(
          `❌ [${symbol}] No se pudo abrir posición en Polymarket: ${result.errorMsg}`
        );
        logger.error(`[Scalper:${symbol}] Buy order failed: ${result.errorMsg}`);
        return;
      }

      // Register with risk manager for P&L tracking and halt enforcement
      const posParams: PositionOpenParams = {
        symbol,
        side: side === 'UP' ? 'YES' : 'NO',
        tokenId,
        marketId: market.conditionId,
        question: market.slug,
      };
      const actualEntry = result.price;
      const actualCostUsd = result.sizeShares * result.price;
      const managedPos = this.risk.openPosition(
        posParams,
        result.orderId!,
        actualEntry,
        result.sizeShares,
        actualCostUsd
      );

      const targetPrice = actualEntry + SCALPER_PROFIT_TARGET;

      this.openPositions.set(symbol, {
        symbol,
        tokenId,
        entryPrice: actualEntry,
        sharesAmount: result.sizeShares,
        usdInvested: actualCostUsd,
        side,
        marketSlug: market.slug,
        marketId: market.conditionId,
        boughtAt: Date.now(),
        targetPrice,
        riskPositionId: managedPos.id,
      });

      this.sendTelegram(
        `🎯 [${symbol}] Posición abierta\n` +
        `• Dirección: ${side}\n` +
        `• Entrada: ${actualEntry.toFixed(3)}\n` +
        `• Target venta: ${targetPrice.toFixed(3)}\n` +
        `• Invertido: $${actualCostUsd.toFixed(3)}\n` +
        `• Shares: ${result.sizeShares}\n` +
        `• Mercado: ${market.slug}`
      );
      logger.info(
        `[Scalper:${symbol}] Position opened — ${side} ${result.sizeShares} shares @ ${actualEntry} ` +
        `(target: ${targetPrice.toFixed(3)})`
      );
    } catch (e: any) {
      this.sendTelegram(
        `❌ [${symbol}] No se pudo abrir posición en Polymarket: ${e.message}`
      );
      logger.error(`[Scalper:${symbol}] Buy order error`, e);
    }
  }

  /**
   * Called by bot.ts every 2 seconds to monitor open positions.
   * Sells when profit target is hit or force-sell threshold reached.
   */
  async monitorPositions(getMarket: (symbol: string) => Market | null): Promise<void> {
    for (const [symbol, position] of this.openPositions.entries()) {
      const market = getMarket(symbol);
      if (!market) continue;

      const currentPrice =
        position.side === 'UP' ? market.upPrice : market.downPrice;
      const secondsLeft = Math.floor(
        (new Date(market.endDate).getTime() - Date.now()) / 1000
      );
      const pnl = (currentPrice - position.entryPrice) * position.sharesAmount;

      const hitTarget = currentPrice >= position.targetPrice;
      const forceSell = secondsLeft <= SCALPER_FORCE_SELL_SECONDS;

      logger.debug(
        `[Scalper:${symbol}] Monitor — price=${currentPrice.toFixed(3)} ` +
        `target=${position.targetPrice.toFixed(3)} secs=${secondsLeft} ` +
        `pnl=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3)}`
      );

      if (!hitTarget && !forceSell) continue;

      const reason = hitTarget ? '✅ target alcanzado' : '⏱ force sell (<30s)';

      try {
        const sellResult = await this.polymarket.placeOrder({
          tokenId: position.tokenId,
          side: 'SELL',
          price: Math.max(currentPrice - 0.01, 0.01),
          sizeUsd: position.sharesAmount * currentPrice,
          marketId: position.marketId,
          symbol,
        });

        const won = pnl >= 0;
        const emoji = won ? '💰' : '💸';

        // Close in risk manager
        this.risk.closePosition(position.riskPositionId, currentPrice, won);
        this.openPositions.delete(symbol);

        this.sendTelegram(
          `${emoji} [${symbol}] Posición cerrada — ${reason}\n` +
          `• Entrada: ${position.entryPrice.toFixed(3)}\n` +
          `• Salida: ${currentPrice.toFixed(3)}\n` +
          `• P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3)}\n` +
          `• Segundos restantes: ${secondsLeft}s`
        );
        logger.info(
          `[Scalper:${symbol}] Position closed — ${reason} ` +
          `P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3)}`
        );

        if (!sellResult.success) {
          this.sendTelegram(
            `❌ [${symbol}] Advertencia: No se pudo ejecutar orden de venta: ${sellResult.errorMsg}`
          );
        }
      } catch (e: any) {
        this.sendTelegram(
          `❌ [${symbol}] No se pudo cerrar posición: ${e.message}`
        );
        logger.error(`[Scalper:${symbol}] Sell order error`, e);
      }
    }
  }

  /**
   * Called by bot.ts when a market window closes with no sell executed.
   * The position resolves by market outcome — removes from internal tracking
   * and closes in the risk manager at market price.
   */
  async onMarketClose(symbol: string, closePrice: number): Promise<void> {
    const position = this.openPositions.get(symbol);
    if (!position) return;

    logger.info(`[Scalper:${symbol}] Market closed — position resolved by market @ ${closePrice}`);

    // Approximate resolution: UP wins if market closed above entry, else DOWN wins
    const won =
      (position.side === 'UP' && closePrice >= position.entryPrice) ||
      (position.side === 'DOWN' && closePrice < position.entryPrice);

    const exitPrice = won ? 0.97 : 0.03;
    this.risk.closePosition(position.riskPositionId, exitPrice, won);
    this.openPositions.delete(symbol);
  }

  // ─── Queries ─────────────────────────────────────────────────────────────────

  getOpenPositionsCount(): number {
    return this.openPositions.size;
  }

  hasOpenPosition(symbol: string): boolean {
    return this.openPositions.has(symbol);
  }

  getOpenPosition(symbol: string): OpenPosition | undefined {
    return this.openPositions.get(symbol);
  }

  /** Get the skip reason for a symbol from the current window */
  getSkipReason(symbol: string): string {
    return this.skipReasons.get(symbol) ?? 'sin señal en esta ventana';
  }

  /** Reset per-window tracking for a symbol when a new market window opens */
  resetWindow(symbol: string): void {
    this.skipReasons.delete(symbol);
  }
}
