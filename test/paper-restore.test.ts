import { describe, it, expect } from 'vitest';
import { PaperAdapter } from '../src/adapters/paper.js';
import { buildPlan, entryActions, initialState, reconcile } from '../src/engine.js';
import { computeLadder } from '../src/ladder.js';
import type { SequenceParams } from '../src/types.js';

const params: SequenceParams = {
  symbol: 'BTC',
  deltaPrice: 0.08,
  nbRounds: 4,
  multipliers: [2, 2, 2],
  initialBetRatio: 0.05,
};

// The simulated book lives in memory. A one-shot `cycle` spawns a fresh
// process, so the runner persists which orders were still resting; without
// that list the rebuilt adapter sees no active sell and places a duplicate.
describe('paper book survives a process restart', () => {
  it('does not re-place the active sell when open ids are restored', async () => {
    const ladder = computeLadder(params, 10_000, 100);
    const plan = buildPlan('BTC-1', ladder);

    const first = new PaperAdapter();
    first.tick(100);
    for (const a of entryActions(plan)) if (a.type === 'placeOrder') await first.placeOrder(a.order);
    let state = initialState();
    const snap1 = { openOrders: await first.getOpenOrders(), fills: await first.getFills() };
    const pass1 = reconcile(plan, state, snap1);
    for (const a of pass1.actions) if (a.type === 'placeOrder') await first.placeOrder(a.order);
    state = pass1.state;

    const fills = await first.getFills();
    const openIds = (await first.getOpenOrders()).map((o) => o.clientId);
    expect(openIds.some((id) => id.includes('sell'))).toBe(true);

    // New process: with the open ids, the next cycle has nothing to place.
    const revived = new PaperAdapter();
    revived.restore(plan, fills, openIds);
    revived.tick(100);
    const pass2 = reconcile(plan, state, {
      openOrders: await revived.getOpenOrders(),
      fills: await revived.getFills(),
    });
    expect(pass2.actions.filter((a) => a.type === 'placeOrder')).toHaveLength(0);

    // Without them (the old behavior), the sell is placed again.
    const naive = new PaperAdapter();
    naive.restore(plan, fills);
    naive.tick(100);
    const pass3 = reconcile(plan, state, {
      openOrders: await naive.getOpenOrders(),
      fills: await naive.getFills(),
    });
    expect(pass3.actions.filter((a) => a.type === 'placeOrder').length).toBeGreaterThan(0);
  });
});
