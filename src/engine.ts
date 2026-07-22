// The sequence engine: plan-in-database pattern + the one-active-sell
// invariant, expressed as PURE functions. The engine never talks to a venue;
// it looks at the plan, the last known state and a fresh venue snapshot, and
// returns the minimal list of actions to take. Adapters execute actions.
//
// Cancel-verify-place is encoded structurally: when the active sell must
// move to a deeper level, the engine first emits ONLY the cancel; the
// replacement sell is emitted on a later cycle, once the snapshot proves the
// old sell is gone. Two sells can never coexist by construction.
//
// Handbook sections 1, 3 and 4:
// https://tradingale.com/handbook/sequence-automation.md

import type { Fill, Ladder, PlannedOrder, VenueOrder } from './types.js';

/** The persisted plan: write this to YOUR database before placing anything. */
export interface SequencePlan {
  sequenceId: string;
  ladder: Ladder;
  /** Every order the sequence will ever need, templates included. */
  orders: PlannedOrder[];
}

export type SequencePhase = 'running' | 'complete' | 'halted';

/** The engine's persisted state. Store it next to the plan; never in memory only. */
export interface SequenceState {
  phase: SequencePhase;
  /** Deepest level whose buy has filled (0 = nothing filled yet). */
  deepestFilledLevel: number;
  /** clientId of the sell the engine believes is (or was) live. */
  activeSellClientId: string | null;
  /** Level whose sell is pending placement after a verified cancel. */
  pendingSellLevel: number | null;
  /** Reason when phase is 'halted'. */
  haltReason: string | null;
}

export type EngineAction =
  | { type: 'placeOrder'; order: PlannedOrder }
  | { type: 'cancelOrder'; clientId: string }
  | { type: 'alert'; message: string }
  | { type: 'complete' };

export interface VenueSnapshot {
  openOrders: VenueOrder[];
  fills: Fill[];
}

/** Build the persisted plan from a computed ladder. */
export function buildPlan(sequenceId: string, ladder: Ladder): SequencePlan {
  const orders: PlannedOrder[] = [];
  for (const level of ladder.levels) {
    orders.push({
      clientId: `${sequenceId}-buy-${level.level}`,
      side: 'buy',
      type: level.level === 1 ? 'market' : 'limit',
      price: level.level === 1 ? undefined : level.buyPrice,
      quantity: level.quantity,
      level: level.level,
    });
    // Sell templates: one per level, covering the cumulative quantity.
    // Never sent as-is; the engine places the one matching the deepest fill.
    orders.push({
      clientId: `${sequenceId}-sell-${level.level}`,
      side: 'sell',
      type: 'limit',
      price: level.exitPrice,
      quantity: level.cumulativeQuantity,
      level: level.level,
    });
  }
  return { sequenceId, ladder, orders };
}

export function initialState(): SequenceState {
  return {
    phase: 'running',
    deepestFilledLevel: 0,
    activeSellClientId: null,
    pendingSellLevel: null,
    haltReason: null,
  };
}

/** The initial orders to place when the sequence starts: the market entry and every limit buy. */
export function entryActions(plan: SequencePlan): EngineAction[] {
  return plan.orders
    .filter((o) => o.side === 'buy')
    .map((order) => ({ type: 'placeOrder' as const, order }));
}

function sellTemplate(plan: SequencePlan, level: number): PlannedOrder | undefined {
  return plan.orders.find((o) => o.side === 'sell' && o.level === level);
}

/**
 * One reconciliation step. Pure: same inputs, same outputs, no side effects.
 * Feed it the persisted plan + state and a fresh venue snapshot; execute the
 * returned actions through your adapter; persist the returned state.
 */
export function reconcile(
  plan: SequencePlan,
  state: SequenceState,
  snapshot: VenueSnapshot,
): { actions: EngineAction[]; state: SequenceState } {
  if (state.phase !== 'running') return { actions: [], state };

  const actions: EngineAction[] = [];
  const next: SequenceState = { ...state };
  const buyIds = new Set(plan.orders.filter((o) => o.side === 'buy').map((o) => o.clientId));

  // 0. Safety: the invariant says at most ONE live sell. Two means a past
  //    action was double-applied (overlapping runs?): halt, human eyes needed.
  const openSells = snapshot.openOrders.filter((o) => o.side === 'sell' && o.status === 'open');
  if (openSells.length > 1) {
    next.phase = 'halted';
    next.haltReason = `invariant violation: ${openSells.length} live sell orders`;
    actions.push({ type: 'alert', message: next.haltReason });
    return { actions, state: next };
  }

  // 1. Completion: the active sell filled.
  const sellFill = snapshot.fills.find(
    (f) => f.side === 'sell' && f.clientId === state.activeSellClientId,
  );
  if (sellFill) {
    next.phase = 'complete';
    next.activeSellClientId = null;
    next.pendingSellLevel = null;
    actions.push({ type: 'complete' });
    return { actions, state: next };
  }

  // 2. Detect newly filled buys from the snapshot.
  let deepest = state.deepestFilledLevel;
  for (const fill of snapshot.fills) {
    if (fill.side !== 'buy' || !buyIds.has(fill.clientId)) continue;
    const planned = plan.orders.find((o) => o.clientId === fill.clientId)!;
    if (planned.level > deepest) deepest = planned.level;
  }
  next.deepestFilledLevel = deepest;

  // 2b. Day-order venues expire resting buys (Alpaca stock 'day' orders at
  // market close, our production lesson): re-place any deeper planned limit
  // buy that is neither open nor filled. Adapters whose venue rejects
  // clientId reuse may suffix it and match by prefix.
  const openIds = new Set(snapshot.openOrders.map((o) => o.clientId));
  const filledIds = new Set(snapshot.fills.map((f) => f.clientId));
  for (const planned of plan.orders) {
    if (planned.side !== 'buy' || planned.type !== 'limit') continue;
    if (planned.level <= deepest) continue;
    if (openIds.has(planned.clientId) || filledIds.has(planned.clientId)) continue;
    actions.push({ type: 'placeOrder', order: planned });
  }

  if (deepest === 0) return { actions, state: next }; // entry not filled yet

  const openSell = openSells[0] ?? null;
  const targetTemplate = sellTemplate(plan, deepest);
  if (!targetTemplate) {
    next.phase = 'halted';
    next.haltReason = `missing sell template for level ${deepest}`;
    actions.push({ type: 'alert', message: next.haltReason });
    return { actions, state: next };
  }

  // 3. The one-active-sell invariant, cancel-verify-place.
  if (openSell && openSell.clientId !== targetTemplate.clientId) {
    // A stale sell is live: cancel it NOW, place nothing. The replacement
    // goes out on a later cycle, once the snapshot proves the cancel landed.
    actions.push({ type: 'cancelOrder', clientId: openSell.clientId });
    next.pendingSellLevel = deepest;
    return { actions, state: next };
  }

  if (!openSell) {
    // No sell is live (fresh entry, or a verified cancel): place the target.
    actions.push({ type: 'placeOrder', order: targetTemplate });
    next.activeSellClientId = targetTemplate.clientId;
    next.pendingSellLevel = null;
    return { actions, state: next };
  }

  // The live sell already matches the deepest fill: nothing to do.
  next.activeSellClientId = openSell.clientId;
  next.pendingSellLevel = null;
  return { actions, state: next };
}

/**
 * Convenience runner for one reconciliation cycle against an adapter:
 * snapshot, reconcile, execute, return the new state. Guard against
 * overlapping invocations yourself (lock or run marker): two concurrent
 * cycles are exactly how duplicate sells happen.
 */
export async function runCycle(
  plan: SequencePlan,
  state: SequenceState,
  adapter: {
    getOpenOrders(): Promise<VenueOrder[]>;
    getFills(): Promise<Fill[]>;
    placeOrder(order: PlannedOrder): Promise<void>;
    cancelOrder(clientId: string): Promise<void>;
  },
  onEvent?: (action: EngineAction) => void,
): Promise<SequenceState> {
  const snapshot: VenueSnapshot = {
    openOrders: await adapter.getOpenOrders(),
    fills: await adapter.getFills(),
  };
  const { actions, state: nextState } = reconcile(plan, state, snapshot);
  for (const action of actions) {
    onEvent?.(action);
    if (action.type === 'placeOrder') await adapter.placeOrder(action.order);
    else if (action.type === 'cancelOrder') await adapter.cancelOrder(action.clientId);
  }
  return nextState;
}
