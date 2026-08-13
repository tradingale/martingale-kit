import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { publicPrice } from '../src/runner/prices.js';

// Offline mock of the two stock price sources: Alpaca's latest-trade
// endpoint and Stooq's CSV. Asserts the routing rule: Alpaca live when the
// user's keys are configured, delayed feed otherwise (and as fallback).
function mockFetch(handlers: { alpaca?: () => Response; stooq?: () => Response }) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes('data.alpaca.markets')) {
      if (handlers.alpaca) return handlers.alpaca();
      throw new Error('unexpected alpaca call');
    }
    if (url.includes('stooq.com')) {
      if (handlers.stooq) return handlers.stooq();
      throw new Error('unexpected stooq call');
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const alpacaOk = () =>
  new Response(JSON.stringify({ trade: { p: 123.45 } }), { status: 200 });
const alpacaDown = () => new Response('nope', { status: 500 });
const stooqOk = () =>
  new Response('Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-08-13,16:00:00,1,2,0.5,111.11,1000\n', { status: 200 });

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

  it('uses Alpaca live data when the keys are configured', async () => {
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

  it('falls back to the delayed feed when Alpaca errors', async () => {
    process.env.ALPACA_API_KEY_ID = 'k';
    process.env.ALPACA_API_SECRET_KEY = 's';
    vi.stubGlobal('fetch', mockFetch({ alpaca: alpacaDown, stooq: stooqOk }));
    expect(await publicPrice('AAPL', 'stock')).toBe(111.11);
  });

  it('goes straight to the delayed feed without keys', async () => {
    const f = mockFetch({ stooq: stooqOk });
    vi.stubGlobal('fetch', f);
    expect(await publicPrice('AAPL', 'stock')).toBe(111.11);
    expect(f.mock.calls.every((c) => !String(c[0]).includes('alpaca'))).toBe(true);
  });
});
