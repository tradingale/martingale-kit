import { describe, expect, it } from 'vitest';
import { buildPlan, initialState, reconcile } from '../src/engine.js';
import { computeLadder } from '../src/ladder.js';
import type { Fill, VenueOrder } from '../src/types.js';

const params = { deltaPrice: 0.05, nbRounds: 4, multipliers: [2, 2, 2], initialBetRatio: 0.1 };
const plan = buildPlan('seq1', computeLadder(params, 1_000, 100));

const buyFill = (level: number): Fill => ({
  clientId: `seq1-buy-${level}`,
  side: 'buy',
  price: 100,
  quantity: 1,
  timestamp: level,
});

const openSell = (level: number): VenueOrder => ({
  clientId: `seq1-sell-${level}`,
  side: 'sell',
  status: 'open',
  price: 1,
  quantity: 1,
  filledQuantity: 0,
});

// Realistic snapshots include the resting limit buys (levels above the
// deepest fill); without them the engine now re-places the missing ones,
// which is exactly the day-order behavior tested separately below.
const openBuy = (level: number): VenueOrder => ({
  clientId: `seq1-buy-${level}`,
  side: 'buy',
  status: 'open',
  price: 1,
  quantity: 1,
  filledQuantity: 0,
});
const restingBuys = (deepest: number): VenueOrder[] =>
  [2, 3, 4].filter((l) => l > deepest).map(openBuy);

describe('reconcile: the one-active-sell invariant', () => {
  it('places the level 1 sell after the entry fills', () => {
    const { actions, state } = reconcile(plan, initialState(), {
      openOrders: restingBuys(1),
      fills: [buyFill(1)],
    });
    expect(actions).toEqual([
      expect.objectContaining({ type: 'placeOrder', order: expect.objectContaining({ clientId: 'seq1-sell-1' }) }),
    ]);
    expect(state.activeSellClientId).toBe('seq1-sell-1');
    expect(state.deepestFilledLevel).toBe(1);
  });

  it('on a deeper fill, cancels first and places NOTHING in the same cycle', () => {
    let state = reconcile(plan, initialState(), { openOrders: restingBuys(1), fills: [buyFill(1)] }).state;
    const cycle = reconcile(plan, state, {
      openOrders: [openSell(1), ...restingBuys(2)],
      fills: [buyFill(1), buyFill(2)],
    });
    expect(cycle.actions).toEqual([{ type: 'cancelOrder', clientId: 'seq1-sell-1' }]);
    expect(cycle.state.pendingSellLevel).toBe(2);
  });

  it('places the replacement only once the snapshot proves the cancel landed', () => {
    let state = reconcile(plan, initialState(), { openOrders: restingBuys(1), fills: [buyFill(1)] }).state;
    state = reconcile(plan, state, { openOrders: [openSell(1), ...restingBuys(2)], fills: [buyFill(1), buyFill(2)] }).state;
    const cycle = reconcile(plan, state, { openOrders: restingBuys(2), fills: [buyFill(1), buyFill(2)] });
    expect(cycle.actions).toEqual([
      expect.objectContaining({ type: 'placeOrder', order: expect.objectContaining({ clientId: 'seq1-sell-2' }) }),
    ]);
    const placed = cycle.actions[0] as Extract<(typeof cycle.actions)[number], { type: 'placeOrder' }>;
    expect(placed.order.quantity).toBeCloseTo(plan.ladder.levels[1].cumulativeQuantity, 9);
  });

  it('halts and alerts when two sells are live', () => {
    const state = reconcile(plan, initialState(), { openOrders: [], fills: [buyFill(1)] }).state;
    const cycle = reconcile(plan, state, {
      openOrders: [openSell(1), openSell(2)],
      fills: [buyFill(1)],
    });
    expect(cycle.state.phase).toBe('halted');
    expect(cycle.actions[0]).toEqual(expect.objectContaining({ type: 'alert' }));
  });

  it('is idempotent on an unchanged snapshot', () => {
    let state = reconcile(plan, initialState(), { openOrders: restingBuys(1), fills: [buyFill(1)] }).state;
    const snapshot = { openOrders: [openSell(1), ...restingBuys(1)], fills: [buyFill(1)] };
    const again = reconcile(plan, state, snapshot);
    expect(again.actions).toEqual([]);
  });

  it('re-places an expired resting buy (the day-order lesson)', () => {
    let state = reconcile(plan, initialState(), { openOrders: restingBuys(1), fills: [buyFill(1)] }).state;
    // Level 3's day order expired at the close: it is neither open nor filled.
    const cycle = reconcile(plan, state, {
      openOrders: [openSell(1), openBuy(2), openBuy(4)],
      fills: [buyFill(1)],
    });
    expect(cycle.actions).toEqual([
      expect.objectContaining({ type: 'placeOrder', order: expect.objectContaining({ clientId: 'seq1-buy-3' }) }),
    ]);
  });

  it('completes when the active sell fills', () => {
    let state = reconcile(plan, initialState(), { openOrders: [], fills: [buyFill(1)] }).state;
    const sellFill: Fill = { clientId: 'seq1-sell-1', side: 'sell', price: 105, quantity: 1, timestamp: 9 };
    const cycle = reconcile(plan, state, { openOrders: [], fills: [buyFill(1), sellFill] });
    expect(cycle.state.phase).toBe('complete');
    expect(cycle.actions).toEqual([{ type: 'complete' }]);
  });
});
