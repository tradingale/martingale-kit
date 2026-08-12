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
 * Stooq free CSV quote for US stocks (no key required, ~15 min delayed).
 * Delayed prices are fine for a paper runner reconciling on a schedule;
 * the delay is disclosed in the README and the UI.
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

/** Crypto: Binance first, Kraken fallback. Stocks: Stooq (delayed). */
export async function publicPrice(symbol: string, assetType: 'crypto' | 'stock' = 'crypto'): Promise<number> {
  if (assetType === 'stock') return stooqStockPrice(symbol);
  try {
    return await binancePublicPrice(symbol);
  } catch {
    return await krakenPublicPrice(symbol);
  }
}
