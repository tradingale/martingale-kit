// Public price feeds for the runner (no keys needed). Paper mode drives the
// PaperAdapter with real market prices; live mode uses the venue's own
// ticker. Simple REST polling: the runner reconciles on a slow loop by
// design (handbook, section 4), sub-second feeds buy nothing here.

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
 * Alpaca live stock price (latest trade) — used automatically when the user
 * has configured ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY. The data API
 * host is the same for paper and live accounts, and the free feed works
 * with any account's keys. Keys go out as headers to Alpaca only; they are
 * never logged or served.
 */
export async function alpacaStockPrice(symbol: string): Promise<number> {
  const key = process.env.ALPACA_API_KEY_ID;
  const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) throw new Error('Alpaca keys not configured');
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
 * Stooq free CSV quote for US stocks (no key required, delayed; the delay
 * is disclosed in the README and the UI). Fine for a paper runner
 * reconciling on a schedule.
 */
export async function stooqStockPrice(symbol: string): Promise<number> {
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
 * Stocks: Alpaca live when the user's keys are configured, otherwise the
 * free delayed feed.
 */
export async function publicPrice(symbol: string, assetType: 'crypto' | 'stock' = 'crypto'): Promise<number> {
  if (assetType === 'stock') {
    if (process.env.ALPACA_API_KEY_ID && process.env.ALPACA_API_SECRET_KEY) {
      try {
        return await alpacaStockPrice(symbol);
      } catch {
        return await stooqStockPrice(symbol);
      }
    }
    return stooqStockPrice(symbol);
  }
  try {
    return await binancePublicPrice(symbol);
  } catch {
    return await krakenPublicPrice(symbol);
  }
}
