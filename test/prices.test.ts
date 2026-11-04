import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  publicPrice,
  priceNote,
  StockKeysMissingError,
  STOCK_KEYS_REQUIRED_MESSAGE,
  STOCK_KEYS_REQUIRED_SHORT,
} from '../src/runner/prices.js';

// Offline mock of the stock price source: Alpaca's latest-trade endpoint.
// Asserts the routing rule: Alpaca when the user's keys are configured, a
// typed StockKeysMissingError otherwise. Any call to Stooq (which stopped
// serving CSV in November 2026) fails the test loudly.
function mockFetch(handlers: { alpaca?: () => Response }) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes('data.alpaca.markets')) {
      if (handlers.alpaca) return handlers.alpaca();
      throw new Error('unexpected alpaca call');
    }
    if (url.includes('stooq.com')) throw new Error('unexpected stooq call');
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const alpacaOk = () =>
  new Response(JSON.stringify({ trade: { p: 123.45 } }), { status: 200 });
const alpacaDown = () => new Response('nope', { status: 500 });

describe('publicPrice stock routing', () => {
  beforeEach(() => {
    delete process.env.ALPACA_API_KEY_ID;
    delete process.env.ALPACA_API_SECRET_KEY;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ALPACA_API_KEY_ID;
    delete process.env.ALPACA_API_SECRET_KEY;
  });

  it('uses Alpaca data when the keys are configured', async () => {
    process.env.ALPACA_API_KEY_ID = 'k';
    process.env.ALPACA_API_SECRET_KEY = 's';
    const f = mockFetch({ alpaca: alpacaOk });
    vi.stubGlobal('fetch', f);
    expect(await publicPrice('AAPL', 'stock')).toBe(123.45);
    // and the keys went out as headers to Alpaca only
    const [calledUrl, calledInit] = f.mock.calls[0];
    expect(String(calledUrl)).toContain('data.alpaca.markets');
    expect(calledInit?.headers).toMatchObject({ 'APCA-API-KEY-ID': 'k' });
  });

  it('surfaces the Alpaca error instead of falling back to a keyless feed', async () => {
    process.env.ALPACA_API_KEY_ID = 'k';
    process.env.ALPACA_API_SECRET_KEY = 's';
    const f = mockFetch({ alpaca: alpacaDown });
    vi.stubGlobal('fetch', f);
    await expect(publicPrice('AAPL', 'stock')).rejects.toThrow('Alpaca data 500 for AAPL');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('refuses a stock price without keys, with the typed error and no network call', async () => {
    const f = mockFetch({});
    vi.stubGlobal('fetch', f);
    const err = await publicPrice('ARM', 'stock').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StockKeysMissingError);
    expect((err as StockKeysMissingError).code).toBe('STOCK_KEYS_MISSING');
    expect((err as Error).message).toBe(
      'US stocks need free Alpaca paper keys (ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY). Crypto works without keys.',
    );
    expect((err as Error).message).toBe(STOCK_KEYS_REQUIRED_MESSAGE);
    expect(f).not.toHaveBeenCalled();
  });

  it('refuses with only one of the two keys set', async () => {
    process.env.ALPACA_API_KEY_ID = 'k';
    const f = mockFetch({});
    vi.stubGlobal('fetch', f);
    await expect(publicPrice('AAPL', 'stock')).rejects.toBeInstanceOf(StockKeysMissingError);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('priceNote (scoreboard price column)', () => {
  it('says the keys are needed for a stock without price and without keys', () => {
    expect(priceNote('stock', null, false)).toBe(STOCK_KEYS_REQUIRED_SHORT);
    expect(priceNote('stock', undefined, false)).toBe('needs Alpaca paper keys');
  });

  it('stays null (UI dash) when keys exist but the price is unavailable', () => {
    expect(priceNote('stock', null, true)).toBeNull();
  });

  it('stays null (UI dash) for an unlisted crypto, keys or not', () => {
    expect(priceNote('crypto', null, false)).toBeNull();
    expect(priceNote('crypto', null, true)).toBeNull();
  });

  it('stays null whenever there is a price', () => {
    expect(priceNote('stock', 123.45, false)).toBeNull();
    expect(priceNote('crypto', 50000, false)).toBeNull();
  });
});
