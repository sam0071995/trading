const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const IST_MS = 330 * 60000;
const istToday = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10);
const shiftDay = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

const state = { data: null, group: 'all', tab: 'overview', busy: false };

const fmtR = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}R`);
const cls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'muted');
const pfTxt = (s) => (s.profitFactor == null ? (s.grossWinR > 0 ? '∞' : '—') : s.profitFactor.toFixed(2));
const pctTxt = (v) => (v == null ? '—' : `${v.toFixed(1)}%`);
const pxTxt = (v) => (v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 6 }));

function selected() {
  if (!state.data) return null;
  if (state.group === 'all') return state.data.overall;
  return state.data.groups.find((g) => g.id === state.group) || state.data.overall;
}

function scopeLabel() {
  if (!state.data) return '';
  return state.group === 'all' ? 'all groups' : state.data.groups.find((g) => g.id === state.group)?.label || 'all groups';
}

function renderMeta() {
  const d = state.data;
  const note = d.availableFrom ? ` · log covers ${d.availableFrom} → ${d.availableTo}` : '';
  const scope = state.group === 'all' ? '' : ` · viewing ${scopeLabel()}`;
  $('repMeta').textContent = `${d.from} → ${d.to} IST · ${d.overall.entries} signals · ${d.overall.exits} closed${scope}${note}`;
}

function kpi(label, value, sub, tone = '') {
  return `<div class="rep-kpi ${tone}">
    <span class="rk-label">${esc(label)}</span>
    <b class="rk-value">${value}</b>
    <span class="rk-sub">${sub}</span>
  </div>`;
}

function renderKpis() {
  const s = selected();
  $('repKpis').innerHTML = [
    kpi('Signals', s.entries, `${s.exits} closed · ${s.entries - s.exits > 0 ? s.entries - s.exits : 0} running`),
    kpi('Target hit', s.reasons.target, `${pctTxt(s.winRate)} win rate · ${s.wins}W / ${s.losses}L`),
    kpi('Stop hit', s.reasons.stop, `${s.reasons.breakeven} BE · ${s.reasons.reversal} reversal · ${s.reasons.session} session`),
    kpi('Profit ratio (PF)', pfTxt(s), `+${s.grossWinR ?? 0}R won / −${s.grossLossR ?? 0}R lost`, s.profitFactor != null ? (s.profitFactor >= 1 ? 'good' : 'bad') : ''),
    kpi('Total R', fmtR(s.totalR), `avg ${fmtR(s.avgR)} / closed trade`, cls(s.totalR)),
    kpi('Max drawdown', fmtR(s.maxDD), 'peak-to-trough on closed trades', s.maxDD < 0 ? 'neg' : ''),
    kpi('Avg win / loss', `${fmtR(s.avgWinR)} / ${fmtR(s.avgLossR)}`, `payoff ${s.payoff == null ? '—' : s.payoff.toFixed(2) + '×'} · conf ${s.avgWinConf ?? '—'}% vs ${s.avgLossConf ?? '—'}%`),
    kpi('Best / worst', `${fmtR(s.bestR)} / ${fmtR(s.worstR)}`, s.best ? `${esc(s.best.symbol)} ${esc(s.best.tf)}` : 'no closed trades'),
  ].join('');
}

function renderGroups() {
  const overall = state.data.overall;
  const card = (id, label, s) => `<button type="button" class="rep-group ${state.group === id ? 'active' : ''}" data-group="${id}">
      <span class="rg-label">${esc(label)}</span>
      <span class="rg-main ${cls(s.totalR)}">${fmtR(s.totalR)}</span>
      <span class="rg-meta">${s.exits} closed · ${pctTxt(s.winRate)} win · PF ${pfTxt(s)}</span>
      <span class="rg-sub">T ${s.reasons.target} · SL ${s.reasons.stop} · worst ${fmtR(s.worstR)}</span>
    </button>`;
  $('repGroups').innerHTML =
    card('all', 'All groups', overall) + state.data.groups.map((g) => card(g.id, g.label, g)).join('');
  $('repGroups')
    .querySelectorAll('[data-group]')
    .forEach((b) => b.addEventListener('click', () => {
      state.group = b.dataset.group;
      renderGroups();
      renderKpis();
      renderMeta();
      renderOverview();
      renderDaily();
      renderLosses();
    }));
}

const otherExits = (s) => (s.reasons.breakeven || 0) + (s.reasons.reversal || 0) + (s.reasons.session || 0) + (s.reasons.other || 0);
const profitTxt = (v) => (v > 0 ? `+${v.toFixed(2)}R` : '—');
const lossTxt = (v) => (v > 0 ? `−${v.toFixed(2)}R` : '—');

function plCells(trades, target, stop, other, won, lost, net) {
  return `<td class="ta-r mono">${trades}</td>
    <td class="ta-r mono pos">${target}</td>
    <td class="ta-r mono neg">${stop}</td>
    <td class="ta-r mono">${other}</td>
    <td class="ta-r mono pos">${profitTxt(won)}</td>
    <td class="ta-r mono neg">${lossTxt(lost)}</td>
    <td class="ta-r mono ${cls(net)}">${fmtR(net)}</td>`;
}

function renderOverview() {
  const s = selected();
  $('repScopeHint').textContent = `${scopeLabel()} · sorted by net R · other = BE / trail / reversal / session`;
  const rows = [['All markets', state.data.overall], ...state.data.groups.map((g) => [g.label, g])];
  $('repPlBody').innerHTML = rows
    .map(
      ([label, x]) => `<tr>
        <td>${esc(label)}</td>
        ${plCells(x.exits, x.reasons.target, x.reasons.stop, otherExits(x), x.grossWinR, x.grossLossR, x.totalR)}
      </tr>`,
    )
    .join('');
  $('repSymBody').innerHTML = s.bySymbol.length
    ? s.bySymbol
        .map(
          (b) => `<tr>
            <td>${esc(b.name)} <span class="dim mono">${esc(b.symbol)}</span></td>
            ${plCells(b.exits, b.target, b.stop, b.breakeven + b.reversal + b.session + b.other, b.wonR, b.lostR, b.r)}
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="8" class="rep-empty">No signals in this range.</td></tr>`;
}

function equitySvg(daily) {
  if (!daily.length) return '';
  const w = 720;
  const h = 150;
  const pad = 10;
  const vals = daily.map((d) => d.cumR);
  const min = Math.min(0, ...vals);
  const max = Math.max(0, ...vals);
  const span = max - min || 1;
  const x = (i) => pad + (daily.length === 1 ? (w - pad * 2) / 2 : (i * (w - pad * 2)) / (daily.length - 1));
  const y = (v) => pad + ((max - v) / span) * (h - pad * 2);
  const pts = daily.map((d, i) => `${x(i).toFixed(1)},${y(d.cumR).toFixed(1)}`).join(' ');
  const zeroY = y(0).toFixed(1);
  const last = vals[vals.length - 1];
  const color = last >= 0 ? 'var(--green)' : 'var(--red)';
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Cumulative R">
    <line x1="${pad}" y1="${zeroY}" x2="${w - pad}" y2="${zeroY}" stroke="#22303f" stroke-dasharray="4 4" stroke-width="1" />
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" />
    ${daily.map((d, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(d.cumR).toFixed(1)}" r="2.4" fill="${color}" />`).join('')}
  </svg>`;
}

function renderDaily() {
  const s = selected();
  $('repDailyHint').textContent = `${scopeLabel()} · IST dates · Target + SL + Other = closed`;
  $('repEquity').innerHTML = equitySvg(s.daily);
  $('repDailyBody').innerHTML = s.daily.length
    ? s.daily
        .map(
          (d) => `<tr>
            <td class="mono">${esc(d.date)}</td>
            <td class="ta-r mono">${d.entries}</td>
            <td class="ta-r mono">${d.exits}</td>
            <td class="ta-r mono pos">${d.target}</td>
            <td class="ta-r mono neg">${d.stop}</td>
            <td class="ta-r mono">${d.other}</td>
            <td class="ta-r mono">${d.exits ? pctTxt((d.wins / d.exits) * 100) : '—'}</td>
            <td class="ta-r mono ${cls(d.r)}">${fmtR(d.r)}</td>
            <td class="ta-r mono ${cls(d.cumR)}">${fmtR(d.cumR)}</td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="9" class="rep-empty">No activity in this range.</td></tr>`;
}

function renderLosses() {
  const s = selected();
  const list = state.data.losses.filter((l) => state.group === 'all' || l.group === state.group);
  $('repLossHint').textContent = `${scopeLabel()} · ${list.length} losing exits`;
  $('repLossSummary').innerHTML = [
    kpi('Losses', s.losses, `${s.exits ? pctTxt((s.losses / s.exits) * 100) : '—'} of closed trades`, 'bad'),
    kpi('Lost', fmtR(-(s.grossLossR ?? 0)), `avg ${fmtR(s.avgLossR)} per loss`, 'neg'),
    kpi('Worst trade', fmtR(s.worstR), s.worst ? `${esc(s.worst.symbol)} ${esc(s.worst.tf)} · ${esc(s.worst.reason)}` : '—', 'neg'),
    kpi('Net total', fmtR(s.totalR), `PF ${pfTxt(s)}`, cls(s.totalR)),
  ].join('');
  $('repLossBody').innerHTML = list.length
    ? list
        .map(
          (l) => `<tr>
            <td class="mono">${esc(l.date)}</td>
            <td>${esc(l.name)} <span class="dim mono">${esc(l.symbol)}</span></td>
            <td class="mono">${esc(l.tf)}</td>
            <td class="${l.dir === 'BUY' ? 'pos' : 'neg'}">${esc(l.dir)}</td>
            <td>${esc(l.reason)}</td>
            <td class="ta-r mono">${pxTxt(l.entry)}</td>
            <td class="ta-r mono">${pxTxt(l.sl)}</td>
            <td class="ta-r mono">${pxTxt(l.exit)}</td>
            <td class="ta-r mono neg">${fmtR(l.r)}</td>
            <td class="ta-r mono">${l.confidence ?? '—'}%</td>
          </tr>`,
        )
        .join('')
    : `<tr><td colspan="10" class="rep-empty">No losing trades in this range.</td></tr>`;
}

function setTab(tab) {
  state.tab = tab;
  for (const b of $('repTabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === tab);
  $('repOverview').hidden = tab !== 'overview';
  $('repDaily').hidden = tab !== 'daily';
  $('repLosses').hidden = tab !== 'losses';
  if (tab === 'daily') renderDaily();
  if (tab === 'losses') renderLosses();
  if (tab === 'overview') renderOverview();
  history.replaceState(null, '', tab === 'overview' ? location.pathname : `?tab=${tab}`);
}

async function load(from, to) {
  if (state.busy) return;
  state.busy = true;
  $('repMeta').textContent = 'Loading…';
  try {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const res = await fetch(`/api/report?${qs.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    $('repFrom').value = state.data.from;
    $('repTo').value = state.data.to;
    renderMeta();
    renderKpis();
    renderGroups();
    renderOverview();
    setTab(state.tab);
  } catch (err) {
    $('repMeta').textContent = `Could not load report: ${err.message}`;
  } finally {
    state.busy = false;
  }
}

function applyRange() {
  const from = $('repFrom').value || undefined;
  const to = $('repTo').value || undefined;
  load(from, to);
}

$('repApply').addEventListener('click', applyRange);
$('repFrom').addEventListener('keydown', (e) => e.key === 'Enter' && applyRange());
$('repTo').addEventListener('keydown', (e) => e.key === 'Enter' && applyRange());
$('repTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) setTab(b.dataset.tab);
});
$('repPresets').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-days]');
  if (!b) return;
  const today = istToday();
  if (b.dataset.days === 'all') {
    const from = state.data?.availableFrom || shiftDay(today, -3650);
    load(from, today);
    return;
  }
  const days = Number(b.dataset.days);
  load(shiftDay(today, -days), today);
});

const today = istToday();
$('repFrom').value = shiftDay(today, -6);
$('repTo').value = today;
const initialTab = new URLSearchParams(location.search).get('tab');
if (['overview', 'daily', 'losses'].includes(initialTab)) state.tab = initialTab;
load();
setInterval(() => {
  if (document.visibilityState === 'visible' && state.data) {
    load($('repFrom').value, $('repTo').value);
  }
}, 60000);
