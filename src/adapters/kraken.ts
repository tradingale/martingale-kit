// KrakenAdapter: a live VenueAdapter for Kraken spot, ported from the
// Tradingale production code (app/api/kraken/trading/route.ts,
// app/api/cron/check-kraken/route.ts, lib/exchange.ts, lib/service/krakenPairs.ts,
// lib/idempotency.ts).
//
// LIVE MEANS REAL ORDERS ON YOUR KRAKEN ACCOUNT. Your keys, your account,
// your sole responsibility. Keys are read from KRAKEN_API_KEY /
// KRAKEN_API_SECRET and are never logged by this module.
//
// What was ported, and from where:
//  - API-Sign construction (lib/exchange.ts `krakenRequest`):
//      API-Sign = base64( HMAC-SHA512( base64decode(secret),
//                   path + SHA256(nonce + postdata) ) )
//    where `path` is "/0/private/<Endpoint>" and `postdata` is the exact
//    x-www-form-urlencoded body that is sent (nonce included, keys sorted).
//    The production code concatenates via latin1 "binary" strings; here we
//    use Buffer.concat, which is byte for byte identical (verified against
//    the vector published in Kraken's authentication docs, see the tests).
//  - Strictly increasing nonce + serialized private calls (Kraken rejects
//    out-of-order nonces inside its nonce window; handbook section 6).
//  - Pair resolution (lib/service/krakenPairs.ts): BTC -> XBT, DOGE -> XDG,
//    then try `${T}${Q}`, `X${T}Z${Q}`, `X${T}${Q}`, `${T}Z${Q}` against
//    /0/public/AssetPairs. USD is preferred, USDC is the fallback quote.
//  - Grids from AssetPairs pair_decimals / lot_decimals / ordermin (plus
//    tick_size / costmin when Kraken declares them), exposed as getGrids().
//  - cl_ord_id carries our engine clientId (lib/idempotency.ts documents the
//    constraint: <= 32 chars, alphanumeric + `_-`, leading letter). When a
//    clientId cannot be a cl_ord_id (or Kraken rejects the field), we fall
//    back to a stable 31-bit `userref` derived from the clientId, persisted
//    in a local mapping file so restarts can still match orders back.
//  - Sell volume haircut and the insufficient-volume retry (trading route
//    fee adjustment + check-kraken retry loop): Kraken charges buy fees in
//    the base currency, so a sell of the full planned cumulative quantity
//    can exceed what the account holds. Production reduced quantities by
//    the fee and retried with 0.1% reductions capped at 0.5%; both are
//    ported here, contained in placeOrder for sells.
//  - Order status mapping (lib/exchange.ts `convertKrakenStatus`):
//    pending/open -> open, closed -> filled, canceled -> canceled,
//    expired -> expired.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Fill, OrderStatus, PlannedOrder, VenueGrids, VenueOrder } from '../types.js';
import type { VenueAdapter } from './types.js';

const KRAKEN_API_URL = 'https://api.kraken.com';
const API_VERSION = '0';

// Ported fee constants (app/api/kraken/trading/route.ts).
export const KRAKEN_MARKET_FEE = 0.004; // 0.4% taker
export const KRAKEN_LIMIT_FEE = 0.0025; // 0.25% maker

const EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// Pure helpers (exported for offline tests)
// ---------------------------------------------------------------------------

/**
 * Kraken API-Sign, exactly as production computed it:
 *   HMAC-SHA512( base64decode(secret), path + SHA256(nonce + postdata) ), base64.
 * `postdata` must be the exact body sent (nonce included).
 */
export function krakenSignature(
  urlPath: string,
  postData: string,
  nonce: string,
  apiSecretBase64: string,
): string {
  const messageHash = crypto.createHash('sha256').update(nonce + postData).digest();
  const hmac = crypto.createHmac('sha512', Buffer.from(apiSecretBase64, 'base64'));
  hmac.update(Buffer.concat([Buffer.from(urlPath, 'utf-8'), messageHash]));
  return hmac.digest('base64');
}

/**
 * Serialize params the way production signed and sent them: keys sorted
 * alphabetically, joined as `k=v` with `&`. Values must stay within the
 * url-safe charset this adapter produces (numbers, pair names, client ids).
 */
export function krakenPostData(params: Record<string, string>): string {
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** Symbol quirks Kraken is known for (lib/service/krakenPairs.ts). */
export const KRAKEN_SYMBOL_MAP: Record<string, string> = {
  BTC: 'XBT',
  DOGE: 'XDG',
};

/** Candidate AssetPairs keys for a ticker + quote (production order). */
export function krakenPairCandidates(ticker: string, quote: string): string[] {
  const mapped = KRAKEN_SYMBOL_MAP[ticker.toUpperCase()] ?? ticker.toUpperCase();
  return [
    `${mapped}${quote}`,
    `X${mapped}Z${quote}`,
    `X${mapped}${quote}`,
    `${mapped}Z${quote}`,
  ];
}

export interface KrakenPairInfo {
  pair_decimals: number;
  lot_decimals: number;
  ordermin: string;
  tick_size?: string;
  costmin?: string;
  altname?: string;
}

/** Build the kit's VenueGrids from Kraken AssetPairs fields. */
export function krakenGridsFromPairInfo(info: KrakenPairInfo): VenueGrids {
  const priceIncrement = info.tick_size
    ? parseFloat(info.tick_size)
    : Number((10 ** -info.pair_decimals).toFixed(info.pair_decimals));
  const qtyStep = Number((10 ** -info.lot_decimals).toFixed(info.lot_decimals));
  return {
    priceIncrement: priceIncrement > 0 ? priceIncrement : null,
    qtyStep: qtyStep > 0 ? qtyStep : null,
    minOrderSize: info.ordermin ? parseFloat(info.ordermin) : null,
    minNotional: info.costmin ? parseFloat(info.costmin) : null,
  };
}

/** lib/exchange.ts `convertKrakenStatus`, mapped onto the kit's OrderStatus. */
export function krakenOrderStatus(status: string): OrderStatus {
  switch (status.toLowerCase()) {
    case 'pending':
    case 'open':
      return 'open';
    case 'closed':
      return 'filled';
    case 'canceled':
      return 'canceled';
    case 'expired':
      return 'expired';
    default:
      return 'rejected';
  }
}

/** cl_ord_id constraint from lib/idempotency.ts: <=32 chars, [A-Za-z0-9_-], leading letter. */
export function isValidClOrdId(clientId: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(clientId);
}

/** Stable 31-bit FNV-1a hash of a clientId, for the userref fallback. */
export function userrefFromClientId(clientId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < clientId.length; i++) {
    hash ^= clientId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) & 0x7fffffff;
}

/** Floor to `decimals` and format (production toFixedDown, ROUND_DOWN). */
export function toFixedDown(value: number, decimals: number): string {
  const factor = 10 ** decimals;
  return (Math.floor(value * factor + EPSILON) / factor).toFixed(decimals);
}

/** Directional price formatting: sells round UP, buys round DOWN (grid.ts rule). */
export function formatKrakenPrice(price: number, decimals: number, side: 'buy' | 'sell'): string {
  const factor = 10 ** decimals;
  const ticks = side === 'sell'
    ? Math.ceil(price * factor - EPSILON)
    : Math.floor(price * factor + EPSILON);
  return (ticks / factor).toFixed(decimals);
}

// ---------------------------------------------------------------------------
// Kraken REST error shapes we treat specially
// ---------------------------------------------------------------------------

function isUnknownOrderError(message: string): boolean {
  return /unknown order/i.test(message);
}

function isDuplicateClientIdError(message: string): boolean {
  return /duplicate|already exist/i.test(message);
}

function isClOrdIdRejectedError(message: string): boolean {
  return /cl_ord_id/i.test(message) && !isDuplicateClientIdError(message);
}

function isInsufficientFundsError(message: string): boolean {
  return /insufficient funds/i.test(message);
}

interface KrakenRestResponse {
  error?: string[];
  result?: unknown;
}

interface KrakenRestOrder {
  status: string;
  vol: string;
  vol_exec: string;
  price?: string;
  cost?: string;
  opentm?: number;
  closetm?: number;
  userref?: number | null;
  cl_ord_id?: string;
  descr?: { pair?: string; type?: string; ordertype?: string; price?: string };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface KrakenAdapterOptions {
  /** Instrument symbol as Tradingale serves it (BTC, ETH, SOL...). */
  symbol: string;
  /**
   * Sequence id whose orders this adapter owns. Open orders and fills are
   * filtered to clientIds starting with `${sequenceId}-` so unrelated orders
   * on the same account never leak into the engine's snapshot (that is what
   * keeps the one-active-sell invariant meaningful on a shared account).
   */
  sequenceId: string;
  /** Defaults to env KRAKEN_API_KEY. Never logged. */
  apiKey?: string;
  /** Defaults to env KRAKEN_API_SECRET (base64, as Kraken issues it). Never logged. */
  apiSecret?: string;
  /** Only fetch closed orders at/after this time (ms epoch); bounds pagination. */
  sinceMs?: number;
  /** Directory for the userref fallback mapping file. Defaults to .martingale-runner. */
  stateDir?: string;
  /** Injectable for OFFLINE tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for OFFLINE tests. Defaults to a strictly increasing Date.now(). */
  nonceFn?: () => string;
  /**
   * Haircut applied to SELL volumes, ported from production: buy fees are
   * charged in the base currency, so the account holds slightly less than
   * the planned cumulative quantity. 0.4% (the taker fee, the larger of the
   * two) guarantees the sell volume never exceeds holdings.
   */
  sellVolumeHaircut?: number;
}

export class KrakenAdapter implements VenueAdapter {
  private readonly symbol: string;
  private readonly sequenceId: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly sinceMs: number | null;
  private readonly stateDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly nonceFn: (() => string) | null;
  private readonly sellVolumeHaircut: number;

  private lastNonce = 0;
  private privateQueue: Promise<unknown> = Promise.resolve();
  private pairCache: { pair: string; info: KrakenPairInfo } | null = null;
  /** true once Kraken rejected cl_ord_id and we switched to userref. */
  private userrefMode = false;
  private userrefMap: Record<string, string> | null = null;

  constructor(options: KrakenAdapterOptions) {
    this.symbol = options.symbol.toUpperCase();
    this.sequenceId = options.sequenceId;
    this.apiKey = options.apiKey ?? process.env.KRAKEN_API_KEY ?? '';
    this.apiSecret = options.apiSecret ?? process.env.KRAKEN_API_SECRET ?? '';
    this.sinceMs = options.sinceMs ?? null;
    this.stateDir = options.stateDir ?? path.join(process.cwd(), '.martingale-runner');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nonceFn = options.nonceFn ?? null;
    this.sellVolumeHaircut = options.sellVolumeHaircut ?? KRAKEN_MARKET_FEE;
    if (!this.apiKey || !this.apiSecret) {
      throw new Error(
        'Kraken keys missing: set KRAKEN_API_KEY and KRAKEN_API_SECRET (trade-only permission, no withdrawal, IP allowlist).',
      );
    }
  }

  // ----- transport -----

  private nextNonce(): string {
    if (this.nonceFn) return this.nonceFn();
    const nonce = Math.max(Date.now(), this.lastNonce + 1);
    this.lastNonce = nonce;
    return String(nonce);
  }

  /** Public endpoint, GET, no auth. */
  private async publicRequest<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    const url = `${KRAKEN_API_URL}/${API_VERSION}${endpoint}${qs ? `?${qs}` : ''}`;
    const res = await this.fetchImpl(url, { method: 'GET' });
    if (!res.ok) throw new Error(`Kraken ${endpoint} HTTP ${res.status}`);
    const body = (await res.json()) as KrakenRestResponse;
    if (body.error && body.error.length > 0) throw new Error(body.error.join(', '));
    return body.result as T;
  }

  /**
   * Private endpoint, POST, signed. All private calls are serialized through
   * a queue so nonces reach Kraken strictly increasing and in order.
   */
  private privateRequest<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const run = async (): Promise<T> => {
      const urlPath = `/${API_VERSION}${endpoint}`;
      const nonce = this.nextNonce();
      const postData = krakenPostData({ ...params, nonce });
      const signature = krakenSignature(urlPath, postData, nonce, this.apiSecret);
      const res = await this.fetchImpl(`${KRAKEN_API_URL}${urlPath}`, {
        method: 'POST',
        headers: {
          'API-Key': this.apiKey,
          'API-Sign': signature,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: postData,
      });
      const text = await res.text();
      if (!res.ok) {
        // Never echo the request (it would reveal nothing secret, but keep
        // failures terse); Kraken maintenance pages are HTML.
        if (text.includes('<html') || text.includes('<!DOCTYPE')) {
          throw new Error(`Kraken ${endpoint} unavailable (HTTP ${res.status})`);
        }
        throw new Error(`Kraken ${endpoint} HTTP ${res.status}`);
      }
      let body: KrakenRestResponse;
      try {
        body = JSON.parse(text) as KrakenRestResponse;
      } catch {
        throw new Error(`Kraken ${endpoint} returned a non-JSON response`);
      }
      if (body.error && body.error.length > 0) throw new Error(body.error.join(', '));
      return body.result as T;
    };
    const next = this.privateQueue.then(run, run);
    this.privateQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // ----- pair + grids -----

  /** Resolve the Kraken pair for this symbol (USD preferred, then USDC). */
  async resolvePair(): Promise<{ pair: string; info: KrakenPairInfo }> {
    if (this.pairCache) return this.pairCache;
    const resolved = await resolveKrakenPair(this.symbol, this.fetchImpl);
    this.pairCache = resolved;
    return resolved;
  }

  /** Venue grids for this instrument, built from AssetPairs. */
  async getGrids(): Promise<VenueGrids> {
    const { info } = await this.resolvePair();
    return krakenGridsFromPairInfo(info);
  }

  // ----- userref fallback mapping (persisted) -----

  private mappingFile(): string {
    return path.join(this.stateDir, 'kraken-userref-map.json');
  }

  private loadUserrefMap(): Record<string, string> {
    if (this.userrefMap) return this.userrefMap;
    try {
      this.userrefMap = JSON.parse(fs.readFileSync(this.mappingFile(), 'utf-8')) as Record<string, string>;
    } catch {
      this.userrefMap = {};
    }
    return this.userrefMap;
  }

  private saveUserrefMap(): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const target = this.mappingFile();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.userrefMap ?? {}, null, 2));
    fs.renameSync(tmp, target);
  }

  /** Stable userref for a clientId, collision-bumped against the local map. */
  private userrefFor(clientId: string): number {
    const map = this.loadUserrefMap();
    let ref = userrefFromClientId(clientId);
    for (let i = 0; i < 1000; i++) {
      const existing = map[String(ref)];
      if (existing === undefined || existing === clientId) break;
      ref = (ref + 1) & 0x7fffffff;
    }
    if (map[String(ref)] !== clientId) {
      map[String(ref)] = clientId;
      this.saveUserrefMap();
    }
    return ref;
  }

  private clientIdOfRestOrder(order: KrakenRestOrder): string | null {
    if (order.cl_ord_id && order.cl_ord_id.startsWith(`${this.sequenceId}-`)) {
      return order.cl_ord_id;
    }
    if (order.userref !== undefined && order.userref !== null && order.userref !== 0) {
      const mapped = this.loadUserrefMap()[String(order.userref)];
      if (mapped && mapped.startsWith(`${this.sequenceId}-`)) return mapped;
    }
    return null;
  }

  // ----- VenueAdapter -----

  async placeOrder(order: PlannedOrder): Promise<void> {
    const { pair, info } = await this.resolvePair();
    const isSell = order.side === 'sell';
    // Ported fee handling: sells get a haircut so the volume never exceeds
    // what the account actually holds after base-currency buy fees.
    const baseVolume = isSell ? order.quantity * (1 - this.sellVolumeHaircut) : order.quantity;

    const buildParams = (volume: number): Record<string, string> => {
      const params: Record<string, string> = {
        pair,
        type: order.side,
        ordertype: order.type === 'market' ? 'market' : 'limit',
        volume: toFixedDown(volume, info.lot_decimals),
      };
      if (order.type !== 'market' && order.price !== undefined) {
        params.price = formatKrakenPrice(order.price, info.pair_decimals, order.side);
      }
      if (!this.userrefMode && isValidClOrdId(order.clientId)) {
        params.cl_ord_id = order.clientId;
      } else {
        params.userref = String(this.userrefFor(order.clientId));
      }
      return params;
    };

    const submit = async (volume: number): Promise<void> => {
      await this.privateRequest<{ txid?: string[] }>('/private/AddOrder', buildParams(volume));
    };

    try {
      await submit(baseVolume);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Same cl_ord_id resubmitted: the order already exists at Kraken.
      // That is the idempotency production relied on; treat as success.
      if (isDuplicateClientIdError(message)) return;
      // cl_ord_id not accepted: switch this adapter to the userref fallback
      // (persisted mapping) and resubmit once.
      if (isClOrdIdRejectedError(message) && !this.userrefMode) {
        this.userrefMode = true;
        await submit(baseVolume);
        return;
      }
      // Ported from check-kraken: a sell can exceed holdings by dust; retry
      // with 0.1% reductions, at most 5 tries, capped at 0.5% total.
      if (isSell && isInsufficientFundsError(message)) {
        const reductionStep = 0.001;
        const maxTotalReduction = 0.005;
        let volume = baseVolume;
        for (let attempt = 1; attempt <= 5; attempt++) {
          volume -= baseVolume * reductionStep;
          if ((baseVolume - volume) / baseVolume > maxTotalReduction + EPSILON) break;
          try {
            await submit(volume);
            return;
          } catch (retryError) {
            const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
            if (isDuplicateClientIdError(retryMessage)) return;
            if (!isInsufficientFundsError(retryMessage)) throw retryError;
          }
        }
      }
      throw error;
    }
  }

  /**
   * Cancel by clientId. Resolves the live txid from OpenOrders, then cancels.
   * Idempotent by contract: an order that is already gone ("Unknown order",
   * or absent from the book) counts as success.
   */
  async cancelOrder(clientId: string): Promise<void> {
    const open = await this.fetchOpenOrdersRaw();
    const entry = Object.entries(open).find(([, o]) => this.clientIdOfRestOrder(o) === clientId);
    if (!entry) return; // already filled, canceled or never landed: success
    try {
      await this.privateRequest('/private/CancelOrder', { txid: entry[0] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isUnknownOrderError(message)) return;
      throw error;
    }
  }

  private async fetchOpenOrdersRaw(): Promise<Record<string, KrakenRestOrder>> {
    const result = await this.privateRequest<{ open?: Record<string, KrakenRestOrder> }>(
      '/private/OpenOrders',
    );
    return result.open ?? {};
  }

  async getOpenOrders(): Promise<VenueOrder[]> {
    const open = await this.fetchOpenOrdersRaw();
    const orders: VenueOrder[] = [];
    for (const raw of Object.values(open)) {
      const clientId = this.clientIdOfRestOrder(raw);
      if (!clientId) continue;
      orders.push({
        clientId,
        side: raw.descr?.type === 'sell' ? 'sell' : 'buy',
        status: krakenOrderStatus(raw.status),
        price: raw.descr?.price ? parseFloat(raw.descr.price) || undefined : undefined,
        quantity: parseFloat(raw.vol),
        filledQuantity: parseFloat(raw.vol_exec) || 0,
      });
    }
    return orders;
  }

  /**
   * Fills from ClosedOrders (paginated), filtered to this sequence's
   * clientIds. Any closed or canceled order with executed volume counts for
   * its executed part, matching how production read vol_exec.
   */
  async getFills(): Promise<Fill[]> {
    const fills: Fill[] = [];
    const pageSize = 50;
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const params: Record<string, string> = { ofs: String(offset) };
      if (this.sinceMs !== null) params.start = String(Math.floor(this.sinceMs / 1000));
      const result = await this.privateRequest<{
        closed?: Record<string, KrakenRestOrder>;
        count?: number;
      }>('/private/ClosedOrders', params);
      const closed = result.closed ?? {};
      const entries = Object.values(closed);
      for (const raw of entries) {
        const clientId = this.clientIdOfRestOrder(raw);
        if (!clientId) continue;
        const executed = parseFloat(raw.vol_exec) || 0;
        if (executed <= 0) continue;
        const avgPrice = raw.price ? parseFloat(raw.price) : 0;
        const fallbackPrice = raw.descr?.price ? parseFloat(raw.descr.price) : 0;
        fills.push({
          clientId,
          side: raw.descr?.type === 'sell' ? 'sell' : 'buy',
          price: avgPrice > 0 ? avgPrice : fallbackPrice,
          quantity: executed,
          timestamp: raw.closetm ? Math.round(raw.closetm * 1000) : 0,
        });
      }
      offset += entries.length;
      const total = result.count ?? entries.length;
      if (entries.length === 0 || offset >= total) break;
    }
    return fills;
  }
}

// ---------------------------------------------------------------------------
// Standalone pair/grids resolution (public endpoint, zero keys), so paper
// mode can snap ladders to the real Kraken grids too.
// ---------------------------------------------------------------------------

export async function resolveKrakenPair(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ pair: string; info: KrakenPairInfo }> {
  const res = await fetchImpl(`${KRAKEN_API_URL}/${API_VERSION}/public/AssetPairs`, { method: 'GET' });
  if (!res.ok) throw new Error(`Kraken AssetPairs HTTP ${res.status}`);
  const body = (await res.json()) as { error?: string[]; result?: Record<string, KrakenPairInfo> };
  if (body.error && body.error.length > 0) throw new Error(body.error.join(', '));
  const pairs = body.result ?? {};
  // USD preferred, USDC as fallback (production supported both quotes).
  for (const quote of ['USD', 'USDC']) {
    for (const candidate of krakenPairCandidates(symbol, quote)) {
      const info = pairs[candidate];
      if (info) return { pair: candidate, info };
    }
  }
  throw new Error(`No Kraken USD or USDC pair found for ${symbol.toUpperCase()}`);
}

/** Kraken grids for a symbol via the public AssetPairs endpoint (no keys). */
export async function fetchKrakenGrids(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VenueGrids> {
  const { info } = await resolveKrakenPair(symbol, fetchImpl);
  return krakenGridsFromPairInfo(info);
}
