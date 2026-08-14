import { describe, it, expect } from 'vitest';
import { computeLadder } from '../src/ladder.js';
import type { SequenceParams } from '../src/types.js';

// The custom editor's contract, exercised through the same math the runner
// uses: 4 or 5 rounds, 5%-15% spacing, and exactly rounds - 1 multipliers.
// (The clamping itself lives in core.applyCustom; here we prove the ladder
// honors a well-formed custom structure.)
const base: SequenceParams = {
  symbol: 'BTC',
  deltaPrice: 0.08,
  nbRounds: 4,
  multipliers: [2, 2, 2],
  initialBetRatio: 0.05,
};

describe('custom structures', () => {
  it('5 rounds needs 4 multipliers and yields 5 levels', () => {
    const ladder = computeLadder({ ...base, nbRounds: 5, multipliers: [2, 2, 2, 2] }, 10_000, 100);
    expect(ladder.levels).toHaveLength(5);
  });

  it('spacing drives the level prices', () => {
    const tight = computeLadder({ ...base, deltaPrice: 0.05 }, 10_000, 100);
    const wide = computeLadder({ ...base, deltaPrice: 0.15 }, 10_000, 100);
    expect(tight.levels[1].buyPrice).toBeCloseTo(95, 6); // 100 * (1 - 0.05)
    expect(wide.levels[1].buyPrice).toBeCloseTo(85, 6); // 100 * (1 - 0.15)
  });

  it('multipliers set the ratio between deeper levels (quantities, not cost)', () => {
    const ladder = computeLadder({ ...base, multipliers: [3, 3, 3] }, 10_000, 100);
    const [, l2, l3, l4] = ladder.levels;
    expect(l3.quantity / l2.quantity).toBeCloseTo(3, 6);
    expect(l4.quantity / l3.quantity).toBeCloseTo(3, 6);
  });

  it('the whole budget is deployed whatever the custom structure', () => {
    const ladder = computeLadder({ ...base, nbRounds: 5, multipliers: [2.5, 2.5, 2.5, 2.5] }, 8_000, 250);
    expect(ladder.totalCost).toBeCloseTo(8_000, 6);
  });
});
