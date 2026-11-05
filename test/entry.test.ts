import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkLadderAgainstGrids, computeLadder, LadderError } from '../src/ladder.js';
import { buildPlan, initialState } from '../src/engine.js';
import type { OrderFill, VenueAdapter } from '../src/adapters/types.js';
import type { Fill, PlannedOrder, SequenceParams, VenueGrids, VenueOrder } from '../src/types.js';

// stopSequence and previewSequence ask for prices, the Tradingale API and
// Kraken grids: keep all of it offline.
vi.mock('../src/runner/prices.js', () => ({
  publicPrice: vi.fn(async () => 100),
  krakenPublicPrice: vi.fn(async () => 100),
}));
vi.mock('../src/client.js', () => ({
  TradingaleClient: class {
    async crypto() {
      return [previewInstrument];
    }
    async stocks() {
      return [];
    }
  },
}));
vi.mock('../src/adapters/kraken.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/adapters/kraken.js')>()),
  fetchKrakenGrids: vi.fn(async () => previewGrids),
}));

// Set per test; read lazily by the mocks above.
let previewInstrument: Record<string, unknown> = {};
let previewGrids: VenueGrids | null = null;

const { checkEntrySlippage, ENTRY_SLIPPAGE_GUARD, journal, journalMetrics, previewSequence, runEntry, stopSequence } =
  await import('../src/runner/core.js');
const { loadRun, saveRun } = await import('../src/runner/state.js');

const PARAMS: SequenceParams = { deltaPrice: 0.08, nbRounds: 4, multipliers: [2, 2, 2], initialBetRatio: 0.1 };
const GRIDS: VenueGrids = { priceIncrement: 0.01, qtyStep: 0.0001, minOrderSize: 0.01, minNotional: 5 };

/**
 * A scripted live venue: the market entry fills after `fillAfterPolls`
 * getFills calls (never if null); a cancel can leave `partialOnCancel` filled.
 */
function scriptedVenue(script: {
  fillAfterPolls: number | null;
  fillPrice: number;
  partialOnCancel?: number;
  ignoreCancel?: boolean;
}) {
  const placed: PlannedOrder[] = [];
  const canceled: string[] = [];
  const fills: Fill[] = [];
  const open = new Map<string, VenueOrder>();
  let polls = 0;
  let entry: PlannedOrder | null = null;
  const venue: VenueAdapter = {
    async placeOrder(order) {
      placed.push(order);
      if (order.type === 'market') entry = order;
      open.set(order.clientId, {
        clientId: order.clientId, side: order.side, status: 'open', price: order.price, quantity: order.quantity, filledQuantity: 0,
      });
    },
    async cancelOrder(clientId) {
      canceled.push(clientId);
      if (script.ignoreCancel) return;
      if (open.delete(clientId) && entry?.clientId === clientId && script.partialOnCancel) {
        fills.push({ clientId, side: 'buy', price: script.fillPrice, quantity: script.partialOnCancel, timestamp: 1 });
      }
    },
    async getOpenOrders() {
      return [...open.values()];
    },
    async getFills() {
      polls++;
      if (entry && open.has(entry.clientId) && script.fillAfterPolls !== null && polls >= script.fillAfterPolls) {
        open.delete(entry.clientId);
        fills.push({ clientId: entry.clientId, side: 'buy', price: script.fillPrice, quantity: entry.quantity, timestamp: 1 });
      }
      return fills.map((f) => ({ ...f }));
    },
  };
  return { venue, placed, canceled };
}

const plan = () => buildPlan('BTC-1', computeLadder(PARAMS, 1_000, 100, GRIDS));

describe('runEntry (live start)', () => {
  it('fills within the polls: rescales, persists, then places the limit buys', async () => {
    const { venue, placed, canceled } = scriptedVenue({ fillAfterPolls: 3, fillPrice: 101 });
    const saved: unknown[] = [];
    const outcome = await runEntry(venue, plan(), { live: true, grids: GRIDS, delayMs: 0, onPlan: (p) => saved.push(p) });
    expect(outcome.kind).toBe('started');
    expect(canceled).toEqual([]);
    expect(saved).toHaveLength(1);
    expect(placed.map((o) => o.level)).toEqual([1, 2, 3, 4]);
  });

  it('timeout: cancels the entry, places nothing else, reports not-filled', async () => {
    const { venue, placed, canceled } = scriptedVenue({ fillAfterPolls: null, fillPrice: 100 });
    const onPlan = vi.fn();
    const outcome = await runEntry(venue, plan(), { live: true, grids: GRIDS, delayMs: 0, onPlan });
    expect(outcome).toEqual({ kind: 'not-filled' });
    expect(canceled).toEqual(['BTC-1-buy-1']);
    expect(placed.map((o) => o.level)).toEqual([1]);
    expect(onPlan).not.toHaveBeenCalled();
    expect(await venue.getOpenOrders()).toEqual([]);
  });

  it('timeout but the cancel does not land: throws (halt), never claims a clean abort', async () => {
    const { venue } = scriptedVenue({ fillAfterPolls: null, fillPrice: 100, ignoreCancel: true });
    await expect(runEntry(venue, plan(), { live: true, grids: GRIDS, delayMs: 0 })).rejects.toThrow(/could not be confirmed canceled/);
  });

  it('partial fill revealed by the cancel: that part is level 1, the sequence continues', async () => {
    const p = plan();
    const partialQty = Math.floor((p.ladder.levels[0].quantity / 2) * 1e4) / 1e4;
    const { venue, placed, canceled } = scriptedVenue({ fillAfterPolls: null, fillPrice: 100.5, partialOnCancel: partialQty });
    const outcome = await runEntry(venue, p, { live: true, grids: GRIDS, delayMs: 0 });
    expect(canceled).toEqual(['BTC-1-buy-1']);
    expect(outcome.kind).toBe('started');
    if (outcome.kind !== 'started') return;
    expect(outcome.partial).toBe(true);
    expect(outcome.plan.ladder.levels[0].quantity).toBe(partialQty);
    expect(outcome.plan.ladder.levels[0].buyPrice).toBe(100.5);
    expect(placed.map((o) => o.level)).toEqual([1, 2, 3, 4]);
  });

  it('partial fill too small for the venue minimums: entry-halt, no limit buy', async () => {
    const { venue, placed } = scriptedVenue({ fillAfterPolls: null, fillPrice: 100, partialOnCancel: 0.001 });
    const outcome = await runEntry(venue, plan(), { live: true, grids: GRIDS, delayMs: 0 });
    expect(outcome.kind).toBe('entry-halt');
    expect(placed.map((o) => o.level)).toEqual([1]);
  });

  it('paper is unchanged: one look, no cancel', async () => {
    const { venue, canceled } = scriptedVenue({ fillAfterPolls: 1, fillPrice: 100 });
    const outcome = await runEntry(venue, plan(), { live: false, grids: GRIDS });
    expect(outcome.kind).toBe('started');
    expect(canceled).toEqual([]);
  });
});

describe('runEntry with getOrderFill (the entry order\'s own record)', () => {
  // Never fills through getFills; the cancel is then read via getOrderFill,
  // which returns the scripted records one call after another.
  function withRecords(records: Array<OrderFill | null>) {
    const { venue, placed, canceled } = scriptedVenue({ fillAfterPolls: null, fillPrice: 100 });
    let call = 0;
    venue.getOrderFill = vi.fn(async () => records[Math.min(call++, records.length - 1)]);
    return { venue, placed, canceled };
  }

  it('waits out pending_cancel, then a canceled partial fill becomes level 1', async () => {
    const p = plan();
    const qty = Math.floor((p.ladder.levels[0].quantity / 2) * 1e4) / 1e4;
    const { venue, placed } = withRecords([
      { status: 'pending_cancel', final: false, filledQty: 0, avgPrice: 0 },
      { status: 'pending_cancel', final: false, filledQty: qty, avgPrice: 100.4 },
      { status: 'canceled', final: true, filledQty: qty, avgPrice: 100.4 },
    ]);
    const outcome = await runEntry(venue, p, { live: true, grids: GRIDS, delayMs: 0 });
    expect(venue.getOrderFill).toHaveBeenCalledTimes(3);
    expect(outcome.kind).toBe('started');
    if (outcome.kind !== 'started') return;
    expect(outcome.plan.ladder.levels[0]).toMatchObject({ quantity: qty, buyPrice: 100.4 });
    expect(placed.map((o) => o.level)).toEqual([1, 2, 3, 4]);
  });

  it('canceled with nothing executed: not-filled', async () => {
    const { venue, placed } = withRecords([{ status: 'canceled', final: true, filledQty: 0, avgPrice: 0 }]);
    expect(await runEntry(venue, plan(), { live: true, grids: GRIDS, delayMs: 0 })).toEqual({ kind: 'not-filled' });
    expect(placed.map((o) => o.level)).toEqual([1]);
  });

  it('never final: entry-halt (filled unknown), no limit buy', async () => {
    const { venue, placed } = withRecords([{ status: 'pending_cancel', final: false, filledQty: 0, avgPrice: 0 }]);
    const outcome = await runEntry(venue, plan(), { live: true, grids: GRIDS, delayMs: 0 });
    expect(outcome).toMatchObject({ kind: 'entry-halt', filled: false });
    expect(String((outcome as { reason: string }).reason)).toMatch(/pending_cancel/);
    expect(placed.map((o) => o.level)).toEqual([1]);
  });
});

describe('checkEntrySlippage (up-front refusal)', () => {
  it('refuses a ladder that passes at the ticker but would break the minimums after a slipped entry', () => {
    // Flat quantities and a heavy level 1: the deepest level is the cheapest,
    // so the shrink after a slipped entry is what pushes it under minNotional.
    const flat: SequenceParams = { deltaPrice: 0.08, nbRounds: 4, multipliers: [1, 1, 1], initialBetRatio: 0.4 };
    const grids: VenueGrids = { priceIncrement: 0.01, qtyStep: 0.0001, minOrderSize: null, minNotional: 10 };
    let borderline: number | null = null;
    let passing: number | null = null;
    for (let cents = 5_000; cents <= 50_000 && (borderline === null || passing === null); cents++) {
      const budget = cents / 100;
      let ladder;
      try {
        ladder = computeLadder(flat, budget, 100, grids);
      } catch (error) {
        expect(error).toBeInstanceOf(LadderError);
        continue;
      }
      if (checkLadderAgainstGrids(ladder, grids).length > 0) continue;
      try {
        checkEntrySlippage(ladder, grids);
        passing ??= budget;
      } catch (error) {
        expect(String(error)).toMatch(/Start refused: if the market entry filled 3% above/);
        borderline ??= budget;
      }
    }
    expect(ENTRY_SLIPPAGE_GUARD).toBe(0.03);
    expect(borderline).not.toBeNull();
    expect(passing).not.toBeNull();
  });
});

describe('stop --reverse on an entry-halted sequence', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-entry-'));
    process.env.RUNNER_STATE_DIR = dir;
  });
  afterEach(() => {
    delete process.env.RUNNER_STATE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeHalted(): string {
    const id = 'BTC-1700000000000';
    const p = buildPlan(id, computeLadder(PARAMS, 1_000, 100, GRIDS));
    const r1 = p.orders[0];
    saveRun(
      {
        version: 1,
        createdAt: new Date(0).toISOString(),
        symbol: 'BTC',
        assetType: 'crypto',
        venue: 'paper',
        budget: 1_000,
        plan: p,
        state: { ...initialState(), phase: 'halted', deepestFilledLevel: 1, haltReason: 'ladder refused after the level 1 fill' },
        entryHalt: true,
        paperFills: [{ clientId: r1.clientId, side: 'buy', price: 100, quantity: r1.quantity, timestamp: 0 }],
        paperOpen: [],
      },
      id,
    );
    return id;
  }

  it('plain stop refuses and points at --reverse', async () => {
    const id = writeHalted();
    const s = await stopSequence(id, {});
    expect(s.reversed).toBe(false);
    expect(s.warning).toMatch(/stop --reverse/);
    expect(loadRun(id)!.state.phase).toBe('halted');
  });

  it('stop --reverse market-sells level 1 and closes the sequence', async () => {
    const id = writeHalted();
    const qty = loadRun(id)!.plan.orders[0].quantity;
    const s = await stopSequence(id, { reverse: true });
    expect(s.warning).toBeNull();
    expect(s.reversed).toBe(true);
    expect(s.reversedQuantity).toBe(qty);
    const file = loadRun(id)!;
    expect(file.state.phase).toBe('canceled');
    expect(file.entryHalt).toBeUndefined();
    expect((file.fills as Fill[]).some((f) => f.side === 'sell' && f.clientId === `${id}-reverse`)).toBe(true);
  });

  it('other halted sequences are still refused', async () => {
    const id = writeHalted();
    const file = loadRun(id)!;
    file.entryHalt = undefined;
    saveRun(file, id);
    const s = await stopSequence(id, { reverse: true });
    expect(s.reversed).toBe(false);
    expect(s.warning).toBe('sequence is halted, not running');
  });
});

describe('previewSequence: the live slippage refusal shows up in the preview', () => {
  beforeEach(() => {
    process.env.TRADINGALE_TOKEN = 'test';
  });
  afterEach(() => {
    delete process.env.TRADINGALE_TOKEN;
  });

  it('live preview lists the same refusal as the start; paper preview does not', async () => {
    const flat = { id: 1, symbol: 'BTC', deltaPrice: 0.08, nbRounds: 4, multipliers: [1, 1, 1], initialBetRatio: 0.4 };
    const grids: VenueGrids = { priceIncrement: 0.01, qtyStep: 0.0001, minOrderSize: null, minNotional: 10 };
    previewInstrument = flat;
    previewGrids = grids;
    // Find a budget that passes at the ticker (100, mocked) but not after 3% slippage.
    let budget: number | null = null;
    for (let cents = 5_000; cents <= 50_000 && budget === null; cents++) {
      try {
        const ladder = computeLadder(flat, cents / 100, 100, grids);
        if (checkLadderAgainstGrids(ladder, grids).length > 0) continue;
        checkEntrySlippage(ladder, grids);
      } catch (error) {
        if (error instanceof LadderError) continue;
        budget = cents / 100;
      }
    }
    expect(budget).not.toBeNull();
    const live = await previewSequence('BTC', budget!, undefined, 'live');
    expect(live.problems.some((p) => /^Start refused: if the market entry filled 3% above/.test(p))).toBe(true);
    const paper = await previewSequence('BTC', budget!, undefined, 'paper');
    expect(paper.problems).toEqual([]);
  });
});

describe('journal: an aborted start is listed, never counted', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-journal-'));
    process.env.RUNNER_STATE_DIR = dir;
  });
  afterEach(() => {
    delete process.env.RUNNER_STATE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('neverStarted is excluded from every metric and shown as not started', () => {
    const doneId = 'BTC-1700000000000';
    const done = buildPlan(doneId, computeLadder(PARAMS, 1_000, 100, GRIDS));
    const q = done.orders[0].quantity;
    saveRun(
      {
        version: 1,
        createdAt: new Date(Date.now() - 3_600_000).toISOString(),
        lastCycleAt: new Date().toISOString(),
        symbol: 'BTC',
        assetType: 'crypto',
        venue: 'kraken',
        budget: 1_000,
        plan: done,
        state: { ...initialState(), phase: 'complete', deepestFilledLevel: 1 },
        fills: [
          { clientId: `${doneId}-buy-1`, side: 'buy', price: 100, quantity: q, timestamp: 0 },
          { clientId: `${doneId}-sell-1`, side: 'sell', price: 108, quantity: q, timestamp: 1 },
        ],
      },
      doneId,
    );
    const abortedId = 'ETH-1700000000001';
    saveRun(
      {
        version: 1,
        createdAt: new Date().toISOString(),
        lastCycleAt: new Date().toISOString(),
        symbol: 'ETH',
        assetType: 'crypto',
        venue: 'kraken',
        budget: 5_000,
        plan: buildPlan(abortedId, computeLadder(PARAMS, 5_000, 100, GRIDS)),
        state: { ...initialState(), phase: 'canceled', haltReason: 'Entry order did not fill' },
        neverStarted: true,
      },
      abortedId,
    );

    const entries = journal();
    expect(entries.find((e) => e.sequenceId === abortedId)).toMatchObject({ phase: 'not started', neverStarted: true });
    for (const scope of ['all', 'live'] as const) {
      const m = journalMetrics(scope);
      expect(m.closedCount).toBe(1);
      expect(m.completedCount).toBe(1);
      expect(m.canceledCount).toBe(0);
      expect(m.activeCount).toBe(0);
      expect(m.winRateDenominator).toBe(1);
      // Budget of the aborted start ($5000) never enters a percentage.
      expect(m.capitalIncreasePct).toBeCloseTo((m.totalRealized / 1_000) * 100, 9);
    }
  });
});
