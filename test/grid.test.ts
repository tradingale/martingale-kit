import { describe, expect, it } from 'vitest';
import { fallbackDecimals, snapPrice, snapQuantity } from '../src/grid.js';
import { computeLadder } from '../src/ladder.js';
import type { VenueGrids } from '../src/types.js';

describe('directional snapping', () => {
  it('sells snap UP, buys snap DOWN', () => {
    expect(snapPrice(0.34567, 'sell', 0.0001)).toBeCloseTo(0.3457, 9);
    expect(snapPrice(0.34567, 'buy', 0.0001)).toBeCloseTo(0.3456, 9);
  });

  it('the sub-$1 lesson: a 2-decimal grid moves a $0.35 exit by over 1%', () => {
    // This is the production bug that produced impossible negative
    // completions before per-asset increments: blind rounding to 2 decimals.
    const rawExit = 0.3535;
    const blind = Math.round(rawExit * 100) / 100; // 0.35
    expect(Math.abs(blind - rawExit) / rawExit).toBeGreaterThan(0.009);
    // Directional snapping on the venue's real grid never goes below raw.
    expect(snapPrice(rawExit, 'sell', 0.0001)).toBeGreaterThanOrEqual(rawExit);
  });

  it('quantities floor to the step, never up', () => {
    expect(snapQuantity(1.2599, 0.01)).toBeCloseTo(1.25, 9);
    expect(snapQuantity(1.2599, null)).toBeCloseTo(1.2599, 9);
  });

  it('fallback decimals scale with magnitude and cap at 9', () => {
    expect(fallbackDecimals(60_000)).toBe(2); // BTC
    expect(fallbackDecimals(0.12)).toBe(5); // DOGE
    expect(fallbackDecimals(0.00002)).toBe(9); // SHIB territory, capped
  });
});

describe('snapped ladders stay on the safe side', () => {
  it('snapping never lowers an exit nor raises a buy', () => {
    const grids: VenueGrids = { priceIncrement: 0.01, qtyStep: 0.1, minOrderSize: null, minNotional: null };
    const params = { deltaPrice: 0.07, nbRounds: 5, multipliers: [2.2, 2.4, 2.1, 2.5], initialBetRatio: 0.02 };
    const raw = computeLadder(params, 5_000, 0.3535);
    const snapped = computeLadder(params, 5_000, 0.3535, grids);
    for (let i = 0; i < raw.levels.length; i++) {
      expect(snapped.levels[i].exitPrice).toBeGreaterThanOrEqual(raw.levels[i].exitPrice - 1e-12);
      expect(snapped.levels[i].buyPrice).toBeLessThanOrEqual(raw.levels[i].buyPrice + 1e-12);
      expect(snapped.levels[i].quantity).toBeLessThanOrEqual(raw.levels[i].quantity + 1e-12);
    }
  });
});
