// RevolutXAdapter: a live VenueAdapter for Revolut X spot.
//
// LIVE MEANS REAL ORDERS ON YOUR REVOLUT X ACCOUNT. Your keys, your account,
// your sole responsibility. Credentials are read from REVOLUTX_API_KEY and
// REVOLUTX_PRIVATE_KEY (or REVOLUTX_PRIVATE_KEY_PATH) and are never logged.
//
// Why this venue is worth an adapter: 61 EUR-quoted pairs including BTC/EUR,
// a central limit order book, resting limit orders, and 0% maker fees. Funding
// in euros is where European users get stuck on venues that only quote USD,
// and a martingale needs resting limit buys, which rules out convert widgets.
//
// WHAT IS VERIFIED, AND WHAT IS NOT. Read this before trusting it with money.
//   Verified against the live venue (2026-09-24):
//     - base URL, the /api prefix, and the public endpoints;
//     - /1.0/public/configuration/pairs is an OBJECT keyed "BTC/EUR", not the
//       list the docs describe, and it carries base_step, quote_step,
//       min_order_size and min_order_size_quote;
//     - path parameters take the HYPHEN form: /2.0/public/order-book/BTC-EUR
//       returns a book, while the pairs document is keyed with a slash. The
//       two forms are not interchangeable and are converted in one place.
//   Verified by construction, not by the venue:
//     - the signature message, pinned byte for byte against the worked example
//       Revolut publishes, and a sign/verify round trip (see test/revolutx.test.ts).
//   NOT verified, written from the documentation alone:
//     - every authenticated response shape (balances, orders, fills). No key
//       was available. Run a read-only call first and correct what differs.
//
// That distinction is not pedantry. The Hyperliquid integration in the
// Tradingale codebase never worked because its signer was subtly wrong and
// failed only at the venue, silently, after shipping. Assume the authenticated
// paths here are unproven until one real call says otherwise.
//
// Design notes specific to this venue:
//  - client_order_id must be a UUID. Engine ids look like `BTC-<ts>-buy-1`,
//    so they are hashed into a deterministic UUID (clientIdToUuid). Determinism
//    is the point: a retry after a timeout derives the same id, so the venue
//    treats it as the same order rather than opening a second one. The hash is
//    one-way, so a local map file carries the reverse direction, exactly as the
//    Kraken adapter does for its userref.
//  - Limit orders are post_only by default. A resting buy that crosses the
//    spread pays the taker fee and fills at a price the ladder did not plan,
//    which moves the average cost the whole sequence is built on.
//  - Fees are 0% maker / 0.09% taker. The buys that build a position are
//    makers, so unlike Kraken there is no systematic base-currency fee. The
//    round 1 market entry is a taker, so sells carry a small haircut by
//    default: dust left behind is cheaper than a sell rejected for
//    insufficient balance.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Fill, OrderStatus, PlannedOrder, VenueGrids, VenueOrder } from '../types.js';
import type { VenueAdapter } from './types.js';

const REVOLUTX_API_URL = 'https://revx.revolut.com';
const API_PREFIX = '/api';

/** 0% maker, 0.09% taker, flat regardless of volume. */
export const REVOLUTX_MAKER_FEE = 0;
export const REVOLUTX_TAKER_FEE = 0.0009;

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

/** "BTC/EUR" or "btc-eur" -> "BTC-EUR": paths and order payloads. */
export function toPathSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace('/', '-');
}

/** "BTC-EUR" or "btc/eur" -> "BTC/EUR": the key in the pairs document. */
export function toPairKey(symbol: string): string {
  return symbol.trim().toUpperCase().replace('-', '/');
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * timestamp(ms) + METHOD + path(from /api) + query(no "?") + body, concatenated
 * with NO separators. Revolut's published example, which the tests pin:
 *   1765360896219POST/api/1.0/orders{"client_order_id":"3b364427-...",...}
 */
export function revolutxSignatureMessage(
  timestampMs: string,
  method: string,
  fullPath: string,
  query: string,
  body: string
): string {
  return `${timestampMs}${method.toUpperCase()}${fullPath}${query}${body}`;
}

/** Ed25519 over the message, base64. `null` is the required algorithm in Node. */
export function revolutxSign(message: string, privateKeyPem: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `Revolut X requires an Ed25519 key; this PEM is ${key.asymmetricKeyType ?? 'unrecognised'}. ` +
        'Generate one with: openssl genpkey -algorithm ed25519 -out private.pem'
    );
  }
  return crypto.sign(null, Buffer.from(message, 'utf8'), key).toString('base64');
}

/**
 * A deterministic UUID for an arbitrary engine client id. Same input, same
 * uuid, forever: that is what makes a retry idempotent at the venue. Shaped as
 * a v4 UUID because the venue only checks the format.
 */
export function clientIdToUuid(clientId: string): string {
  const h = crypto.createHash('sha256').update(clientId).digest('hex');
  const variant = ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `${variant}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join('-');
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/** Venue order states -> the engine's five. Unknown states stay 'open'. */
export function revolutxOrderStatus(state: string | undefined): OrderStatus {
  switch ((state ?? '').toLowerCase()) {
    case 'new':
    case 'pending':
    case 'open':
    case 'partially_filled':
      return 'open';
    case 'filled':
    case 'closed':
      return 'filled';
    case 'cancelled':
    case 'canceled':
      return 'canceled';
    case 'expired':
      return 'expired';
    case 'rejected':
    case 'failed':
      return 'rejected';
    default:
      return 'open';
  }
}

// ---------------------------------------------------------------------------
// Grids
// ---------------------------------------------------------------------------

export interface RevolutXPairInfo {
  base: string;
  quote: string;
  base_step: string;
  quote_step: string;
  min_order_size: string;
  max_order_size: string;
  min_order_size_quote: string;
  max_order_size_quote: string;
  status: string;
  slippage?: number;
}

export function revolutxGridsFromPairInfo(pair: RevolutXPairInfo): VenueGrids {
  return {
    priceIncrement: Number(pair.quote_step),
    qtyStep: Number(pair.base_step),
    minOrderSize: Number(pair.min_order_size),
    minNotional: Number(pair.min_order_size_quote),
  };
}

export async function fetchRevolutXGrids(
  symbol: string,
  fetchImpl: typeof fetch = fetch
): Promise<VenueGrids> {
  const res = await fetchImpl(`${REVOLUTX_API_URL}${API_PREFIX}/1.0/public/configuration/pairs`);
  if (!res.ok) throw new RevolutXHttpError(res.status, `configuration/pairs failed: ${res.status}`);
  const pairs = (await res.json()) as Record<string, RevolutXPairInfo>;
  const info = pairs[toPairKey(symbol)];
  if (!info) throw new Error(`Revolut X does not list ${toPairKey(symbol)}`);
  if (info.status !== 'active') throw new Error(`${toPairKey(symbol)} is ${info.status} on Revolut X`);
  return revolutxGridsFromPairInfo(info);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface RevolutXAdapterOptions {
  /** Instrument for this sequence, either form: "BTC-EUR" or "BTC/EUR". */
  symbol: string;
  /** Defaults to env REVOLUTX_API_KEY. Never logged. */
  apiKey?: string;
  /** PEM PKCS#8 Ed25519 key. Defaults to env REVOLUTX_PRIVATE_KEY, else the file at REVOLUTX_PRIVATE_KEY_PATH. Never logged. */
  privateKeyPem?: string;
  /** Directory for the uuid -> clientId map. Defaults to .martingale-runner. */
  stateDir?: string;
  /** Resting limit orders are post_only unless this is false. */
  postOnly?: boolean;
  /**
   * Fraction shaved off SELL quantities. Defaults to the 0.09% taker fee: the
   * round 1 market entry is a taker, so the account can hold marginally less
   * base currency than the ladder planned. Maker buys cost nothing, so this is
   * far smaller than Kraken's equivalent.
   */
  sellQuantityHaircut?: number;
  /** Injectable for OFFLINE tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for OFFLINE tests. Defaults to Date.now. */
  nowFn?: () => number;
}

export class RevolutXHttpError extends Error {
  constructor(readonly status: number, message: string, readonly errorId?: string) {
    super(message);
    this.name = 'RevolutXHttpError';
  }
}

export class RevolutXAdapter implements VenueAdapter {
  private readonly symbol: string;
  private readonly apiKey: string;
  private readonly privateKeyPem: string;
  private readonly stateDir: string;
  private readonly postOnly: boolean;
  private readonly sellQuantityHaircut: number;
  private readonly fetchImpl: typeof fetch;
  private readonly nowFn: () => number;
  /** uuid -> engine clientId. The hash is one-way, so this carries the return trip. */
  private idMap: Record<string, string>;

  constructor(options: RevolutXAdapterOptions) {
    this.symbol = toPathSymbol(options.symbol);

    const apiKey = options.apiKey ?? process.env.REVOLUTX_API_KEY ?? '';
    if (!apiKey) throw new Error('Revolut X API key missing (REVOLUTX_API_KEY)');
    this.apiKey = apiKey;

    const inlineKey = options.privateKeyPem ?? process.env.REVOLUTX_PRIVATE_KEY ?? '';
    const keyPath = process.env.REVOLUTX_PRIVATE_KEY_PATH ?? '';
    const pem = inlineKey || (keyPath ? fs.readFileSync(keyPath, 'utf8') : '');
    if (!pem) {
      throw new Error('Revolut X private key missing (REVOLUTX_PRIVATE_KEY or REVOLUTX_PRIVATE_KEY_PATH)');
    }
    this.privateKeyPem = pem;

    this.stateDir = options.stateDir ?? '.martingale-runner';
    this.postOnly = options.postOnly ?? true;
    this.sellQuantityHaircut = options.sellQuantityHaircut ?? REVOLUTX_TAKER_FEE;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nowFn = options.nowFn ?? Date.now;
    this.idMap = this.loadIdMap();
  }

  // -- id map ---------------------------------------------------------------

  private get idMapPath(): string {
    return path.join(this.stateDir, `revolutx-${this.symbol.toLowerCase()}-ids.json`);
  }

  private loadIdMap(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.idMapPath, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private rememberId(clientId: string): string {
    const uuid = clientIdToUuid(clientId);
    if (this.idMap[uuid] !== clientId) {
      this.idMap[uuid] = clientId;
      try {
        fs.mkdirSync(this.stateDir, { recursive: true });
        fs.writeFileSync(this.idMapPath, JSON.stringify(this.idMap, null, 2));
      } catch {
        // A map we cannot persist still works for this process. Losing it only
        // costs us the reverse lookup after a restart, never an order.
      }
    }
    return uuid;
  }

  private clientIdFor(uuid: string): string {
    return this.idMap[uuid] ?? uuid;
  }

  // -- transport ------------------------------------------------------------

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE' | 'PUT',
    apiPath: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>
  ): Promise<T> {
    const fullPath = `${API_PREFIX}${apiPath}`;
    const queryString = query
      ? Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';

    // Serialise ONCE: this exact string is both signed and sent. Two
    // serialisations of the same object are one reordered key away from an
    // invalid signature.
    const payload = body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(this.nowFn());
    const message = revolutxSignatureMessage(timestamp, method, fullPath, queryString, payload);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Revx-API-Key': this.apiKey,
      'X-Revx-Timestamp': timestamp,
      'X-Revx-Signature': revolutxSign(message, this.privateKeyPem),
    };
    if (payload) headers['Content-Type'] = 'application/json';

    const url = `${REVOLUTX_API_URL}${fullPath}${queryString ? `?${queryString}` : ''}`;
    const res = await this.fetchImpl(url, { method, headers, body: payload || undefined });
    const text = await res.text();

    if (!res.ok) {
      let message = text || `HTTP ${res.status}`;
      let errorId: string | undefined;
      try {
        const parsed = JSON.parse(text) as { message?: string; error_id?: string };
        message = parsed.message ?? message;
        errorId = parsed.error_id;
      } catch {
        // keep the raw text
      }
      throw new RevolutXHttpError(res.status, message, errorId);
    }

    return (text ? JSON.parse(text) : undefined) as T;
  }

  // -- VenueAdapter ---------------------------------------------------------

  async getGrids(): Promise<VenueGrids> {
    return fetchRevolutXGrids(this.symbol, this.fetchImpl);
  }

  async placeOrder(order: PlannedOrder): Promise<void> {
    const clientOrderId = this.rememberId(order.clientId);

    let quantity = order.quantity;
    if (order.side === 'sell' && this.sellQuantityHaircut > 0) {
      quantity = quantity * (1 - this.sellQuantityHaircut);
    }

    const configuration =
      order.type === 'market'
        ? { market: { base_size: String(quantity) } }
        : {
            limit: {
              base_size: String(quantity),
              price: String(order.price),
              execution_instructions: [this.postOnly ? 'post_only' : 'allow_taker'],
            },
          };

    if (order.type === 'limit' && (order.price === undefined || !Number.isFinite(order.price))) {
      throw new Error(`limit order ${order.clientId} has no usable price`);
    }

    await this.request('POST', '/1.0/orders', {
      client_order_id: clientOrderId,
      symbol: this.symbol,
      side: order.side.toUpperCase(),
      order_configuration: configuration,
    });
  }

  /** Idempotent: an order already gone is a success, not an error. */
  async cancelOrder(clientId: string): Promise<void> {
    const uuid = clientIdToUuid(clientId);
    const open = await this.fetchActiveOrders();
    const match = open.find((o) => o.client_order_id === uuid);
    if (!match) return;
    try {
      await this.request('DELETE', `/1.0/orders/${match.venue_order_id}`);
    } catch (error) {
      if (error instanceof RevolutXHttpError && (error.status === 404 || error.status === 409)) return;
      throw error;
    }
  }

  async getOpenOrders(): Promise<VenueOrder[]> {
    const orders = await this.fetchActiveOrders();
    return orders
      .filter((o) => !o.symbol || toPathSymbol(o.symbol) === this.symbol)
      .map((o) => this.toVenueOrder(o));
  }

  async getFills(): Promise<Fill[]> {
    const res = await this.request<{ data?: RevolutXTrade[] }>(
      'GET',
      `/1.0/trades/private/${this.symbol}`
    );
    const trades = res?.data ?? [];
    return trades.map((t) => ({
      clientId: this.clientIdFor(t.client_order_id ?? ''),
      side: (t.side ?? 'buy').toLowerCase() === 'sell' ? 'sell' : 'buy',
      price: Number(t.price ?? 0),
      quantity: Number(t.quantity ?? t.base_size ?? 0),
      timestamp: Number(t.created_at ?? t.timestamp ?? 0),
    }));
  }

  // -- internals ------------------------------------------------------------

  private async fetchActiveOrders(): Promise<RevolutXRawOrder[]> {
    const res = await this.request<{ data?: RevolutXRawOrder[] } | RevolutXRawOrder[]>(
      'GET',
      '/1.0/orders/active'
    );
    if (Array.isArray(res)) return res;
    return res?.data ?? [];
  }

  private toVenueOrder(o: RevolutXRawOrder): VenueOrder {
    const quantity = Number(o.base_size ?? o.quantity ?? 0);
    const filled = Number(o.filled_size ?? o.filled_quantity ?? 0);
    return {
      clientId: this.clientIdFor(o.client_order_id ?? ''),
      side: (o.side ?? 'buy').toLowerCase() === 'sell' ? 'sell' : 'buy',
      status: revolutxOrderStatus(o.state),
      price: o.price === undefined ? undefined : Number(o.price),
      quantity,
      filledQuantity: filled,
    };
  }
}

interface RevolutXRawOrder {
  venue_order_id: string;
  client_order_id?: string;
  state?: string;
  side?: string;
  symbol?: string;
  price?: string | number;
  base_size?: string | number;
  quantity?: string | number;
  filled_size?: string | number;
  filled_quantity?: string | number;
}

interface RevolutXTrade {
  client_order_id?: string;
  side?: string;
  price?: string | number;
  quantity?: string | number;
  base_size?: string | number;
  created_at?: string | number;
  timestamp?: string | number;
}
