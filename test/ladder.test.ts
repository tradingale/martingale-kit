import { describe, expect, it } from 'vitest';
import { budgetMin, checkLadderAgainstGrids, computeLadder, LadderError } from '../src/ladder.js';
import type { SequenceParams, VenueGrids } from '../src/types.js';

const params: SequenceParams = {
  deltaPrice: 0.08,
  nbRounds: 4,
  multipliers: [2, 2, 2],
  initialBetRatio: 0.03125,
};

describe('computeLadder', () => {
  it('spends exactly the budget', () => {
    const ladder = computeLadder(params, 10_000, 60_000);
    expect(ladder.totalCost).toBeCloseTo(10_000, 6);
  });

  it('applies multipliers to QUANTITIES, never to costs', () => {
    const ladder = computeLadder(params, 10_000, 60_000);
    const [l1, l2, l3, l4] = ladder.levels;
    // Deeper-level quantity ratios reproduce the multipliers exactly (the
    // budget scaling multiplies every deeper level by the same factor).
    expect(l3.quantity / l2.quantity).toBeCloseTo(2, 9);
    expect(l4.quantity / l3.quantity).toBeCloseTo(2, 9);
    // The classic integration bug inverted: COST ratios must be strictly
    // below the quantity multiplier, because deeper levels buy cheaper.
    expect(l3.cost / l2.cost).toBeLessThan(2);
    expect(l4.cost / l3.cost).toBeLessThan(2);
    expect(l1.quantity).toBeGreaterThan(0);
  });

  it('prices the levels on the delta grid and exits at the previous level', () => {
    const entry = 100;
    const ladder = computeLadder(params, 1_000, entry);
    const [l1, l2, l3, l4] = ladder.levels;
    expect(l1.buyPrice).toBeCloseTo(100);
    expect(l2.buyPrice).toBeCloseTo(92);
    expect(l3.buyPrice).toBeCloseTo(84);
    expect(l4.buyPrice).toBeCloseTo(76);
    expect(l1.exitPrice).toBeCloseTo(108);
    expect(l2.exitPrice).toBeCloseTo(100);
    expect(l3.exitPrice).toBeCloseTo(92);
    expect(l4.exitPrice).toBeCloseTo(84);
  });

  it('accumulates quantities for the unified exit', () => {
    const ladder = computeLadder(params, 1_000, 100);
    let running = 0;
    for (const level of ladder.levels) {
      running += level.quantity;
      expect(level.cumulativeQuantity).toBeCloseTo(running, 9);
    }
  });

  it('every completed level exits above its average cost (profitable by construction)', () => {
    const ladder = computeLadder(params, 1_000, 100);
    for (const level of ladder.levels) {
      const spent = ladder.levels.slice(0, level.level).reduce((s, l) => s + l.cost, 0);
      const proceeds = level.cumulativeQuantity * level.exitPrice;
      expect(proceeds).toBeGreaterThan(spent);
    }
  });

  it('rejects malformed parameters', () => {
    expect(() => computeLadder({ ...params, multipliers: [2, 2] }, 1_000, 100)).toThrow(LadderError);
    expect(() => computeLadder({ ...params, deltaPrice: 0 }, 1_000, 100)).toThrow(LadderError);
    expect(() => computeLadder(params, 0, 100)).toThrow(LadderError);
    expect(() => computeLadder({ ...params, deltaPrice: 0.4, nbRounds: 4, multipliers: [2, 2, 2] }, 1_000, 100)).toThrow(
      LadderError,
    );
  });
});

describe('budgetMin', () => {
  const btcGrids: VenueGrids = { priceIncrement: 0.1, qtyStep: 0.001, minOrderSize: 0.0001, minNotional: 10 };

  it('derives the BTC floor from the handbook example', () => {
    // max(0.0001, 100 * 0.001) * 60000 / 0.03 = 0.1 * 60000 / 0.03 = 200_000
    expect(budgetMin({ initialBetRatio: 0.03 }, 60_000, btcGrids)).toBeCloseTo(200_000);
    // Bare minimum (no safety steps): the raw step alone
    expect(budgetMin({ initialBetRatio: 0.03 }, 60_000, btcGrids, 1)).toBeCloseTo(2_000);
  });

  it('flags underfunded ladders instead of letting them distort', () => {
    const ladder = computeLadder({ ...params, initialBetRatio: 0.03 }, 1_000, 60_000, btcGrids);
    const problems = checkLadderAgainstGrids(ladder, btcGrids);
    expect(problems.length).toBeGreaterThan(0);
  });
});
