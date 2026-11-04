// Price feeds for the runner. Paper mode drives the PaperAdapter with real
// market prices; live mode uses the venue's own ticker. Simple REST polling:
// the runner reconciles on a slow loop by design (handbook, section 4),
// sub-second feeds buy nothing here.
//
// Crypto needs no keys (public Binance / Kraken tickers). US stocks need the
// user's free Alpaca paper keys (ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY),
// used for market DATA only: in paper mode orders stay simulated. There is no
// keyless stock fallback on purpose. The free CSV feed we used (Stooq) stopped
// serving CSV in November 2026, and we do not scrape unofficial sources.

/** The one message shown wherever a stock price is asked for without keys. */
export const STOCK_KEYS_REQUIRED_MESSAGE =
  'US stocks need free Alpaca paper keys (ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY). Crypto works without keys.';

/** Short form for the scoreboard price column. */
export const STOCK_KEYS_REQUIRED_SHORT = 'needs Alpaca paper keys';

/** Thrown when a US stock price is requested without Alpaca keys. */
export class StockKeysMissingError extends Error {
  readonly code = 'STOCK_KEYS_MISSING';
  constructor() {
    super(STOCK_KEYS_REQUIRED_MESSAGE);
    this.name = 'StockKeysMissingError';
  }
}

/** Presence only: both Alpaca key env vars are set. */
export function hasAlpacaKeys(): boolean {
  return Boolean(process.env.ALPACA_API_KEY_ID && process.env.ALPACA_API_SECRET_KEY);
}

/**
 * What the scoreboard shows in place of a missing price: the short keys
 * message for a stock when the Alpaca keys are absent, null otherwise (the
 * UI then shows a dash: the price is genuinely unavailable, e.g. a crypto
 * no public venue lists).
 */
export function priceNote(
  assetType: 'crypto' | 'stock',
  price: number | null | undefined,
  alpacaKeys: boolean,
): string | null {
  if (price !== null && price !== undefined) return null;
  if (assetType === 'stock' && !alpacaKeys) return STOCK_KEYS_REQUIRED_SHORT;
  return null;
}

export type PriceSource = (symbol: string) => Promise<number>;

/** Binance public ticker (crypto). Symbol like "BTC" -> BTCUSDC. */
export async function binancePublicPrice(symbol: string): Promise<number> {
  const res = await fetch(
    `https://api.binance.com/api/v3/ticker/price?symbol=${symbol.toUpperCase()}USDC`,
  );
  if (!res.ok) throw new Error(`Binance ticker ${res.status} for ${symbol}`);
  const body = (await res.json()) as { price: string };
  return parseFloat(body.price);
}

/** Kraken public ticker (crypto). Handles XBT/XDG naming quirks. */
export async function krakenPublicPrice(symbol: string): Promise<number> {
  const map: Record<string, string> = { BTC: 'XBT', DOGE: 'XDG' };
  const s = map[symbol.toUpperCase()] ?? symbol.toUpperCase();
  const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${s}USD`);
  if (!res.ok) throw new Error(`Kraken ticker ${res.status} for ${symbol}`);
  const body = (await res.json()) as { error: string[]; result: Record<string, { c: [string, string] }> };
  if (body.error?.length) throw new Error(`Kraken: ${body.error.join(', ')}`);
  const first = Object.values(body.result)[0];
  if (!first) throw new Error(`Kraken: no pair for ${symbol}`);
  return parseFloat(first.c[0]);
}

/**
 * Bulk crypto prices for a whole catalog in TWO public calls (no keys):
 * Binance's all-tickers snapshot (USDC first, USDT as fallback quote) and
 * Kraken's all-tickers snapshot for whatever Binance does not list. Symbols
 * on neither venue simply stay absent from the map — the UI shows a dash
 * rather than inventing a price.
 */
export async function bulkCryptoPrices(symbols: string[]): Promise<Map<string, number>> {
  const wanted = new Set(symbols.map((s) => s.toUpperCase()));
  const out = new Map<string, number>();

  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price');
    if (res.ok) {
      const rows = (await res.json()) as { symbol: string; price: string }[];
      const byPair = new Map(rows.map((r) => [r.symbol, Number(r.price)]));
      for (const symbol of wanted) {
        const price = byPair.get(`${symbol}USDC`) ?? byPair.get(`${symbol}USDT`);
        if (Number.isFinite(price) && (price as number) > 0) out.set(symbol, price as number);
      }
    }
  } catch {
    /* Binance unreachable: Kraken below still fills what it can */
  }

  const missing = [...wanted].filter((s) => !out.has(s));
  if (missing.length === 0) return out;

  try {
    const res = await fetch('https://api.kraken.com/0/public/Ticker');
    if (res.ok) {
      const body = (await res.json()) as { result?: Record<string, { c?: string[] }> };
      const result = body.result ?? {};
      for (const symbol of missing) {
        // Kraken keys are mostly `${SYMBOL}USD`; legacy assets carry the
        // X/Z prefixes, and BTC is XBT there.
        const base = symbol === 'BTC' ? 'XBT' : symbol;
        const entry =
          result[`${base}USD`] ?? result[`X${base}ZUSD`] ?? result[`${base}ZUSD`] ?? result[`X${base}USD`];
        const price = Number(entry?.c?.[0]);
        if (Number.isFinite(price) && price > 0) out.set(symbol, price);
      }
    }
  } catch {
    /* both venues unreachable: the map stays partial, callers show dashes */
  }

  return out;
}

/**
 * Bulk US stock prices via Alpaca's snapshots endpoint (one call for the
 * whole list) when the user's Alpaca keys are configured. Without keys
 * the map comes back empty and the scoreboard says the keys are needed
 * (see priceNote).
 */
export async function bulkStockPrices(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const key = process.env.ALPACA_API_KEY_ID;
  const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret || symbols.length === 0) return out;
  try {
    const res = await fetch(
      `https://data.alpaca.markets/v2/stocks/snapshots?symbols=${symbols.map((s) => s.toUpperCase()).join(',')}`,
      { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } },
    );
    if (!res.ok) return out;
    const body = (await res.json()) as Record<string, { latestTrade?: { p?: number }; dailyBar?: { c?: number } }>;
    for (const [symbol, snap] of Object.entries(body)) {
      const price = Number(snap?.latestTrade?.p ?? snap?.dailyBar?.c);
      if (Number.isFinite(price) && price > 0) out.set(symbol.toUpperCase(), price);
    }
  } catch {
    /* leave empty: per-symbol resolution still works on click */
  }
  return out;
}

/**
 * Alpaca stock price (latest trade), the only stock price source. Needs the
 * user's ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY (free paper keys work). The data API
 * host is the same for paper and live accounts, and the free feed works
 * with any account's keys. Keys go out as headers to Alpaca only; they are
 * never logged or served.
 */
export async function alpacaStockPrice(symbol: string): Promise<number> {
  const key = process.env.ALPACA_API_KEY_ID;
  const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) throw new StockKeysMissingError();
  const res = await fetch(
    `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol.toUpperCase())}/trades/latest`,
    { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } },
  );
  if (!res.ok) throw new Error(`Alpaca data ${res.status} for ${symbol}`);
  const body = (await res.json()) as { trade?: { p?: number } };
  const price = Number(body.trade?.p);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Alpaca: no trade for ${symbol}`);
  return price;
}

/**
 * UNUSED, kept for reference. Stooq stopped serving CSV in November 2026
 * (the endpoint now answers a 404 HTML anti-bot page), so stocks need
 * Alpaca keys instead. Not exported and not called anywhere.
 */
async function stooqStockPrice(symbol: string): Promise<number> {
  const res = await fetch(
    `https://stooq.com/q/l/?s=${symbol.toLowerCase()}.us&f=sd2t2ohlcv&h&e=csv`,
  );
  if (!res.ok) throw new Error(`Stooq ${res.status} for ${symbol}`);
  const lines = (await res.text()).trim().split('\n');
  const close = lines[1]?.split(',')[6];
  const price = parseFloat(close ?? '');
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Stooq: no quote for ${symbol}`);
  return price;
}

/**
 * Crypto: Binance first, Kraken fallback (public tickers, live, no keys).
 * Stocks: Alpaca with the user's keys; without them, a StockKeysMissingError
 * (thrown before any network call). No keyless stock fallback.
 */
export async function publicPrice(symbol: string, assetType: 'crypto' | 'stock' = 'crypto'): Promise<number> {
  if (assetType === 'stock') {
    if (!hasAlpacaKeys()) throw new StockKeysMissingError();
    return alpacaStockPrice(symbol);
  }
  try {
    return await binancePublicPrice(symbol);
  } catch {
    return await krakenPublicPrice(symbol);
  }
}
