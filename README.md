# martingale-kit

**We ran martingale sequence automation in production. Then we repositioned as a pure data provider and open-sourced the engine's brain.**

This kit is everything that was hard to get right, as exact, tested TypeScript:

- **The ladder math**: `computeLadder()` turns [Tradingale's](https://tradingale.com) dimensionless model parameters plus your budget and a live entry price into a complete plan. Including the rule that breaks most integrations: multipliers scale QUANTITIES, never dollar costs.
- **The state machine**: plan-in-database pattern, the one-active-sell invariant with structural cancel-verify-place, a pure `reconcile()` you can unit test.
- **Directional grid snapping**: exit prices UP, buy prices DOWN, quantities floored. The sub-$1 rounding lesson is a test fixture.
- **`budgetMin()`**: the minimum viable capital for a venue's grids, so a runner refuses to start instead of placing a distorted ladder.
- **A `PaperAdapter`**: local fill simulator. The whole engine runs end to end with zero keys, right now.
- **A `TradingaleClient`**: fetches the model parameters from the [REST API](https://tradingale.com/settings/api).

What it deliberately does **not** contain: a connection to any real exchange. The `VenueAdapter` interface is documented and left to you (or to your coding agent). Your adapter, your keys, your account, your sole responsibility. Tradingale never places orders, holds funds, or gives advice.

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
