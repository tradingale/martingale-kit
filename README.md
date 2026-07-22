# martingale-kit

**We ran martingale sequence automation in production. Then we repositioned as a pure data provider and open-sourced the engine's brain.**

This kit is everything that was hard to get right, as exact, tested TypeScript:

- **The ladder math**: `computeLadder()` turns [Tradingale's](https://tradingale.com) dimensionless model parameters plus your budget and a live entry price into a complete plan. Including the rule that breaks most integrations: multipliers scale QUANTITIES, never dollar costs.
- **The state machine**: plan-in-database pattern, the one-active-sell invariant with structural cancel-verify-place, a pure `reconcile()` you can unit test.
- **Directional grid snapping**: exit prices UP, buy prices DOWN, quantities floored. The sub-$1 rounding lesson is a test fixture.
- **`budgetMin()`**: the minimum viable capital for a venue's grids, so a runner refuses to start instead of placing a distorted ladder.
- **A `PaperAdapter`**: local fill simulator. The whole engine runs end to end with zero keys, right now.
- **A `TradingaleClient`**: fetches the model parameters from the [REST API](https://tradingale.com/settings/api).

Exchange connectivity is a thin, replaceable layer: the `VenueAdapter` interface is documented, and one reference implementation ships in-repo (`KrakenAdapter`, ported from our production Kraken integration), behind an explicit live mode that is OFF by default. Other venues are left to you (or to your coding agent). Your adapter, your keys, your account, your sole responsibility. Tradingale never places orders, holds funds, or gives advice.

## The mental model, in five sentences

A sequence is **not** adaptive. It is frozen at birth: the first market buy fixes the entry price, and every other order is computed at that instant (all the limit buys and all the sell templates); nothing is ever recomputed. Every buy can rest on the book from second one. Only **one** order ever changes: the sell. A limit buy fills? Cancel the sell, place the next level's template (cumulative quantity, at the previous level's buy price). The sell fills? The sequence is over, above its average cost by construction.

`reconcile()` in this kit is exactly those five sentences as a pure function.

## Quickstart (paper, zero keys)

```ts
import {
  computeLadder, buildPlan, entryActions, initialState, runCycle, PaperAdapter,
} from './src/index.js';

// Model parameters come from the Tradingale API (per instrument):
const params = { deltaPrice: 0.05, nbRounds: 4, multipliers: [2, 2, 2], initialBetRatio: 0.1 };

const ladder = computeLadder(params, 1_000, 100); // your budget, live entry price
const plan = buildPlan('demo', ladder);
const venue = new PaperAdapter();

venue.tick(100); // market at entry
for (const a of entryActions(plan)) if (a.type === 'placeOrder') await venue.placeOrder(a.order);

let state = initialState();
state = await runCycle(plan, state, venue); // places the level 1 exit
venue.tick(95);                             // dip: level 2 fills
state = await runCycle(plan, state, venue); // cancels the stale exit
state = await runCycle(plan, state, venue); // cancel verified, places the level 2 exit
venue.tick(100);                            // recovery: exit fills
state = await runCycle(plan, state, venue); // phase: 'complete'
```

Run the tests: `npm install && npm test`.

## The Runner (the bot, self-hosted, paper-first)

The kit ships a ready-to-run sequence bot. Everything happens on YOUR machine: your token, your files, later your keys. Paper by default, driven by real public market prices.

```bash
git clone https://github.com/tradingale/martingale-kit && cd martingale-kit && npm install
export TRADINGALE_TOKEN=...   # tradingale.com/settings/api

npm run runner -- start --symbol BTC --budget 5000   # freezes the plan, places the paper entry
npm run runner -- watch                              # reconciles every 10 minutes
npm run runner -- status                             # where every sequence stands
```

- Crypto AND US stocks both run in paper: crypto prices come from public exchange tickers, stock prices from a free delayed feed (about 15 minutes; fine for a 10-minute reconciliation loop, and disclosed here on purpose). Live mode routes by asset class: Kraken carries crypto (KRAKEN_API_KEY / KRAKEN_API_SECRET), Alpaca carries US stocks (ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY; set ALPACA_PAPER=true to point the same rail at Alpaca's paper environment). Stock sequences refuse to start while the US market is closed, stock day orders are re-placed automatically after expiry, and your keys never leave your deployment.
- The plan is persisted to `.martingale-runner/` before anything is placed (atomic writes); a crash or reboot resumes by replaying the file, exactly like the handbook says.
- Underfunded ladders are refused with the computed `budget_min` instead of being silently distorted.
- Live execution on Kraken ships in-repo (`src/adapters/kraken.ts`) behind the explicit `--live` flag, off by default. It requires `KRAKEN_API_KEY` / `KRAKEN_API_SECRET` (trade-only permission, never withdrawal, IP allowlisting) and places REAL orders on your account. Even paper mode snaps ladders to the real Kraken grids when they can be fetched, so paper plans match what live would submit.

## The web runner

The same runner, as a small web app: one `node:http` server hosts the status UI and runs the 10-minute reconciliation loop in the same process.

```bash
export TRADINGALE_TOKEN=...       # tradingale.com/settings/api
npm run server                    # paper by default, http://localhost:8080
```

- The page shows each sequence as the Tradingale price ladder (model buy level, model exit level, outcome if reached) plus phase, level reached, budget, last price and venue. It refreshes every 30 seconds.
- `RUNNER_MODE=live` switches to the Kraken adapter, shows a permanent red banner, and refuses to start sequences while keys are missing. Paper mode shows an amber "Simulated" banner.
- Stopping a sequence halts the loop for it and cancels NOTHING at the venue: cancel your open orders on Kraken yourself.
- Set `RUNNER_PASSWORD` to put the whole server behind Basic Auth.

## Deploy on Railway

Run the web runner on a small always-on box. Paper by default there too. Your keys live in YOUR Railway project; Tradingale never sees them.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/github?repo=https://github.com/tradingale/martingale-kit)

Variables:

| Variable | Required | Notes |
| --- | --- | --- |
| `TRADINGALE_TOKEN` | yes | Model parameters token, from [tradingale.com/settings/api](https://tradingale.com/settings/api). |
| `RUNNER_MODE` | no | `paper` (default) or `live`. Live places real orders on your Kraken account. |
| `KRAKEN_API_KEY` / `KRAKEN_API_SECRET` | live only | Create them trade-only (no withdrawal) and IP-allowlisted. Read from env, never logged, never served. |
| `RUNNER_PASSWORD` | recommended | Basic Auth for the whole UI. Without it the page is open to anyone who finds the URL. |
| `RUNNER_STATE_DIR` | recommended | Mount a [Railway volume](https://docs.railway.com/volumes) and point this at it (e.g. `/data`). Containers are ephemeral: without a volume, a redeploy forgets your sequence files. In live mode your orders would keep resting on Kraken with nothing reconciling them. |
| `PORT` | auto | Injected by Railway. |

The deploy config lives in `railway.json` (start command `npm run server`, healthcheck `GET /api/state`). Note for live mode on any hosted box: Kraken API keys can be IP-allowlisted only if your egress IP is stable; hosted containers usually are not, so weigh that against running the runner at home.

## The one prompt

Paste this into Claude Code, Cursor, or any coding agent:

```text
Clone https://github.com/tradingale/martingale-kit and read its README and
https://tradingale.com/handbook/sequence-automation.md entirely.

Build me a runner on top of the kit:
1. Fetch instruments from the Tradingale API with my token (TRADINGALE_TOKEN
   env var) and let me pick one and a budget.
2. Use computeLadder / buildPlan / runCycle exactly as designed; never
   reimplement the math. Check budgetMin before starting.
3. Wire the PaperAdapter first and drive it with live prices from the venue's
   public ticker, so I can watch full sequences run with zero keys.
4. Implement the VenueAdapter interface for [MY VENUE] from its official API
   docs, following the handbook's per-venue notes (grids, rate limits, key
   hygiene: trade-only permission, no withdrawal, IP allowlist). Keep it
   behind an explicit --live flag that defaults OFF.
5. Schedule the reconciliation loop every 10 minutes with an overlap guard.
```

The agent writes a thin adapter instead of a whole engine. The engine part is already here, tested.

## Where the data comes from

The model parameters (`delta_price`, `nb_rounds`, `multipliers`, `initial_bet_ratio`, plus the Martingale Score and Startingale metrics) are served by Tradingale, identically for every subscriber, through the [REST API](https://tradingale.com/settings/api) and an [MCP server](https://tradingale.com/docs/mcp-setup) for AI agents. Plans: [tradingale.com/pricing](https://tradingale.com/pricing). The engineering background lives in the [Sequence Automation Handbook](https://tradingale.com/handbook/sequence-automation.md), and the model's own simulated track record is public at [tradingale.com/performance](https://tradingale.com/performance).

## Disclaimer

Engineering software and documentation for informational purposes only. Not investment advice. Martingale structures concentrate risk by design and trading involves significant risk of loss. Simulated results do not represent actual trading. Anything you build with this kit runs on your keys and under your sole responsibility.
