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
import { deleteRun, listRuns, loadRun, saveRun, type RunnerFile } from './state.js';
import { notify, tag } from './notify.js';

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
  /**
   * The site's manual sequences: YOU execute on your own exchange, the
   * runner only tracks. The plan is frozen exactly like any other sequence
   * and the level-1 buy is recorded as filled at the live entry price (the
   * site does the same); after that, you record each fill yourself. No
   * order is ever placed anywhere. Overrides mode.
   */
  manual?: boolean;
}

export interface StartSummary {
  sequenceId: string;
  symbol: string;
  mode: RunnerMode;
  venue: 'paper' | 'kraken' | 'alpaca' | 'manual';
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

  // Manual tracking: same instrument, same math, same guardrails — but the
  // runner never touches a venue. The level-1 buy is recorded as filled at
  // the live entry price, exactly like the site's manual sequences, and
  // every later fill is declared by the user from the dashboard.
  if (options.manual) {
    let manualGrids = NULL_GRIDS;
    let manualHasGrids = false;
    try {
      manualGrids = assetType === 'crypto' ? await fetchKrakenGrids(symbol) : NULL_GRIDS;
      manualHasGrids = assetType === 'crypto';
    } catch {
      manualGrids = NULL_GRIDS;
    }
    const manualEntry = await publicPrice(symbol, assetType);
    const manualFloor = budgetMin(instrument, manualEntry, manualGrids);
    const manualLadder = computeLadder(instrument, budget, manualEntry, manualHasGrids ? manualGrids : undefined);
    const manualProblems = checkLadderAgainstGrids(manualLadder, manualGrids);
    if (manualProblems.length > 0 || budget < manualFloor) {
      throw new Error(
        `Underfunded ladder (budget_min ~$${Math.ceil(manualFloor)}): ${manualProblems.join('; ') || 'raise the budget'}`,
      );
    }
    const manualPlan = buildPlan(sequenceId, manualLadder);
    const state = initialState();
    state.phase = 'running';
    state.deepestFilledLevel = 1; // the site marks round 1 FILLED at creation
    const entryFill: Fill = {
      clientId: `${sequenceId}-buy-1`,
      side: 'buy',
      price: manualEntry,
      quantity: manualLadder.levels[0].quantity,
      timestamp: Date.now(),
    };
    const file: RunnerFile = {
      version: 1,
      createdAt: new Date().toISOString(),
      symbol,
      assetType,
      venue: 'manual',
      budget,
      plan: manualPlan,
      state,
      fills: [entryFill],
      lastPrice: manualEntry,
      lastAction: 'manual tracking started: record your own fills from the dashboard',
    };
    saveRun(file, sequenceId);
    log(
      `started MANUAL tracking ${sequenceId} at $${manualEntry} (${manualPlan.ladder.levels.length} levels, $${budget}) — you execute, the runner tracks`,
    );
    void notify(
      `${tag('manual')} ${sequenceId}\nManual tracking started on ${symbol} at $${manualEntry}: ${manualPlan.ladder.levels.length} levels, $${budget} budget. Record your fills from the dashboard.`,
    );
    return {
      sequenceId,
      symbol,
      mode: 'paper',
      venue: 'manual',
      entryPrice: manualEntry,
      levels: manualPlan.ladder.levels.length,
      budget,
      martingaleScore: instrument.martingaleScore,
      startingale: instrument.startingale,
    };
  }

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
    await savePaperState(file, venue);
    saveRun(file, sequenceId);
  }

  log(
    `started ${mode.toUpperCase()} sequence ${sequenceId} at $${entry} (${plan.ladder.levels.length} levels, $${budget})`,
  );
  log(
    `score ${instrument.martingaleScore ?? '?'} / startingale ${instrument.startingale ?? '?'} (descriptive metrics, not advice)`,
  );
  void notify(
    `${tag(file.venue)} ${sequenceId}\nStarted on ${symbol} at $${entry}: ${plan.ladder.levels.length} levels, $${budget} budget.`,
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
  venue.restore(file.plan, fills, (file.paperOpen ?? []) as string[]);
  return venue;
}

/** Persist the paper venue's fills AND still-open orders (see paperOpen). */
async function savePaperState(file: RunnerFile, venue: VenueAdapter): Promise<void> {
  if (!(venue instanceof PaperAdapter)) return;
  file.paperFills = await venue.getFills();
  file.paperOpen = (await venue.getOpenOrders()).map((o) => o.clientId);
}

// Build the venue adapter for a persisted sequence and read the current price.
// Shared by cycleSequence and stopSequence so they agree on how each venue is
// constructed (kraken / alpaca live, or the rebuilt paper simulator).
async function buildVenue(
  file: RunnerFile,
  sequenceId: string,
  options: { skipPrice?: boolean } = {},
): Promise<{ venue: VenueAdapter; price: number }> {
  if (file.venue === 'kraken') {
    const venue = new KrakenAdapter({
      symbol: file.symbol,
      sequenceId,
      sinceMs: Date.parse(file.createdAt) - 60 * 1000,
    });
    return { venue, price: options.skipPrice ? (file.lastPrice ?? 0) : await krakenPublicPrice(file.symbol) };
  }
  if (file.venue === 'alpaca') {
    const venue = new AlpacaAdapter({
      symbol: file.symbol,
      assetType: file.assetType ?? 'stock',
      paper: process.env.ALPACA_PAPER === 'true',
    });
    return {
      venue,
      price: options.skipPrice ? (file.lastPrice ?? 0) : await publicPrice(file.symbol, file.assetType ?? 'stock'),
    };
  }
  const paper = rebuildPaper(file);
  if (options.skipPrice) return { venue: paper, price: file.lastPrice ?? 0 };
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
  if (file.paused) {
    throw new Error(`${sequenceId} is paused: resume it before running a check`);
  }
  // Manual sequences have nothing to reconcile — the user IS the venue.
  // Refresh the display price (best effort) and report, nothing else.
  if (file.venue === 'manual') {
    try {
      file.lastPrice = await publicPrice(file.symbol, file.assetType ?? 'crypto');
    } catch {
      /* price is cosmetic here */
    }
    file.lastCycleAt = new Date().toISOString();
    file.lastAction = 'manual tracking: waiting for your fills';
    saveRun(file, sequenceId);
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
  // What this pass did, in plain words: the automation is only reassuring
  // if the user can see it working.
  file.lastAction = actions.length
    ? actions
        .map((a) =>
          a.type === 'placeOrder'
            ? `placed ${a.order.side} level ${a.order.level}${a.order.price ? ` @ ${a.order.price}` : ' at market'}`
            : a.type === 'cancelOrder'
              ? 'canceled the stale sell'
              : a.type === 'complete'
                ? 'sequence complete: the sell filled'
                : `alert: ${a.message}`,
        )
        .join('; ')
    : 'nothing to do';

  // Alerts on the events worth waking up for: a deeper level filled, the
  // sequence closing, or the engine halting. Fire and forget — notify()
  // never throws, so a Telegram outage cannot disturb the cycle.
  const previousLevel = file.state.deepestFilledLevel;
  if (state.deepestFilledLevel > previousLevel) {
    void notify(
      `${tag(file.venue)} ${sequenceId}\nLevel ${state.deepestFilledLevel}/${file.plan.ladder.levels.length} reached on ${file.symbol} at $${price}.\nThe sell has been moved to the matching level.`,
    );
  }
  if (state.phase === 'complete') {
    void notify(`${tag(file.venue)} ${sequenceId}\nSequence complete on ${file.symbol}: the sell filled at level ${state.deepestFilledLevel}.`);
  } else if (state.phase === 'halted') {
    void notify(`${tag(file.venue)} ${sequenceId}\nHALTED on ${file.symbol}: ${state.haltReason ?? 'unknown reason'}\nCheck your venue.`);
  }

  file.state = state;
  file.fills = snapshot.fills; // journal history, every venue
  file.lastPrice = price;
  file.lastCycleAt = new Date().toISOString();
  await savePaperState(file, venue);
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

/**
 * Manual repair of the active sell, the local equivalent of the site's
 * update-sell action: cancel whatever sell is resting, then reconcile so
 * the engine re-places the correct template for the level actually reached.
 * Useful when a venue rejected or expired the order, or after fixing keys.
 * The buy ladder is never touched.
 */
export async function resyncSell(sequenceId: string, log: Logger = () => {}): Promise<CycleSummary> {
  const file = loadRun(sequenceId);
  if (!file) throw new Error(`unknown sequence ${sequenceId}`);
  if (file.state.phase !== 'running') throw new Error(`sequence is ${file.state.phase}, not running`);
  if (file.paused) throw new Error(`${sequenceId} is paused: resume it before resyncing the sell`);
  if (file.venue === 'manual') throw new Error('manual sequences have no resting orders to resync: you execute them yourself');

  const { venue } = await buildVenue(file, sequenceId);
  const open = await venue.getOpenOrders();
  let canceled = 0;
  for (const order of open) {
    if (order.side !== 'sell') continue;
    try {
      await venue.cancelOrder(order.clientId);
      canceled++;
      log(`${sequenceId}: resync, canceled sell ${order.clientId}`);
    } catch (error) {
      log(`${sequenceId}: resync could not cancel ${order.clientId}: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (venue instanceof PaperAdapter) {
    await savePaperState(file, venue);
    saveRun(file, sequenceId);
  }
  if (canceled === 0) log(`${sequenceId}: no resting sell to resync; reconciling anyway`);
  // The next reconciliation places the right template again.
  return cycleSequence(sequenceId, log);
}

/** One pass over every persisted sequence, strictly sequential. */
export async function cycleAll(log: Logger = () => {}): Promise<CycleSummary[]> {
  const summaries: CycleSummary[] = [];
  for (const id of listRuns()) {
    try {
      // The site's toggle-bot: a paused sequence is skipped by the scheduled
      // pass, quietly. Its resting orders stay exactly where they are.
      const file = loadRun(id);
      if (file?.paused) {
        log(`${id}: paused, skipped`);
        continue;
      }
      summaries.push(await cycleSequence(id, log));
    } catch (error) {
      log(`${id}: cycle error: ${error instanceof Error ? error.message : error}`);
    }
  }
  return summaries;
}

/**
 * The site's toggle-bot, per sequence: paused means the scheduled pass skips
 * it and Check now / Resync refuse, until it is resumed. Orders already
 * resting on the venue are NOT touched — pausing stops the runner's checks,
 * it does not cancel anything (use Stop for that).
 */
export function pauseSequence(sequenceId: string, paused: boolean): { sequenceId: string; paused: boolean } {
  const file = loadRun(sequenceId);
  if (!file) throw new Error(`unknown sequence ${sequenceId}`);
  if (file.state.phase !== 'running') throw new Error(`sequence is ${file.state.phase}, not running`);
  if (file.venue === 'manual') throw new Error('manual sequences have no bot to pause: you execute them yourself');
  file.paused = paused;
  file.lastAction = paused
    ? 'paused: automatic checks skip this sequence until you resume it (resting orders untouched)'
    : 'resumed: automatic checks are back on';
  saveRun(file, sequenceId);
  void notify(
    `${tag(file.venue)} ${sequenceId}\n${paused ? 'Paused' : 'Resumed'} on ${file.symbol}: automatic checks are ${paused ? 'OFF (resting orders untouched)' : 'back on'}.`,
  );
  return { sequenceId, paused };
}

/**
 * The site's manual update-round / complete-sell: record a fill YOU executed
 * on your own exchange. 'buy' marks the next level's buy as filled at its
 * planned price; 'sell' marks the current level's sell as filled and
 * completes the sequence. Manual sequences only.
 */
export function markManualFill(
  sequenceId: string,
  kind: 'buy' | 'sell',
): { sequenceId: string; phase: string; deepestFilledLevel: number } {
  const file = loadRun(sequenceId);
  if (!file) throw new Error(`unknown sequence ${sequenceId}`);
  if (file.venue !== 'manual') throw new Error('fills can only be recorded on manual sequences');
  if (file.state.phase !== 'running') throw new Error(`sequence is ${file.state.phase}, not running`);

  const levels = file.plan.ladder.levels;
  const fills = (file.fills ?? []) as Fill[];

  if (kind === 'buy') {
    const next = file.state.deepestFilledLevel + 1;
    const level = levels.find((l) => l.level === next);
    if (!level) throw new Error(`level ${next} does not exist: the ladder has ${levels.length} levels`);
    fills.push({
      clientId: `${sequenceId}-buy-${next}`,
      side: 'buy',
      price: level.buyPrice,
      quantity: level.quantity,
      timestamp: Date.now(),
    });
    file.state.deepestFilledLevel = next;
    file.lastAction = `you recorded the level ${next} buy as filled @ ${level.buyPrice}`;
    void notify(
      `${tag('manual')} ${sequenceId}\nLevel ${next}/${levels.length} buy recorded on ${file.symbol} @ $${level.buyPrice}.`,
    );
  } else {
    const current = levels.find((l) => l.level === file.state.deepestFilledLevel);
    if (!current) throw new Error('no filled level to sell from');
    fills.push({
      clientId: `${sequenceId}-sell-${current.level}`,
      side: 'sell',
      price: current.exitPrice,
      quantity: current.cumulativeQuantity,
      timestamp: Date.now(),
    });
    file.state.phase = 'complete';
    file.lastAction = `you recorded the level ${current.level} sell as filled @ ${current.exitPrice}: sequence complete`;
    void notify(
      `${tag('manual')} ${sequenceId}\nSequence complete on ${file.symbol}: sell recorded @ $${current.exitPrice}.`,
    );
  }

  file.fills = fills;
  file.lastCycleAt = new Date().toISOString();
  saveRun(file, sequenceId);
  return { sequenceId, phase: file.state.phase, deepestFilledLevel: file.state.deepestFilledLevel };
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
  venue: 'paper' | 'kraken' | 'alpaca' | 'manual';
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

  // Manual tracking: nothing rests anywhere, stopping only closes the
  // record. Whatever you hold on your exchange stays yours to manage.
  if (file.venue === 'manual') {
    file.state.phase = 'canceled';
    file.state.haltReason = 'tracking stopped by operator; your own exchange orders are untouched';
    file.lastAction = 'manual tracking stopped';
    file.lastCycleAt = new Date().toISOString();
    saveRun(file, sequenceId);
    void notify(`${tag('manual')} ${sequenceId}\nManual tracking stopped on ${file.symbol}. Your own exchange orders are untouched.`);
    return {
      sequenceId,
      venue: file.venue,
      phase: 'canceled',
      canceledOrders: 0,
      reversed: false,
      reversedQuantity: 0,
      warning: options.reverse ? 'nothing to reverse: the runner never held or placed anything for a manual sequence' : null,
    };
  }

  // A stop must ALWAYS be possible: a public ticker being unreachable must
  // never stand between the user and cancelling their orders. The price is
  // cosmetic here (it only updates lastPrice), so degrade instead of throwing.
  let venue: VenueAdapter;
  let price: number | null = null;
  try {
    const built = await buildVenue(file, sequenceId);
    venue = built.venue;
    price = built.price;
  } catch (error) {
    log(`${sequenceId}: price lookup failed (${error instanceof Error ? error.message : error}); cancelling anyway`);
    const built = await buildVenue(file, sequenceId, { skipPrice: true });
    venue = built.venue;
  }

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
  file.fills = await venue.getFills(); // final history for the journal
  if (price !== null) file.lastPrice = price;
  file.state.haltReason = options.reverse
    ? reversed
      ? `stopped by operator; position reversed (market sold ${reversedQuantity})`
      : 'stopped by operator; no position to reverse'
    : 'stopped by operator; open orders canceled, position kept';
  file.lastCycleAt = new Date().toISOString();
  await savePaperState(file, venue);
  saveRun(file, sequenceId);

  void notify(
    `${tag(file.venue)} ${sequenceId}\nStopped on ${file.symbol}: ${canceledOrders} order(s) canceled` +
      (reversed ? `, position market-sold (${reversedQuantity}).` : ', position kept.'),
  );

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

/**
 * Delete a finished SIMULATED sequence's file (dashboard housekeeping).
 * Two refusals, both deliberate:
 *  - a RUNNING sequence is never deleted (stop it first, otherwise live
 *    orders keep resting at the venue with nothing reconciling them);
 *  - a LIVE sequence is never deleted, ever. Real money placed BY THE RUNNER
 *    stays in the journal as a permanent record. Manual sequences are
 *    deletable like on the site: the runner only ever held your notes about
 *    them, not the orders.
 */
export function deleteSequence(sequenceId: string): { deleted: boolean; reason?: string } {
  const file = loadRun(sequenceId);
  if (!file) return { deleted: false, reason: 'unknown sequence' };
  if (file.state.phase === 'running') {
    return { deleted: false, reason: 'sequence is running: stop it first' };
  }
  if (file.venue !== 'paper' && file.venue !== 'manual') {
    return { deleted: false, reason: 'live sequences are kept permanently in the journal' };
  }
  return { deleted: deleteRun(sequenceId) };
}

/** Delete finished SIMULATED sequences only. Live history is never removed. */
export function deleteFinished(): number {
  let removed = 0;
  for (const id of listRuns()) {
    const file = loadRun(id);
    if (!file || file.state.phase === 'running' || file.venue !== 'paper') continue;
    if (deleteRun(id)) removed++;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Journal + metrics, computed from the persisted fill history (the same
// figures the Tradingale dashboard reports, restricted to what a local
// runner can actually know).
// ---------------------------------------------------------------------------

export interface JournalEntry {
  sequenceId: string;
  symbol: string;
  assetType: 'crypto' | 'stock';
  venue: 'paper' | 'kraken' | 'alpaca' | 'manual';
  /** True for anything that is not simulated: runner-driven live AND manual. */
  live: boolean;
  phase: string;
  budget: number;
  /** Quote spent on filled buys. */
  capitalUsed: number;
  /** Quote received from filled sells. */
  proceeds: number;
  /** Realized P/L on the portion actually sold (proportional cost basis). */
  realized: number;
  /** Realized P/L as a percentage of the capital actually deployed. */
  realizedPctOnUsed: number;
  /** Realized P/L as a percentage of the budget allocated. */
  realizedPctOnBudget: number;
  /** Base units still held (a stop without reverse keeps the position). */
  openQuantity: number;
  roundsReached: number;
  totalRounds: number;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
}

interface FillLike {
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
}

function entryFor(file: RunnerFile, sequenceId: string): JournalEntry {
  const fills = ((file.fills ?? file.paperFills ?? []) as FillLike[]).filter(
    (f) => f && Number.isFinite(f.price) && Number.isFinite(f.quantity),
  );
  let boughtQty = 0;
  let capitalUsed = 0;
  let soldQty = 0;
  let proceeds = 0;
  for (const fill of fills) {
    if (fill.side === 'buy') {
      boughtQty += fill.quantity;
      capitalUsed += fill.quantity * fill.price;
    } else {
      soldQty += fill.quantity;
      proceeds += fill.quantity * fill.price;
    }
  }
  // Cost basis of the SOLD portion only, so a partial exit is not counted
  // as a loss on inventory the user still holds.
  const soldCost = boughtQty > 0 ? capitalUsed * Math.min(1, soldQty / boughtQty) : 0;
  const realized = proceeds - soldCost;
  const endedAt = file.state.phase === 'running' ? null : (file.lastCycleAt ?? null);
  return {
    sequenceId,
    symbol: file.symbol,
    assetType: file.assetType ?? 'crypto',
    venue: file.venue,
    live: file.venue !== 'paper',
    phase: file.state.phase,
    budget: file.budget,
    capitalUsed,
    proceeds,
    realized,
    realizedPctOnUsed: soldCost > 0 ? (realized / soldCost) * 100 : 0,
    realizedPctOnBudget: file.budget > 0 ? (realized / file.budget) * 100 : 0,
    openQuantity: Math.max(0, boughtQty - soldQty),
    roundsReached: file.state.deepestFilledLevel,
    totalRounds: file.plan.ladder.levels.length,
    startedAt: file.createdAt,
    endedAt,
    durationMs: endedAt ? Date.parse(endedAt) - Date.parse(file.createdAt) : null,
  };
}

/** Every sequence the runner knows about, newest first. */
export function journal(): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const id of listRuns()) {
    const file = loadRun(id);
    if (file) entries.push(entryFor(file, id));
  }
  return entries.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

/**
 * The dashboard metric set, ported from the Tradingale site's
 * PerformanceOverview: three headline figures, then five sections behind
 * the expand toggle (profit, analytics, projections, risk, active).
 * Everything is derived from this runner's own fill history.
 */
export interface JournalMetrics {
  // Headline
  totalRealized: number;
  capitalIncreasePct: number;
  completedCount: number;
  avgPctPerSequence: number;
  avgDurationMs: number | null;
  avgRiskExposurePct: number;
  roundEfficiency: number;
  activeCount: number;
  activeCapital: number;
  activeExposurePct: number;

  // Profit performance
  monthlyRealized: number;
  monthlyPct: number;
  ytdRealized: number;
  ytdPct: number;
  canceledCount: number;
  canceledRealized: number;
  canceledPct: number;

  // Sequence analytics
  closedCount: number;
  capitalEfficiencyPct: number;
  avgCapitalUsed: number;
  avgRealizedPctOnUsed: number;
  avgRealizedPctOnBudget: number;

  // Projections (theoretical, from the observed average sequence)
  projectedAnnualReturnPct: number;
  compoundedAnnualReturnPct: number;
  tenYearMultiplier: number;

  // Risk
  winRatePct: number;
  winRateNumerator: number;
  winRateDenominator: number;
  apexRiskRatioPct: number;
  maxRoundCount: number;
}

/**
 * Aggregate the journal. `scope` mirrors the dashboard filter: simulated
 * runs and real ones are never averaged together, because mixing them
 * would report a number that describes neither.
 */
export function journalMetrics(scope: 'live' | 'paper' | 'all' = 'all'): JournalMetrics {
  const all = journal().filter((e) => (scope === 'all' ? true : scope === 'live' ? e.live : !e.live));
  const closed = all.filter((e) => e.phase !== 'running');
  const active = all.filter((e) => e.phase === 'running');
  const wins = closed.filter((e) => e.realized > 0);
  const durations = closed.map((e) => e.durationMs).filter((d): d is number => typeof d === 'number' && d > 0);
  const avg = (nums: number[]): number => (nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : 0);

  const totalBudget = closed.reduce((sum, e) => sum + e.budget, 0);
  const totalRealized = closed.reduce((sum, e) => sum + e.realized, 0);
  const avgPctPerSequence = avg(closed.map((e) => e.realizedPctOnBudget));
  const avgDurationMs = durations.length ? avg(durations) : null;

  // Windowed slices, by the day a sequence closed.
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const yearStart = new Date(now.getFullYear(), 0, 1).getTime();
  const closedSince = (from: number): JournalEntry[] =>
    closed.filter((e) => e.endedAt && Date.parse(e.endedAt) >= from);
  const monthly = closedSince(monthStart);
  const ytd = closedSince(yearStart);
  const sumRealized = (list: JournalEntry[]): number => list.reduce((s, e) => s + e.realized, 0);
  const pctOn = (list: JournalEntry[]): number => {
    const budget = list.reduce((s, e) => s + e.budget, 0);
    return budget > 0 ? (sumRealized(list) / budget) * 100 : 0;
  };
  const canceled = closed.filter((e) => e.phase === 'canceled');

  // Projections are pure arithmetic on the observed average sequence, and
  // are theoretical by construction: they assume the same average outcome
  // repeats at the same pace. Guarded so a missing duration yields 0.
  const avgDurationDays = avgDurationMs ? avgDurationMs / 86_400_000 : 0;
  const cyclesPerYear = avgDurationDays > 0 ? 365 / avgDurationDays : 0;
  const growth = 1 + avgPctPerSequence / 100;
  const compounded = cyclesPerYear > 0 && growth > 0 ? (Math.pow(growth, cyclesPerYear) - 1) * 100 : 0;
  const tenYear = cyclesPerYear > 0 && growth > 0 ? Math.pow(growth, cyclesPerYear * 10) : 0;

  return {
    totalRealized,
    capitalIncreasePct: totalBudget > 0 ? (totalRealized / totalBudget) * 100 : 0,
    completedCount: closed.filter((e) => e.phase === 'complete').length,
    avgPctPerSequence,
    avgDurationMs,
    avgRiskExposurePct: avg(closed.map((e) => (e.budget > 0 ? (e.capitalUsed / e.budget) * 100 : 0))),
    roundEfficiency: avg(closed.map((e) => e.roundsReached)),
    activeCount: active.length,
    activeCapital: active.reduce((sum, e) => sum + e.capitalUsed, 0),
    activeExposurePct: (() => {
      const budget = active.reduce((sum, e) => sum + e.budget, 0);
      return budget > 0 ? (active.reduce((s, e) => s + e.capitalUsed, 0) / budget) * 100 : 0;
    })(),

    monthlyRealized: sumRealized(monthly),
    monthlyPct: pctOn(monthly),
    ytdRealized: sumRealized(ytd),
    ytdPct: pctOn(ytd),
    canceledCount: canceled.length,
    canceledRealized: sumRealized(canceled),
    canceledPct: pctOn(canceled),

    closedCount: closed.length,
    capitalEfficiencyPct: avg(closed.map((e) => e.realizedPctOnUsed)),
    avgCapitalUsed: avg(closed.map((e) => e.capitalUsed)),
    avgRealizedPctOnUsed: avg(closed.map((e) => e.realizedPctOnUsed)),
    avgRealizedPctOnBudget: avgPctPerSequence,

    projectedAnnualReturnPct: avgPctPerSequence * cyclesPerYear,
    compoundedAnnualReturnPct: compounded,
    tenYearMultiplier: tenYear,

    winRatePct: closed.length ? (wins.length / closed.length) * 100 : 0,
    winRateNumerator: wins.length,
    winRateDenominator: closed.length,
    apexRiskRatioPct: closed.length
      ? (closed.filter((e) => e.roundsReached >= e.totalRounds).length / closed.length) * 100
      : 0,
    maxRoundCount: closed.filter((e) => e.roundsReached >= e.totalRounds).length,
  };
}

export interface SequenceStatus {
  sequenceId: string;
  symbol: string;
  venue: 'paper' | 'kraken' | 'alpaca' | 'manual';
  phase: string;
  /** The site's toggle-bot: automatic checks skip this sequence while true. */
  paused: boolean;
  haltReason: string | null;
  budget: number;
  createdAt: string;
  deepestFilledLevel: number;
  totalLevels: number;
  entryPrice: number;
  deltaPrice: number;
  lastPrice: number | null;
  lastCycleAt: string | null;
  /** What the last check did, in plain words. */
  lastAction: string | null;
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
      paused: Boolean(file.paused),
      lastCycleAt: file.lastCycleAt ?? null,
      lastAction: file.lastAction ?? null,
      levels: file.plan.ladder.levels,
    });
  }
  statuses.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return statuses;
}
