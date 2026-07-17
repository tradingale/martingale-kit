// Minimal Tradingale REST client: fetches the dimensionless model
// parameters this kit turns into ladders. Get a token (and the full field
// reference) at https://tradingale.com/settings/api. The same data is
// exposed to AI agents through the MCP server: https://tradingale.com/mcp
//
// Quotas are weighted monthly calls (Score Scout 5,000 personal use,
// Martingale Maestro 50,000 commercial license). One /all call covers the
// whole catalog; it refreshes about every 40 minutes, so poll gently.

import type { SequenceParams } from './types.js';

export interface TradingaleInstrument extends SequenceParams {
  id: number;
  name?: string;
}

interface RawInstrument {
  id: number;
  symbol: string;
  name?: string;
  delta_price: number;
  nb_rounds: number;
  multipliers: number[];
  initial_bet_ratio?: number;
  martingale_score?: number;
  startingale?: number;
}

function toParams(raw: RawInstrument): TradingaleInstrument {
  return {
    id: raw.id,
    symbol: raw.symbol,
    name: raw.name,
    deltaPrice: raw.delta_price,
    nbRounds: raw.nb_rounds,
    multipliers: raw.multipliers,
    initialBetRatio: raw.initial_bet_ratio ?? NaN,
    martingaleScore: raw.martingale_score,
    startingale: raw.startingale,
  };
}

export class TradingaleClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl = 'https://tradingale.com/api/martingale',
  ) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      throw new Error(`Tradingale API ${res.status} on ${path}: ${await res.text().catch(() => '')}`);
    }
    return res.json() as Promise<T>;
  }

  /** Crypto instruments, optionally filtered (e.g. { symbol: 'BTC' }). */
  async crypto(filters: Record<string, string | number> = {}): Promise<TradingaleInstrument[]> {
    const qs = new URLSearchParams(Object.entries(filters).map(([k, v]) => [k, String(v)] as [string, string]));
    const body = await this.get<{ data: RawInstrument[] }>(`/crypto?${qs}`);
    return body.data.map(toParams);
  }

  /** US stock instruments, same shape. */
  async stocks(filters: Record<string, string | number> = {}): Promise<TradingaleInstrument[]> {
    const qs = new URLSearchParams(Object.entries(filters).map(([k, v]) => [k, String(v)] as [string, string]));
    const body = await this.get<{ data: RawInstrument[] }>(`/stocks?${qs}`);
    return body.data.map(toParams);
  }
}
