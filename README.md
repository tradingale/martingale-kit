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
npm run runner -- watch                              # reconciles on a schedule
npm run runner -- status                             # where every sequence stands
npm run runner -- stop <id>                          # cancel open orders, keep the position
npm run runner -- stop <id> --reverse                # cancel AND market-sell the position
```

Stop mirrors the Tradingale dashboard: `stop <id>` cancels the resting buys and the active sell but keeps whatever you have accumulated; add `--reverse` to also market-sell that position and exit completely. Get the `<id>` from `status`.

- Crypto AND US stocks both run in paper: crypto prices come from public exchange tickers, stock prices from a free delayed feed (delayed, and disclosed here on purpose; fine for the reconciliation loop). Live mode routes by asset class: Kraken carries crypto (KRAKEN_API_KEY / KRAKEN_API_SECRET), Alpaca carries US stocks (ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY; set ALPACA_PAPER=true to point the same rail at Alpaca's paper environment). Stock sequences refuse to start while the US market is closed, stock day orders are re-placed automatically after expiry, and your keys never leave your deployment.
- The plan is persisted to `.martingale-runner/` before anything is placed (atomic writes); a crash or reboot resumes by replaying the file, exactly like the handbook says. The paper venue's book (fills AND still-resting orders) is persisted too, so a one-shot `cycle` in a fresh process sees the active sell instead of placing another.
- Finished SIMULATED sequences can be deleted from the dashboard (a running one must be stopped first). **Live sequences are permanent** and can never be deleted: real orders happened, so they stay on record.
- **Active sequence controls.** Each running sequence carries **Check now** (reconcile immediately instead of waiting for the scheduled pass) and **Resync sell** (the site's update-sell: cancel the resting sell and re-place the right template for the level actually reached, buy ladder untouched), alongside Stop and Stop + reverse. The dashboard states when the last automatic check ran and when the next is due.
- **Journal tab.** Every sequence with its own metrics, computed from this runner's fill history: realized P/L, win rate (profitable closed over closed), average return on capital used and on budget, capital efficiency, average rounds, max-round sequences, average duration, active capital. Filter Live / Simulated / All — the two are never averaged together, since a mixed number describes neither.
- Underfunded ladders are refused with the computed `budget_min` instead of being silently distorted.
- Live execution on Kraken ships in-repo (`src/adapters/kraken.ts`) behind the explicit `--live` flag, off by default. It requires `KRAKEN_API_KEY` / `KRAKEN_API_SECRET` (trade-only permission, never withdrawal, IP allowlisting) and places REAL orders on your account. Even paper mode snaps ladders to the real Kraken grids when they can be fetched, so paper plans match what live would submit.

## The web runner

The same runner, as a small web app: one `node:http` server hosts the UI and runs the reconciliation loop in the same process.

```bash
export TRADINGALE_TOKEN=...       # tradingale.com/settings/api  (or: npm run runner -- keys)
npm run server                    # paper by default, http://localhost:8080
```

- **Three pages.** A nav switches between **Scoreboard** (pick an instrument, preview its sequence, start it), **Dashboard** (your running sequences), and **Keys & settings**. Key status lives on its own page, not scattered.
- **Custom sequences.** Tick "Edit the structure myself" under the preview to set your own spacing, number of rounds, and quantity multipliers, exactly like the site's custom sequences. The preview recomputes live and every guardrail still applies (budget floor, grid checks); leave it off to use Tradingale's structure.
- **Refresh button** on the scoreboard refetches scores and prices on demand (data refreshes cost weighted API calls, so they are user-triggered).
- **Catalog picker.** The page shows a scoreboard of your instruments — symbol, name, Martingale Score, Startingale as a word (Strong / Favorable / Moderate / Misaligned), and the live public price (top rows prefetched, the rest on click) — sortable by score and filterable. Click a row to load it into the Start form with its live price. The scoreboard is proxied through the server, so your `TRADINGALE_TOKEN` never reaches the browser. Whatever your plan scopes is what shows (free = BTC). Prices come from public tickers (crypto: Binance with a Kraken fallback; stocks: a free delayed feed), no keys needed — and once Alpaca keys are configured, US stock prices upgrade automatically to Alpaca's live data.
- **Key status.** A line reports whether the Tradingale token and the Kraken / Alpaca keys are configured — presence only, never the values — with the command to set them.
- Each sequence renders as the Tradingale price ladder (model buy level, model exit level, outcome if reached) plus phase, level reached, budget, last price and venue. It refreshes on a short interval.
- `RUNNER_MODE=live` switches to the live adapters, shows a permanent red banner, and refuses to start while keys are missing. Paper mode shows an amber "Simulated" banner.
- **Stop** on a running sequence cancels the resting buys and the active sell; **Stop + reverse** also market-sells the accumulated position to exit completely (mirrors the Tradingale dashboard).
- Set `RUNNER_PASSWORD` to put the whole server behind Basic Auth.

## Going live

Live mode places REAL orders on your own exchange account. Two deliberate guardrails:

1. **Live is decided only by the environment at launch** (`RUNNER_MODE=live`). Nothing in the UI or a config file can flip paper -> live.
2. **Your keys never leave your machine.** They are read from the environment or from a local `.martingale-runner/keys.env` (chmod 600), never logged, never returned by any API, never shown once saved.

Configure keys with the guided command instead of exporting env vars by hand:

```bash
npm run runner -- keys      # hidden prompts; writes .martingale-runner/keys.env (0600)
```

Or from the web UI: the **API keys** card at the bottom of the page is write-only (values are saved to the same local file, never displayed again, never served back — the status line only ever shows configured/absent). Over the network the form requires `RUNNER_PASSWORD`; without it, it only works from the machine itself (localhost). Saving keys never changes the mode.

It stores your Tradingale token and, for live, your exchange keys. Then relaunch in live mode:

```bash
RUNNER_MODE=live npm run server      # crypto -> Kraken, US stocks -> Alpaca
```

**Key hygiene, non-negotiable:** create exchange keys **trade-only, never with withdrawal permission**, and **IP-allowlist** them to your machine or your Railway egress. The runner refuses underfunded ladders (it surfaces `budget_min`) rather than placing a distorted one.

## Deploy on Railway

Run the web runner on a small always-on box. Paper by default there too. Your keys live in YOUR Railway project; Tradingale never sees them.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/github?repo=https://github.com/tradingale/martingale-kit)

Variables:

| Variable | Required | Notes |
| --- | --- | --- |
| `TRADINGALE_TOKEN` | yes | Model parameters token, from [tradingale.com/settings/api](https://tradingale.com/settings/api). |
| `RUNNER_MODE` | no | `paper` (default) or `live`. Live places real orders on your Kraken account. |
| `KRAKEN_API_KEY` / `KRAKEN_API_SECRET` | live crypto | Create them trade-only (no withdrawal) and IP-allowlisted. Read from env, never logged, never served. |
| `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` | live US stocks | Same hygiene. `ALPACA_PAPER=true` points the rail at Alpaca's paper environment. |
| `RUNNER_PASSWORD` | recommended | Basic Auth for the whole UI. Without it the page is open to anyone who finds the URL. |
| `RUNNER_STATE_DIR` | recommended | Mount a [Railway volume](https://docs.railway.com/volumes) and point this at it (e.g. `/data`). Containers are ephemeral: without a volume, a redeploy forgets your sequence files. In live mode your orders would keep resting on Kraken with nothing reconciling them. |
| `CATALOG_REFRESH_MINUTES` | no | How often the dashboard's catalog refetches Tradingale data (default 120, min 10). Each refresh spends a few weighted calls of your monthly plan quota; the default keeps an always-open dashboard well within a Score Scout plan, with headroom for your own tooling. Refresh faster only if you want to spend more of your quota. |
| `PORT` | auto | Injected by Railway. |

The deploy config lives in `railway.json` (start command `npm run server`, healthcheck `GET /api/state`). Note for live mode on any hosted box: Kraken API keys can be IP-allowlisted only if your egress IP is stable; hosted containers usually are not, so weigh that against running the runner at home.

## The one prompt

Paste this into Claude Code, Cursor, or any coding agent:

```text
Clone https://github.com/tradingale/martingale-kit and read its README and
https://tradingale.com/handbook/sequence-automation.md entirely.

Build me a runner on top of the kit:
0. FIRST, a Tradingale API token is required. If the TRADINGALE_TOKEN env var
   is not set, stop and tell me to generate one at
   https://tradingale.com/settings/api (the free tier covers BTC), then set
   it. Nothing else works without it, so confirm this before anything.
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
5. Schedule the reconciliation loop on a schedule with an overlap guard.
6. Keep the kit's stop command: `stop <id>` cancels the open orders and keeps
   the position; `stop <id> --reverse` also market-sells it to exit fully.
```

The agent writes a thin adapter instead of a whole engine. The engine part is already here, tested.

Working with a smaller model or a bare local LLM? Point it at [`llms.txt`](llms.txt) first: ten dense lines with the stack, the exact commands, the real API response shape, and the engine invariants — everything a model tends to guess wrong.

## Where the data comes from

The model parameters (`delta_price`, `nb_rounds`, `multipliers`, `initial_bet_ratio`, plus the Martingale Score and Startingale metrics) are served by Tradingale, identically for every subscriber, through the [REST API](https://tradingale.com/settings/api) and an [MCP server](https://tradingale.com/docs/mcp-setup) for AI agents. Plans: [tradingale.com/pricing](https://tradingale.com/pricing). The engineering background lives in the [Sequence Automation Handbook](https://tradingale.com/handbook/sequence-automation.md), and the model's own simulated track record is public at [tradingale.com/performance](https://tradingale.com/performance).

## Disclaimer

Engineering software and documentation for informational purposes only. Not investment advice. Martingale structures concentrate risk by design and trading involves significant risk of loss. Simulated results do not represent actual trading. Anything you build with this kit runs on your keys and under your sole responsibility.
