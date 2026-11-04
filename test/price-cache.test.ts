import { describe, it, expect, vi } from 'vitest';
import { createPriceCache, sequencesWithDisplayPrices, type AssetType } from '../src/server/priceCache.js';
import { sequenceAssetType, type SequenceStatus } from '../src/runner/core.js';

// The dashboard's display price for a sequence must go through the
// sequence's own asset path: a stock sequence never resolves through the
// crypto tickers (it used to, because the asset type was not passed).
function status(symbol: string, assetType: AssetType, lastPrice: number | null): SequenceStatus {
  return {
    sequenceId: `${symbol}-1`,
    symbol,
    venue: 'paper',
    assetType,
    phase: 'running',
    haltReason: null,
    budget: 1000,
    createdAt: '2026-11-04T00:00:00.000Z',
    deepestFilledLevel: 0,
    totalLevels: 4,
    entryPrice: 100,
    deltaPrice: 0.08,
    lastPrice,
    lastCycleAt: null,
    lastAction: null,
    levels: [],
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('display prices for /api/state', () => {
  it('fetches each sequence through its own asset type', async () => {
    const fetcher = vi.fn(async (_symbol: string, assetType: AssetType) => (assetType === 'stock' ? 150 : 50_000));
    const cache = createPriceCache(fetcher);
    const seqs = [status('ARM', 'stock', 140), status('BTC', 'crypto', 49_000)];

    // First call: nothing cached yet, so the plan file's lastPrice shows.
    const first = sequencesWithDisplayPrices(seqs, cache);
    expect(first.map((s) => s.lastPrice)).toEqual([140, 49_000]);
    expect(fetcher).toHaveBeenCalledWith('ARM', 'stock');
    expect(fetcher).toHaveBeenCalledWith('BTC', 'crypto');
    expect(fetcher).not.toHaveBeenCalledWith('ARM', 'crypto');

    await flush();
    const second = sequencesWithDisplayPrices(seqs, cache);
    expect(second.map((s) => s.lastPrice)).toEqual([150, 50_000]);
  });

  it('keeps a stock and a crypto with the same ticker apart', () => {
    const cache = createPriceCache(async () => 0);
    cache.set('COIN', 'stock', 250);
    expect(cache.peek('COIN', 'stock')).toBe(250);
    expect(cache.peek('COIN', 'crypto')).toBeNull();
  });

  it('falls back to lastPrice when the stock path fails (no Alpaca keys)', async () => {
    const cache = createPriceCache(async () => {
      throw new Error('keys missing');
    });
    sequencesWithDisplayPrices([status('ARM', 'stock', 140)], cache);
    await flush();
    expect(sequencesWithDisplayPrices([status('ARM', 'stock', 140)], cache)[0].lastPrice).toBe(140);
  });
});

describe('sequenceAssetType', () => {
  it('uses the plan file value, else Alpaca means stock and anything else crypto', () => {
    expect(sequenceAssetType({ assetType: 'stock', venue: 'paper' })).toBe('stock');
    expect(sequenceAssetType({ venue: 'alpaca' })).toBe('stock');
    expect(sequenceAssetType({ venue: 'paper' })).toBe('crypto');
    expect(sequenceAssetType({ venue: 'kraken' })).toBe('crypto');
  });
});
