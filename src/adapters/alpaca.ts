// AlpacaAdapter: live venue adapter for US stocks and Alpaca-listed crypto,
// ported from the Tradingale production engine. Auth is header-based
// (APCA-API-KEY-ID / APCA-API-SECRET-KEY), no signing.
//
// Production lessons baked in:
//  - US stock FRACTIONAL orders must be time_in_force 'day'; they expire at
//    market close and the engine re-places them next cycle (reconcile 2b).
//    Crypto rests 'gtc'.
//  - Alpaca supports client_order_id natively, but requires it unique per
//    account FOREVER (even after cancel/expiry). Re-placements therefore
//    retry with a '~r<n>' suffix; matching back to the plan strips the
//    suffix. Keep base clientIds under ~40 chars.
//  - Grids come from GET /v2/assets (crypto: price_increment,
//    min_trade_increment, min_order_size). Stocks follow the SEC sub-penny
//    rule (2 decimals at or above $1) and allow fractional quantities.
//  - Check the market clock before starting a stock sequence: a market
//    entry placed while closed just queues blindly.
//
// Keys default to ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY env vars.
// `paper: true` targets https://paper-api.alpaca.markets — the same live
// rail pointed at Alpaca's paper environment (a safety setting, not a mode
// of its own).

import type { Fill, PlannedOrder, VenueGrids, VenueOrder } from '../types.js';
import type { VenueAdapter } from './types.js';

export interface AlpacaAdapterOptions {
  /** Plain symbol as Tradingale serves it: "BTC" (crypto) or "AAPL" (stock). */
  symbol: string;
  assetType: 'crypto' | 'stock';
  apiKeyId?: string;
  apiSecretKey?: string;
  /** Target Alpaca's paper environment instead of the live one. */
  paper?: boolean;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

interface AlpacaOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  side: 'buy' | 'sell';
  status: string;
  qty?: string;
  filled_qty?: string;
  filled_avg_price?: string;
  limit_price?: string;
  filled_at?: string | null;
}

const OPEN_STATUSES = new Set(['new', 'accepted', 'pending_new', 'partially_filled', 'accepted_for_bidding']);

function toStatus(s: string): VenueOrder['status'] {
  if (OPEN_STATUSES.has(s)) return 'open';
  if (s === 'filled') return 'filled';
  if (s === 'canceled' || s === 'pending_cancel' || s === 'done_for_day') return 'canceled';
  if (s === 'expired') return 'expired';
  return 'rejected';
}

/** Strip the '~r<n>' re-placement suffix back to the plan's clientId. */
export function baseClientId(clientOrderId: string): string {
  return clientOrderId.split('~')[0];
}

export class AlpacaAdapter implements VenueAdapter {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly tradingSymbol: string;
  private readonly fetchFn: typeof fetch;
  readonly assetType: 'crypto' | 'stock';

  constructor(private readonly options: AlpacaAdapterOptions) {
    const key = options.apiKeyId ?? process.env.ALPACA_API_KEY_ID;
    const secret = options.apiSecretKey ?? process.env.ALPACA_API_SECRET_KEY;
    if (!key || !secret) {
      throw new Error('Alpaca keys missing: set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY');
    }
    this.baseUrl = options.paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
    this.headers = {
      'APCA-API-KEY-ID': key,
      'APCA-API-SECRET-KEY': secret,
      'Content-Type': 'application/json',
    };
    this.assetType = options.assetType;
    this.tradingSymbol = options.assetType === 'crypto'
      ? `${options.symbol.toUpperCase()}/USD`
      : options.symbol.toUpperCase();
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 404 && method === 'DELETE') return undefined as T; // idempotent cancel
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AlpacaHttpError(res.status, text || `Alpaca ${res.status} on ${path}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  /** Market clock; stock sequences must not start while the market is closed. */
  async isMarketOpen(): Promise<boolean> {
    if (this.assetType === 'crypto') return true;
    const clock = await this.request<{ is_open: boolean }>('GET', '/v2/clock');
    return clock.is_open;
  }

  /** Per-asset grids for computeLadder/budgetMin (production precision port). */
  async getGrids(): Promise<VenueGrids> {
    if (this.assetType === 'stock') {
      // SEC sub-penny rule; fractional quantities allowed; Alpaca minimum
      // notional for fractionals is $1.
      return { priceIncrement: 0.01, qtyStep: null, minOrderSize: null, minNotional: 1 };
    }
    try {
      const asset = await this.request<{
        price_increment?: string;
        min_trade_increment?: string;
        min_order_size?: string;
      }>('GET', `/v2/assets/${encodeURIComponent(this.tradingSymbol)}`);
      const num = (v?: string) => {
        const n = parseFloat(v ?? '');
        return Number.isFinite(n) && n > 0 ? n : null;
      };
      return {
        priceIncrement: num(asset.price_increment),
        qtyStep: num(asset.min_trade_increment),
        minOrderSize: num(asset.min_order_size),
        minNotional: null,
      };
    } catch {
      return { priceIncrement: null, qtyStep: null, minOrderSize: null, minNotional: null };
    }
  }

  async placeOrder(order: PlannedOrder): Promise<void> {
    // Fractional stock orders must be 'day' (they expire at the close and
    // the engine re-places them); crypto rests 'gtc'.
    const timeInForce = this.assetType === 'crypto' ? 'gtc' : 'day';
    const payload = {
      symbol: this.tradingSymbol,
      qty: String(order.quantity),
      side: order.side,
      type: order.type,
      time_in_force: timeInForce,
      ...(order.type === 'limit' ? { limit_price: String(order.price) } : {}),
      client_order_id: order.clientId,
    };

    // client_order_id must be unique per account forever: a re-placement of
    // an expired day order retries with a '~r<n>' suffix.
    for (let attempt = 0; attempt < 5; attempt++) {
      const clientOrderId = attempt === 0 ? order.clientId : `${order.clientId}~r${attempt}`;
      try {
        await this.request('POST', '/v2/orders', { ...payload, client_order_id: clientOrderId });
        return;
      } catch (e) {
        const duplicate = e instanceof AlpacaHttpError
          && e.status === 422
          && /client_order_id/i.test(e.message);
        if (!duplicate) throw e;
      }
    }
    throw new Error(`Alpaca: could not find a free client_order_id for ${order.clientId}`);
  }

  async cancelOrder(clientId: string): Promise<void> {
    const order = await this.findByClientId(clientId);
    if (!order || toStatus(order.status) !== 'open') return; // idempotent
    await this.request('DELETE', `/v2/orders/${order.id}`);
  }

  async getOpenOrders(): Promise<VenueOrder[]> {
    const orders = await this.request<AlpacaOrder[]>(
      'GET',
      `/v2/orders?status=open&symbols=${encodeURIComponent(this.tradingSymbol)}&limit=100`,
    );
    return orders.map((o) => this.toVenueOrder(o)).filter((o) => o.status === 'open');
  }

  async getFills(): Promise<Fill[]> {
    const orders = await this.request<AlpacaOrder[]>(
      'GET',
      `/v2/orders?status=closed&symbols=${encodeURIComponent(this.tradingSymbol)}&limit=200`,
    );
    return orders
      .filter((o) => o.status === 'filled' && parseFloat(o.filled_qty ?? '0') > 0)
      .map((o) => ({
        clientId: baseClientId(o.client_order_id),
        side: o.side,
        price: parseFloat(o.filled_avg_price ?? o.limit_price ?? '0'),
        quantity: parseFloat(o.filled_qty ?? '0'),
        timestamp: o.filled_at ? Date.parse(o.filled_at) : 0,
      }));
  }

  private toVenueOrder(o: AlpacaOrder): VenueOrder {
    return {
      clientId: baseClientId(o.client_order_id),
      side: o.side,
      status: toStatus(o.status),
      price: o.limit_price ? parseFloat(o.limit_price) : undefined,
      quantity: parseFloat(o.qty ?? '0'),
      filledQuantity: parseFloat(o.filled_qty ?? '0'),
    };
  }

  private async findByClientId(clientId: string): Promise<AlpacaOrder | null> {
    // The live order may carry a '~r<n>' suffix: look through open orders
    // first (cheap), matching on the base id.
    const open = await this.request<AlpacaOrder[]>(
      'GET',
      `/v2/orders?status=open&symbols=${encodeURIComponent(this.tradingSymbol)}&limit=100`,
    );
    return open.find((o) => baseClientId(o.client_order_id) === clientId) ?? null;
  }
}

export class AlpacaHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
