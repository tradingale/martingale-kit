// Local, owner-only key storage for the runner, so a user can configure
// their token and exchange keys once (via `runner keys`) instead of exporting
// env vars every session. The keys live in `<RUNNER_STATE_DIR>/keys.env`
// (chmod 600), are loaded into process.env at boot, and are NEVER logged,
// echoed, or returned by any API.
//
// SECURITY INVARIANT: this file can only ever carry KEY material. RUNNER_MODE
// is deliberately NOT in the allowlist, so a keys file can never flip the
// runner from paper to live — live stays decided by the real environment at
// launch, and only there.

import fs from 'node:fs';
import path from 'node:path';
import { runnerDir } from './state.js';

export const KEY_VARS = [
  'TRADINGALE_TOKEN',
  'KRAKEN_API_KEY',
  'KRAKEN_API_SECRET',
  'ALPACA_API_KEY_ID',
  'ALPACA_API_SECRET_KEY',
  'ALPACA_PAPER',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
] as const;
export type KeyVar = (typeof KEY_VARS)[number];
const ALLOWED = new Set<string>(KEY_VARS);

export function keysFilePath(): string {
  return path.join(runnerDir(), 'keys.env');
}

// Parse KEY=VALUE lines, dropping comments, blanks, and anything not in the
// allowlist. The file is parsed here, never shell-sourced, so values need no
// escaping and an unknown line can do nothing.
function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!ALLOWED.has(key)) continue;
    out[key] = line.slice(eq + 1);
  }
  return out;
}

/**
 * Load keys.env into process.env, without overriding anything already set in
 * the real environment (the shell always wins). Silent when the file is
 * absent. RUNNER_MODE is never touched.
 */
export function loadKeysIntoEnv(): void {
  let text: string;
  try {
    text = fs.readFileSync(keysFilePath(), 'utf-8');
  } catch {
    return;
  }
  const parsed = parse(text);
  for (const key of KEY_VARS) {
    if (process.env[key] === undefined && parsed[key] !== undefined) {
      process.env[key] = parsed[key];
    }
  }
}

/**
 * Merge new values into keys.env and write it back with owner-only perms.
 * An empty-string value clears that key. Non-allowlisted keys are ignored.
 * Values are never logged.
 */
export function writeKeys(entries: Partial<Record<KeyVar, string>>): void {
  const file = keysFilePath();
  let existing: Record<string, string> = {};
  try {
    existing = parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    /* first write: no file yet */
  }
  for (const [key, value] of Object.entries(entries)) {
    if (!ALLOWED.has(key) || value === undefined) continue;
    if (value === '') delete existing[key];
    else existing[key] = value;
  }
  const body =
    '# Tradingale Runner keys. Owner-only (chmod 600). Do NOT commit.\n' +
    '# RUNNER_MODE is intentionally NOT read from here: live is env-only.\n' +
    KEY_VARS.filter((k) => existing[k] !== undefined)
      .map((k) => `${k}=${existing[k]}`)
      .join('\n') +
    '\n';
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export interface KeysStatus {
  tradingale: boolean;
  kraken: boolean;
  alpaca: boolean;
  telegram: boolean;
}

/** Presence booleans only — the values themselves are never exposed. */
export function keysStatus(): KeysStatus {
  return {
    tradingale: Boolean(process.env.TRADINGALE_TOKEN),
    kraken: Boolean(process.env.KRAKEN_API_KEY && process.env.KRAKEN_API_SECRET),
    alpaca: Boolean(process.env.ALPACA_API_KEY_ID && process.env.ALPACA_API_SECRET_KEY),
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
  };
}
