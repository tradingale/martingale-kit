#!/usr/bin/env node
// The Tradingale Runner: a self-hosted sequence bot built on the kit.
//
// PAPER BY DEFAULT. Everything runs locally: your token, your (optional)
// keys, your machine. Tradingale only ever serves the model parameters.
//
//   npx tsx src/runner/cli.ts start --symbol BTC --budget 1000
//   npx tsx src/runner/cli.ts cycle            # run one reconciliation pass
//   npx tsx src/runner/cli.ts watch            # loop every 10 minutes
//   npx tsx src/runner/cli.ts status
//
// Env: TRADINGALE_TOKEN (required). The runner refuses underfunded ladders
// (budgetMin) instead of placing a distorted one, per the handbook.
import { computeLadder, budgetMin, checkLadderAgainstGrids } from '../ladder.js';
import { buildPlan, entryActions, initialState, reconcile, type EngineAction } from '../engine.js';
import { PaperAdapter } from '../adapters/paper.js';
import { TradingaleClient } from '../client.js';
import type { Fill, VenueGrids } from '../types.js';
import { publicPrice } from './prices.js';
import { listRuns, loadRun, saveRun, type RunnerFile } from './state.js';

const CYCLE_MS = 10 * 60 * 1000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function log(msg: string): void {
  console.log(`[runner ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// Rebuild a PaperAdapter from persisted fills so restarts stay consistent.
function rebuildPaper(file: RunnerFile): PaperAdapter {
  const venue = new PaperAdapter();
  const fills = (file.paperFills ?? []) as Fill[];
  venue.restore(file.plan, fills);
  return venue;
}

async function cmdStart(): Promise<void> {
  const token = process.env.TRADINGALE_TOKEN;
  if (!token) throw new Error('Set TRADINGALE_TOKEN (create one at tradingale.com/settings/api)');
  const symbol = (arg('symbol') ?? 'BTC').toUpperCase();
  const budget = Number(arg('budget') ?? 1000);
  const live = process.argv.includes('--live');
  if (live) {
    throw new Error(
      'Live venue adapters ship separately; the runner is paper-first by design. Run without --live.',
    );
  }

  const client = new TradingaleClient(token);
  const instruments = await client.crypto({ symbol });
  const instrument = instruments[0];
  if (!instrument) throw new Error(`No fresh Tradingale data for ${symbol} (check your plan's scope)`);
  if (!Number.isFinite(instrument.initialBetRatio)) {
    throw new Error(`Tradingale did not return initial_bet_ratio for ${symbol}`);
  }

  const entry = await publicPrice(symbol);
  const grids: VenueGrids = { priceIncrement: null, qtyStep: null, minOrderSize: null, minNotional: null };
  const floor = budgetMin(instrument, entry, grids);
  const ladder = computeLadder(instrument, budget, entry);
  const problems = checkLadderAgainstGrids(ladder, grids);
  if (problems.length > 0 || budget < floor) {
    throw new Error(`Underfunded ladder (budget_min ~$${Math.ceil(floor)}): ${problems.join('; ') || 'raise the budget'}`);
  }

  const sequenceId = `${symbol}-${Date.now()}`;
  const plan = buildPlan(sequenceId, ladder);
  const venue = new PaperAdapter();
  venue.tick(entry);
  for (const action of entryActions(plan)) {
    if (action.type === 'placeOrder') await venue.placeOrder(action.order);
  }

  const file: RunnerFile = {
    version: 1,
    createdAt: new Date().toISOString(),
    symbol,
    venue: 'paper',
    budget,
    plan,
    state: initialState(),
    paperFills: await venue.getFills(),
  };
  saveRun(file, sequenceId);
  log(`started PAPER sequence ${sequenceId} at $${entry} (${plan.ladder.levels.length} levels, $${budget})`);
  log(`score ${instrument.martingaleScore ?? '?'} / startingale ${instrument.startingale ?? '?'} (descriptive metrics, not advice)`);
}

async function cycleOne(sequenceId: string): Promise<void> {
  const file = loadRun(sequenceId);
  if (!file) throw new Error(`unknown sequence ${sequenceId}`);
  if (file.state.phase !== 'running') {
    log(`${sequenceId}: ${file.state.phase}${file.state.haltReason ? ` (${file.state.haltReason})` : ''}`);
    return;
  }
  const venue = rebuildPaper(file);
  const price = await publicPrice(file.symbol);
  venue.tick(price);

  const snapshot = { openOrders: await venue.getOpenOrders(), fills: await venue.getFills() };
  const { actions, state } = reconcile(file.plan, file.state, snapshot);
  for (const action of actions) {
    describe(action, sequenceId);
    if (action.type === 'placeOrder') await venue.placeOrder(action.order);
    else if (action.type === 'cancelOrder') await venue.cancelOrder(action.clientId);
  }
  file.state = state;
  file.paperFills = await venue.getFills();
  saveRun(file, sequenceId);
  if (actions.length === 0) log(`${sequenceId}: $${price}, level ${state.deepestFilledLevel}, nothing to do`);
}

function describe(action: EngineAction, id: string): void {
  if (action.type === 'placeOrder') log(`${id}: place ${action.order.side} ${action.order.clientId} @ ${action.order.price ?? 'market'}`);
  else if (action.type === 'cancelOrder') log(`${id}: cancel ${action.clientId}`);
  else if (action.type === 'complete') log(`${id}: SEQUENCE COMPLETE`);
  else if (action.type === 'alert') log(`${id}: ALERT ${action.message}`);
}

async function cmdCycle(): Promise<void> {
  for (const id of listRuns()) await cycleOne(id);
}

async function cmdWatch(): Promise<void> {
  log(`watching (every ${CYCLE_MS / 60000} min, Ctrl+C to stop)`);
  // Overlap guard: a plain sequential loop cannot overlap itself.
  for (;;) {
    try {
      await cmdCycle();
    } catch (e) {
      log(`cycle error: ${e instanceof Error ? e.message : e}`);
    }
    await new Promise((r) => setTimeout(r, CYCLE_MS));
  }
}

async function cmdStatus(): Promise<void> {
  for (const id of listRuns()) {
    const file = loadRun(id)!;
    const filled = file.state.deepestFilledLevel;
    console.log(
      `${id}  ${file.venue}  ${file.state.phase}  level ${filled}/${file.plan.ladder.levels.length}  budget $${file.budget}`,
    );
  }
}

const cmd = process.argv[2];
const run = { start: cmdStart, cycle: cmdCycle, watch: cmdWatch, status: cmdStatus }[cmd ?? ''];
if (!run) {
  console.log('usage: runner <start|cycle|watch|status> [--symbol BTC] [--budget 1000]');
  process.exit(1);
}
run().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
