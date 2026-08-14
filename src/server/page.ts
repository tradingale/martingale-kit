// The web runner page: one self-contained HTML document (inline CSS, inline
// JS, zero CDN, zero framework). The visual language is ported from the
// Tradingale site (app/components/Sequence.tsx): slate-950 background,
// slate-900 cards, #2a81ff -> #3ce7fc gradient accents, the price-ladder
// layout with a level coin (ENTRY / -x%), and the MODEL BUY LEVEL / MODEL
// EXIT LEVEL / OUTCOME IF REACHED tiles with the same NFA wording.
//
// The page polls GET /api/state every 30 seconds and renders client side.

import type { RunnerMode } from '../runner/core.js';

export function renderPage(mode: RunnerMode): string {
  const banner =
    mode === 'live'
      ? '<div class="banner banner-live">LIVE: real orders on your Kraken account</div>'
      : '<div class="banner banner-paper">Simulated: paper mode, no real orders. Simulated results do not represent actual trading.</div>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tradingale Runner</title>
<style>
  :root {
    --bg: #020617;          /* slate-950 */
    --card: #0f172a;        /* slate-900 */
    --blue: #2a81ff;
    --cyan: #3ce7fc;
    --text: #ffffff;
    --muted: #94a3b8;       /* slate-400 */
    --faint: #64748b;       /* slate-500 */
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    min-height: 100vh;
  }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .banner {
    position: sticky; top: 0; z-index: 50;
    text-align: center; font-weight: 700; font-size: 13px; letter-spacing: 0.06em;
    padding: 8px 12px; text-transform: uppercase;
  }
  .banner-live { background: #7f1d1d; color: #fecaca; border-bottom: 1px solid #ef4444; }
  .banner-paper { background: #451a03; color: #fcd34d; border-bottom: 1px solid #b45309; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 20px 14px 60px; }
  header.top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 18px; flex-wrap: wrap; }
  .logo { font-size: 22px; font-weight: 900; letter-spacing: 0.02em; }
  .logo span {
    background: linear-gradient(90deg, var(--blue), var(--cyan));
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .top-meta { font-size: 11px; color: var(--muted); }
  .card {
    background: rgba(15, 23, 42, 0.6);
    border: 1px solid rgba(60, 231, 252, 0.2);
    border-radius: 14px; overflow: hidden; margin-bottom: 18px;
  }
  .card-head {
    display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
    padding: 12px 14px;
    background: linear-gradient(90deg, rgba(42, 129, 255, 0.10), rgba(60, 231, 252, 0.10));
    border-bottom: 1px solid rgba(60, 231, 252, 0.2);
  }
  .card-head h2 { font-size: 16px; font-weight: 800; letter-spacing: 0.02em; }
  .chip {
    display: inline-block; font-size: 11px; font-weight: 600; color: var(--cyan);
    background: rgba(42, 129, 255, 0.10); border: 1px solid rgba(60, 231, 252, 0.2);
    border-radius: 8px; padding: 2px 8px;
  }
  /* Simulated vs real, visible at a glance on every sequence card. */
  .card.paper > .card-head { background: linear-gradient(90deg, rgba(180, 83, 9, 0.35), rgba(251, 191, 36, 0.12)); border-bottom-color: rgba(251, 191, 36, 0.45); }
  .card.paper { border-color: rgba(251, 191, 36, 0.4); }
  .card.livecard > .card-head { background: linear-gradient(90deg, rgba(127, 29, 29, 0.45), rgba(239, 68, 68, 0.12)); border-bottom-color: rgba(239, 68, 68, 0.5); }
  .card.livecard { border-color: rgba(239, 68, 68, 0.45); }
  .chip-paper { color: #fcd34d; border-color: rgba(251, 191, 36, 0.5); background: rgba(180, 83, 9, 0.18); }
  .chip-live { color: #fecaca; border-color: rgba(239, 68, 68, 0.55); background: rgba(127, 29, 29, 0.25); }
  .chip-halted { color: #fda4af; border-color: rgba(244, 63, 94, 0.4); background: rgba(244, 63, 94, 0.08); }
  .chip-complete { color: #86efac; border-color: rgba(34, 197, 94, 0.4); background: rgba(34, 197, 94, 0.08); }
  .card-body { padding: 14px; }
  form.controls { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field label { font-size: 10px; font-weight: 700; letter-spacing: 0.1em; color: var(--muted); text-transform: uppercase; }
  .field input {
    background: var(--bg); color: var(--text); border: 1px solid rgba(60, 231, 252, 0.25);
    border-radius: 8px; padding: 8px 10px; font-size: 14px; width: 130px; outline: none;
  }
  .field input:focus { border-color: var(--cyan); }
  button.primary {
    background: linear-gradient(90deg, var(--blue), var(--cyan)); color: #04101f;
    font-weight: 800; font-size: 13px; letter-spacing: 0.04em; border: 0; border-radius: 9px;
    padding: 10px 18px; cursor: pointer;
  }
  button.primary:disabled { opacity: 0.5; cursor: default; }
  button.stop {
    background: transparent; color: #fda4af; border: 1px solid rgba(244, 63, 94, 0.5);
    border-radius: 8px; padding: 4px 10px; font-size: 11px; font-weight: 700; cursor: pointer;
  }
  .msg { margin-top: 10px; font-size: 12px; display: none; border-radius: 8px; padding: 8px 10px; }
  .msg.err { display: block; color: #fda4af; background: rgba(244, 63, 94, 0.08); border: 1px solid rgba(244, 63, 94, 0.35); }
  .msg.ok { display: block; color: #86efac; background: rgba(34, 197, 94, 0.08); border: 1px solid rgba(34, 197, 94, 0.35); }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin-bottom: 14px; }
  .stat {
    background: rgba(15, 23, 42, 0.4); border: 1px solid rgba(60, 231, 252, 0.12);
    border-radius: 10px; padding: 8px 10px;
  }
  .stat .k { font-size: 9px; font-weight: 700; letter-spacing: 0.12em; color: var(--muted); text-transform: uppercase; }
  .stat .v { font-size: 15px; font-weight: 800; margin-top: 3px; }
  .ladder { display: flex; flex-direction: column; gap: 16px; }
  .level { position: relative; padding-left: 52px; }
  .rail {
    position: absolute; left: 17px; top: -16px; width: 1px; height: calc(100% + 16px);
    background: linear-gradient(180deg, rgba(42, 129, 255, 0.5), rgba(60, 231, 252, 0.25), transparent);
  }
  .coin {
    position: absolute; left: 0; top: 8px; width: 36px; height: 36px; border-radius: 12px; padding: 1.5px;
    background: linear-gradient(135deg, rgba(42, 129, 255, 0.5), rgba(60, 231, 252, 0.3));
  }
  .coin.entry { background: linear-gradient(135deg, var(--blue), var(--cyan)); box-shadow: 0 0 12px rgba(60, 231, 252, 0.35); }
  .coin .in {
    width: 100%; height: 100%; border-radius: 10px; background: var(--bg);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
  }
  .coin .n { font-weight: 900; font-size: 13px; line-height: 1; }
  .coin .d { font-size: 7px; margin-top: 2px; color: rgba(60, 231, 252, 0.6); }
  .coin.entry .d { color: var(--cyan); }
  .lvl-card { border: 1px solid rgba(60, 231, 252, 0.1); background: rgba(15, 23, 42, 0.4); border-radius: 12px; padding: 10px 12px; }
  .lvl-card.entry { border-color: rgba(60, 231, 252, 0.5); background: linear-gradient(90deg, rgba(42, 129, 255, 0.08), rgba(60, 231, 252, 0.04)); }
  .lvl-card.filled { border-color: rgba(60, 231, 252, 0.35); }
  .lvl-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .lvl-name { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
  .lvl-cost { font-size: 10px; color: var(--muted); }
  .lvl-cost b { color: var(--text); }
  .tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  @media (min-width: 640px) { .tiles { grid-template-columns: 1fr 1fr 1fr; } }
  .tile { border-radius: 10px; padding: 8px 10px; }
  .tile .t { font-size: 8px; font-weight: 800; letter-spacing: 0.15em; margin-bottom: 4px; }
  .tile .p { font-size: 15px; font-weight: 800; line-height: 1; }
  .tile .s { font-size: 9px; margin-top: 4px; }
  .tile-buy { background: rgba(16, 185, 129, 0.06); border: 1px solid rgba(16, 185, 129, 0.2); }
  .tile-buy .t { color: rgba(52, 211, 153, 0.9); }
  .tile-buy .s { color: rgba(60, 231, 252, 0.8); }
  .tile-exit { background: rgba(244, 63, 94, 0.06); border: 1px solid rgba(244, 63, 94, 0.2); }
  .tile-exit .t { color: rgba(251, 113, 133, 0.9); }
  .tile-exit .s { color: var(--muted); }
  .tile-outcome { grid-column: span 2; background: linear-gradient(90deg, rgba(34, 197, 94, 0.08), rgba(52, 211, 153, 0.05)); border: 1px solid rgba(34, 197, 94, 0.25); }
  @media (min-width: 640px) { .tile-outcome { grid-column: span 1; } }
  .tile-outcome .t { color: rgba(74, 222, 128, 0.9); }
  .tile-outcome .p { color: #86efac; }
  .tile-outcome .s { color: rgba(74, 222, 128, 0.7); }
  .halt-note { margin: 0 0 12px; font-size: 11px; color: #fda4af; background: rgba(244, 63, 94, 0.08); border: 1px solid rgba(244, 63, 94, 0.3); border-radius: 8px; padding: 8px 10px; }
  .empty { color: var(--faint); font-size: 13px; padding: 8px 2px; }
  .foot { font-size: 10px; color: var(--faint); line-height: 1.6; border-top: 1px solid rgba(60, 231, 252, 0.1); padding: 10px 14px; }
  footer.page { font-size: 10px; color: var(--faint); line-height: 1.7; margin-top: 24px; }
  /* Catalog scoreboard */
  button.tab { background: transparent; color: var(--muted); border: 1px solid rgba(60,231,252,0.25); border-radius: 8px; padding: 6px 12px; font-size: 12px; font-weight: 700; cursor: pointer; }
  button.tab.active { color: #04101f; background: linear-gradient(90deg, var(--blue), var(--cyan)); border-color: transparent; }
  .cat-filter { background: var(--bg); color: var(--text); border: 1px solid rgba(60,231,252,0.25); border-radius: 8px; padding: 6px 10px; font-size: 13px; width: 200px; max-width: 55vw; outline: none; }
  .cat-filter:focus { border-color: var(--cyan); }
  .cat-note { font-size: 10px; color: var(--faint); margin-bottom: 8px; }
  .cat-wrap { max-height: 320px; overflow-y: auto; border: 1px solid rgba(60,231,252,0.1); border-radius: 10px; }
  table.cat { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.cat th { position: sticky; top: 0; background: var(--card); text-align: left; font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); font-weight: 700; padding: 8px 10px; border-bottom: 1px solid rgba(60,231,252,0.15); }
  table.cat th.cat-sort { cursor: pointer; color: var(--cyan); user-select: none; }
  table.cat td { padding: 8px 10px; border-bottom: 1px solid rgba(60,231,252,0.06); }
  table.cat tbody tr { cursor: pointer; }
  table.cat tbody tr:hover { background: rgba(42,129,255,0.08); }
  .cat-sym { font-weight: 800; }
  .cat-score { font-weight: 800; }
  .cat-tag { font-size: 8px; color: var(--faint); border: 1px solid rgba(100,116,139,0.4); border-radius: 5px; padding: 0 4px; margin-left: 6px; text-transform: uppercase; letter-spacing: 0.06em; }
  .sg-strong { color: #4ade80; font-weight: 700; } .sg-favorable { color: #60a5fa; font-weight: 700; } .sg-moderate { color: #facc15; font-weight: 700; } .sg-misaligned { color: #f87171; font-weight: 700; }
  .cat-empty { font-size: 12px; color: var(--faint); padding: 8px 2px; }
  nav.nav { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .nav-tab { background: rgba(15,23,42,0.6); color: var(--muted); border: 1px solid rgba(60,231,252,0.2); border-radius: 10px; padding: 8px 16px; font-size: 13px; font-weight: 700; cursor: pointer; }
  .nav-tab.active { color: #04101f; background: linear-gradient(90deg, var(--blue), var(--cyan)); border-color: transparent; }
  /* Journal: compact rows, expandable with the arrow. */
  .jrow { border: 1px solid rgba(60,231,252,0.1); border-radius: 10px; margin-bottom: 6px; background: rgba(15,23,42,0.4); }
  .jrow-head { display: flex; align-items: center; gap: 10px; padding: 8px 10px; cursor: pointer; flex-wrap: wrap; font-size: 12px; }
  .jrow-head:hover { background: rgba(42,129,255,0.06); }
  .jrow-arrow { color: var(--cyan); font-size: 11px; width: 12px; transition: transform 0.15s; }
  .jrow.open .jrow-arrow { transform: rotate(90deg); }
  .jrow-sym { font-weight: 800; min-width: 56px; }
  .jrow-badge { font-size: 9px; font-weight: 700; border-radius: 5px; padding: 1px 6px; letter-spacing: 0.05em; }
  .jrow-badge.sim { color: #fcd34d; background: rgba(180,83,9,0.25); }
  .jrow-badge.live { color: #fecaca; background: rgba(127,29,29,0.35); }
  .jrow-spacer { flex: 1; }
  .jrow-body { display: none; padding: 0 10px 10px 32px; }
  .jrow.open .jrow-body { display: block; }
  .jsection-title { font-size: 12px; font-weight: 800; color: var(--cyan); letter-spacing: 0.05em; text-transform: uppercase; margin: 16px 0 8px; }
  .keygroup { border: 1px solid rgba(60,231,252,0.12); border-radius: 10px; padding: 12px; margin-bottom: 12px; background: rgba(15,23,42,0.35); }
  .keygroup-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; font-size: 13px; }
  .keygroup-sub { color: var(--faint); font-size: 11px; }
  .kstatus { font-size: 11px; font-weight: 700; border-radius: 8px; padding: 2px 8px; border: 1px solid rgba(100,116,139,0.4); color: var(--faint); }
  .kstatus.on { color: #4ade80; border-color: rgba(74,222,128,0.45); background: rgba(34,197,94,0.08); }
  .keys-line { font-size: 11px; color: var(--muted); margin: -6px 0 16px; }
  .keys-line b { color: var(--text); font-weight: 600; }
  .k-ok { color: #4ade80; } .k-absent { color: var(--faint); }
  .keys-hint { color: var(--faint); }
  .keys-hint code { color: var(--cyan); }
</style>
</head>
<body>
${banner}
<div class="wrap">
  <header class="top">
    <div class="logo"><span>Tradingale</span> Runner</div>
    <div class="top-meta" id="topMeta">loading state...</div>
  </header>

  <nav class="nav">
    <button class="nav-tab active" id="navScoreboard" type="button">Scoreboard</button>
    <button class="nav-tab" id="navDashboard" type="button">Dashboard</button>
    <button class="nav-tab" id="navJournal" type="button">Journal</button>
    <button class="nav-tab" id="navKeys" type="button">Keys &amp; settings</button>
  </nav>

  <section id="pageScoreboard">
  <div class="card">
    <div class="card-head">
      <h2>Scoreboard</h2>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="tab active" id="tabCryptos" type="button">Cryptos</button>
        <button class="tab" id="tabStocks" type="button">Stocks</button>
        <input class="cat-filter" id="catFilter" placeholder="Filter symbol or name" autocomplete="off">
        <button class="tab" id="catRefresh" type="button" title="Refetch scores and prices">&#8635; Refresh</button>
      </div>
    </div>
    <div class="card-body">
      <div class="cat-note">Descriptive metrics, not advice. Click a row to view its sequence at your budget.</div>
      <div class="cat-wrap">
        <table class="cat">
          <thead><tr><th>Symbol</th><th>Name</th><th class="cat-sort" id="catSortScore">Score &#9662;</th><th>Startingale</th><th>Live price</th></tr></thead>
          <tbody id="catBody"></tbody>
        </table>
      </div>
      <div class="cat-empty" id="catEmpty">loading catalog...</div>
    </div>
  </div>

  <div class="card" id="previewCard" style="display:none">
    <div class="card-head">
      <h2 id="pvTitle">Sequence preview</h2>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap" id="pvChips"></div>
    </div>
    <div class="card-body">
      <form class="controls" id="startForm">
        <div class="field"><label for="symbol">Symbol</label><input id="symbol" value="BTC" autocomplete="off"></div>
        <div class="field"><label for="budget">Budget (USD)</label><input id="budget" value="1000" inputmode="decimal" autocomplete="off"></div>
        <button class="tab" id="pvRefresh" type="button">Preview</button>
        <button class="primary" id="startBtn" type="submit">Start this sequence</button>
      </form>

      <div style="margin-top:12px;border-top:1px solid rgba(60,231,252,0.12);padding-top:12px">
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);cursor:pointer">
          <input type="checkbox" id="customToggle"> Edit the structure myself (custom sequence)
        </label>
        <div id="customFields" style="display:none;margin-top:10px">
          <div class="controls">
            <div class="field"><label for="cDelta">Delta price (5-15%)</label><input id="cDelta" inputmode="decimal" autocomplete="off" style="width:130px" min="5" max="15"></div>
            <div class="field"><label for="cRounds">Rounds</label><select id="cRounds" class="cat-filter" style="width:90px"><option value="4">4</option><option value="5">5</option></select></div>
            <div class="field" style="flex:1"><label for="cMult" id="cMultLabel">Multipliers (quantities)</label><input id="cMult" autocomplete="off" style="width:100%;min-width:200px"></div>
            <button class="tab" id="cReset" type="button">Reset to Tradingale</button>
          </div>
          <p style="margin-top:8px;font-size:10px;color:var(--faint)">
            Multipliers set how QUANTITIES grow from one level to the next, never the amount spent; the deeper levels are then scaled together so the whole budget is deployed. The same guardrails apply: an underfunded custom ladder is refused with its budget floor.
          </p>
        </div>
      </div>
      <div class="msg" id="startMsg"></div>
      <div id="pvMeta" style="margin-top:10px;font-size:11px;color:var(--muted)"></div>
      <div class="ladder" id="pvLadder" style="margin-top:14px"></div>
      <p style="margin-top:10px;font-size:10px;color:var(--faint)">
        Descriptive model structure at the capital shown. Outcomes are arithmetic, before fees and slippage. Not investment advice.
        The runner refuses underfunded ladders and surfaces the computed budget floor instead of placing a distorted one.
      </p>
    </div>
  </div>

  </section>

  <section id="pageDashboard" style="display:none">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
      <span class="chip" id="dashCount">0 active</span>
      <span style="font-size:10px;color:var(--faint)">Active sequences only. Finished ones move to the Journal.</span>
    </div>
    <div id="dashChecks" style="font-size:11px;color:var(--muted);margin:-6px 0 14px"></div>
    <div id="sequences"></div>
  </section>

  <section id="pageJournal" style="display:none">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
      <button class="tab active" id="jTabMetrics" type="button">Metrics</button>
      <button class="tab" id="jTabHistory" type="button">History</button>
      <span style="flex:1"></span>
      <button class="tab active" id="jScopeAll" type="button">All</button>
      <button class="tab" id="jScopeLive" type="button">Live</button>
      <button class="tab" id="jScopePaper" type="button">Simulated</button>
    </div>

    <div id="jPaneMetrics">
      <div class="card">
        <div class="card-head">
          <h2>Performance</h2>
          <button class="tab" id="jExpand" type="button">View more metrics &#9662;</button>
        </div>
        <div class="card-body">
          <div class="stats" id="jHeadline"></div>
          <div id="jDetail" style="display:none"></div>
          <p style="margin-top:10px;font-size:10px;color:var(--faint)" id="jScopeNote"></p>
        </div>
      </div>
    </div>

    <div id="jPaneHistory" style="display:none">
      <div class="card">
        <div class="card-head">
          <h2>Sequence history</h2>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <span class="chip" id="jCount">0</span>
            <button class="tab" id="clearPaper" type="button">Clear finished simulated</button>
          </div>
        </div>
        <div class="card-body">
          <div id="jRows"></div>
          <div class="cat-empty" id="jEmpty">loading journal...</div>
          <p style="margin-top:10px;font-size:10px;color:var(--faint)">
            Realized figures come from this runner's own fill history, on the portion actually sold, before fees and slippage.
            Simulated results do not represent actual trading. Live sequences are kept permanently and cannot be deleted.
          </p>
        </div>
      </div>
    </div>
  </section>

  <section id="pageKeys" style="display:none">
  <div class="keys-line" id="keysLine"></div>

  <div class="card">
    <div class="card-head"><h2>Settings</h2><span class="chip" id="modeChip"></span></div>
    <div class="card-body">
      <form class="controls" id="settingsForm">
        <div class="field"><label for="cycleMin">Reconciliation interval (minutes)</label><input id="cycleMin" inputmode="numeric" autocomplete="off" style="width:170px"></div>
        <button class="primary" id="settingsBtn" type="submit">Save</button>
      </form>
      <div class="msg" id="settingsMsg"></div>
      <p style="margin-top:10px;font-size:10px;color:var(--faint)">
        How often the runner reconciles open sequences with the venue (orders and public prices). It does not change your Tradingale data usage.
      </p>
      <div style="margin-top:14px;border-top:1px solid rgba(60,231,252,0.12);padding-top:12px">
        <p style="font-size:12px;color:var(--muted)"><b>Paper or live?</b> <span id="modeExplain"></span></p>
        <p style="margin-top:6px;font-size:10px;color:var(--faint)">
          Switching to live is deliberately NOT a button here: no web page, and nothing you save in this UI, can make the runner place real orders.
          Stop the server and relaunch it with <code style="color:var(--cyan)">RUNNER_MODE=live</code> in its environment (a service variable on Railway).
          Live also requires the matching exchange keys, and paper stays the default everywhere else.
        </p>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head"><h2>API keys</h2><span class="chip">write-only</span></div>
    <div class="card-body">
      <div class="cat-note">
        Values are saved to this deployment's local keys file (owner-only), never displayed again, never logged, never served.
        Configuring keys does NOT switch to live: live requires relaunching with RUNNER_MODE=live.
        Over the network this form requires RUNNER_PASSWORD; otherwise use it from the machine itself.
        Bonus: with Alpaca keys saved, US stock prices upgrade from the delayed feed to Alpaca live data.
        On Railway, mount a volume (RUNNER_STATE_DIR) so saved keys survive redeploys — or set them as service variables instead.
      </div>
      <form id="keysForm" autocomplete="off">
        <div class="keygroup">
          <div class="keygroup-head">
            <div><b>Tradingale data</b> <span class="keygroup-sub">REST API + MCP server — required for scores and sequences</span></div>
            <span class="kstatus" id="stTgl">checking</span>
          </div>
          <div class="controls">
            <div class="field" style="flex:1"><label for="kTgl">API token</label><input id="kTgl" type="password" placeholder="not set" autocomplete="new-password" style="width:100%;min-width:220px"></div>
          </div>
        </div>

        <div class="keygroup">
          <div class="keygroup-head">
            <div><b>Crypto</b> <span class="keygroup-sub">Kraken — live crypto execution</span></div>
            <span class="kstatus" id="stKraken">checking</span>
          </div>
          <div class="controls">
            <div class="field"><label for="kKk">API key</label><input id="kKk" type="password" placeholder="not set" autocomplete="new-password"></div>
            <div class="field"><label for="kKs">API secret</label><input id="kKs" type="password" placeholder="not set" autocomplete="new-password"></div>
          </div>
        </div>

        <div class="keygroup">
          <div class="keygroup-head">
            <div><b>Stocks</b> <span class="keygroup-sub">Alpaca — live US stock execution, and live stock prices</span></div>
            <span class="kstatus" id="stAlpaca">checking</span>
          </div>
          <div class="controls">
            <div class="field"><label for="kAk">API key id</label><input id="kAk" type="password" placeholder="not set" autocomplete="new-password"></div>
            <div class="field"><label for="kAs">API secret key</label><input id="kAs" type="password" placeholder="not set" autocomplete="new-password"></div>
          </div>
        </div>

        <button class="primary" id="keysBtn" type="submit" style="margin-top:12px">Save keys</button>
      </form>
      <div class="msg" id="keysMsg"></div>
      <p style="margin-top:10px;font-size:10px;color:var(--faint)">
        Exchange keys must be trade-only (never withdrawal permission), ideally IP-allowlisted. Your keys, your account, your sole responsibility.
      </p>
    </div>
  </div>
  </section>

  <footer class="page">
    <p>Descriptive model structure at the capital shown. Outcomes are arithmetic, before fees and slippage. Not investment advice; you alone decide and execute on your own exchange.</p>
    <p>Simulated results do not represent actual trading. Martingale structures concentrate risk by design and trading involves significant risk of loss.</p>
    <p>Your keys, your account, your sole responsibility. Keys stay in this deployment's environment; Tradingale never sees them.</p>
  </footer>
</div>

<script>
(function () {
  'use strict';
  var LEVEL_NAMES = ['Entry Level', 'Second Level', 'Third Level', 'Fourth Level', 'Fifth Level', 'Sixth Level'];

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function fmtPrice(value) {
    if (value === null || value === undefined || isNaN(value)) return '?';
    var abs = Math.abs(value);
    var decimals = abs >= 1000 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
    return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  function fmtQty(value) {
    if (value === null || value === undefined || isNaN(value)) return '?';
    return value.toLocaleString('en-US', { maximumFractionDigits: 6 });
  }

  function stat(key, value) {
    var s = el('div', 'stat');
    s.appendChild(el('div', 'k', key));
    var v = el('div', 'v mono', value);
    s.appendChild(v);
    return s;
  }

  function phaseChip(phase) {
    var cls = 'chip';
    if (phase === 'halted') cls += ' chip-halted';
    if (phase === 'complete') cls += ' chip-complete';
    return el('span', cls, phase);
  }

  function tile(kind, title, price, sub) {
    var t = el('div', 'tile tile-' + kind);
    t.appendChild(el('div', 't', title));
    t.appendChild(el('div', 'p mono', price));
    if (sub) t.appendChild(el('div', 's mono', sub));
    return t;
  }

  function renderLevel(seq, level, idx) {
    var wrapper = el('div', 'level');
    var isEntry = idx === 0;
    if (idx > 0) wrapper.appendChild(el('div', 'rail'));

    var coin = el('div', 'coin' + (isEntry ? ' entry' : ''));
    var inner = el('div', 'in');
    inner.appendChild(el('div', 'n', String(level.level)));
    var depth = (idx * seq.deltaPrice * 100).toFixed(1);
    inner.appendChild(el('div', 'd mono', isEntry ? 'ENTRY' : '-' + depth + '%'));
    coin.appendChild(inner);
    wrapper.appendChild(coin);

    var filled = seq.deepestFilledLevel >= level.level;
    var card = el('div', 'lvl-card' + (isEntry ? ' entry' : '') + (filled ? ' filled' : ''));

    var head = el('div', 'lvl-head');
    var name = LEVEL_NAMES[idx] || 'Level ' + level.level;
    head.appendChild(el('div', 'lvl-name', name + (filled ? ' (reached)' : '')));
    var cost = el('div', 'lvl-cost');
    cost.appendChild(document.createTextNode('Cost '));
    var costB = el('b', 'mono', '$' + fmtPrice(level.cost));
    cost.appendChild(costB);
    head.appendChild(cost);
    card.appendChild(head);

    var totalCost = 0;
    for (var i = 0; i <= idx; i++) totalCost += seq.levels[i].cost;
    var totalRevenue = level.cumulativeQuantity * level.exitPrice;
    var outcomeUsd = totalRevenue - totalCost;
    var outcomePct = seq.budget > 0 ? (outcomeUsd / seq.budget) * 100 : 0;

    var tiles = el('div', 'tiles');
    tiles.appendChild(tile('buy', 'MODEL BUY LEVEL', '$' + fmtPrice(level.buyPrice), '+' + fmtQty(level.quantity) + ' tokens'));
    tiles.appendChild(tile('exit', 'MODEL EXIT LEVEL', '$' + fmtPrice(level.exitPrice), fmtQty(level.cumulativeQuantity) + ' total'));
    tiles.appendChild(tile('outcome', 'OUTCOME IF REACHED', '+' + outcomePct.toFixed(2) + '%', '+$' + outcomeUsd.toFixed(2)));
    card.appendChild(tiles);
    wrapper.appendChild(card);
    return wrapper;
  }

  function renderSequence(seq) {
    var isPaper = seq.venue === 'paper';
    var card = el('div', 'card ' + (isPaper ? 'paper' : 'livecard'));

    var head = el('div', 'card-head');
    var title = el('h2');
    var sym = el('span');
    sym.style.fontWeight = '900';
    sym.textContent = seq.symbol;
    title.appendChild(sym);
    title.appendChild(document.createTextNode(' Martingale Sequence'));
    head.appendChild(title);

    var chips = el('div');
    chips.style.display = 'flex';
    chips.style.gap = '6px';
    chips.style.alignItems = 'center';
    chips.style.flexWrap = 'wrap';
    chips.appendChild(el('span', 'chip mono', '$' + fmtPrice(seq.budget)));
    chips.appendChild(el('span', 'chip', seq.totalLevels + ' rounds'));
    chips.appendChild(el('span', 'chip ' + (isPaper ? 'chip-paper' : 'chip-live'),
      isPaper ? 'SIMULATED (paper)' : 'REAL ORDERS (' + seq.venue + ')'));
    chips.appendChild(phaseChip(seq.phase));
    if (seq.phase === 'running') {
      var checkBtn = el('button', 'tab', 'Check now');
      checkBtn.type = 'button';
      checkBtn.addEventListener('click', function () { checkNow(seq.sequenceId, this); });
      chips.appendChild(checkBtn);
      var resyncBtn = el('button', 'tab', 'Resync sell');
      resyncBtn.type = 'button';
      resyncBtn.addEventListener('click', function () { resyncSell(seq.sequenceId, this); });
      chips.appendChild(resyncBtn);
      var stopBtn = el('button', 'stop', 'Stop');
      stopBtn.type = 'button';
      stopBtn.addEventListener('click', function () { stopSequence(seq.sequenceId, false); });
      chips.appendChild(stopBtn);
      var reverseBtn = el('button', 'stop', 'Stop + reverse');
      reverseBtn.type = 'button';
      reverseBtn.addEventListener('click', function () { stopSequence(seq.sequenceId, true); });
      chips.appendChild(reverseBtn);
    }
    head.appendChild(chips);
    card.appendChild(head);

    var body = el('div', 'card-body');

    if (seq.haltReason) {
      body.appendChild(el('p', 'halt-note', 'Halted: ' + seq.haltReason +
        (seq.venue === 'kraken' ? ' Cancel your open orders on Kraken yourself.' : '')));
    }

    var stats = el('div', 'stats');
    stats.appendChild(stat('Phase', seq.phase));
    stats.appendChild(stat('Level reached', seq.deepestFilledLevel + ' / ' + seq.totalLevels));
    stats.appendChild(stat('Budget', '$' + fmtPrice(seq.budget)));
    stats.appendChild(stat('Live price', seq.lastPrice === null ? 'waiting' : '$' + fmtPrice(seq.lastPrice)));
    stats.appendChild(stat('Venue', seq.venue === 'paper' ? 'paper (simulated)' : seq.venue + ' (live)'));
    stats.appendChild(stat('Last check', seq.lastCycleAt ? new Date(seq.lastCycleAt).toLocaleTimeString() : 'not yet'));
    body.appendChild(stats);

    var ladder = el('div', 'ladder');
    for (var i = 0; i < seq.levels.length; i++) ladder.appendChild(renderLevel(seq, seq.levels[i], i));
    body.appendChild(ladder);
    card.appendChild(body);

    var foot = el('div', 'foot',
      'Descriptive model structure at the capital shown. Outcomes are arithmetic, before fees and slippage. ' +
      'Not investment advice; you alone decide and execute on your own exchange. Sequence started ' +
      new Date(seq.createdAt).toLocaleString() +
      (seq.lastCycleAt ? '; last reconciliation ' + new Date(seq.lastCycleAt).toLocaleString() : '') + '.');
    card.appendChild(foot);
    return card;
  }

  function render(state) {
    lastState = state;
    var cyc = document.getElementById('cycleMin');
    if (cyc && document.activeElement !== cyc) cyc.value = String(Math.round(state.cycleMs / 60000));
    var chip = document.getElementById('modeChip');
    chip.textContent = state.mode === 'live' ? 'LIVE mode' : 'paper mode (default)';
    chip.className = 'chip ' + (state.mode === 'live' ? 'chip-live' : 'chip-paper');
    var explain = document.getElementById('modeExplain');
    if (explain) {
      explain.textContent = state.mode === 'live'
        ? 'This runner is in LIVE mode: sequences you start place REAL orders on your own exchange account.'
        : 'This runner is in PAPER mode: every sequence is simulated against live public prices. Nothing reaches an exchange.';
    }
    var meta = 'mode ' + state.mode +
      (state.mode === 'live' ? (state.keysPresent ? ', Kraken keys detected' : ', Kraken keys MISSING') : '') +
      ', refreshed ' + new Date().toLocaleTimeString();
    document.getElementById('topMeta').textContent = meta;
    renderKeys(state.keys || {});

    // The dashboard is the live cockpit: ACTIVE sequences only. Anything
    // finished belongs to the Journal, with its metrics.
    var activeSeqs = state.sequences.filter(function (s) { return s.phase === 'running'; });
    var simCount = activeSeqs.filter(function (s) { return s.venue === 'paper'; }).length;
    document.getElementById('dashCount').textContent =
      activeSeqs.length + ' active (' + simCount + ' simulated, ' + (activeSeqs.length - simCount) + ' live)';

    // Automatic checks: prove they are running, and say when the next is due.
    var checkLine = document.getElementById('dashChecks');
    if (checkLine) {
      var last = state.lastPassAt ? new Date(state.lastPassAt).toLocaleTimeString() : 'not yet';
      var nextIn = state.nextPassAt ? Math.max(0, Math.round((Date.parse(state.nextPassAt) - Date.now()) / 60000)) : null;
      checkLine.textContent = state.checking
        ? 'Automatic checks: running now...'
        : 'Automatic checks every ' + Math.round(state.cycleMs / 60000) + ' min · last ' + last +
          (nextIn === null ? '' : ' · next in ~' + nextIn + ' min');
    }

    var host = document.getElementById('sequences');
    host.textContent = '';
    if (!activeSeqs.length) {
      var done = state.sequences.length;
      host.appendChild(el('div', 'empty', done
        ? 'No active sequence. ' + done + ' finished one(s) are in the Journal.'
        : 'No sequences yet. Pick an instrument on the Scoreboard; paper mode fills against live public prices with zero keys.'));
      return;
    }
    for (var i = 0; i < activeSeqs.length; i++) host.appendChild(renderSequence(activeSeqs[i]));
  }

  function renderKeys(keys) {
    // Status per group + masked placeholders: a configured secret shows dots,
    // never its value (the server only ever sends booleans).
    function mark(id, ok, inputs) {
      var node = document.getElementById(id);
      if (node) {
        node.textContent = ok ? 'verified ✓' : 'not set';
        node.className = 'kstatus' + (ok ? ' on' : '');
      }
      (inputs || []).forEach(function (inputId) {
        var input = document.getElementById(inputId);
        if (input && !input.value) input.placeholder = ok ? '••••••••••••  (saved)' : 'not set';
      });
    }
    mark('stTgl', !!keys.tradingale, ['kTgl']);
    mark('stKraken', !!keys.kraken, ['kKk', 'kKs']);
    mark('stAlpaca', !!keys.alpaca, ['kAk', 'kAs']);

    var line = document.getElementById('keysLine');
    if (!line) return;
    line.textContent = '';
    var hint = el('span', 'keys-hint');
    hint.appendChild(document.createTextNode('Keys stay on this machine. You can also set them with '));
    hint.appendChild(el('code', null, 'npm run runner -- keys'));
    hint.appendChild(document.createTextNode('. They are never displayed again, logged, or served.'));
    line.appendChild(hint);
  }

  var CATALOG = [];
  var catSortDesc = true;
  var activeTab = 'crypto';
  var lastState = null;

  function sgClass(word) { return 'sg-' + String(word).toLowerCase(); }

  function setTab(tab) {
    activeTab = tab;
    document.getElementById('tabCryptos').className = 'tab' + (tab === 'crypto' ? ' active' : '');
    document.getElementById('tabStocks').className = 'tab' + (tab === 'stock' ? ' active' : '');
    renderCatalog();
  }

  function tabCounts() {
    var c = 0, s = 0;
    CATALOG.forEach(function (r) { if (r.assetType === 'stock') s++; else c++; });
    document.getElementById('tabCryptos').textContent = 'Cryptos (' + c + ')';
    document.getElementById('tabStocks').textContent = 'Stocks (' + s + ')';
  }

  function renderCatalog() {
    var body = document.getElementById('catBody');
    var empty = document.getElementById('catEmpty');
    var q = (document.getElementById('catFilter').value || '').trim().toLowerCase();
    var rows = CATALOG.filter(function (r) {
      if ((r.assetType === 'stock' ? 'stock' : 'crypto') !== activeTab) return false;
      return !q || r.symbol.toLowerCase().indexOf(q) >= 0 || String(r.name || '').toLowerCase().indexOf(q) >= 0;
    });
    rows.sort(function (a, b) { return catSortDesc ? b.score - a.score : a.score - b.score; });
    body.textContent = '';
    if (!rows.length) {
      empty.textContent = CATALOG.length ? 'No match.' : 'Catalog empty (check your Tradingale token and plan scope).';
      return;
    }
    empty.textContent = '';
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      var tdSym = el('td', 'cat-sym mono');
      tdSym.textContent = r.symbol;
      tr.appendChild(tdSym);
      tr.appendChild(el('td', null, r.name || r.symbol));
      tr.appendChild(el('td', 'cat-score mono', Number(r.score).toFixed(2)));
      tr.appendChild(el('td', sgClass(r.startingale), r.startingale));
      tr.appendChild(el('td', 'mono', r.price === null || r.price === undefined ? '—' : '$' + fmtPrice(r.price)));
      tr.addEventListener('click', function () { pickInstrument(r.symbol, r.assetType); });
      body.appendChild(tr);
    });
  }

  function pickInstrument(symbol) {
    document.getElementById('symbol').value = symbol;
    document.getElementById('previewCard').style.display = '';
    document.getElementById('previewCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    loadPreview();
  }

  var previewTimer = null;

  // Custom structure (site parity): only sent when the user opted in.
  function customQuery() {
    if (!document.getElementById('customToggle').checked) return '';
    var q = '';
    var d = Number(document.getElementById('cDelta').value);
    var r = Number(document.getElementById('cRounds').value);
    var m = (document.getElementById('cMult').value || '').trim();
    if (Number.isFinite(d) && d > 0) q += '&deltaPrice=' + encodeURIComponent(d / 100); // UI is %, engine is a fraction
    if (Number.isFinite(r) && r >= 2) q += '&nbRounds=' + encodeURIComponent(r);
    if (m) q += '&multipliers=' + encodeURIComponent(m.replace(/\\s+/g, ''));
    return q;
  }

  function customBody() {
    if (!document.getElementById('customToggle').checked) return undefined;
    var d = Number(document.getElementById('cDelta').value);
    var r = Number(document.getElementById('cRounds').value);
    var m = (document.getElementById('cMult').value || '').trim();
    var out = {};
    if (Number.isFinite(d) && d > 0) out.deltaPrice = d / 100;
    if (Number.isFinite(r) && r >= 2) out.nbRounds = r;
    if (m) out.multipliers = m.split(',').map(Number).filter(function (n) { return Number.isFinite(n) && n > 0; });
    return Object.keys(out).length ? out : undefined;
  }

  function loadPreview() {
    var symbol = (document.getElementById('symbol').value || '').trim().toUpperCase();
    var budget = Number(document.getElementById('budget').value);
    if (!symbol) return;
    document.getElementById('pvTitle').textContent = symbol + ' sequence preview';
    document.getElementById('pvMeta').textContent = 'computing the model structure at your budget...';
    fetch('/api/preview?symbol=' + encodeURIComponent(symbol) + '&budget=' + encodeURIComponent(budget) + customQuery())
      .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }); })
      .then(function (r) {
        if (!(r.ok && r.body.ok)) {
          document.getElementById('pvMeta').textContent = (r.body && r.body.error) || 'preview failed';
          document.getElementById('pvLadder').textContent = '';
          document.getElementById('pvChips').textContent = '';
          return;
        }
        renderPreview(r.body.preview);
      })
      .catch(function () { document.getElementById('pvMeta').textContent = 'preview failed: server unreachable'; });
  }

  function renderPreview(p) {
    var chips = document.getElementById('pvChips');
    chips.textContent = '';
    document.getElementById('pvTitle').textContent = p.symbol + ' — ' + (p.name || p.symbol);
    chips.appendChild(el('span', 'chip mono', 'Score ' + (p.martingaleScore !== undefined ? Number(p.martingaleScore).toFixed(2) : '?')));
    chips.appendChild(el('span', 'chip', p.assetType));
    chips.appendChild(el('span', 'chip mono', 'entry $' + fmtPrice(p.entryPrice)));
    if (p.custom) chips.appendChild(el('span', 'chip', 'custom structure'));

    // Mirror the structure actually used into the custom fields, so opening
    // the editor starts from Tradingale's values instead of blanks. The
    // editor's own bounds apply (4 or 5 rounds, 5-15% spacing), so a
    // tighter Tradingale delta is raised to the editable minimum here.
    if (p.params && !document.getElementById('customToggle').checked) {
      var pct = Math.min(15, Math.max(5, p.params.deltaPrice * 100));
      document.getElementById('cDelta').value = pct.toFixed(2);
      document.getElementById('cRounds').value = p.params.nbRounds >= 5 ? '5' : '4';
      document.getElementById('cMult').value = p.params.multipliers.join(',');
      syncMultipliers();
    }

    var meta = document.getElementById('pvMeta');
    if (p.problems && p.problems.length) {
      meta.textContent = 'Refused as-is (budget_min ~$' + p.budgetMin + '): ' + p.problems.join('; ');
      meta.style.color = '#fda4af';
    } else {
      meta.textContent = 'Budget $' + fmtPrice(p.budget) + ' (floor ~$' + p.budgetMin + '), ' + p.levels.length + ' levels, live entry $' + fmtPrice(p.entryPrice) + '. Review the ladder, then Start.';
      meta.style.color = '';
    }
    if (p.notes && p.notes.length) {
      meta.textContent += '  [adjusted: ' + p.notes.join('; ') + ']';
    }

    var fake = { deltaPrice: p.deltaPrice, deepestFilledLevel: 0, levels: p.levels, budget: p.budget };
    var host = document.getElementById('pvLadder');
    host.textContent = '';
    for (var i = 0; i < p.levels.length; i++) host.appendChild(renderLevel(fake, p.levels[i], i));

    // Live-mode key guard: surface the missing key before the user hits Start.
    if (lastState && lastState.mode === 'live' && lastState.keys) {
      var needs = p.assetType === 'stock' ? !lastState.keys.alpaca : !lastState.keys.kraken;
      if (needs) {
        showMsg('err', 'Live mode: configure your ' + (p.assetType === 'stock' ? 'Alpaca' : 'Kraken') + ' keys first (API keys card below), then Start.');
      }
    }
  }

  function fetchCatalog(force) {
    return fetch('/api/catalog' + (force ? '?refresh=1' : ''), { headers: { 'Accept': 'application/json' } })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (body && body.ok && body.instruments) {
          CATALOG = body.instruments;
          tabCounts();
          renderCatalog();
          // Cold start: the very first call returns rows before the bulk
          // price snapshot has landed. Poll briefly instead of leaving a
          // priceless scoreboard on screen.
          var priced = CATALOG.filter(function (r) { return r.price; }).length;
          if (!priced && !force) {
            document.getElementById('catEmpty').textContent = 'loading live prices...';
            setTimeout(function () { fetchCatalog(); }, 2500);
          }
        }
        else { document.getElementById('catEmpty').textContent = (body && body.error) || 'Catalog unavailable.'; }
      })
      .catch(function () { document.getElementById('catEmpty').textContent = 'Catalog unavailable (server unreachable).'; });
  }

  function refresh() {
    fetch('/api/state', { headers: { 'Accept': 'application/json' } })
      .then(function (res) { return res.json(); })
      .then(function (state) { if (state && state.sequences) render(state); })
      .catch(function () {
        document.getElementById('topMeta').textContent = 'state unavailable, retrying';
      });
  }

  function showMsg(kind, text) {
    var box = document.getElementById('startMsg');
    box.className = 'msg ' + kind;
    box.textContent = text;
  }

  document.getElementById('startForm').addEventListener('submit', function (event) {
    event.preventDefault();
    var btn = document.getElementById('startBtn');
    btn.disabled = true;
    showMsg('ok', 'starting...');
    fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: document.getElementById('symbol').value,
        budget: Number(document.getElementById('budget').value),
        custom: customBody(),
      }),
    })
      .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); })
      .then(function (result) {
        if (result.ok && result.body.ok) {
          showMsg('ok', 'Started ' + result.body.summary.sequenceId + ' at $' + fmtPrice(result.body.summary.entryPrice) +
            ' (' + result.body.summary.levels + ' levels).');
          refresh();
        } else {
          showMsg('err', result.body && result.body.error ? result.body.error : 'start failed');
        }
      })
      .catch(function () { showMsg('err', 'start failed: server unreachable'); })
      .then(function () { btn.disabled = false; });
  });

  function postAction(url, id, btn, label) {
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sequenceId: id }) })
      .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }); })
      .then(function (r) {
        if (!(r.ok && r.body.ok)) window.alert((r.body && r.body.error) || 'action failed');
        refresh();
      })
      .catch(function () { window.alert('action failed: server unreachable'); })
      .then(function () { if (btn) { btn.disabled = false; btn.textContent = label; } });
  }

  function checkNow(id, btn) { postAction('/api/check', id, btn, 'Check now'); }

  function resyncSell(id, btn) {
    if (!window.confirm('Resync the sell for ' + id + '? The resting sell is canceled and re-placed from the plan for the level actually reached. The buy ladder is untouched.')) return;
    postAction('/api/resync-sell', id, btn, 'Resync sell');
  }

  function deleteSequence(id) {
    if (!window.confirm('Delete ' + id + ' from the dashboard? The sequence is finished; this only removes its file.')) return;
    fetch('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sequenceId: id }) })
      .then(function (res) { return res.json(); })
      .then(function (body) { if (!body.ok) window.alert(body.error || 'delete failed'); refresh(); fetchJournal(); })
      .catch(function () { window.alert('delete failed: server unreachable'); });
  }

  function clearFinished() {
    if (!window.confirm('Remove finished SIMULATED sequences from the dashboard? Running and live sequences are kept.')) return;
    fetch('/api/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ finished: true }) })
      .then(function (res) { return res.json(); })
      .then(function (body) { if (body.ok) window.alert('Removed ' + body.removed + ' sequence(s).'); refresh(); fetchJournal(); })
      .catch(function () { window.alert('cleanup failed: server unreachable'); });
  }

  function stopSequence(id, reverse) {
    var msg = reverse
      ? 'Stop ' + id + ' AND market-sell your position? This cancels the open orders and sells everything you have accumulated, at market, to exit completely.'
      : 'Stop ' + id + '? This cancels the open orders and KEEPS the position you have accumulated.';
    if (!window.confirm(msg)) return;
    fetch('/api/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sequenceId: id, reverse: reverse }),
    })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (body.reversed) window.alert('Reversed: market-sold ' + body.reversedQuantity + '. Orders canceled: ' + body.canceledOrders + '.');
        else if (reverse) window.alert('Nothing accumulated to reverse. Orders canceled: ' + body.canceledOrders + '.');
        else window.alert('Stopped. Orders canceled: ' + body.canceledOrders + '. Position kept.');
        if (body.warning) window.alert(body.warning);
        refresh();
      })
      .catch(function () { window.alert('stop failed: server unreachable'); });
  }

  document.getElementById('keysForm').addEventListener('submit', function (event) {
    event.preventDefault();
    var btn = document.getElementById('keysBtn');
    var box = document.getElementById('keysMsg');
    var payload = {};
    var map = { kTgl: 'TRADINGALE_TOKEN', kKk: 'KRAKEN_API_KEY', kKs: 'KRAKEN_API_SECRET', kAk: 'ALPACA_API_KEY_ID', kAs: 'ALPACA_API_SECRET_KEY' };
    Object.keys(map).forEach(function (id) {
      var v = document.getElementById(id).value;
      if (v && v.trim()) payload[map[id]] = v.trim();
    });
    if (!Object.keys(payload).length) { box.className = 'msg err'; box.textContent = 'Nothing to save.'; return; }
    btn.disabled = true;
    fetch('/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }); })
      .then(function (r) {
        if (r.ok && r.body.ok) {
          box.className = 'msg ok';
          box.textContent = 'Saved (write-only; values will not be shown again). Live still requires relaunching with RUNNER_MODE=live.';
          Object.keys(map).forEach(function (id) { document.getElementById(id).value = ''; });
          renderKeys(r.body.keys || {});
          fetchCatalog();
        } else {
          box.className = 'msg err';
          box.textContent = (r.body && r.body.error) || 'save failed';
        }
      })
      .catch(function () { box.className = 'msg err'; box.textContent = 'save failed: server unreachable'; })
      .then(function () { btn.disabled = false; });
  });

  document.getElementById('catFilter').addEventListener('input', renderCatalog);
  document.getElementById('catSortScore').addEventListener('click', function () {
    catSortDesc = !catSortDesc;
    this.textContent = 'Score ' + (catSortDesc ? '▾' : '▴');
    renderCatalog();
  });
  function showPage(name) {
    var pages = { scoreboard: 'pageScoreboard', dashboard: 'pageDashboard', journal: 'pageJournal', keys: 'pageKeys' };
    var navs = { scoreboard: 'navScoreboard', dashboard: 'navDashboard', journal: 'navJournal', keys: 'navKeys' };
    Object.keys(pages).forEach(function (k) {
      document.getElementById(pages[k]).style.display = k === name ? '' : 'none';
      document.getElementById(navs[k]).className = 'nav-tab' + (k === name ? ' active' : '');
    });
    if (name === 'journal') fetchJournal();
  }

  var journalScope = 'all';

  function fmtDur(ms) {
    if (!ms) return '—';
    var h = ms / 3600000;
    if (h < 24) return h.toFixed(1) + ' h';
    return (h / 24).toFixed(1) + ' d';
  }

  function setScope(scope) {
    journalScope = scope;
    document.getElementById('jScopeAll').className = 'tab' + (scope === 'all' ? ' active' : '');
    document.getElementById('jScopeLive').className = 'tab' + (scope === 'live' ? ' active' : '');
    document.getElementById('jScopePaper').className = 'tab' + (scope === 'paper' ? ' active' : '');
    fetchJournal();
  }

  function fetchJournal() {
    fetch('/api/journal?scope=' + journalScope, { headers: { 'Accept': 'application/json' } })
      .then(function (res) { return res.json(); })
      .then(function (body) { if (body && body.ok) renderJournal(body); })
      .catch(function () { document.getElementById('jEmpty').textContent = 'journal unavailable'; });
  }

  function money(v) { return (v >= 0 ? '+$' : '-$') + fmtPrice(Math.abs(v)); }
  function pct(v) { return (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%'; }

  function section(host, title) {
    host.appendChild(el('div', 'jsection-title', title));
    var grid = el('div', 'stats');
    host.appendChild(grid);
    return grid;
  }

  function renderJournal(body) {
    var m = body.metrics;

    // Headline: the three cards the site shows before you expand.
    var head = document.getElementById('jHeadline');
    head.textContent = '';
    head.appendChild(stat('Total performance', money(m.totalRealized)));
    head.appendChild(stat('Efficiency', fmtDur(m.avgDurationMs) + ' avg'));
    head.appendChild(stat('Active portfolio', m.activeCount + ' seq · $' + fmtPrice(m.activeCapital)));

    // Detail: the five sections behind the toggle.
    var d = document.getElementById('jDetail');
    d.textContent = '';

    var g1 = section(d, 'Profit performance');
    g1.appendChild(stat('All time', money(m.totalRealized) + '  (' + pct(m.capitalIncreasePct) + ')'));
    g1.appendChild(stat('This month', money(m.monthlyRealized) + '  (' + pct(m.monthlyPct) + ')'));
    g1.appendChild(stat('Year to date', money(m.ytdRealized) + '  (' + pct(m.ytdPct) + ')'));
    g1.appendChild(stat('Canceled early', money(m.canceledRealized) + '  (' + m.canceledCount + ' seq)'));

    var g2 = section(d, 'Sequence analytics');
    g2.appendChild(stat('Closed sequences', m.closedCount + '  (' + m.completedCount + ' completed)'));
    g2.appendChild(stat('Average per sequence', pct(m.avgPctPerSequence)));
    g2.appendChild(stat('Average duration', fmtDur(m.avgDurationMs)));
    g2.appendChild(stat('Capital efficiency', pct(m.capitalEfficiencyPct)));
    g2.appendChild(stat('Average capital used', '$' + fmtPrice(m.avgCapitalUsed)));

    var g3 = section(d, 'Projections (theoretical)');
    g3.appendChild(stat('Simple annual return', pct(m.projectedAnnualReturnPct)));
    g3.appendChild(stat('Compounded annual', pct(m.compoundedAnnualReturnPct)));
    g3.appendChild(stat('10-year projection', m.tenYearMultiplier ? 'x' + m.tenYearMultiplier.toFixed(0) : '—'));

    var g4 = section(d, 'Risk management');
    g4.appendChild(stat('True win rate', m.winRateDenominator ? m.winRatePct.toFixed(0) + '%  (' + m.winRateNumerator + '/' + m.winRateDenominator + ')' : '—'));
    g4.appendChild(stat('Risk exposure', m.avgRiskExposurePct.toFixed(1) + '%'));
    g4.appendChild(stat('Apex risk ratio', m.apexRiskRatioPct.toFixed(2) + '%  (' + m.maxRoundCount + ')'));
    g4.appendChild(stat('Round efficiency', m.roundEfficiency.toFixed(1)));

    var g5 = section(d, 'Active portfolio');
    g5.appendChild(stat('Live sequences', m.activeCount + '  ($' + fmtPrice(m.activeCapital) + ' deployed)'));
    g5.appendChild(stat('Active exposure', m.activeExposurePct.toFixed(1) + '%'));

    var proj = el('p', null, 'Projections are arithmetic on the observed average sequence: they assume the same average outcome repeats at the same pace. They are not forecasts.');
    proj.style.cssText = 'margin-top:10px;font-size:10px;color:var(--faint)';
    d.appendChild(proj);

    document.getElementById('jScopeNote').textContent = body.scope === 'all'
      ? 'All sequences, simulated and live together. Use the Live / Simulated filters to read them apart.'
      : body.scope === 'live'
        ? 'Live sequences only: real orders on your own account.'
        : 'Simulated sequences only. Simulated results do not represent actual trading.';

    // History: compact rows, details behind the arrow.
    var rows = body.entries || [];
    document.getElementById('jCount').textContent = rows.length + ' sequence(s)';
    var host = document.getElementById('jRows');
    host.textContent = '';
    document.getElementById('jEmpty').textContent = rows.length ? '' : 'No sequences yet.';
    rows.forEach(function (e) {
      var row = el('div', 'jrow');
      var head2 = el('div', 'jrow-head');
      head2.appendChild(el('span', 'jrow-arrow', '▶'));
      head2.appendChild(el('span', 'jrow-sym mono', e.symbol));
      head2.appendChild(el('span', 'jrow-badge ' + (e.live ? 'live' : 'sim'), e.live ? 'LIVE' : 'SIM'));
      head2.appendChild(el('span', null, e.phase));
      head2.appendChild(el('span', 'jrow-spacer'));
      head2.appendChild(el('span', 'mono ' + (e.realized >= 0 ? 'sg-strong' : 'sg-misaligned'), money(e.realized)));
      head2.appendChild(el('span', 'mono', pct(e.realizedPctOnUsed)));
      head2.appendChild(el('span', 'mono', fmtDur(e.durationMs)));
      head2.addEventListener('click', function () { row.className = row.className.indexOf('open') >= 0 ? 'jrow' : 'jrow open'; });
      row.appendChild(head2);

      var body2 = el('div', 'jrow-body');
      var grid = el('div', 'stats');
      grid.appendChild(stat('Sequence', e.sequenceId));
      grid.appendChild(stat('Venue', e.live ? e.venue + ' (real orders)' : 'paper (simulated)'));
      grid.appendChild(stat('Rounds reached', e.roundsReached + ' / ' + e.totalRounds));
      grid.appendChild(stat('Budget', '$' + fmtPrice(e.budget)));
      grid.appendChild(stat('Capital used', '$' + fmtPrice(e.capitalUsed)));
      grid.appendChild(stat('Proceeds', '$' + fmtPrice(e.proceeds)));
      grid.appendChild(stat('Realized', money(e.realized)));
      grid.appendChild(stat('On budget', pct(e.realizedPctOnBudget)));
      if (e.openQuantity > 0) grid.appendChild(stat('Position kept', fmtQty(e.openQuantity) + ' ' + e.symbol));
      grid.appendChild(stat('Started', new Date(e.startedAt).toLocaleString()));
      grid.appendChild(stat('Ended', e.endedAt ? new Date(e.endedAt).toLocaleString() : 'running'));
      body2.appendChild(grid);
      // Simulated runs can be removed; live history is permanent.
      if (!e.live && e.phase !== 'running') {
        var del = el('button', 'stop', 'Delete this simulated run');
        del.type = 'button';
        del.addEventListener('click', function () { deleteSequence(e.sequenceId); });
        body2.appendChild(del);
      } else if (e.live) {
        var note = el('p', null, 'Live sequence: kept permanently, cannot be deleted.');
        note.style.cssText = 'font-size:10px;color:var(--faint);margin-top:6px';
        body2.appendChild(note);
      }
      row.appendChild(body2);
      host.appendChild(row);
    });
  }
  document.getElementById('clearPaper').addEventListener('click', function () { clearFinished(); });
  document.getElementById('navScoreboard').addEventListener('click', function () { showPage('scoreboard'); });
  document.getElementById('navDashboard').addEventListener('click', function () { showPage('dashboard'); });
  document.getElementById('navJournal').addEventListener('click', function () { showPage('journal'); });
  document.getElementById('navKeys').addEventListener('click', function () { showPage('keys'); });
  function journalPane(which) {
    document.getElementById('jPaneMetrics').style.display = which === 'metrics' ? '' : 'none';
    document.getElementById('jPaneHistory').style.display = which === 'history' ? '' : 'none';
    document.getElementById('jTabMetrics').className = 'tab' + (which === 'metrics' ? ' active' : '');
    document.getElementById('jTabHistory').className = 'tab' + (which === 'history' ? ' active' : '');
  }
  document.getElementById('jTabMetrics').addEventListener('click', function () { journalPane('metrics'); });
  document.getElementById('jTabHistory').addEventListener('click', function () { journalPane('history'); });
  document.getElementById('jExpand').addEventListener('click', function () {
    var d = document.getElementById('jDetail');
    var open = d.style.display !== 'none';
    d.style.display = open ? 'none' : '';
    this.innerHTML = open ? 'View more metrics &#9662;' : 'Fewer metrics &#9652;';
  });
  document.getElementById('jScopeAll').addEventListener('click', function () { setScope('all'); });
  document.getElementById('jScopeLive').addEventListener('click', function () { setScope('live'); });
  document.getElementById('jScopePaper').addEventListener('click', function () { setScope('paper'); });

  document.getElementById('catRefresh').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    document.getElementById('catEmpty').textContent = 'refreshing scores and prices...';
    fetchCatalog(true).then(function () { btn.disabled = false; });
  });

  document.getElementById('customToggle').addEventListener('change', function () {
    document.getElementById('customFields').style.display = this.checked ? '' : 'none';
    if (!this.checked) loadPreview();
  });
  document.getElementById('cReset').addEventListener('click', function () {
    document.getElementById('customToggle').checked = false;
    document.getElementById('customFields').style.display = 'none';
    loadPreview();
  });
  // Changing the round count immediately resizes the multiplier list to
  // rounds - 1 (pad with the last value, or trim), so the two fields can
  // never disagree — 5 rounds always shows 4 multipliers.
  function syncMultipliers() {
    var rounds = Number(document.getElementById('cRounds').value) || 4;
    var need = Math.max(0, rounds - 1);
    var list = (document.getElementById('cMult').value || '')
      .split(',').map(function (s) { return Number(s.trim()); })
      .filter(function (n) { return Number.isFinite(n) && n > 0; });
    while (list.length < need) list.push(list.length ? list[list.length - 1] : 2);
    list = list.slice(0, need);
    document.getElementById('cMult').value = list.join(',');
    document.getElementById('cMultLabel').textContent = 'Multipliers (' + need + ' for ' + rounds + ' rounds)';
  }

  document.getElementById('cRounds').addEventListener('change', function () {
    syncMultipliers();
    loadPreview();
  });
  document.getElementById('cDelta').addEventListener('blur', function () {
    var v = Number(this.value);
    if (Number.isFinite(v) && v > 0) this.value = String(Math.min(15, Math.max(5, v)));
  });
  ['cDelta', 'cMult'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', function () {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(loadPreview, 700);
    });
  });

  document.getElementById('tabCryptos').addEventListener('click', function () { setTab('crypto'); });
  document.getElementById('tabStocks').addEventListener('click', function () { setTab('stock'); });
  document.getElementById('pvRefresh').addEventListener('click', loadPreview);
  document.getElementById('budget').addEventListener('input', function () {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(loadPreview, 600);
  });
  document.getElementById('symbol').addEventListener('change', loadPreview);

  document.getElementById('settingsForm').addEventListener('submit', function (event) {
    event.preventDefault();
    var box = document.getElementById('settingsMsg');
    var minutes = Number(document.getElementById('cycleMin').value);
    fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cycleMinutes: minutes }) })
      .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }); })
      .then(function (r) {
        box.className = 'msg ' + (r.ok && r.body.ok ? 'ok' : 'err');
        box.textContent = r.ok && r.body.ok
          ? 'Saved: reconciling every ' + Math.round(r.body.cycleMs / 60000) + ' min.'
          : ((r.body && r.body.error) || 'save failed');
      })
      .catch(function () { box.className = 'msg err'; box.textContent = 'save failed: server unreachable'; });
  });

  refresh();
  setInterval(refresh, 30000);
  fetchCatalog();
  setInterval(fetchCatalog, 60000);
})();
</script>
</body>
</html>
`;
}
