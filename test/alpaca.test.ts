import { describe, expect, it, vi } from 'vitest';
import { AlpacaAdapter, baseClientId } from '../src/adapters/alpaca.js';

// Offline mock of the Alpaca REST surface: orders live in a Map, statuses
// follow the venue's vocabulary, client_order_id is unique forever (the
// production constraint the adapter works around with '~r<n>' suffixes).
function mockAlpaca() {
  const orders = new Map<string, Record<string, unknown>>();
  let nextId = 1;
  const usedClientIds = new Set<string>();

  const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const respond = (status: number, body?: unknown) =>
      new Response(body === undefined ? null : JSON.stringify(body), { status });

    if (method === 'POST' && u.endsWith('/v2/orders')) {
      const body = JSON.parse(String(init?.body));
      if (usedClientIds.has(body.client_order_id)) {
        return respond(422, { message: 'client_order_id must be unique' });
      }
      usedClientIds.add(body.client_order_id);
      const id = `oid-${nextId++}`;
      orders.set(id, { id, ...body, status: 'new', filled_qty: '0' });
      return respond(200, orders.get(id));
    }
    if (method === 'GET' && u.includes('/v2/orders?')) {
      const wantOpen = u.includes('status=open');
      const list = [...orders.values()].filter((o) =>
        wantOpen ? o.status === 'new' : o.status !== 'new',
      );
      return respond(200, list);
    }
    if (method === 'DELETE' && u.includes('/v2/orders/')) {
      const id = u.split('/').pop()!;
      const o = orders.get(id);
      if (!o) return respond(404);
      o.status = 'canceled';
      return respond(204);
    }
    if (u.endsWith('/v2/clock')) return respond(200, { is_open: false });
    if (u.includes('/v2/assets/')) {
      return respond(200, { price_increment: '0.05', min_trade_increment: '0.0001', min_order_size: '0.0001' });
    }
    return respond(500, { message: `unhandled ${method} ${u}` });
  });

  const control = {
    fill(clientOrderId: string, price: number) {
      for (const o of orders.values()) {
        if (o.client_order_id === clientOrderId) {
          o.status = 'filled';
          o.filled_qty = o.qty;
          o.filled_avg_price = String(price);
          o.filled_at = new Date(0).toISOString();
        }
      }
    },
    expire(clientOrderId: string) {
      for (const o of orders.values()) {
        if (o.client_order_id === clientOrderId) o.status = 'expired';
      }
    },
  };
  return { fetchFn, control };
}

const opts = (fetchFn: typeof fetch, assetType: 'crypto' | 'stock') => ({
  symbol: assetType === 'crypto' ? 'BTC' : 'AAPL',
  assetType,
  apiKeyId: 'k',
  apiSecretKey: 's',
  paper: true,
  fetchFn,
});

describe('AlpacaAdapter', () => {
  it('stock orders go out as day orders, crypto as gtc', async () => {
    const { fetchFn } = mockAlpaca();
    const stock = new AlpacaAdapter(opts(fetchFn as unknown as typeof fetch, 'stock'));
    await stock.placeOrder({ clientId: 's1-buy-2', side: 'buy', type: 'limit', price: 100, quantity: 1, level: 2 });
    const stockBody = JSON.parse(String((fetchFn.mock.calls.at(-1)![1] as RequestInit).body));
    expect(stockBody.time_in_force).toBe('day');
    expect(stockBody.symbol).toBe('AAPL');

    const crypto = new AlpacaAdapter(opts(fetchFn as unknown as typeof fetch, 'crypto'));
    await crypto.placeOrder({ clientId: 'c1-buy-2', side: 'buy', type: 'limit', price: 100, quantity: 1, level: 2 });
    const cryptoBody = JSON.parse(String((fetchFn.mock.calls.at(-1)![1] as RequestInit).body));
    expect(cryptoBody.time_in_force).toBe('gtc');
    expect(cryptoBody.symbol).toBe('BTC/USD');
  });

  it('retries with a ~r suffix when the client_order_id was already used, and matching strips it', async () => {
    const { fetchFn, control } = mockAlpaca();
    const a = new AlpacaAdapter(opts(fetchFn as unknown as typeof fetch, 'stock'));
    const order = { clientId: 's1-buy-3', side: 'buy' as const, type: 'limit' as const, price: 90, quantity: 1, level: 3 };
    await a.placeOrder(order);
    control.expire('s1-buy-3');
    await a.placeOrder(order); // re-placement after expiry: same base clientId
    const open = await a.getOpenOrders();
    expect(open).toHaveLength(1);
    expect(open[0].clientId).toBe('s1-buy-3'); // suffix stripped
    expect(baseClientId('s1-buy-3~r1')).toBe('s1-buy-3');
  });

  it('fills come back keyed to the base clientId with the filled price', async () => {
    const { fetchFn, control } = mockAlpaca();
    const a = new AlpacaAdapter(opts(fetchFn as unknown as typeof fetch, 'stock'));
    await a.placeOrder({ clientId: 's1-buy-1', side: 'buy', type: 'market', quantity: 2, level: 1 });
    control.fill('s1-buy-1', 101.5);
    const fills = await a.getFills();
    expect(fills).toEqual([
      expect.objectContaining({ clientId: 's1-buy-1', side: 'buy', price: 101.5, quantity: 2 }),
    ]);
  });

  it('cancel is idempotent and only cancels open orders', async () => {
    const { fetchFn, control } = mockAlpaca();
    const a = new AlpacaAdapter(opts(fetchFn as unknown as typeof fetch, 'stock'));
    await a.placeOrder({ clientId: 's1-sell-1', side: 'sell', type: 'limit', price: 110, quantity: 1, level: 1 });
    await a.cancelOrder('s1-sell-1');
    await a.cancelOrder('s1-sell-1'); // second cancel: no throw
    expect((await a.getOpenOrders())).toHaveLength(0);
    control.fill('s1-sell-1', 110); // already canceled: fill() is a no-op on status here
  });

  it('reads the market clock for stocks and reports crypto as always open', async () => {
    const { fetchFn } = mockAlpaca();
    const stock = new AlpacaAdapter(opts(fetchFn as unknown as typeof fetch, 'stock'));
    expect(await stock.isMarketOpen()).toBe(false); // mock clock says closed
    const crypto = new AlpacaAdapter(opts(fetchFn as unknown as typeof fetch, 'crypto'));
    expect(await crypto.isMarketOpen()).toBe(true);
  });

  it('maps declared crypto grids and applies the stock sub-penny rule', async () => {
    const { fetchFn } = mockAlpaca();
    const crypto = new AlpacaAdapter(opts(fetchFn as unknown as typeof fetch, 'crypto'));
    expect(await crypto.getGrids()).toEqual({
      priceIncrement: 0.05,
      qtyStep: 0.0001,
      minOrderSize: 0.0001,
      minNotional: null,
    });
    const stock = new AlpacaAdapter(opts(fetchFn as unknown as typeof fetch, 'stock'));
    expect(await stock.getGrids()).toEqual({
      priceIncrement: 0.01,
      qtyStep: null,
      minOrderSize: null,
      minNotional: 1,
    });
  });

  it('refuses to build without keys', () => {
    expect(() => new AlpacaAdapter({ symbol: 'AAPL', assetType: 'stock' })).toThrow(/keys missing/i);
  });
});
