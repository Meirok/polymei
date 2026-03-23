/**
 * src/state.ts
 *
 * Shared bot state updated by multiple modules.
 * Period counters (signals, orders, pnl) reset every 5 minutes after the summary is sent.
 * openPositions and currentPrices are persistent/continuously updated.
 */

export interface BotState {
  /** Number of trade signals detected in the current 5-min window (reset every 5 min) */
  signalsDetected: number;
  /** Number of orders successfully placed in the current 5-min window (reset every 5 min) */
  ordersPlaced: number;
  /** Number of orders rejected (risk/confidence) in the current 5-min window (reset every 5 min) */
  ordersRejected: number;
  /** Cumulative P&L for the current 5-min window in USD (reset every 5 min) */
  pnlPeriod: number;
  /** Current number of open positions (persistent, updated on open/close) */
  openPositions: number;
  /** Latest known prices per symbol (updated continuously from Binance feed) */
  currentPrices: { BTC: number; ETH: number; SOL: number };
  /** Prices at the start of the previous 5-min window (for % change calculation) */
  prevPrices: { BTC: number; ETH: number; SOL: number };
}

export const botState: BotState = {
  signalsDetected: 0,
  ordersPlaced: 0,
  ordersRejected: 0,
  pnlPeriod: 0,
  openPositions: 0,
  currentPrices: { BTC: 0, ETH: 0, SOL: 0 },
  prevPrices: { BTC: 0, ETH: 0, SOL: 0 },
};

/**
 * Snapshots current prices into prevPrices and zeroes the period counters.
 * Called after each 5-minute summary is sent.
 */
export function resetPeriodCounters(): void {
  botState.prevPrices = { ...botState.currentPrices };
  botState.signalsDetected = 0;
  botState.ordersPlaced = 0;
  botState.ordersRejected = 0;
  botState.pnlPeriod = 0;
}
