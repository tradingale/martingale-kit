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

/** Try Binance first, fall back to Kraken. */
export async function publicPrice(symbol: string): Promise<number> {
  try {
    return await binancePublicPrice(symbol);
  } catch {
    return await krakenPublicPrice(symbol);
  }
}
