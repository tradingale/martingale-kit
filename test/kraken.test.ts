// KrakenAdapter tests. ALL OFFLINE: fetch is injected, no test ever touches
// the network. The signature vector comes from Kraken's own authentication
// documentation, so the construction is proven without any live call.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  KrakenAdapter,
  fetchKrakenGrids,
  formatKrakenPrice,
  krakenGridsFromPairInfo,
  krakenOrderStatus,
  krakenPairCandidates,
  krakenPostData,
  krakenSignature,
  resolveKrakenPair,
  toFixedDown,
  userrefFromClientId,
} from '../src/adapters/kraken.js';
import type { PlannedOrder } from '../src/types.js';

// ---------------------------------------------------------------------------
// Offline fetch harness
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

type Handler = (call: RecordedCall) => { status?: number; json: unknown };

function fakeFetch(handler: Handler): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === 'string' ? init.body : '',
    };
    calls.push(call);
    const { status = 200, json } = handler(call);
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const ASSET_PAIRS = {
  XXBTZUSD: { altname: 'XBTUSD', pair_decimals: 1, lot_decimals: 8, ordermin: '0.00005', tick_size: '0.1', costmin: '0.5' },
  XBTUSDC: { altname: 'XBTUSDC', pair_decimals: 2, lot_decimals: 8, ordermin: '0.00005' },
  XDGUSD: { altname: 'XDGUSD', pair_decimals: 7, lot_decimals: 8, ordermin: '20' },
  SOLUSD: { altname: 'SOLUSD', pair_decimals: 2, lot_decimals: 8, ordermin: '0.02' },
  ADAUSDC: { altname: 'ADAUSDC', pair_decimals: 6, lot_decimals: 8, ordermin: '5' },
};

function assetPairsHandler(call: RecordedCall): { json: unknown } | null {
  if (call.url.includes('/0/public/AssetPairs')) {
    return { json: { error: [], result: ASSET_PAIRS } };
  }
  return null;
}

function tmpStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kraken-adapter-test-'));
}

function makeAdapter(handler: Handler, overrides: Partial<ConstructorParameters<typeof KrakenAdapter>[0]> = {}) {
  const { fetchImpl, calls } = fakeFetch(handler);
  const adapter = new KrakenAdapter({
    symbol: 'BTC',
    sequenceId: 'BTC-1',
    apiKey: 'test-key',
    apiSecret: TEST_SECRET,
    stateDir: tmpStateDir(),
    fetchImpl,
    nonceFn: () => '1616492376594',
    ...overrides,
  });
  return { adapter, calls };
}

// The private key published in Kraken's authentication documentation example.
const TEST_SECRET =
  'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==';

// ---------------------------------------------------------------------------
// Signature (the exact construction production used)
// ---------------------------------------------------------------------------

describe('kraken signature', () => {
  it('reproduces the vector from the Kraken authentication docs', () => {
    // Construction: API-Sign = base64( HMAC-SHA512( base64decode(secret),
    //   path + SHA256(nonce + postdata) ) )
    // with path = "/0/private/AddOrder" and postdata the exact form body.
    const postData = 'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25';
    const signature = krakenSignature('/0/private/AddOrder', postData, '1616492376594', TEST_SECRET);
    expect(signature).toBe('4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==');
  });

  it('serializes postdata with sorted keys, nonce included', () => {
    const postData = krakenPostData({ volume: '1.25', pair: 'XBTUSD', nonce: '7', type: 'buy' });
    expect(postData).toBe('nonce=7&pair=XBTUSD&type=buy&volume=1.25');
  });

  it('signs exactly the body it sends on a private call', async () => {
    const { adapter, calls } = makeAdapter((call) => {
      const pub = assetPairsHandler(call);
      if (pub) return pub;
      return { json: { error: [], result: { txid: ['OTEST-1'] } } };
    });
    const order: PlannedOrder = {
      clientId: 'BTC-1-buy-2',
      side: 'buy',
      type: 'limit',
      price: 96.34,
      quantity: 0.123456789,
      level: 2,
    };
    await adapter.placeOrder(order);

    const addOrder = calls.find((c) => c.url.includes('/private/AddOrder'))!;
    expect(addOrder.method).toBe('POST');
    expect(addOrder.headers['API-Key']).toBe('test-key');
    expect(addOrder.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    // The signature must be computed over the exact body that was sent.
    const expected = krakenSignature('/0/private/AddOrder', addOrder.body, '1616492376594', TEST_SECRET);
    expect(addOrder.headers['API-Sign']).toBe(expected);
    expect(addOrder.body).toContain('nonce=1616492376594');
  });
});

// ---------------------------------------------------------------------------
// Symbol mapping + pair resolution + grids
// ---------------------------------------------------------------------------

describe('kraken symbol mapping', () => {
  it('maps BTC to XBT and DOGE to XDG in pair candidates', () => {
    expect(krakenPairCandidates('BTC', 'USD')).toEqual(['XBTUSD', 'XXBTZUSD', 'XXBTUSD', 'XBTZUSD']);
    expect(krakenPairCandidates('DOGE', 'USD')[0]).toBe('XDGUSD');
    expect(krakenPairCandidates('SOL', 'USD')[0]).toBe('SOLUSD');
  });

  it('resolves BTC to XXBTZUSD, preferring USD over USDC', async () => {
    const { fetchImpl } = fakeFetch((call) => assetPairsHandler(call)!);
    const { pair } = await resolveKrakenPair('BTC', fetchImpl);
    expect(pair).toBe('XXBTZUSD');
  });

  it('resolves DOGE to XDGUSD and falls back to USDC when no USD pair exists', async () => {
    const { fetchImpl } = fakeFetch((call) => assetPairsHandler(call)!);
    expect((await resolveKrakenPair('DOGE', fetchImpl)).pair).toBe('XDGUSD');
    expect((await resolveKrakenPair('ADA', fetchImpl)).pair).toBe('ADAUSDC');
    await expect(resolveKrakenPair('NOPE', fetchImpl)).rejects.toThrow(/No Kraken USD or USDC pair/);
  });

  it('builds VenueGrids from pair_decimals, lot_decimals and ordermin', async () => {
    const { fetchImpl } = fakeFetch((call) => assetPairsHandler(call)!);
    const grids = await fetchKrakenGrids('BTC', fetchImpl);
    expect(grids).toEqual({ priceIncrement: 0.1, qtyStep: 1e-8, minOrderSize: 0.00005, minNotional: 0.5 });
    // Without tick_size/costmin, decimals imply the increments.
    const dogeGrids = krakenGridsFromPairInfo(ASSET_PAIRS.XDGUSD);
    expect(dogeGrids.priceIncrement).toBe(1e-7);
    expect(dogeGrids.minOrderSize).toBe(20);
    expect(dogeGrids.minNotional).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Order placement
// ---------------------------------------------------------------------------

describe('kraken placeOrder', () => {
  it('sends a limit buy with cl_ord_id, floored volume and floored buy price', async () => {
    const { adapter, calls } = makeAdapter((call) => {
      const pub = assetPairsHandler(call);
      if (pub) return pub;
      return { json: { error: [], result: { txid: ['OTEST-1'] } } };
    });
    await adapter.placeOrder({
      clientId: 'BTC-1-buy-2', side: 'buy', type: 'limit', price: 96.34, quantity: 0.123456789, level: 2,
    });
    const body = calls.find((c) => c.url.includes('/private/AddOrder'))!.body;
    expect(body).toContain('pair=XXBTZUSD');
    expect(body).toContain('type=buy');
    expect(body).toContain('ordertype=limit');
    expect(body).toContain('volume=0.12345678'); // floored to lot_decimals
    expect(body).toContain('price=96.3'); // buy price floored to pair_decimals
    expect(body).toContain('cl_ord_id=BTC-1-buy-2');
  });

  it('sends a market order without price, and rounds sell prices UP', async () => {
    const { adapter, calls } = makeAdapter((call) => {
      const pub = assetPairsHandler(call);
      if (pub) return pub;
      return { json: { error: [], result: { txid: ['OTEST-2'] } } };
    });
    await adapter.placeOrder({ clientId: 'BTC-1-buy-1', side: 'buy', type: 'market', quantity: 0.5, level: 1 });
    await adapter.placeOrder({
      clientId: 'BTC-1-sell-1', side: 'sell', type: 'limit', price: 103.61, quantity: 0.5, level: 1,
    });
    const bodies = calls.filter((c) => c.url.includes('/private/AddOrder')).map((c) => c.body);
    expect(bodies[0]).toContain('ordertype=market');
    expect(bodies[0]).not.toContain('price=');
    expect(bodies[1]).toContain('price=103.7'); // sell price rounded UP
    // Ported sell haircut: 0.5 * (1 - 0.004) = 0.498, floored to 8 decimals.
    expect(bodies[1]).toContain('volume=0.49800000');
  });

  it('treats a duplicate cl_ord_id as success (idempotent resubmission)', async () => {
    const { adapter } = makeAdapter((call) => {
      const pub = assetPairsHandler(call);
      if (pub) return pub;
      return { json: { error: ['EOrder:Cl-Ord-Id already exists'], result: {} } };
    });
    await expect(
      adapter.placeOrder({ clientId: 'BTC-1-buy-2', side: 'buy', type: 'limit', price: 96, quantity: 0.1, level: 2 }),
    ).resolves.toBeUndefined();
  });

  it('falls back to a stable persisted userref when Kraken rejects cl_ord_id', async () => {
    const stateDir = tmpStateDir();
    let addOrderCalls = 0;
    const { adapter, calls } = makeAdapter(
      (call) => {
        const pub = assetPairsHandler(call);
        if (pub) return pub;
        if (call.url.includes('/private/AddOrder')) {
          addOrderCalls++;
          if (addOrderCalls === 1) {
            return { json: { error: ['EGeneral:Invalid arguments:cl_ord_id'], result: {} } };
          }
          return { json: { error: [], result: { txid: ['OTEST-3'] } } };
        }
        return { json: { error: [], result: {} } };
      },
      { stateDir },
    );
    await adapter.placeOrder({
      clientId: 'BTC-1-buy-3', side: 'buy', type: 'limit', price: 90, quantity: 0.1, level: 3,
    });
    const bodies = calls.filter((c) => c.url.includes('/private/AddOrder')).map((c) => c.body);
    expect(bodies).toHaveLength(2);
    const expectedRef = userrefFromClientId('BTC-1-buy-3');
    expect(bodies[1]).toContain(`userref=${expectedRef}`);
    expect(bodies[1]).not.toContain('cl_ord_id=');
    // Mapping persisted so a restarted adapter can still match orders back.
    const map = JSON.parse(fs.readFileSync(path.join(stateDir, 'kraken-userref-map.json'), 'utf-8'));
    expect(map[String(expectedRef)]).toBe('BTC-1-buy-3');
  });
});

// ---------------------------------------------------------------------------
// Cancel (idempotent), open orders, fills
// ---------------------------------------------------------------------------

const OPEN_ORDERS = {
  'OTX-1': {
    status: 'open', vol: '0.50000000', vol_exec: '0.00000000', cl_ord_id: 'BTC-1-sell-2',
    descr: { pair: 'XBTUSD', type: 'sell', ordertype: 'limit', price: '100.0' },
  },
  'OTX-FOREIGN': {
    status: 'open', vol: '1.00000000', vol_exec: '0.00000000',
    descr: { pair: 'XBTUSD', type: 'sell', ordertype: 'limit', price: '123.0' },
  },
};

describe('kraken cancelOrder', () => {
  it('cancels by resolving the txid of our clientId', async () => {
    const { adapter, calls } = makeAdapter((call) => {
      if (call.url.includes('/private/OpenOrders')) return { json: { error: [], result: { open: OPEN_ORDERS } } };
      return { json: { error: [], result: { count: 1 } } };
    });
    await adapter.cancelOrder('BTC-1-sell-2');
    const cancel = calls.find((c) => c.url.includes('/private/CancelOrder'))!;
    expect(cancel.body).toContain('txid=OTX-1');
  });

  it('is idempotent: an order that is already gone counts as success', async () => {
    // Not on the book at all: no CancelOrder call, resolves.
    const { adapter, calls } = makeAdapter((call) => {
      if (call.url.includes('/private/OpenOrders')) return { json: { error: [], result: { open: {} } } };
      return { json: { error: [], result: {} } };
    });
    await expect(adapter.cancelOrder('BTC-1-sell-2')).resolves.toBeUndefined();
    expect(calls.some((c) => c.url.includes('/private/CancelOrder'))).toBe(false);

    // On the book, but Kraken answers "Unknown order": still success.
    const second = makeAdapter((call) => {
      if (call.url.includes('/private/OpenOrders')) return { json: { error: [], result: { open: OPEN_ORDERS } } };
      return { json: { error: ['EOrder:Unknown order'], result: {} } };
    });
    await expect(second.adapter.cancelOrder('BTC-1-sell-2')).resolves.toBeUndefined();
  });
});

describe('kraken snapshots', () => {
  it('getOpenOrders returns only this sequence, with mapped status', async () => {
    const { adapter } = makeAdapter((call) => {
      if (call.url.includes('/private/OpenOrders')) return { json: { error: [], result: { open: OPEN_ORDERS } } };
      return { json: { error: [], result: {} } };
    });
    const orders = await adapter.getOpenOrders();
    expect(orders).toHaveLength(1); // the foreign manual order is filtered out
    expect(orders[0]).toEqual({
      clientId: 'BTC-1-sell-2', side: 'sell', status: 'open', price: 100, quantity: 0.5, filledQuantity: 0,
    });
  });

  it('getFills maps executed closed orders, skipping zero executions and foreign orders', async () => {
    const closed = {
      'OTX-2': {
        status: 'closed', vol: '0.50000000', vol_exec: '0.50000000', price: '99.5', closetm: 1700000000.123,
        cl_ord_id: 'BTC-1-buy-1', descr: { type: 'buy', ordertype: 'market', price: '0' },
      },
      'OTX-3': {
        status: 'canceled', vol: '0.30000000', vol_exec: '0.00000000', price: '0.0', closetm: 1700000100,
        cl_ord_id: 'BTC-1-buy-2', descr: { type: 'buy', ordertype: 'limit', price: '95.0' },
      },
      'OTX-FOREIGN': {
        status: 'closed', vol: '2.00000000', vol_exec: '2.00000000', price: '101.0', closetm: 1700000200,
        descr: { type: 'buy', ordertype: 'limit', price: '101.0' },
      },
    };
    const { adapter, calls } = makeAdapter(
      (call) => {
        if (call.url.includes('/private/ClosedOrders')) {
          return { json: { error: [], result: { closed, count: 3 } } };
        }
        return { json: { error: [], result: {} } };
      },
      { sinceMs: 1_700_000_000_000 },
    );
    const fills = await adapter.getFills();
    expect(fills).toEqual([
      { clientId: 'BTC-1-buy-1', side: 'buy', price: 99.5, quantity: 0.5, timestamp: 1700000000123 },
    ]);
    // The since bound is forwarded so pagination stays cheap.
    expect(calls.find((c) => c.url.includes('/private/ClosedOrders'))!.body).toContain('start=1700000000');
  });

  it('maps Kraken statuses onto the kit statuses', () => {
    expect(krakenOrderStatus('open')).toBe('open');
    expect(krakenOrderStatus('pending')).toBe('open');
    expect(krakenOrderStatus('closed')).toBe('filled');
    expect(krakenOrderStatus('canceled')).toBe('canceled');
    expect(krakenOrderStatus('expired')).toBe('expired');
  });
});

describe('kraken formatting helpers', () => {
  it('floors volumes and formats prices directionally', () => {
    expect(toFixedDown(0.123456789, 8)).toBe('0.12345678');
    expect(toFixedDown(0.1, 8)).toBe('0.10000000'); // epsilon guards float dust
    expect(formatKrakenPrice(96.34, 1, 'buy')).toBe('96.3');
    expect(formatKrakenPrice(103.61, 1, 'sell')).toBe('103.7');
    expect(formatKrakenPrice(100, 1, 'sell')).toBe('100.0'); // exact stays exact
  });
});
