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
import { AlpacaAdapter } from '../adapters/alpaca.js';
import type { VenueAdapter } from '../adapters/types.js';
import { TradingaleClient, type TradingaleInstrument } from '../client.js';
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
  /** Optional custom structure, exactly as previewed. */
  custom?: CustomParams;
}

export interface StartSummary {
  sequenceId: string;
  symbol: string;
  mode: RunnerMode;
  venue: 'paper' | 'kraken' | 'alpaca';
  entryPrice: number;
  levels: number;
  budget: number;
  martingaleScore?: number;
  startingale?: number;
}

/**
 * Optional overrides of the model structure, mirroring the site's custom
 * sequences: edit the spacing, the number of rounds, and the per-level
 * quantity multipliers. Anything omitted keeps Tradingale's value for the
 * instrument. The multipliers array must hold nbRounds - 1 entries; the
 * ladder math and every guardrail (budgetMin, grid checks) apply exactly
 * the same way to a custom structure.
 */
export interface CustomParams {
  deltaPrice?: number;
  nbRounds?: number;
  multipliers?: number[];
}

/** Custom structures are bounded like the site's: 4 or 5 rounds, 5% to 15% spacing. */
export const CUSTOM_ROUNDS = [4, 5] as const;
export const CUSTOM_DELTA_MIN = 0.05;
export const CUSTOM_DELTA_MAX = 0.15;

function applyCustom(
  base: TradingaleInstrument,
  custom?: CustomParams,
): { instrument: TradingaleInstrument; notes: string[] } {
  if (!custom) return { instrument: base, notes: [] };
  const notes: string[] = [];
  const merged: TradingaleInstrument = { ...base };

  // Spacing: clamped to the allowed band rather than rejected, so typing in
  // the editor never hard-errors mid-keystroke.
  if (Number.isFinite(custom.deltaPrice) && (custom.deltaPrice as number) > 0) {
    let delta = custom.deltaPrice as number;
    if (delta < CUSTOM_DELTA_MIN || delta > CUSTOM_DELTA_MAX) {
      const clamped = Math.min(CUSTOM_DELTA_MAX, Math.max(CUSTOM_DELTA_MIN, delta));
      notes.push(
        `delta price ${(delta * 100).toFixed(2)}% is outside 5%-15%, using ${(clamped * 100).toFixed(2)}%`,
      );
      delta = clamped;
    }
    merged.deltaPrice = delta;
  }

  // Rounds: 4 or 5 only.
  if (Number.isFinite(custom.nbRounds)) {
    const asked = Math.floor(custom.nbRounds as number);
    if (!(CUSTOM_ROUNDS as readonly number[]).includes(asked)) {
      const clamped = asked <= 4 ? 4 : 5;
      notes.push(`rounds must be 4 or 5, using ${clamped}`);
      merged.nbRounds = clamped;
    } else {
      merged.nbRounds = asked;
    }
  }

  if (Array.isArray(custom.multipliers) && custom.multipliers.length > 0) {
    const cleaned = custom.multipliers.map(Number).filter((m) => Number.isFinite(m) && m > 0);
    if (cleaned.length > 0) merged.multipliers = cleaned;
  }

  // The engine needs exactly nbRounds - 1 multipliers. Pad with the last
  // value (or trim) so changing the round count alone stays valid, and say
  // so when the list had to be resized.
  const need = Math.max(0, merged.nbRounds - 1);
  const list = [...merged.multipliers];
  if (list.length !== need) {
    notes.push(`${need} multipliers needed for ${merged.nbRounds} rounds, list resized`);
  }
  while (list.length < need) list.push(list[list.length - 1] ?? 2);
  merged.multipliers = list.slice(0, need);
  return { instrument: merged, notes };
}

export interface SequencePreview {
  symbol: string;
  name?: string;
  assetType: 'crypto' | 'stock';
  martingaleScore?: number;
  startingale?: number;
  entryPrice: number;
  budget: number;
  budgetMin: number;
  problems: string[];
  deltaPrice: number;
  levels: LadderLevel[];
  /** The structure actually used (Tradingale's, or the user's edits). */
  params: { deltaPrice: number; nbRounds: number; multipliers: number[]; initialBetRatio: number };
  /** True when the preview used custom values instead of Tradingale's. */
  custom: boolean;
  /** Adjustments applied to the custom input (clamped delta, resized list). */
  notes: string[];
}

/**
 * The site flow, dry: resolve the instrument, take the live entry price,
 * compute the ladder at the requested budget, and report budgetMin/grid
 * problems — WITHOUT placing or persisting anything. The web UI renders
 * this as the sequence preview the user inspects before pressing Start.
 * Paper-basis grids (best effort), same arithmetic as the site.
 */
export async function previewSequence(
  symbolRaw: string,
  budgetRaw: number,
  custom?: CustomParams,
): Promise<SequencePreview> {
  const token = process.env.TRADINGALE_TOKEN;
  if (!token) throw new Error('Set TRADINGALE_TOKEN (create one at tradingale.com/settings/api)');
  const symbol = symbolRaw.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,12}$/.test(symbol)) throw new Error(`Invalid symbol: ${symbolRaw}`);
  const budget = Number(budgetRaw);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('budget must be a positive number');

  const client = new TradingaleClient(token);
  let assetType: 'crypto' | 'stock' = 'crypto';
  let instruments = await client.crypto({ symbol });
  if (!instruments[0]) {
    instruments = await client.stocks({ symbol }).catch(() => []);
    if (instruments[0]) assetType = 'stock';
  }
  const base = instruments[0];
  if (!base) throw new Error(`No fresh Tradingale data for ${symbol} (check your plan's scope)`);
  if (!Number.isFinite(base.initialBetRatio)) {
    throw new Error(`Tradingale did not return initial_bet_ratio for ${symbol}`);
  }
  const { instrument, notes } = applyCustom(base, custom);

  let grids = NULL_GRIDS;
  let hasGrids = false;
  try {
    grids = assetType === 'crypto' ? await fetchKrakenGrids(symbol) : NULL_GRIDS;
    hasGrids = assetType === 'crypto';
  } catch {
    grids = NULL_GRIDS;
  }
  const entry = await publicPrice(symbol, assetType);
  const floor = budgetMin(instrument, entry, grids);
  const ladder = computeLadder(instrument, budget, entry, hasGrids ? grids : undefined);
  const problems = checkLadderAgainstGrids(ladder, grids);
  if (budget < floor) problems.unshift(`budget below the computed floor (~$${Math.ceil(floor)})`);

  return {
    symbol,
    name: base.name,
    assetType,
    martingaleScore: base.martingaleScore,
    startingale: base.startingale,
    entryPrice: entry,
    budget,
    budgetMin: Math.ceil(floor),
    problems,
    deltaPrice: instrument.deltaPrice,
    levels: ladder.levels,
    params: {
      deltaPrice: instrument.deltaPrice,
      nbRounds: instrument.nbRounds,
      multipliers: instrument.multipliers,
      initialBetRatio: instrument.initialBetRatio,
    },
    custom: Boolean(custom && (custom.deltaPrice || custom.nbRounds || custom.multipliers)),
    notes,
  };
}

export async function startSequence(options: StartOptions, log: Logger = () => {}): Promise<StartSummary> {
  const token = process.env.TRADINGALE_TOKEN;
  if (!token) throw new Error('Set TRADINGALE_TOKEN (create one at tradingale.com/settings/api)');

  const symbol = options.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,12}$/.test(symbol)) throw new Error(`Invalid symbol: ${options.symbol}`);
  const budget = Number(options.budget);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('budget must be a positive number');
  const mode = options.mode;

  const client = new TradingaleClient(token);
  // Crypto first, then US stocks: the Runner covers both catalogs in paper.
  let assetType: 'crypto' | 'stock' = 'crypto';
  let instruments = await client.crypto({ symbol });
  if (!instruments[0]) {
    instruments = await client.stocks({ symbol }).catch(() => []);
    if (instruments[0]) assetType = 'stock';
  }
  const baseInstrument = instruments[0];
  if (!baseInstrument) throw new Error(`No fresh Tradingale data for ${symbol} (check your plan's scope)`);
  if (!Number.isFinite(baseInstrument.initialBetRatio)) {
    throw new Error(`Tradingale did not return initial_bet_ratio for ${symbol}`);
  }
  // Custom structures (edited spacing / rounds / multipliers) go through the
  // exact same math and guardrails as Tradingale's own parameters.
  const { instrument } = applyCustom(baseInstrument, options.custom);

  const sequenceId = `${symbol}-${Date.now()}`;

  // Grids: live resolves through the adapter (a missing pair refuses the
  // start); paper tries the same public AssetPairs data and degrades to
  // null grids when Kraken cannot be reached.
  // Live venue by asset class: Kraken carries crypto, Alpaca carries US
  // stocks (ALPACA_PAPER=true targets Alpaca's paper environment: same rail,
  // safety setting). Keys are checked before anything is computed.
  let adapter: KrakenAdapter | AlpacaAdapter | null = null;
  let grids = NULL_GRIDS;
  let hasGrids = false;
  if (mode === 'live' && assetType === 'crypto') {
    if (!krakenKeysPresent()) {
      throw new Error(
        'Live mode refused: KRAKEN_API_KEY and KRAKEN_API_SECRET are not set. Live places real orders on your Kraken account.',
      );
    }
    adapter = new KrakenAdapter({ symbol, sequenceId, sinceMs: Date.now() - 5 * 60 * 1000 });
    grids = await adapter.getGrids();
    hasGrids = true;
  } else if (mode === 'live' && assetType === 'stock') {
    const alpaca = new AlpacaAdapter({
      symbol,
      assetType,
      paper: process.env.ALPACA_PAPER === 'true',
    }); // throws a clear error when ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY are missing
    if (!(await alpaca.isMarketOpen())) {
      throw new Error('US market is closed: a market entry placed now would queue blindly. Start during market hours.');
    }
    adapter = alpaca;
    grids = await alpaca.getGrids();
    hasGrids = true;
  } else {
    try {
      grids = assetType === 'crypto' ? await fetchKrakenGrids(symbol) : NULL_GRIDS;
      hasGrids = assetType === 'crypto';
    } catch {
      grids = NULL_GRIDS;
    }
  }

  const entry = mode === 'live' && assetType === 'crypto'
    ? await krakenPublicPrice(symbol)
    : await publicPrice(symbol, assetType);

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
    assetType,
    venue: mode === 'live' ? (assetType === 'stock' ? 'alpaca' : 'kraken') : 'paper',
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
    file.state.haltReason = `entry placement failed: ${message}. Check and cancel your open orders on the venue yourself.`;
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

// Build the venue adapter for a persisted sequence and read the current price.
// Shared by cycleSequence and stopSequence so they agree on how each venue is
// constructed (kraken / alpaca live, or the rebuilt paper simulator).
async function buildVenue(
  file: RunnerFile,
  sequenceId: string,
): Promise<{ venue: VenueAdapter; price: number }> {
  if (file.venue === 'kraken') {
    const venue = new KrakenAdapter({
      symbol: file.symbol,
      sequenceId,
      sinceMs: Date.parse(file.createdAt) - 60 * 1000,
    });
    return { venue, price: await krakenPublicPrice(file.symbol) };
  }
  if (file.venue === 'alpaca') {
    const venue = new AlpacaAdapter({
      symbol: file.symbol,
      assetType: file.assetType ?? 'stock',
      paper: process.env.ALPACA_PAPER === 'true',
    });
    return { venue, price: await publicPrice(file.symbol, file.assetType ?? 'stock') };
  }
  const paper = rebuildPaper(file);
  const price = await publicPrice(file.symbol, file.assetType ?? 'crypto');
  paper.tick(price);
  return { venue: paper, price };
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

  const { venue, price } = await buildVenue(file, sequenceId);

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

export interface StopOptions {
  /**
   * When true, after canceling the open orders, market-sell the position
   * built so far (the "reverse trades" option in the Tradingale dashboard):
   * sum of filled buys minus anything already sold. Default false keeps the
   * accumulated position sitting in your account.
   */
  reverse?: boolean;
}

export interface StopSummary {
  sequenceId: string;
  venue: 'paper' | 'kraken' | 'alpaca';
  phase: string;
  canceledOrders: number;
  reversed: boolean;
  reversedQuantity: number;
  warning: string | null;
}

/**
 * Stop a running sequence, mirroring the Tradingale dashboard cancel:
 *  - always cancels the open orders at the venue (the resting limit buys and
 *    the one active sell);
 *  - with { reverse: true }, additionally market-sells the accumulated
 *    position to exit completely. Without it, the position is kept.
 * Idempotent client ids mean a failed run can be retried safely.
 */
export async function stopSequence(
  sequenceId: string,
  options: StopOptions = {},
  log: Logger = () => {},
): Promise<StopSummary> {
  const file = loadRun(sequenceId);
  if (!file) throw new Error(`unknown sequence ${sequenceId}`);
  if (file.state.phase !== 'running') {
    return {
      sequenceId,
      venue: file.venue,
      phase: file.state.phase,
      canceledOrders: 0,
      reversed: false,
      reversedQuantity: 0,
      warning: `sequence is ${file.state.phase}, not running`,
    };
  }

  const { venue, price } = await buildVenue(file, sequenceId);

  // 1. Cancel every open order at the venue (idempotent, tolerant of a
  //    single failure so one bad id does not block the rest).
  const open = await venue.getOpenOrders();
  let canceledOrders = 0;
  for (const order of open) {
    try {
      await venue.cancelOrder(order.clientId);
      canceledOrders++;
      log(`${sequenceId}: cancel ${order.clientId}`);
    } catch (error) {
      log(`${sequenceId}: cancel ${order.clientId} failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  // 2. Optional reverse: market-sell the net position (filled buys - sells).
  let reversed = false;
  let reversedQuantity = 0;
  if (options.reverse) {
    const fills = await venue.getFills();
    const bought = fills.filter((f) => f.side === 'buy').reduce((sum, f) => sum + f.quantity, 0);
    const sold = fills.filter((f) => f.side === 'sell').reduce((sum, f) => sum + f.quantity, 0);
    reversedQuantity = bought - sold;
    if (reversedQuantity > 0) {
      await venue.placeOrder({
        clientId: `${sequenceId}-reverse`,
        side: 'sell',
        type: 'market',
        quantity: reversedQuantity,
        level: file.state.deepestFilledLevel,
      });
      reversed = true;
      log(`${sequenceId}: reverse market-sell ${reversedQuantity}`);
    } else {
      log(`${sequenceId}: nothing accumulated, nothing to reverse`);
    }
  }

  file.state.phase = 'canceled';
  file.state.haltReason = options.reverse
    ? reversed
      ? `stopped by operator; position reversed (market sold ${reversedQuantity})`
      : 'stopped by operator; no position to reverse'
    : 'stopped by operator; open orders canceled, position kept';
  file.lastPrice = price;
  file.lastCycleAt = new Date().toISOString();
  if (venue instanceof PaperAdapter) file.paperFills = await venue.getFills();
  saveRun(file, sequenceId);

  return {
    sequenceId,
    venue: file.venue,
    phase: 'canceled',
    canceledOrders,
    reversed,
    reversedQuantity,
    warning: null,
  };
}

export interface SequenceStatus {
  sequenceId: string;
  symbol: string;
  venue: 'paper' | 'kraken' | 'alpaca';
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
