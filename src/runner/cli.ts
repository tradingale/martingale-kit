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
//   npx tsx src/runner/cli.ts watch            # loop every 10 minutes
//   npx tsx src/runner/cli.ts status
//
// Env: TRADINGALE_TOKEN (required). --live additionally requires
// KRAKEN_API_KEY and KRAKEN_API_SECRET and places REAL orders on your
// Kraken account: your keys, your account, your sole responsibility.
// The runner refuses underfunded ladders (budgetMin) instead of placing a
// distorted one, per the handbook.
import { CYCLE_MS, cycleAll, startSequence, statusAll } from './core.js';

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
  log(`watching (every ${CYCLE_MS / 60000} min, Ctrl+C to stop)`);
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

const cmd = process.argv[2];
const run = { start: cmdStart, cycle: cmdCycle, watch: cmdWatch, status: cmdStatus }[cmd ?? ''];
if (!run) {
  console.log('usage: runner <start|cycle|watch|status> [--symbol BTC] [--budget 1000] [--live]');
  process.exit(1);
}
run().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
