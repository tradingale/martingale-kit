// PaperAdapter: a local fill simulator implementing the VenueAdapter
// interface, so the full engine loop (entry, ladder, sell replacement,
// completion) runs end to end with ZERO keys and ZERO real orders.
//
// Drive it with `tick(price)` from any price source (a live websocket, a
// candle replay, a test). Fill semantics are deliberately simple and
// conservative: market orders fill at the current tick price; limit buys
// fill when price trades at or below the limit; limit sells fill when price
// trades at or above the limit. Real execution adds fees, slippage, queue
// position and partial fills; paper results flatter you (handbook, section 7).

import type { Fill, PlannedOrder, VenueOrder } from '../types.js';
import type { SequencePlan } from '../engine.js';
import type { VenueAdapter } from './types.js';

interface PaperOrder extends VenueOrder {
  type: 'market' | 'limit';
}

export class PaperAdapter implements VenueAdapter {
  private orders = new Map<string, PaperOrder>();
  private fills: Fill[] = [];
  private lastPrice: number | null = null;
  private clock = 0;

  async placeOrder(order: PlannedOrder): Promise<void> {
    const existing = this.orders.get(order.clientId);
    if (existing && existing.status !== 'canceled' && existing.status !== 'expired') {
      throw new Error(`duplicate clientId: ${order.clientId}`);
    }
    const paper: PaperOrder = {
      clientId: order.clientId,
      side: order.side,
      status: 'open',
      type: order.type,
      price: order.price,
      quantity: order.quantity,
      filledQuantity: 0,
    };
    this.orders.set(order.clientId, paper);
    // Market orders fill immediately at the last known price.
    if (order.type === 'market') {
      if (this.lastPrice === null) throw new Error('market order before any tick: call tick(price) first');
      this.fill(paper, this.lastPrice);
    }
  }

  async cancelOrder(clientId: string): Promise<void> {
    const order = this.orders.get(clientId);
    if (!order || order.status !== 'open') return; // idempotent
    order.status = 'canceled';
  }

  async getOpenOrders(): Promise<VenueOrder[]> {
    return [...this.orders.values()].filter((o) => o.status === 'open').map((o) => ({ ...o }));
  }

  async getFills(): Promise<Fill[]> {
    return this.fills.map((f) => ({ ...f }));
  }

  /**
   * Rebuild the adapter from a persisted plan + fill log (runner restarts).
   * Buys are re-materialized (filled if a fill exists, open otherwise);
   * sells are only re-materialized once filled — a live-but-unfilled sell is
   * deliberately dropped and re-placed by the next reconcile() cycle, which
   * keeps restore() free of any engine-state knowledge.
   */
  restore(plan: SequencePlan, fills: Fill[], openIds: string[] = []): void {
    this.orders.clear();
    this.fills = fills.map((f) => ({ ...f }));
    this.clock = fills.length;
    const filledIds = new Set(fills.map((f) => f.clientId));
    // Sells that were resting when the process exited are named in openIds
    // (persisted by the runner). Without that list a one-shot `cycle` in a
    // fresh process would see no active sell and place a duplicate.
    const openSet = new Set(openIds);
    for (const order of plan.orders) {
      const isFilled = filledIds.has(order.clientId);
      if (order.side === 'sell' && !isFilled && !openSet.has(order.clientId)) continue;
      this.orders.set(order.clientId, {
        clientId: order.clientId,
        side: order.side,
        status: isFilled ? 'filled' : 'open',
        type: order.type,
        price: order.price,
        quantity: order.quantity,
        filledQuantity: isFilled ? order.quantity : 0,
      });
    }
  }

  /** Advance the simulated market to `price`, filling whatever crosses. */
  tick(price: number): Fill[] {
    this.lastPrice = price;
    const newFills: Fill[] = [];
    for (const order of this.orders.values()) {
      if (order.status !== 'open' || order.type !== 'limit' || order.price === undefined) continue;
      const crosses = order.side === 'buy' ? price <= order.price : price >= order.price;
      if (crosses) newFills.push(this.fill(order, order.price));
    }
    return newFills;
  }

  private fill(order: PaperOrder, price: number): Fill {
    order.status = 'filled';
    order.filledQuantity = order.quantity;
    const fill: Fill = {
      clientId: order.clientId,
      side: order.side,
      price,
      quantity: order.quantity,
      timestamp: this.clock++,
    };
    this.fills.push(fill);
    return fill;
  }
}
