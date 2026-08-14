#!/usr/bin/env node
// The Tradingale Runner, web edition: one node:http server (zero frameworks,
// zero added dependencies) hosting the UI AND running the reconciliation
// loop in the same process. Built for one-click Railway deploys; works the
// same on any box with `npm run server`.
//
// PAPER BY DEFAULT. RUNNER_MODE=live switches to the KrakenAdapter and is
// refused at start time when KRAKEN_API_KEY / KRAKEN_API_SECRET are absent.
// Keys are read from the environment and never logged or served.
//
// Env:
//   TRADINGALE_TOKEN   required to start sequences (model parameters)
//   RUNNER_MODE        paper (default) | live
//   KRAKEN_API_KEY / KRAKEN_API_SECRET      live crypto (Kraken)
//   ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY  live US stocks (Alpaca)
//   ALPACA_PAPER       'true' points the Alpaca rail at its paper environment
//   KRAKEN_API_KEY     live mode only
//   KRAKEN_API_SECRET  live mode only
//   RUNNER_PASSWORD    optional; when set, Basic Auth guards the server
//   RUNNER_STATE_DIR   optional; persistent dir for plan files (Railway volume)
//   PORT               listen port (Railway injects it)

import http from 'node:http';
import crypto from 'node:crypto';
import {
  CYCLE_MS,
  cycleAll,
  deleteFinished,
  deleteSequence,
  krakenKeysPresent,
  previewSequence,
  runnerMode,
  startSequence,
  statusAll,
  stopSequence,
} from '../runner/core.js';
import { runnerDir } from '../runner/state.js';
import fs from 'node:fs';
import path from 'node:path';
import { bulkCryptoPrices, bulkStockPrices, publicPrice } from '../runner/prices.js';
import { TradingaleClient, type TradingaleInstrument } from '../client.js';
import { startingaleLabel } from '../runner/startingale.js';
import { KEY_VARS, keysStatus, loadKeysIntoEnv, writeKeys, type KeyVar } from '../runner/keystore.js';
import { renderPage } from './page.js';

// Load <RUNNER_STATE_DIR>/keys.env into the environment before anything reads
// it. Never overrides a real env var, never carries RUNNER_MODE: live stays
// decided by the real environment at launch.
loadKeysIntoEnv();

const PORT = Number(process.env.PORT ?? 8080);
const MODE = runnerMode();
const PASSWORD = process.env.RUNNER_PASSWORD ?? '';
const MAX_BODY_BYTES = 64 * 1024;

function log(msg: string): void {
  console.log(`[server ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Display price cache: /api/state never awaits the network (it doubles as
// the deploy healthcheck), it serves cached prices and refreshes them in
// the background.
// ---------------------------------------------------------------------------

const priceCache = new Map<string, { price: number; at: number }>();
const priceInflight = new Set<string>();
const PRICE_TTL_MS = 25 * 1000;

function cachedPrice(symbol: string, assetType: 'crypto' | 'stock' = 'crypto'): number | null {
  const hit = priceCache.get(symbol);
  const fresh = hit && Date.now() - hit.at < PRICE_TTL_MS;
  if (!fresh && !priceInflight.has(symbol)) {
    priceInflight.add(symbol);
    publicPrice(symbol, assetType)
      .then((price) => priceCache.set(symbol, { price, at: Date.now() }))
      .catch(() => undefined)
      .finally(() => priceInflight.delete(symbol));
  }
  return hit ? hit.price : null;
}

// ---------------------------------------------------------------------------
// Catalog: a scoreboard the browser can pick from, proxied through the server
// so the TRADINGALE_TOKEN never reaches the browser. Startingale is returned
// as a WORD (house rule), the score as a number. Cached briefly to be gentle
// on the API. Whatever the token's plan scopes is what shows up (free = BTC).
// ---------------------------------------------------------------------------

interface CatalogRow {
  symbol: string;
  name: string;
  score: number;
  startingale: string;
  assetType: 'crypto' | 'stock';
  /** Live public price when already cached (top rows are prefetched). */
  price?: number | null;
}

// Prices for the WHOLE catalog come from bulk snapshots (two public calls
// for crypto, one Alpaca call for stocks when keys exist), refreshed on
// their own short interval — no per-symbol fan-out.
const CATALOG_PRICE_TTL_MS = 60 * 1000;
let catalogPrices = new Map<string, number>();
let catalogPricesAt = 0;
let catalogPricesInflight = false;

function refreshCatalogPrices(rows: CatalogRow[]): void {
  if (catalogPricesInflight || Date.now() - catalogPricesAt < CATALOG_PRICE_TTL_MS) return;
  catalogPricesInflight = true;
  const cryptos = rows.filter((r) => r.assetType === 'crypto').map((r) => r.symbol);
  const stocks = rows.filter((r) => r.assetType === 'stock').map((r) => r.symbol);
  Promise.all([bulkCryptoPrices(cryptos), bulkStockPrices(stocks)])
    .then(([c, s]) => {
      const merged = new Map<string, number>(c);
      for (const [k, v] of s) merged.set(k, v);
      catalogPrices = merged;
      catalogPricesAt = Date.now();
    })
    .catch(() => undefined)
    .finally(() => {
      catalogPricesInflight = false;
    });
}

// Scores move slowly; prices move fast. The UI polls /api/catalog every
// minute, but that only re-merges LIVE PRICES from the local price cache —
// the Tradingale data itself is refetched at most once per CATALOG_TTL_MS.
//
// Each data refresh spends a few WEIGHTED calls of the monthly plan quota,
// so the default (120 min) keeps an always-open dashboard well under half a
// Score Scout plan, leaving headroom for the user's own tooling (alerts,
// scripts). CATALOG_REFRESH_MINUTES overrides it: refresh faster and you
// consciously spend more of your quota. Clamped to >= 10.
let catalogCache: { at: number; rows: CatalogRow[] } | null = null;
const CATALOG_REFRESH_MINUTES = Math.max(10, Number(process.env.CATALOG_REFRESH_MINUTES ?? 120) || 120);
const CATALOG_TTL_MS = CATALOG_REFRESH_MINUTES * 60 * 1000;

function projectCatalog(list: TradingaleInstrument[], assetType: 'crypto' | 'stock'): CatalogRow[] {
  return list
    .filter((i) => i.martingaleScore !== undefined && i.symbol)
    .map((i) => ({
      symbol: String(i.symbol),
      name: i.name ?? String(i.symbol),
      score: Number(i.martingaleScore),
      startingale: startingaleLabel(Number(i.startingale ?? 0)),
      assetType,
    }));
}

async function getCatalog(): Promise<CatalogRow[]> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.rows;
  const token = process.env.TRADINGALE_TOKEN;
  if (!token) throw new Error('Set TRADINGALE_TOKEN to load the catalog (tradingale.com/settings/api)');
  const client = new TradingaleClient(token);
  // A free-scope token returns only BTC (and no stocks); tolerate either
  // side failing so the catalog still shows what the plan covers.
  // The API paginates (default limit 50): ask for the whole catalog so the
  // picker shows every instrument the plan scopes, like the site scoreboard.
  const [crypto, stocks] = await Promise.all([
    client.crypto({ limit: 500 }).catch(() => [] as TradingaleInstrument[]),
    client.stocks({ limit: 500 }).catch(() => [] as TradingaleInstrument[]),
  ]);
  const rows = [...projectCatalog(crypto, 'crypto'), ...projectCatalog(stocks, 'stock')].sort(
    (a, b) => b.score - a.score,
  );
  catalogCache = { at: Date.now(), rows };
  return rows;
}

// Serve the catalog with whatever live prices are cached, warming the top
// rows in the background (cachedPrice triggers the fetch and returns null
// until it lands; the UI polls, so prices fill in within seconds).
function catalogWithPrices(rows: CatalogRow[]): CatalogRow[] {
  refreshCatalogPrices(rows); // background; serves what is already known
  return rows.map((row) => ({
    ...row,
    price: catalogPrices.get(row.symbol) ?? priceCache.get(row.symbol)?.price ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Basic Auth (optional): set RUNNER_PASSWORD and the whole server requires
// it. Exception: an unauthenticated GET /api/state answers a minimal
// liveness body (mode only, no sequence data) so the Railway healthcheck,
// which cannot send credentials, still sees a 200.
// ---------------------------------------------------------------------------

function timingSafeEquals(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isAuthorized(req: http.IncomingMessage): boolean {
  if (!PASSWORD) return true;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
  } catch {
    return false;
  }
  const colon = decoded.indexOf(':');
  const candidate = colon >= 0 ? decoded.slice(colon + 1) : decoded;
  return timingSafeEquals(candidate, PASSWORD);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function stateBody(): unknown {
  const sequences = statusAll().map((s) => {
    const cached = cachedPrice(s.symbol);
    return { ...s, lastPrice: cached ?? s.lastPrice };
  });
  return {
    ok: true,
    mode: MODE,
    keysPresent: krakenKeysPresent(), // boolean only; the keys themselves are never served
    keys: keysStatus(), // { tradingale, kraken, alpaca } booleans, never the values
    cycleMs,
    now: new Date().toISOString(),
    sequences,
  };
}

// ---------------------------------------------------------------------------
// The reconciliation loop: on a fixed schedule, strictly sequential. The
// reentrancy guard means a slow pass is never overlapped by the next tick
// (overlapping cycles are exactly how duplicate sells happen).
// ---------------------------------------------------------------------------

// The venue reconciliation interval is adjustable from the dashboard
// (settings.json in the state dir, so it survives restarts). It only paces
// venue/public-price work — the Tradingale data budget is CATALOG_TTL_MS,
// untouched by this. Clamped to >= 1 minute.
const SETTINGS_FILE = path.join(runnerDir(), 'settings.json');
function loadCycleMs(): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) as { cycleMinutes?: number };
    const minutes = Number(parsed.cycleMinutes);
    if (Number.isFinite(minutes) && minutes >= 1) return Math.round(minutes * 60 * 1000);
  } catch {
    /* no settings yet */
  }
  return CYCLE_MS;
}
let cycleMs = loadCycleMs();
let cycleTimer: ReturnType<typeof setInterval> | null = null;
function armCycleTimer(): void {
  if (cycleTimer) clearInterval(cycleTimer);
  cycleTimer = setInterval(() => void runCyclePass('interval'), cycleMs);
}
function setCycleMinutes(minutes: number): void {
  cycleMs = Math.round(Math.max(1, minutes) * 60 * 1000);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ cycleMinutes: cycleMs / 60000 }, null, 2));
  armCycleTimer();
}

let cycling = false;
async function runCyclePass(reason: string): Promise<void> {
  if (cycling) {
    log(`skip ${reason} pass: previous pass still running`);
    return;
  }
  cycling = true;
  try {
    await cycleAll(log);
  } catch (error) {
    log(`cycle pass error: ${error instanceof Error ? error.message : error}`);
  } finally {
    cycling = false;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

let startInFlight = false;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  if (!isAuthorized(req)) {
    // Liveness exception for the healthcheck: mode only, no sequence data.
    if (route === 'GET /api/state') {
      sendJson(res, 200, { ok: true, mode: MODE, auth: 'required' });
      return;
    }
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="tradingale-runner", charset="UTF-8"' });
    res.end('Authentication required');
    return;
  }

  try {
    if (route === 'GET /' || route === 'GET /index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(renderPage(MODE));
      return;
    }

    if (route === 'GET /api/state') {
      sendJson(res, 200, stateBody());
      return;
    }

    if (route === 'GET /api/catalog') {
      // ?refresh=1 forces both the data and the price snapshots (the
      // dashboard's Refresh button). Data still costs weighted API calls,
      // so it is user-triggered, never automatic.
      if (url.searchParams.get('refresh') === '1') {
        catalogCache = null;
        catalogPricesAt = 0;
      }
      const instruments = catalogWithPrices(await getCatalog());
      sendJson(res, 200, { ok: true, instruments, pricesAt: catalogPricesAt || null });
      return;
    }

    if (route === 'GET /api/preview') {
      const symbol = String(url.searchParams.get('symbol') ?? '');
      const budget = Number(url.searchParams.get('budget') ?? NaN);
      // Optional custom structure (site parity): spacing, rounds, multipliers.
      const deltaRaw = url.searchParams.get('deltaPrice');
      const roundsRaw = url.searchParams.get('nbRounds');
      const multRaw = url.searchParams.get('multipliers');
      const custom = {
        deltaPrice: deltaRaw ? Number(deltaRaw) : undefined,
        nbRounds: roundsRaw ? Number(roundsRaw) : undefined,
        multipliers: multRaw ? multRaw.split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0) : undefined,
      };
      const hasCustom = Boolean(custom.deltaPrice || custom.nbRounds || custom.multipliers?.length);
      const preview = await previewSequence(symbol, budget, hasCustom ? custom : undefined);
      sendJson(res, 200, { ok: true, preview });
      return;
    }

    if (route === 'POST /api/delete') {
      // Dashboard housekeeping: drop finished sequence files so the page
      // stays readable. Running sequences are protected (stop them first).
      const body = await readJsonBody(req);
      if (body.finished === true) {
        const removed = deleteFinished(body.onlyPaper === true);
        sendJson(res, 200, { ok: true, removed });
        return;
      }
      const sequenceId = String(body.sequenceId ?? '');
      if (!sequenceId) {
        sendJson(res, 400, { ok: false, error: 'sequenceId is required' });
        return;
      }
      const result = deleteSequence(sequenceId);
      if (!result.deleted) {
        sendJson(res, 400, { ok: false, error: result.reason ?? 'could not delete' });
        return;
      }
      sendJson(res, 200, { ok: true, removed: 1 });
      return;
    }

    if (route === 'POST /api/settings') {
      const body = await readJsonBody(req);
      const minutes = Number(body.cycleMinutes);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) {
        sendJson(res, 400, { ok: false, error: 'cycleMinutes must be between 1 and 1440' });
        return;
      }
      setCycleMinutes(minutes);
      log(`reconciliation interval set to ${Math.round(minutes)} min from the dashboard`);
      sendJson(res, 200, { ok: true, cycleMs });
      return;
    }

    if (route === 'GET /api/price') {
      const symbol = String(url.searchParams.get('symbol') ?? '').toUpperCase();
      const assetType = url.searchParams.get('assetType') === 'stock' ? 'stock' : 'crypto';
      if (!/^[A-Z0-9]{1,12}$/.test(symbol)) {
        sendJson(res, 400, { ok: false, error: 'invalid symbol' });
        return;
      }
      const price = await publicPrice(symbol, assetType);
      priceCache.set(symbol, { price, at: Date.now() });
      sendJson(res, 200, { ok: true, symbol, price, assetType });
      return;
    }

    if (route === 'POST /api/keys') {
      // Guarded key intake, per the security design:
      //  - only over localhost OR when the whole server sits behind
      //    RUNNER_PASSWORD (isAuthorized already passed above);
      //  - WRITE-ONLY: values go to keys.env (0600) and are never echoed,
      //    logged, or served back — the response is presence booleans;
      //  - the keystore allowlist means RUNNER_MODE can never be smuggled
      //    in: live stays decided by the environment at launch.
      const remote = req.socket.remoteAddress ?? '';
      const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
      if (!isLocal && !PASSWORD) {
        sendJson(res, 403, {
          ok: false,
          error: 'Key configuration over the network requires RUNNER_PASSWORD. Set it, or configure keys from the machine itself (localhost or `npm run runner -- keys`).',
        });
        return;
      }
      const body = await readJsonBody(req);
      const entries: Partial<Record<KeyVar, string>> = {};
      for (const key of KEY_VARS) {
        const value = body[key];
        if (typeof value === 'string' && value.trim() !== '') entries[key] = value.trim();
      }
      if (Object.keys(entries).length === 0) {
        sendJson(res, 400, { ok: false, error: 'no keys provided' });
        return;
      }
      writeKeys(entries);
      loadKeysIntoEnv();
      sendJson(res, 200, { ok: true, keys: keysStatus() }); // booleans only
      return;
    }

    if (route === 'POST /api/start') {
      if (startInFlight) {
        sendJson(res, 409, { ok: false, error: 'a start is already in progress, retry in a moment' });
        return;
      }
      startInFlight = true;
      try {
        const body = await readJsonBody(req);
        const customBody = (body.custom ?? {}) as Record<string, unknown>;
        const multipliers = Array.isArray(customBody.multipliers)
          ? (customBody.multipliers as unknown[]).map(Number).filter((n) => Number.isFinite(n) && n > 0)
          : undefined;
        const custom = {
          deltaPrice: customBody.deltaPrice === undefined ? undefined : Number(customBody.deltaPrice),
          nbRounds: customBody.nbRounds === undefined ? undefined : Number(customBody.nbRounds),
          multipliers: multipliers && multipliers.length ? multipliers : undefined,
        };
        const hasCustom = Boolean(custom.deltaPrice || custom.nbRounds || custom.multipliers);
        const summary = await startSequence(
          {
            symbol: String(body.symbol ?? 'BTC'),
            budget: Number(body.budget ?? NaN),
            mode: MODE, // the client can never escalate to live; only RUNNER_MODE decides
            custom: hasCustom ? custom : undefined,
          },
          log,
        );
        sendJson(res, 200, { ok: true, summary });
      } finally {
        startInFlight = false;
      }
      return;
    }

    if (route === 'POST /api/stop') {
      const body = await readJsonBody(req);
      const sequenceId = String(body.sequenceId ?? '');
      if (!sequenceId) {
        sendJson(res, 400, { ok: false, error: 'sequenceId is required' });
        return;
      }
      const summary = await stopSequence(sequenceId, { reverse: Boolean(body.reverse) }, log);
      sendJson(res, 200, { ok: true, ...summary });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unexpected error';
    sendJson(res, 400, { ok: false, error: message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  log(`Tradingale Runner listening on :${PORT}`);
  log(`mode: ${MODE}${MODE === 'live' ? ' (REAL ORDERS on your Kraken account)' : ' (simulated, the default)'}`);
  if (MODE === 'live' && !krakenKeysPresent()) {
    log('live mode without KRAKEN_API_KEY / KRAKEN_API_SECRET: starts will be refused until keys are set');
  }
  log(PASSWORD ? 'Basic Auth: enabled (RUNNER_PASSWORD)' : 'Basic Auth: DISABLED (set RUNNER_PASSWORD to guard this UI)');
  log('reconciliation loop: running on a schedule, sequential');
  // First pass shortly after boot (the healthcheck does not wait on it),
  // then the fixed interval with the reentrancy guard.
  setTimeout(() => void runCyclePass('boot'), 30 * 1000);
  armCycleTimer();
});

function shutdown(signal: string): void {
  log(`${signal} received, closing`);
  server.close(() => process.exit(0));
  // Do not wait forever on idle keep-alive sockets.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
