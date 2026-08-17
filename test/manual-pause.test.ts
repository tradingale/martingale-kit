// The site's toggle-bot (pause/resume) and manual sequences (you execute,
// the runner tracks), as core contracts: no network, no venue.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeLadder } from '../src/ladder.js';
import { buildPlan, initialState } from '../src/engine.js';
import {
  cycleSequence, deleteSequence, markManualFill, pauseSequence, resyncSell, stopSequence,
} from '../src/runner/core.js';
import { saveRun, loadRun, type RunnerFile } from '../src/runner/state.js';

const PARAMS = { symbol: 'BTC', deltaPrice: 0.08, nbRounds: 4, multipliers: [2, 2, 2], initialBetRatio: 0.05 };

function seedRun(id: string, venue: RunnerFile['venue'], overrides: Partial<RunnerFile> = {}): RunnerFile {
  const ladder = computeLadder(PARAMS, 10_000, 100);
  const state = initialState();
  state.phase = 'running';
  state.deepestFilledLevel = 1;
  const file: RunnerFile = {
    version: 1,
    createdAt: new Date().toISOString(),
    symbol: 'BTC',
    assetType: 'crypto',
    venue,
    budget: 10_000,
    plan: buildPlan(id, ladder),
    state,
    fills: [{ clientId: `${id}-buy-1`, side: 'buy', price: 100, quantity: ladder.levels[0].quantity, timestamp: 1 }],
    ...overrides,
  };
  saveRun(file, id);
  return file;
}

describe('manual sequences + toggle-bot', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-manual-'));
    process.env.RUNNER_STATE_DIR = dir;
  });
  afterEach(() => {
    delete process.env.RUNNER_STATE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('manual: records the next buy at its planned price, then the sell completes', () => {
    seedRun('BTC-1', 'manual');
    const afterBuy = markManualFill('BTC-1', 'buy');
    expect(afterBuy.deepestFilledLevel).toBe(2);
    let file = loadRun('BTC-1')!;
    const level2 = file.plan.ladder.levels[1];
    const buys = (file.fills as any[]).filter((f) => f.side === 'buy');
    expect(buys).toHaveLength(2);
    expect(buys[1].price).toBe(level2.buyPrice);
    expect(buys[1].quantity).toBe(level2.quantity);

    const afterSell = markManualFill('BTC-1', 'sell');
    expect(afterSell.phase).toBe('complete');
    file = loadRun('BTC-1')!;
    const sell = (file.fills as any[]).find((f) => f.side === 'sell');
    expect(sell.price).toBe(level2.exitPrice);
    expect(sell.quantity).toBe(level2.cumulativeQuantity);
    // completed: no further fill can be recorded
    expect(() => markManualFill('BTC-1', 'buy')).toThrow(/not running/);
  });

  it('manual: refuses a buy past the last level', () => {
    const file = seedRun('BTC-2', 'manual');
    const total = file.plan.ladder.levels.length;
    for (let l = 2; l <= total; l++) markManualFill('BTC-2', 'buy');
    expect(() => markManualFill('BTC-2', 'buy')).toThrow(/does not exist/);
  });

  it('manual fills are refused on runner-driven sequences', () => {
    seedRun('BTC-3', 'paper');
    expect(() => markManualFill('BTC-3', 'buy')).toThrow(/only be recorded on manual/);
  });

  it('manual: stop closes the record without touching any venue; resync refuses', async () => {
    seedRun('BTC-4', 'manual');
    await expect(resyncSell('BTC-4')).rejects.toThrow(/no resting orders/);
    const stopped = await stopSequence('BTC-4', { reverse: true });
    expect(stopped.phase).toBe('canceled');
    expect(stopped.canceledOrders).toBe(0);
    expect(stopped.reversed).toBe(false);
    expect(stopped.warning).toMatch(/nothing to reverse/);
  });

  it('finished manual records are deletable, live never is', () => {
    seedRun('BTC-5', 'manual');
    expect(deleteSequence('BTC-5').reason).toMatch(/running/); // must stop first
    const file = loadRun('BTC-5')!;
    file.state.phase = 'canceled';
    saveRun(file, 'BTC-5');
    expect(deleteSequence('BTC-5').deleted).toBe(true);

    seedRun('BTC-6', 'kraken', { state: { ...initialState(), phase: 'complete', deepestFilledLevel: 1 } });
    expect(deleteSequence('BTC-6').deleted).toBe(false);
    expect(deleteSequence('BTC-6').reason).toMatch(/permanently/);
  });

  it('toggle-bot: paused blocks checks and resync until resumed; manual has no bot', async () => {
    seedRun('BTC-7', 'paper');
    expect(pauseSequence('BTC-7', true).paused).toBe(true);
    expect(loadRun('BTC-7')!.paused).toBe(true);
    await expect(cycleSequence('BTC-7')).rejects.toThrow(/paused/);
    await expect(resyncSell('BTC-7')).rejects.toThrow(/paused/);
    expect(pauseSequence('BTC-7', false).paused).toBe(false);
    expect(loadRun('BTC-7')!.paused).toBe(false);

    seedRun('BTC-8', 'manual');
    expect(() => pauseSequence('BTC-8', true)).toThrow(/no bot to pause/);
  });
});
