#!/usr/bin/env node
// The Tradingale Runner, CLI front end. The actual start/cycle/stop/status
// logic lives in src/runner/core.ts, shared with the web runner
// (src/server/); this file only parses arguments and prints.
//
// PAPER BY DEFAULT. Everything runs locally: your token, your (optional)
// keys, your machine. Tradingale only ever serves the model parameters.
//
//   npx tsx src/runner/cli.ts start --symbol BTC --budget 1000
//   npx tsx src/runner/cli.ts start --symbol BTC --budget 1000 --live
//   npx tsx src/runner/cli.ts cycle            # run one reconciliation pass
//   npx tsx src/runner/cli.ts watch            # reconcile on a schedule
//   npx tsx src/runner/cli.ts status
//   npx tsx src/runner/cli.ts stop <sequenceId>            # cancel open orders, keep the position
//   npx tsx src/runner/cli.ts stop <sequenceId> --reverse  # cancel AND market-sell the position
//
// Env: TRADINGALE_TOKEN (required). --live additionally requires
// KRAKEN_API_KEY and KRAKEN_API_SECRET and places REAL orders on your
// Kraken account: your keys, your account, your sole responsibility.
// The runner refuses underfunded ladders (budgetMin) instead of placing a
// distorted one, per the handbook.
import { CYCLE_MS, cycleAll, startSequence, statusAll, stopSequence } from './core.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function log(msg: string): void {
  console.log(`[runner ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function cmdStart(): Promise<void> {
  const live = process.argv.includes('--live');
  if (live) {
    log('LIVE MODE: real orders on your Kraken account. Your keys, your account, your sole responsibility.');
  }
  await startSequence(
    {
      symbol: arg('symbol') ?? 'BTC',
      budget: Number(arg('budget') ?? 1000),
      mode: live ? 'live' : 'paper',
    },
    log,
  );
}

async function cmdCycle(): Promise<void> {
  await cycleAll(log);
}

async function cmdWatch(): Promise<void> {
  log('watching (Ctrl+C to stop)');
  // Overlap guard: a plain sequential loop cannot overlap itself.
  for (;;) {
    try {
      await cycleAll(log);
    } catch (e) {
      log(`cycle error: ${e instanceof Error ? e.message : e}`);
    }
    await new Promise((r) => setTimeout(r, CYCLE_MS));
  }
}

async function cmdStatus(): Promise<void> {
  for (const s of statusAll()) {
    console.log(
      `${s.sequenceId}  ${s.venue}  ${s.phase}  level ${s.deepestFilledLevel}/${s.totalLevels}  budget $${s.budget}`,
    );
  }
}

async function cmdStop(): Promise<void> {
  const id = process.argv[3];
  if (!id || id.startsWith('--')) {
    console.error('usage: runner stop <sequenceId> [--reverse]   (get the id from `runner status`)');
    process.exit(1);
  }
  const reverse = process.argv.includes('--reverse');
  const s = await stopSequence(id, { reverse }, log);
  const tail = reverse
    ? s.reversed
      ? `, reversed ${s.reversedQuantity} at market`
      : ', nothing to reverse'
    : ', position kept';
  log(`stopped ${id}: canceled ${s.canceledOrders} order(s)${tail}`);
}

const cmd = process.argv[2];
const run = { start: cmdStart, cycle: cmdCycle, watch: cmdWatch, status: cmdStatus, stop: cmdStop }[cmd ?? ''];
if (!run) {
  console.log('usage: runner <start|cycle|watch|status|stop> [--symbol BTC] [--budget 1000] [--live] [--reverse]');
  process.exit(1);
}
run().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
