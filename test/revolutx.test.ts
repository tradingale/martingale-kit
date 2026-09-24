// RevolutXAdapter tests. ALL OFFLINE: fetch is injected, no test touches the
// network. The signature vector is the worked example from Revolut's own
// authentication documentation, so the construction is proven without a key.
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RevolutXAdapter,
  RevolutXHttpError,
  clientIdToUuid,
  fetchRevolutXGrids,
  revolutxGridsFromPairInfo,
  revolutxOrderStatus,
  revolutxSign,
  revolutxSignatureMessage,
  toPairKey,
  toPathSymbol,
} from '../src/adapters/revolutx.js';
import type { PlannedOrder } from '../src/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DOC_BODY =
  '{"client_order_id":"3b364427-1f4f-4f66-9935-86b6fb115d26","symbol":"BTC-USD","side":"BUY","order_configuration":{"limit":{"base_size":"0.1","price":"90000.1"}}}';
const DOC_MESSAGE = `1765360896219POST/api/1.0/orders${DOC_BODY}`;

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

// Copied from the live GET /api/1.0/public/configuration/pairs on 2026-09-24.
const PAIRS = {
  'BTC/EUR': {
    base: 'BTC',
    quote: 'EUR',
    base_step: '0.00000001',
    quote_step: '0.01',
    min_order_size: '0.00000001',
    max_order_size: '200',
    min_order_size_quote: '0.1',
    max_order_size_quote: '1000000',
    status: 'active',
    slippage: 5,
  },
  'DOGE/EUR': {
    base: 'DOGE',
    quote: 'EUR',
    base_step: '0.1',
    quote_step: '0.00001',
    min_order_size: '0.1',
    max_order_size: '10000000',
    min_order_size_quote: '0.1',
    max_order_size_quote: '1000000',
    status: 'halted',
    slippage: 5,
  },
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function harness(responses: Array<{ status?: number; json: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: unknown, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body as string | undefined,
    });
    const r = responses[Math.min(i++, responses.length - 1)] ?? { json: {} };
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(r.json),
      json: async () => r.json,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function makeAdapter(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revx-'));
  return new RevolutXAdapter({
    symbol: 'BTC-EUR',
    apiKey: 'k'.repeat(64),
    privateKeyPem: PEM,
    stateDir,
    fetchImpl,
    nowFn: () => 1765360896219,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

describe('signature', () => {
  it('matches the worked example Revolut publishes, byte for byte', () => {
    expect(revolutxSignatureMessage('1765360896219', 'POST', '/api/1.0/orders', '', DOC_BODY)).toBe(
      DOC_MESSAGE
    );
  });

  it('concatenates with no separators and signs the query without its "?"', () => {
    const m = revolutxSignatureMessage('1700000000000', 'GET', '/api/1.0/orders/active', 'limit=5', '');
    expect(m).toBe('1700000000000GET/api/1.0/orders/activelimit=5');
    expect(m).not.toContain('?');
  });

  it('upper-cases the method', () => {
    expect(revolutxSignatureMessage('1', 'post', '/api/x', '', '')).toBe(
      revolutxSignatureMessage('1', 'POST', '/api/x', '', '')
    );
  });

  it('verifies under the matching public key', () => {
    const sig = revolutxSign(DOC_MESSAGE, PEM);
    expect(
      crypto.verify(null, Buffer.from(DOC_MESSAGE, 'utf8'), publicKey, Buffer.from(sig, 'base64'))
    ).toBe(true);
  });

  it('is invalidated by a one-byte change, which is why the body is serialised once', () => {
    const sig = revolutxSign(DOC_MESSAGE, PEM);
    const tampered = DOC_MESSAGE.replace('"0.1"', '"0.2"');
    expect(
      crypto.verify(null, Buffer.from(tampered, 'utf8'), publicKey, Buffer.from(sig, 'base64'))
    ).toBe(false);
  });

  it('refuses a non-Ed25519 key with an actionable message', () => {
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => revolutxSign('x', pem)).toThrow(/Ed25519/);
  });
});

// ---------------------------------------------------------------------------
// Client order ids
// ---------------------------------------------------------------------------

describe('clientIdToUuid', () => {
  it('is deterministic, which is what makes a retry idempotent', () => {
    expect(clientIdToUuid('BTC-1758700000000-buy-1')).toBe(clientIdToUuid('BTC-1758700000000-buy-1'));
  });

  it('produces a uuid the venue will accept', () => {
    expect(clientIdToUuid('BTC-1758700000000-buy-1')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('separates engine ids that differ only at the end', () => {
    expect(clientIdToUuid('BTC-1-buy-1')).not.toBe(clientIdToUuid('BTC-1-buy-2'));
  });
});

// ---------------------------------------------------------------------------
// Symbols and grids
// ---------------------------------------------------------------------------

describe('symbols', () => {
  it('uses the hyphen form for paths and payloads, the slash form for the pairs document', () => {
    expect(toPathSymbol('BTC/EUR')).toBe('BTC-EUR');
    expect(toPathSymbol('btc-eur')).toBe('BTC-EUR');
    expect(toPairKey('BTC-EUR')).toBe('BTC/EUR');
  });
});

describe('grids', () => {
  it('reads the venue steps straight off the pair', () => {
    expect(revolutxGridsFromPairInfo(PAIRS['BTC/EUR'])).toEqual({
      priceIncrement: 0.01,
      qtyStep: 0.00000001,
      minOrderSize: 0.00000001,
      minNotional: 0.1,
    });
  });

  it('fetches the pairs document, which is an OBJECT keyed by slash form', async () => {
    const { fetchImpl, calls } = harness([{ json: PAIRS }]);
    const grids = await fetchRevolutXGrids('BTC-EUR', fetchImpl);
    expect(grids.priceIncrement).toBe(0.01);
    expect(calls[0].url).toContain('/api/1.0/public/configuration/pairs');
  });

  it('refuses an unlisted pair rather than guessing', async () => {
    const { fetchImpl } = harness([{ json: PAIRS }]);
    await expect(fetchRevolutXGrids('XYZ-EUR', fetchImpl)).rejects.toThrow(/does not list/);
  });

  it('refuses a pair that is not active', async () => {
    const { fetchImpl } = harness([{ json: PAIRS }]);
    await expect(fetchRevolutXGrids('DOGE-EUR', fetchImpl)).rejects.toThrow(/halted/);
  });
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

const buy: PlannedOrder = { clientId: 'BTC-1-buy-2', side: 'buy', type: 'limit', price: 70000.5, quantity: 0.002, level: 2 };
const sell: PlannedOrder = { clientId: 'BTC-1-sell-2', side: 'sell', type: 'limit', price: 73000.25, quantity: 0.004, level: 2 };
const entry: PlannedOrder = { clientId: 'BTC-1-buy-1', side: 'buy', type: 'market', quantity: 0.001, level: 1 };

describe('placeOrder', () => {
  it('sends the signed headers the venue requires', async () => {
    const { fetchImpl, calls } = harness([{ json: { data: [{ venue_order_id: 'v1' }] } }]);
    await makeAdapter(fetchImpl).placeOrder(buy);
    const h = calls[0].headers;
    expect(h['X-Revx-API-Key']).toBe('k'.repeat(64));
    expect(h['X-Revx-Timestamp']).toBe('1765360896219');
    expect(h['X-Revx-Signature']).toBeTruthy();
  });

  it('signs exactly the body it sends', async () => {
    const { fetchImpl, calls } = harness([{ json: { data: [{ venue_order_id: 'v1' }] } }]);
    await makeAdapter(fetchImpl).placeOrder(buy);
    const sent = calls[0].body as string;
    const expected = revolutxSign(
      revolutxSignatureMessage('1765360896219', 'POST', '/api/1.0/orders', '', sent),
      PEM
    );
    expect(calls[0].headers['X-Revx-Signature']).toBe(expected);
  });

  it('rests limit orders post_only by default', async () => {
    const { fetchImpl, calls } = harness([{ json: { data: [{ venue_order_id: 'v1' }] } }]);
    await makeAdapter(fetchImpl).placeOrder(buy);
    const body = JSON.parse(calls[0].body as string);
    expect(body.order_configuration.limit.execution_instructions).toEqual(['post_only']);
    expect(body.symbol).toBe('BTC-EUR');
    expect(body.side).toBe('BUY');
    expect(body.client_order_id).toBe(clientIdToUuid('BTC-1-buy-2'));
  });

  it('allows taker fills when asked', async () => {
    const { fetchImpl, calls } = harness([{ json: { data: [{ venue_order_id: 'v1' }] } }]);
    await makeAdapter(fetchImpl, { postOnly: false }).placeOrder(buy);
    expect(JSON.parse(calls[0].body as string).order_configuration.limit.execution_instructions).toEqual([
      'allow_taker',
    ]);
  });

  it('sends a market configuration for the round 1 entry, with no price', async () => {
    const { fetchImpl, calls } = harness([{ json: { data: [{ venue_order_id: 'v1' }] } }]);
    await makeAdapter(fetchImpl).placeOrder(entry);
    const body = JSON.parse(calls[0].body as string);
    expect(body.order_configuration.market.base_size).toBe('0.001');
    expect(body.order_configuration.limit).toBeUndefined();
  });

  it('haircuts sell quantities so a taker entry cannot make the sell unsellable', async () => {
    const { fetchImpl, calls } = harness([{ json: { data: [{ venue_order_id: 'v1' }] } }]);
    await makeAdapter(fetchImpl).placeOrder(sell);
    const size = Number(JSON.parse(calls[0].body as string).order_configuration.limit.base_size);
    expect(size).toBeLessThan(0.004);
    expect(size).toBeGreaterThan(0.004 * 0.999);
  });

  it('leaves buy quantities untouched', async () => {
    const { fetchImpl, calls } = harness([{ json: { data: [{ venue_order_id: 'v1' }] } }]);
    await makeAdapter(fetchImpl).placeOrder(buy);
    expect(JSON.parse(calls[0].body as string).order_configuration.limit.base_size).toBe('0.002');
  });

  it('refuses a limit order with no price instead of sending a broken one', async () => {
    const { fetchImpl } = harness([{ json: {} }]);
    const bad = { ...buy, price: undefined } as PlannedOrder;
    await expect(makeAdapter(fetchImpl).placeOrder(bad)).rejects.toThrow(/no usable price/);
  });

  it('surfaces a venue rejection with its message', async () => {
    const { fetchImpl } = harness([{ status: 400, json: { message: 'Invalid price', error_id: 'abc' } }]);
    await expect(makeAdapter(fetchImpl).placeOrder(buy)).rejects.toThrow(/Invalid price/);
  });
});

describe('cancelOrder', () => {
  it('resolves the venue id from our client order id, then cancels', async () => {
    const uuid = clientIdToUuid('BTC-1-buy-2');
    const { fetchImpl, calls } = harness([
      { json: { data: [{ venue_order_id: 'v-42', client_order_id: uuid, state: 'new' }] } },
      { json: {} },
    ]);
    await makeAdapter(fetchImpl).cancelOrder('BTC-1-buy-2');
    expect(calls[1].method).toBe('DELETE');
    expect(calls[1].url).toContain('/api/1.0/orders/v-42');
  });

  it('is idempotent: an order already gone is a success', async () => {
    const { fetchImpl, calls } = harness([{ json: { data: [] } }]);
    await expect(makeAdapter(fetchImpl).cancelOrder('BTC-1-buy-2')).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('treats a 404 on the delete as success too', async () => {
    const uuid = clientIdToUuid('BTC-1-buy-2');
    const { fetchImpl } = harness([
      { json: { data: [{ venue_order_id: 'v-42', client_order_id: uuid }] } },
      { status: 404, json: { message: 'gone' } },
    ]);
    await expect(makeAdapter(fetchImpl).cancelOrder('BTC-1-buy-2')).resolves.toBeUndefined();
  });
});

describe('getOpenOrders', () => {
  it('maps venue orders back to engine client ids', async () => {
    const uuid = clientIdToUuid('BTC-1-buy-2');
    const { fetchImpl } = harness([
      { json: { data: [{ venue_order_id: 'v1' }] } },
      {
        json: {
          data: [
            {
              venue_order_id: 'v1',
              client_order_id: uuid,
              state: 'partially_filled',
              side: 'BUY',
              symbol: 'BTC-EUR',
              price: '70000.50',
              base_size: '0.002',
              filled_size: '0.0005',
            },
          ],
        },
      },
    ]);
    const adapter = makeAdapter(fetchImpl);
    await adapter.placeOrder(buy); // teaches the adapter the reverse mapping
    const open = await adapter.getOpenOrders();
    expect(open).toEqual([
      { clientId: 'BTC-1-buy-2', side: 'buy', status: 'open', price: 70000.5, quantity: 0.002, filledQuantity: 0.0005 },
    ]);
  });

  it('ignores orders on another instrument', async () => {
    const { fetchImpl } = harness([
      { json: { data: [{ venue_order_id: 'v9', client_order_id: 'x', symbol: 'ETH-EUR', state: 'new' }] } },
    ]);
    expect(await makeAdapter(fetchImpl).getOpenOrders()).toEqual([]);
  });
});

describe('status mapping', () => {
  it('maps the venue states onto the engine five states', () => {
    expect(revolutxOrderStatus('new')).toBe('open');
    expect(revolutxOrderStatus('partially_filled')).toBe('open');
    expect(revolutxOrderStatus('filled')).toBe('filled');
    expect(revolutxOrderStatus('cancelled')).toBe('canceled');
    expect(revolutxOrderStatus('expired')).toBe('expired');
    expect(revolutxOrderStatus('rejected')).toBe('rejected');
  });

  it('treats an unknown state as still working rather than assuming it is done', () => {
    expect(revolutxOrderStatus('something_new')).toBe('open');
    expect(revolutxOrderStatus(undefined)).toBe('open');
  });
});

describe('construction', () => {
  it('refuses to start without credentials rather than failing at the venue', () => {
    expect(
      () => new RevolutXAdapter({ symbol: 'BTC-EUR', apiKey: '', privateKeyPem: PEM })
    ).toThrow(/API key missing/);
  });

  it('surfaces http errors as RevolutXHttpError with the status', async () => {
    const { fetchImpl } = harness([{ status: 401, json: { message: 'bad signature' } }]);
    const err = await makeAdapter(fetchImpl)
      .getOpenOrders()
      .catch((e) => e);
    expect(err).toBeInstanceOf(RevolutXHttpError);
    expect(err.status).toBe(401);
  });
});
