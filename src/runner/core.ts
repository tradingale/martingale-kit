// The runner core: start / cycle / stop / status as plain functions, shared
// by the CLI (src/runner/cli.ts) and the web runner (src/server/). One
// implementation, two front ends; neither duplicates the other.
//
// PAPER BY DEFAULT everywhere. Live mode drives the KrakenAdapter and is an
// explicit opt-in that refuses to start without keys. Even paper mode snaps
// ladders to the real Kraken grids when they can be fetched (public
// endpoint, zero keys), so paper plans match what live would submit.

import { budgetMin, checkLadderAgainstGrids, computeLadder } from '../ladder.js';
import { buildPlan, entryActions, initialState, reconcile, type EngineAction } from '../engine.js';
import { PaperAdapter } from '../adapters/paper.js';
import { KrakenAdapter, fetchKrakenGrids } from '../adapters/kraken.js';
import type { VenueAdapter } from '../adapters/types.js';
import { TradingaleClient } from '../client.js';
import type { Fill, LadderLevel, VenueGrids } from '../types.js';
import { krakenPublicPrice, publicPrice } from './prices.js';
import { listRuns, loadRun, saveRun, type RunnerFile } from './state.js';

export type RunnerMode = 'paper' | 'live';

export const CYCLE_MS = 10 * 60 * 1000;

const NULL_GRIDS: VenueGrids = {
  priceIncrement: null,
  qtyStep: null,
  minOrderSize: null,
  minNotional: null,
};

export type Logger = (message: string) => void;

export function krakenKeysPresent(): boolean {
  return Boolean(process.env.KRAKEN_API_KEY && process.env.KRAKEN_API_SECRET);
}

/** RUNNER_MODE env: 'live' only when spelled exactly; anything else is paper. */
export function runnerMode(): RunnerMode {
  return process.env.RUNNER_MODE === 'live' ? 'live' : 'paper';
}

export interface StartOptions {
  symbol: string;
  budget: number;
  mode: RunnerMode;
}

export interface StartSummary {
  sequenceId: string;
  symbol: string;
  mode: RunnerMode;
  venue: 'paper' | 'kraken';
  entryPrice: number;
  levels: number;
  budget: number;
  martingaleScore?: number;
  startingale?: number;
}

export async function startSequence(options: StartOptions, log: Logger = () => {}): Promise<StartSummary> {
  const token = process.env.TRADINGALE_TOKEN;
  if (!token) throw new Error('Set TRADINGALE_TOKEN (create one at tradingale.com/settings/api)');

  const symbol = options.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,12}$/.test(symbol)) throw new Error(`Invalid symbol: ${options.symbol}`);
  const budget = Number(options.budget);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('budget must be a positive number');
  const mode = options.mode;
  if (mode === 'live' && !krakenKeysPresent()) {
    throw new Error(
      'Live mode refused: KRAKEN_API_KEY and KRAKEN_API_SECRET are not set. Live places real orders on your Kraken account.',
    );
  }

  const client = new TradingaleClient(token);
  const instruments = await client.crypto({ symbol });
  const instrument = instruments[0];
  if (!instrument) throw new Error(`No fresh Tradingale data for ${symbol} (check your plan's scope)`);
  if (!Number.isFinite(instrument.initialBetRatio)) {
    throw new Error(`Tradingale did not return initial_bet_ratio for ${symbol}`);
  }

  const sequenceId = `${symbol}-${Date.now()}`;

  // Grids: live resolves through the adapter (a missing pair refuses the
  // start); paper tries the same public AssetPairs data and degrades to
  // null grids when Kraken cannot be reached.
  let adapter: KrakenAdapter | null = null;
  let grids = NULL_GRIDS;
  let hasGrids = false;
  if (mode === 'live') {
    adapter = new KrakenAdapter({ symbol, sequenceId, sinceMs: Date.now() - 5 * 60 * 1000 });
    grids = await adapter.getGrids();
    hasGrids = true;
  } else {
    try {
      grids = await fetchKrakenGrids(symbol);
      hasGrids = true;
    } catch {
      grids = NULL_GRIDS;
    }
  }

  const entry = mode === 'live' ? await krakenPublicPrice(symbol) : await publicPrice(symbol);

  // budgetMin / grid check BEFORE anything is placed: refuse a distorted
  // ladder and surface the floor instead (handbook section 5).
  const floor = budgetMin(instrument, entry, grids);
  const ladder = computeLadder(instrument, budget, entry, hasGrids ? grids : undefined);
  const problems = checkLadderAgainstGrids(ladder, grids);
  if (problems.length > 0 || budget < floor) {
    throw new Error(
      `Underfunded ladder (budget_min ~$${Math.ceil(floor)}): ${problems.join('; ') || 'raise the budget'}`,
    );
  }

  const plan = buildPlan(sequenceId, ladder);
  const file: RunnerFile = {
    version: 1,
    createdAt: new Date().toISOString(),
    symbol,
    venue: mode === 'live' ? 'kraken' : 'paper',
    budget,
    plan,
    state: initialState(),
    lastPrice: entry,
  };
  // Plan-in-database pattern: persist BEFORE the first order goes out, so a
  // crash mid-placement still leaves a file to reconcile against.
  saveRun(file, sequenceId);

  let venue: VenueAdapter;
  if (mode === 'live') {
    venue = adapter!;
  } else {
    const paper = new PaperAdapter();
    paper.tick(entry);
    venue = paper;
  }

  try {
    for (const action of entryActions(plan)) {
      if (action.type === 'placeOrder') await venue.placeOrder(action.order);
    }
  } catch (error) {
    // Real orders may already rest on the book: halt loudly, cancel nothing.
    const message = error instanceof Error ? error.message : String(error);
    file.state.phase = 'halted';
    file.state.haltReason = `entry placement failed: ${message}. Check and cancel your open orders on Kraken yourself.`;
    saveRun(file, sequenceId);
    throw new Error(file.state.haltReason);
  }

  if (venue instanceof PaperAdapter) {
    file.paperFills = await venue.getFills();
    saveRun(file, sequenceId);
  }

  log(
    `started ${mode.toUpperCase()} sequence ${sequenceId} at $${entry} (${plan.ladder.levels.length} levels, $${budget})`,
  );
  log(
    `score ${instrument.martingaleScore ?? '?'} / startingale ${instrument.startingale ?? '?'} (descriptive metrics, not advice)`,
  );
  return {
    sequenceId,
    symbol,
    mode,
    venue: file.venue,
    entryPrice: entry,
    levels: plan.ladder.levels.length,
    budget,
    martingaleScore: instrument.martingaleScore,
    startingale: instrument.startingale,
  };
}

// Rebuild a PaperAdapter from persisted fills so restarts stay consistent.
function rebuildPaper(file: RunnerFile): PaperAdapter {
  const venue = new PaperAdapter();
  const fills = (file.paperFills ?? []) as Fill[];
  venue.restore(file.plan, fills);
  return venue;
}

function describeAction(action: EngineAction, id: string, log: Logger): void {
  if (action.type === 'placeOrder') {
    log(`${id}: place ${action.order.side} ${action.order.clientId} @ ${action.order.price ?? 'market'}`);
  } else if (action.type === 'cancelOrder') log(`${id}: cancel ${action.clientId}`);
  else if (action.type === 'complete') log(`${id}: SEQUENCE COMPLETE`);
  else if (action.type === 'alert') log(`${id}: ALERT ${action.message}`);
}

export interface CycleSummary {
  sequenceId: string;
  phase: string;
  deepestFilledLevel: number;
  price: number | null;
  actionCount: number;
}

export async function cycleSequence(sequenceId: string, log: Logger = () => {}): Promise<CycleSummary> {
  const file = loadRun(sequenceId);
  if (!file) throw new Error(`unknown sequence ${sequenceId}`);
  if (file.state.phase !== 'running') {
    log(`${sequenceId}: ${file.state.phase}${file.state.haltReason ? ` (${file.state.haltReason})` : ''}`);
    return {
      sequenceId,
      phase: file.state.phase,
      deepestFilledLevel: file.state.deepestFilledLevel,
      price: file.lastPrice ?? null,
      actionCount: 0,
    };
  }

  let venue: VenueAdapter;
  let price: number;
  if (file.venue === 'kraken') {
    venue = new KrakenAdapter({
      symbol: file.symbol,
      sequenceId,
      sinceMs: Date.parse(file.createdAt) - 60 * 1000,
    });
    price = await krakenPublicPrice(file.symbol);
  } else {
    const paper = rebuildPaper(file);
    price = await publicPrice(file.symbol);
    paper.tick(price);
    venue = paper;
  }

  const snapshot = { openOrders: await venue.getOpenOrders(), fills: await venue.getFills() };
  const { actions, state } = reconcile(file.plan, file.state, snapshot);
  for (const action of actions) {
    describeAction(action, sequenceId, log);
    // If an execution throws, nothing is persisted: the next cycle replays
    // the same reconciliation against fresh venue state (idempotent ids).
    if (action.type === 'placeOrder') await venue.placeOrder(action.order);
    else if (action.type === 'cancelOrder') await venue.cancelOrder(action.clientId);
  }
  file.state = state;
  file.lastPrice = price;
  file.lastCycleAt = new Date().toISOString();
  if (venue instanceof PaperAdapter) file.paperFills = await venue.getFills();
  saveRun(file, sequenceId);
  if (actions.length === 0) log(`${sequenceId}: $${price}, level ${state.deepestFilledLevel}, nothing to do`);
  return {
    sequenceId,
    phase: state.phase,
    deepestFilledLevel: state.deepestFilledLevel,
    price,
    actionCount: actions.length,
  };
}

/** One pass over every persisted sequence, strictly sequential. */
export async function cycleAll(log: Logger = () => {}): Promise<CycleSummary[]> {
  const summaries: CycleSummary[] = [];
  for (const id of listRuns()) {
    try {
      summaries.push(await cycleSequence(id, log));
    } catch (error) {
      log(`${id}: cycle error: ${error instanceof Error ? error.message : error}`);
    }
  }
  return summaries;
}

export interface StopSummary {
  sequenceId: string;
  venue: 'paper' | 'kraken';
  phase: string;
  warning: string | null;
}

/**
 * Mark a sequence halted. Deliberately cancels NOTHING at the venue: real
 * orders stay on the book until you cancel them on Kraken yourself.
 */
export function stopSequence(sequenceId: string): StopSummary {
  const file = loadRun(sequenceId);
  if (!file) throw new Error(`unknown sequence ${sequenceId}`);
  if (file.state.phase === 'running') {
    file.state.phase = 'halted';
    file.state.haltReason = 'stopped by operator; open orders were not canceled';
    saveRun(file, sequenceId);
  }
  return {
    sequenceId,
    venue: file.venue,
    phase: file.state.phase,
    warning:
      file.venue === 'kraken'
        ? 'Stopping cancels nothing at the venue: cancel your open orders on Kraken yourself.'
        : null,
  };
}

export interface SequenceStatus {
  sequenceId: string;
  symbol: string;
  venue: 'paper' | 'kraken';
  phase: string;
  haltReason: string | null;
  budget: number;
  createdAt: string;
  deepestFilledLevel: number;
  totalLevels: number;
  entryPrice: number;
  deltaPrice: number;
  lastPrice: number | null;
  lastCycleAt: string | null;
  levels: LadderLevel[];
}

export function statusAll(): SequenceStatus[] {
  const statuses: SequenceStatus[] = [];
  for (const id of listRuns()) {
    const file = loadRun(id);
    if (!file) continue;
    statuses.push({
      sequenceId: id,
      symbol: file.symbol,
      venue: file.venue,
      phase: file.state.phase,
      haltReason: file.state.haltReason,
      budget: file.budget,
      createdAt: file.createdAt,
      deepestFilledLevel: file.state.deepestFilledLevel,
      totalLevels: file.plan.ladder.levels.length,
      entryPrice: file.plan.ladder.entryPrice,
      deltaPrice: file.plan.ladder.params.deltaPrice,
      lastPrice: file.lastPrice ?? null,
      lastCycleAt: file.lastCycleAt ?? null,
      levels: file.plan.ladder.levels,
    });
  }
  statuses.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return statuses;
}
