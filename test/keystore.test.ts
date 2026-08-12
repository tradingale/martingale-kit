import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadKeysIntoEnv, writeKeys, keysStatus, keysFilePath } from '../src/runner/keystore.js';

const MANAGED = [
  'TRADINGALE_TOKEN',
  'KRAKEN_API_KEY',
  'KRAKEN_API_SECRET',
  'ALPACA_API_KEY_ID',
  'ALPACA_API_SECRET_KEY',
  'ALPACA_PAPER',
  'RUNNER_MODE',
];

function clearEnv(): void {
  for (const key of MANAGED) delete process.env[key];
}

describe('keystore', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-keys-'));
    process.env.RUNNER_STATE_DIR = dir;
    clearEnv();
  });

  afterEach(() => {
    delete process.env.RUNNER_STATE_DIR;
    clearEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes an owner-only (0600) file, and keysStatus reflects presence only', () => {
    writeKeys({ TRADINGALE_TOKEN: 'tok', KRAKEN_API_KEY: 'k', KRAKEN_API_SECRET: 's' });
    expect(fs.statSync(keysFilePath()).mode & 0o777).toBe(0o600);
    loadKeysIntoEnv();
    expect(process.env.TRADINGALE_TOKEN).toBe('tok');
    const status = keysStatus();
    expect(status).toEqual({ tradingale: true, kraken: true, alpaca: false });
  });

  it('the real environment always wins over keys.env', () => {
    writeKeys({ TRADINGALE_TOKEN: 'fromfile' });
    process.env.TRADINGALE_TOKEN = 'fromenv';
    loadKeysIntoEnv();
    expect(process.env.TRADINGALE_TOKEN).toBe('fromenv');
  });

  it('never loads RUNNER_MODE from the file (no paper -> live escalation)', () => {
    fs.writeFileSync(keysFilePath(), 'RUNNER_MODE=live\nTRADINGALE_TOKEN=tok\n', { mode: 0o600 });
    loadKeysIntoEnv();
    expect(process.env.RUNNER_MODE).toBeUndefined();
    expect(process.env.TRADINGALE_TOKEN).toBe('tok');
  });

  it('merges on rewrite, and an empty value clears a key', () => {
    writeKeys({ TRADINGALE_TOKEN: 'tok', KRAKEN_API_KEY: 'k', KRAKEN_API_SECRET: 's' });
    writeKeys({ KRAKEN_API_KEY: '', KRAKEN_API_SECRET: '' });
    loadKeysIntoEnv();
    expect(process.env.TRADINGALE_TOKEN).toBe('tok');
    expect(process.env.KRAKEN_API_KEY).toBeUndefined();
    expect(keysStatus().kraken).toBe(false);
  });
});
