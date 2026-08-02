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
  krakenKeysPresent,
  runnerMode,
  startSequence,
  statusAll,
  stopSequence,
} from '../runner/core.js';
import { publicPrice } from '../runner/prices.js';
import { renderPage } from './page.js';

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

function cachedPrice(symbol: string): number | null {
  const hit = priceCache.get(symbol);
  const fresh = hit && Date.now() - hit.at < PRICE_TTL_MS;
  if (!fresh && !priceInflight.has(symbol)) {
    priceInflight.add(symbol);
    publicPrice(symbol)
      .then((price) => priceCache.set(symbol, { price, at: Date.now() }))
      .catch(() => undefined)
      .finally(() => priceInflight.delete(symbol));
  }
  return hit ? hit.price : null;
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
    cycleMs: CYCLE_MS,
    now: new Date().toISOString(),
    sequences,
  };
}

// ---------------------------------------------------------------------------
// The reconciliation loop: every 10 minutes, strictly sequential. The
// reentrancy guard means a slow pass is never overlapped by the next tick
// (overlapping cycles are exactly how duplicate sells happen).
// ---------------------------------------------------------------------------

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

    if (route === 'POST /api/start') {
      if (startInFlight) {
        sendJson(res, 409, { ok: false, error: 'a start is already in progress, retry in a moment' });
        return;
      }
      startInFlight = true;
      try {
        const body = await readJsonBody(req);
        const summary = await startSequence(
          {
            symbol: String(body.symbol ?? 'BTC'),
            budget: Number(body.budget ?? NaN),
            mode: MODE, // the client can never escalate to live; only RUNNER_MODE decides
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
  log(`reconciliation loop: every ${CYCLE_MS / 60000} minutes, sequential`);
  // First pass shortly after boot (the healthcheck does not wait on it),
  // then the fixed interval with the reentrancy guard.
  setTimeout(() => void runCyclePass('boot'), 30 * 1000);
  setInterval(() => void runCyclePass('interval'), CYCLE_MS);
});

function shutdown(signal: string): void {
  log(`${signal} received, closing`);
  server.close(() => process.exit(0));
  // Do not wait forever on idle keep-alive sockets.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
