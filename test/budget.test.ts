import { describe, expect, it } from 'vitest';
import { checkLadderAgainstGrids, computeLadder, LadderError, rescaleAfterEntry } from '../src/ladder.js';
import { awaitEntryFill } from '../src/runner/core.js';
import type { Fill, Ladder, SequenceParams, VenueGrids } from '../src/types.js';

// The budget guarantee, checked over a deterministic grid (no property-test
// dependency). Level 1 is a market buy: it can fill ABOVE the price used to
// size it, and the API's initial_bet_ratio is rounded (here: rounded up, the
// direction that grows level 1). Whatever the combination, what the plan
// commits to (level 1 at its fill price + every limit buy) must stay within
// the budget, and the venue minimums must hold or the plan be refused.
//
// Tolerance: unsnapped ladders are plain floating point; 1e-9 of the budget
// absorbs that dust and nothing else (the bug this guards against was 3e-3).
const TOLERANCE = 1e-9;

const SLIPPAGES = [0, 0.005, 0.01, 0.03];
const IBR_ROUNDED_UP = [0, 0.01, 0.02];
const BUDGETS = [137, 500, 1_000, 10_000, 250_000];
const PRICES = [0.0123, 0.4567, 3.21, 187.3, 67_890.12];
const DELTAS = [0.03, 0.08, 0.15];
const IBRS = [0.03125, 0.0625, 0.1];
const STRUCTURES: Array<[number, number[]]> = [
  [4, [2, 2, 2]],
  [5, [1.5, 2, 2.5, 3]],
  [4, [1.2, 1.8, 2.7]],
];
const GRIDS: Array<VenueGrids | undefined> = [
  undefined,
  { priceIncrement: 0.0001, qtyStep: 0.00000001, minOrderSize: null, minNotional: null },
  { priceIncrement: 0.01, qtyStep: 0.001, minOrderSize: null, minNotional: null },
  { priceIncrement: 0.1, qtyStep: 1, minOrderSize: null, minNotional: null },
  // Venue minimums, so the refusal branch is exercised too.
  { priceIncrement: 0.01, qtyStep: 0.0001, minOrderSize: 0.01, minNotional: 5 },
  { priceIncrement: 0.0001, qtyStep: 0.01, minOrderSize: 1, minNotional: 10 },
];

const committed = (ladder: Ladder): number =>
  ladder.levels.reduce((sum, l) => sum + l.quantity * l.buyPrice, 0);

describe('budget guarantee after the level 1 market fill', () => {
  it('never commits more than the budget, and never silently breaks venue minimums', () => {
    let checked = 0;
    let refused = 0;
    let shrunk = 0;
    for (const slip of SLIPPAGES) for (const up of IBR_ROUNDED_UP) for (const budget of BUDGETS)
    for (const entry of PRICES) for (const deltaPrice of DELTAS) for (const [nbRounds, multipliers] of STRUCTURES)
    for (const grids of GRIDS) for (const ibr of IBRS) {
      const params: SequenceParams = { deltaPrice, nbRounds, multipliers, initialBetRatio: ibr * (1 + up) };
      let planned: Ladder;
      try {
        planned = computeLadder(params, budget, entry, grids);
      } catch (error) {
        expect(error).toBeInstanceOf(LadderError);
        continue;
      }
      // The runner refuses to start on a failed pre-start check; skip those.
      if (grids && checkLadderAgainstGrids(planned, grids).length > 0) continue;

      const fill = { price: entry * (1 + slip), quantity: planned.levels[0].quantity };
      const label = JSON.stringify({ slip, up, budget, entry, deltaPrice, nbRounds, grids, ibr });
      let ladder: Ladder;
      try {
        ladder = rescaleAfterEntry(planned, fill, grids);
      } catch (error) {
        // Refused, loudly: acceptable. Silently overspending is not.
        expect(error, label).toBeInstanceOf(LadderError);
        refused++;
        continue;
      }
      checked++;
      if (ladder.levels[1].quantity < planned.levels[1].quantity) shrunk++;

      expect(ladder.levels[0].cost, label).toBeCloseTo(fill.quantity * fill.price, 9);
      expect(committed(ladder), label).toBeLessThanOrEqual(budget * (1 + TOLERANCE));
      if (grids) expect(checkLadderAgainstGrids(ladder, grids), label).toEqual([]);

      // Prices are never recomputed from the fill.
      ladder.levels.slice(1).forEach((l, i) => {
        expect(l.buyPrice, label).toBe(planned.levels[i + 1].buyPrice);
        expect(l.exitPrice, label).toBe(planned.levels[i + 1].exitPrice);
      });
      // Multipliers still scale quantities (exact without grid flooring).
      if (!grids) {
        for (let n = 2; n < nbRounds; n++) {
          expect(ladder.levels[n].quantity / ladder.levels[n - 1].quantity, label).toBeCloseTo(multipliers[n - 1], 9);
        }
      }
      // A fill at the entry price changes nothing (unsnapped: up to float dust).
      if (slip === 0) {
        ladder.levels.forEach((l, i) => {
          expect(Math.abs(l.quantity / planned.levels[i].quantity - 1), label).toBeLessThanOrEqual(TOLERANCE);
        });
      }
    }
    // The grid really ran the interesting branches.
    expect(checked).toBeGreaterThan(10_000);
    expect(shrunk).toBeGreaterThan(1_000);
    expect(refused).toBeGreaterThan(0);
  });

  it('reproduces the reported overspend without the fit, and removes it with it', () => {
    const params = { deltaPrice: 0.03, nbRounds: 4, multipliers: [2, 2, 2], initialBetRatio: 0.102 };
    const planned = computeLadder(params, 500, 0.0123);
    const fill = { price: 0.0123 * 1.03, quantity: planned.levels[0].quantity };
    const naive = fill.quantity * fill.price + planned.levels.slice(1).reduce((s, l) => s + l.cost, 0);
    expect(naive).toBeCloseTo(501.53, 2); // budget * ratio * slippage = 1.53 over
    expect(committed(rescaleAfterEntry(planned, fill))).toBeLessThanOrEqual(500 * (1 + TOLERANCE));
  });

  it('refuses when level 1 alone used the budget', () => {
    const planned = computeLadder({ deltaPrice: 0.05, nbRounds: 4, multipliers: [2, 2, 2], initialBetRatio: 0.5 }, 1_000, 100);
    expect(() => rescaleAfterEntry(planned, { price: 200, quantity: planned.levels[0].quantity })).toThrow(LadderError);
  });
});

describe('awaitEntryFill', () => {
  const fill = (price: number, quantity: number, clientId = 's-buy-1'): Fill =>
    ({ clientId, side: 'buy', price, quantity, timestamp: 0 });

  it('volume-weights partial fills of the entry and ignores other orders', async () => {
    const venue = { getFills: async () => [fill(100, 1), fill(103, 3), fill(50, 9, 's-buy-2')] };
    expect(await awaitEntryFill(venue, 's-buy-1', false)).toEqual({ price: 102.25, quantity: 4 });
  });

  it('polls a live venue until the fill shows up, and gives up with null', async () => {
    let calls = 0;
    const late = { getFills: async () => (++calls >= 3 ? [fill(100, 1)] : []) };
    expect(await awaitEntryFill(late, 's-buy-1', true, 5, 0)).toEqual({ price: 100, quantity: 1 });
    const never = { getFills: async () => [] };
    expect(await awaitEntryFill(never, 's-buy-1', true, 3, 0)).toBeNull();
  });
});
