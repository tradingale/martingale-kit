import { describe, expect, it } from 'vitest';
import { PaperAdapter } from '../src/adapters/paper.js';
import { buildPlan, entryActions, initialState, runCycle } from '../src/engine.js';
import { computeLadder } from '../src/ladder.js';

describe('full paper run: entry, dip, sell replacement, recovery, completion', () => {
  it('runs a sequence end to end with zero keys', async () => {
    const params = { deltaPrice: 0.05, nbRounds: 4, multipliers: [2, 2, 2], initialBetRatio: 0.1 };
    const budget = 1_000;
    const entry = 100;
    const ladder = computeLadder(params, budget, entry);
    const plan = buildPlan('paper1', ladder);
    const venue = new PaperAdapter();

    // Market opens at the entry price; place the whole entry (market level 1
    // + the resting limit buys), exactly as the plan-in-database pattern says.
    venue.tick(entry);
    for (const action of entryActions(plan)) {
      if (action.type === 'placeOrder') await venue.placeOrder(action.order);
    }

    let state = initialState();
    state = await runCycle(plan, state, venue); // sees the entry fill, places sell 1
    expect(state.activeSellClientId).toBe('paper1-sell-1');

    // Price dips to level 2: the limit buy fills.
    venue.tick(95);
    state = await runCycle(plan, state, venue); // cancel sell 1 (verify next cycle)
    state = await runCycle(plan, state, venue); // cancel verified, place sell 2
    expect(state.deepestFilledLevel).toBe(2);
    expect(state.activeSellClientId).toBe('paper1-sell-2');
    const open = await venue.getOpenOrders();
    expect(open.filter((o) => o.side === 'sell')).toHaveLength(1); // the invariant, observed

    // Price recovers to the level 2 exit (the entry price): the sell fills.
    venue.tick(100);
    state = await runCycle(plan, state, venue);
    expect(state.phase).toBe('complete');

    // Profitable by construction: proceeds exceed the cost of levels 1 + 2.
    const fills = await venue.getFills();
    const bought = fills.filter((f) => f.side === 'buy').reduce((s, f) => s + f.price * f.quantity, 0);
    const sold = fills.filter((f) => f.side === 'sell').reduce((s, f) => s + f.price * f.quantity, 0);
    expect(sold).toBeGreaterThan(bought);
  });
});
