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
</style>
</head>
<body>
${banner}
<div class="wrap">
  <header class="top">
    <div class="logo"><span>Tradingale</span> Runner</div>
    <div class="top-meta" id="topMeta">loading state...</div>
  </header>

  <div class="card">
    <div class="card-head"><h2>Start a sequence</h2><span class="chip" id="modeChip"></span></div>
    <div class="card-body">
      <form class="controls" id="startForm">
        <div class="field"><label for="symbol">Symbol</label><input id="symbol" value="BTC" autocomplete="off"></div>
        <div class="field"><label for="budget">Budget (USD)</label><input id="budget" value="1000" inputmode="decimal" autocomplete="off"></div>
        <button class="primary" id="startBtn" type="submit">Start</button>
      </form>
      <div class="msg" id="startMsg"></div>
      <p style="margin-top:10px;font-size:10px;color:var(--faint)">
        The runner refuses underfunded ladders and surfaces the computed budget floor instead of placing a distorted one.
      </p>
    </div>
  </div>

  <div id="sequences"></div>

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
      stopBtn.addEventListener('click', function () { stopSequence(seq.sequenceId, card); });
      chips.appendChild(stopBtn);
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
    stats.appendChild(stat('Last price', seq.lastPrice === null ? 'waiting' : '$' + fmtPrice(seq.lastPrice)));
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
    var chip = document.getElementById('modeChip');
    chip.textContent = state.mode === 'live' ? 'LIVE mode' : 'paper mode (default)';
    var meta = 'mode ' + state.mode +
      (state.mode === 'live' ? (state.keysPresent ? ', Kraken keys detected' : ', Kraken keys MISSING') : '') +
      ', reconciles every ' + Math.round(state.cycleMs / 60000) + ' min, refreshed ' + new Date().toLocaleTimeString();
    document.getElementById('topMeta').textContent = meta;

    var host = document.getElementById('sequences');
    host.textContent = '';
    if (!state.sequences.length) {
      host.appendChild(el('div', 'empty', 'No sequences yet. Start one above; paper mode fills against live public prices with zero keys.'));
      return;
    }
    for (var i = 0; i < state.sequences.length; i++) host.appendChild(renderSequence(state.sequences[i]));
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

  function stopSequence(id, card) {
    if (!window.confirm('Stop ' + id + '? Nothing is canceled at the venue. If it runs live, cancel your open orders on Kraken yourself.')) return;
    fetch('/api/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sequenceId: id }),
    })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (body.warning) window.alert(body.warning);
        refresh();
      })
      .catch(function () { window.alert('stop failed: server unreachable'); });
  }

  refresh();
  setInterval(refresh, 30000);
})();
</script>
</body>
</html>
`;
}
