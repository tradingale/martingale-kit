// The venue adapter interface: the ONE part of a runner this kit does not
// ship. Implementing it against a real exchange is deliberately left to you
// (or to your coding agent), on your keys, under your sole responsibility.
//
// Everything an implementation must honor is documented in the handbook:
// https://tradingale.com/handbook/sequence-automation.md
//  - section 5: snap prices/quantities to the venue grids BEFORE submitting
//    (exit prices UP, buy prices DOWN, quantities floored to the step)
//  - section 6: venue specifics (Binance weight limits, Kraken nonce window,
//    Alpaca day orders on fractional stock orders) and API key hygiene
//    (trade-only permission, never withdrawal, IP allowlisting)
//
// The PaperAdapter in this folder implements the same interface as a local
// simulator, so the whole engine runs with zero keys.

import type { Fill, PlannedOrder, VenueOrder } from '../types.js';

export interface VenueAdapter {
  /**
   * Submit an order, carrying `order.clientId` as the venue's client order
   * id so fills and open orders can be matched back to the plan.
   */
  placeOrder(order: PlannedOrder): Promise<void>;

  /** Cancel by client order id. Must be idempotent (already-gone = success). */
  cancelOrder(clientId: string): Promise<void>;

  /** Open (still working) orders for this sequence's instrument. */
  getOpenOrders(): Promise<VenueOrder[]>;

  /** All fills so far for this sequence's instrument. */
  getFills(): Promise<Fill[]>;
}
