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
    <div id="sequences"></div>
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
      <form class="controls" id="keysForm" autocomplete="off">
        <div class="field"><label for="kTgl">Tradingale token</label><input id="kTgl" type="password" placeholder="unchanged" autocomplete="new-password"></div>
        <div class="field"><label for="kKk">Kraken key</label><input id="kKk" type="password" placeholder="unchanged" autocomplete="new-password"></div>
        <div class="field"><label for="kKs">Kraken secret</label><input id="kKs" type="password" placeholder="unchanged" autocomplete="new-password"></div>
        <div class="field"><label for="kAk">Alpaca key id</label><input id="kAk" type="password" placeholder="unchanged" autocomplete="new-password"></div>
        <div class="field"><label for="kAs">Alpaca secret</label><input id="kAs" type="password" placeholder="unchanged" autocomplete="new-password"></div>
        <button class="primary" id="keysBtn" type="submit">Save keys</button>
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
    var card = el('div', 'card');

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
    chips.appendChild(el('span', 'chip', seq.venue));
    chips.appendChild(phaseChip(seq.phase));
    if (seq.phase === 'running') {
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
    stats.appendChild(stat('Venue', seq.venue === 'kraken' ? 'kraken (live)' : 'paper (simulated)'));
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
    var meta = 'mode ' + state.mode +
      (state.mode === 'live' ? (state.keysPresent ? ', Kraken keys detected' : ', Kraken keys MISSING') : '') +
      ', refreshed ' + new Date().toLocaleTimeString();
    document.getElementById('topMeta').textContent = meta;
    renderKeys(state.keys || {});

    var host = document.getElementById('sequences');
    host.textContent = '';
    if (!state.sequences.length) {
      host.appendChild(el('div', 'empty', 'No sequences yet. Start one above; paper mode fills against live public prices with zero keys.'));
      return;
    }
    for (var i = 0; i < state.sequences.length; i++) host.appendChild(renderSequence(state.sequences[i]));
  }

  function renderKeys(keys) {
    var line = document.getElementById('keysLine');
    line.textContent = '';
    function part(label, ok) {
      var span = el('span');
      span.appendChild(el('b', null, label + ': '));
      span.appendChild(el('span', ok ? 'k-ok' : 'k-absent', ok ? 'configured ✓' : 'absent'));
      return span;
    }
    line.appendChild(part('Tradingale token', !!keys.tradingale));
    line.appendChild(document.createTextNode('  ·  '));
    line.appendChild(part('Kraken', !!keys.kraken));
    line.appendChild(document.createTextNode('  ·  '));
    line.appendChild(part('Alpaca', !!keys.alpaca));
    var hint = el('span', 'keys-hint');
    hint.appendChild(document.createTextNode('  — set them with '));
    hint.appendChild(el('code', null, 'npm run runner -- keys'));
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
        if (body && body.ok && body.instruments) { CATALOG = body.instruments; tabCounts(); renderCatalog(); }
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
    var pages = { scoreboard: 'pageScoreboard', dashboard: 'pageDashboard', keys: 'pageKeys' };
    var navs = { scoreboard: 'navScoreboard', dashboard: 'navDashboard', keys: 'navKeys' };
    Object.keys(pages).forEach(function (k) {
      document.getElementById(pages[k]).style.display = k === name ? '' : 'none';
      document.getElementById(navs[k]).className = 'nav-tab' + (k === name ? ' active' : '');
    });
  }
  document.getElementById('navScoreboard').addEventListener('click', function () { showPage('scoreboard'); });
  document.getElementById('navDashboard').addEventListener('click', function () { showPage('dashboard'); });
  document.getElementById('navKeys').addEventListener('click', function () { showPage('keys'); });

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
