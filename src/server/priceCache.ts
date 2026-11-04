// Display price cache for the web runner. /api/state never awaits the
// network (it doubles as the deploy healthcheck): it serves cached prices
// and refreshes them in the background.
//
// Keyed by asset type AND symbol, and always fetched through the asset's
// own path: a stock sequence's price goes through the stock source (Alpaca,
// keys required), never through the crypto tickers, even when a crypto
// shares its ticker. Kept out of src/server/index.ts (which starts the
// server on import) so it can be tested.

import type { SequenceStatus } from '../runner/core.js';

export type AssetType = 'crypto' | 'stock';
export type PriceFetcher = (symbol: string, assetType: AssetType) => Promise<number>;

export const PRICE_TTL_MS = 25 * 1000;

export interface PriceCache {
  /** Cached price (or null), refreshing it in the background when stale. */
  cachedPrice(symbol: string, assetType: AssetType): number | null;
  /** Cached price (or null) without triggering any fetch. */
  peek(symbol: string, assetType: AssetType): number | null;
  set(symbol: string, assetType: AssetType, price: number): void;
}

export function createPriceCache(fetcher: PriceFetcher, now: () => number = Date.now): PriceCache {
  const cache = new Map<string, { price: number; at: number }>();
  const inflight = new Set<string>();
  const keyOf = (symbol: string, assetType: AssetType) => `${assetType}:${symbol}`;

  return {
    cachedPrice(symbol, assetType) {
      const key = keyOf(symbol, assetType);
      const hit = cache.get(key);
      const fresh = hit && now() - hit.at < PRICE_TTL_MS;
      if (!fresh && !inflight.has(key)) {
        inflight.add(key);
        fetcher(symbol, assetType)
          .then((price) => cache.set(key, { price, at: now() }))
          .catch(() => undefined)
          .finally(() => inflight.delete(key));
      }
      return hit ? hit.price : null;
    },
    peek(symbol, assetType) {
      return cache.get(keyOf(symbol, assetType))?.price ?? null;
    },
    set(symbol, assetType, price) {
      cache.set(keyOf(symbol, assetType), { price, at: now() });
    },
  };
}

/** Sequences for /api/state, each with its display price from its own asset path. */
export function sequencesWithDisplayPrices(statuses: SequenceStatus[], cache: PriceCache): SequenceStatus[] {
  return statuses.map((s) => {
    const cached = cache.cachedPrice(s.symbol, s.assetType);
    return { ...s, lastPrice: cached ?? s.lastPrice };
  });
}
