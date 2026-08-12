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
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { CYCLE_MS, cycleAll, startSequence, statusAll, stopSequence } from './core.js';
import { keysStatus, loadKeysIntoEnv, writeKeys, type KeyVar } from './keystore.js';

// Load <RUNNER_STATE_DIR>/keys.env before any command reads the environment.
loadKeysIntoEnv();

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

function printKeyStatus(): void {
  const s = keysStatus();
  const mark = (ok: boolean): string => (ok ? 'configured ✓' : 'absent');
  console.log(`  Tradingale token : ${mark(s.tradingale)}`);
  console.log(`  Kraken keys      : ${mark(s.kraken)}`);
  console.log(`  Alpaca keys      : ${mark(s.alpaca)}`);
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function cmdKeys(): Promise<void> {
  console.log('Configure runner keys -> .martingale-runner/keys.env (chmod 600).');
  console.log('Input is hidden and never displayed again or logged. Leave a field BLANK to keep the current value.');
  console.log('This does NOT enable live: live stays decided by RUNNER_MODE=live at launch.\n');
  console.log('Current:');
  printKeyStatus();
  console.log('');

  // Two paths. On a real terminal, a shared readline with a toggled-mute
  // output hides the typed characters. When stdin is piped/scripted, read
  // the lines up front and consume them in order (a TTY-only readline would
  // race the stream's EOF). Either way the label stays visible.
  const isTTY = process.stdin.isTTY === true;
  let ask: (label: string) => Promise<string>;
  let cleanup: () => void = () => {};

  if (isTTY) {
    let mute = false;
    const out = new Writable({
      write(chunk, _enc, cb) {
        if (!mute) process.stdout.write(chunk as Buffer);
        cb();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
    cleanup = () => rl.close();
    ask = (label: string): Promise<string> =>
      new Promise((resolve) => {
        process.stdout.write(`${label}: `);
        mute = true;
        rl.question('', (answer) => {
          mute = false;
          process.stdout.write('\n');
          resolve(answer.trim());
        });
      });
  } else {
    const lines = (await readAllStdin()).split('\n');
    let cursor = 0;
    ask = (label: string): Promise<string> => {
      process.stdout.write(`${label}: \n`);
      return Promise.resolve((lines[cursor++] ?? '').trim());
    };
  }

  const fields: { key: KeyVar; label: string }[] = [
    { key: 'TRADINGALE_TOKEN', label: 'Tradingale API token (tradingale.com/settings/api)' },
    { key: 'KRAKEN_API_KEY', label: 'Kraken API key (live crypto; trade-only, no withdrawal)' },
    { key: 'KRAKEN_API_SECRET', label: 'Kraken API secret' },
    { key: 'ALPACA_API_KEY_ID', label: 'Alpaca API key id (live US stocks)' },
    { key: 'ALPACA_API_SECRET_KEY', label: 'Alpaca API secret key' },
  ];
  const entries: Partial<Record<KeyVar, string>> = {};
  for (const field of fields) {
    const value = await ask(field.label);
    if (value) entries[field.key] = value;
  }
  cleanup();

  if (Object.keys(entries).length === 0) {
    console.log('\nNothing entered; keys unchanged.');
    return;
  }
  writeKeys(entries);
  loadKeysIntoEnv();
  console.log('\nSaved. New status:');
  printKeyStatus();
  console.log('\nReminder: exchange keys must be trade-only (no withdrawal permission), ideally IP-allowlisted.');
  console.log('To go live: relaunch with RUNNER_MODE=live (paper stays the default).');
}

const cmd = process.argv[2];
const run = { start: cmdStart, cycle: cmdCycle, watch: cmdWatch, status: cmdStatus, stop: cmdStop, keys: cmdKeys }[cmd ?? ''];
if (!run) {
  console.log('usage: runner <start|cycle|watch|status|stop|keys> [--symbol BTC] [--budget 1000] [--live] [--reverse]');
  process.exit(1);
}
run().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
