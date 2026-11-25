const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const state = {
  tf: localStorage.getItem('tt_tf') || '15m',
  market: localStorage.getItem('tt_market') || 'all',
  sort: 'default',
  rows: [],
  bySymbol: new Map(),
  selected: null,
  detail: null,
  config: null,
  configBySymbol: new Map(),
  signals: [],
  sound: localStorage.getItem('tt_sound') === '1',
  es: null,
  detailTimer: null,
  lastSnapshot: 0,
  lastDetail: 0,
  openCard: null,
};

const MOBILE_Q = '(max-width: 760px)';
const mobile = () => window.matchMedia(MOBILE_Q).matches;

/* ------------------------------------------------------------------ */
/* formatting                                                          */
/* ------------------------------------------------------------------ */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function fmt(v, dec = 2) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtPct(v, dec = 2) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(dec)}%`;
}

const cls = (v) => (Number(v) > 0 ? 'pos' : Number(v) < 0 ? 'neg' : 'muted');

function ago(ms) {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 2 ? 'now' : s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

function hhmm(ts) {
  return new Date(ts * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function chartTime(ts, tf) {
  const d = new Date(ts * 1000);
  if (tf === '1d') return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
  if (tf === '4h' || tf === '1h') return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${hhmm(ts)}`;
  return hhmm(ts);
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

init();

async function init() {
  try {
    const cfg = await fetch('/api/config').then((r) => r.json());
    applyConfig(cfg);
  } catch (err) {
    setConn('dead', 'server unreachable');
  }
  buildTfButtons();
  bindUi();
  setupChart();
  initLegend();
  connect();
  loadInitial();
  setInterval(tickClock, 1000);
}

async function loadInitial() {
  try {
    const data = await fetch(`/api/scan?tf=${encodeURIComponent(state.tf)}`).then((r) => r.json());
    if (data && data.tf === state.tf) onSnapshot(data);
  } catch {
    /* SSE will deliver data */
  }
}

function applyConfig(cfg) {
  state.config = cfg;
  state.configBySymbol = new Map(cfg.symbols.map((s) => [s.symbol, s]));
  buildTabs();
}

function connect() {
  if (state.es) state.es.close();
  setConn('wait', 'connecting');
  const es = new EventSource(`/api/stream?tf=${encodeURIComponent(state.tf)}`);
  state.es = es;
  es.addEventListener('snapshot', (e) => onSnapshot(JSON.parse(e.data)));
  es.addEventListener('signal', (e) => onSignal(JSON.parse(e.data)));
  es.onopen = () => setConn('live', 'live');
  es.onerror = () => setConn('dead', 'reconnecting');
}

function setConn(kind, text) {
  const el = $('conn');
  el.classList.toggle('live', kind === 'live');
  el.classList.toggle('dead', kind === 'dead');
  $('connText').textContent = text;
}

function tickClock() {
  const el = $('lastTick');
  if (el && state.lastSnapshot) el.textContent = `sync ${ago(Date.now() - state.lastSnapshot)}`;
  const pulse = document.querySelector('.pulse-item.sync');
  if (pulse) pulse.innerHTML = `<span>Last sync</span><b>${state.lastSnapshot ? ago(Date.now() - state.lastSnapshot) : '—'}</b>`;
}

/* ------------------------------------------------------------------ */
/* header controls                                                     */
/* ------------------------------------------------------------------ */

function buildTfButtons() {
  const tfs = state.config?.tfs || ['1m', '5m', '15m', '1h', '4h', '1d'];
  if (!tfs.includes(state.tf)) state.tf = '15m';
  const html = tfs
    .map((t) => `<button data-tf="${t}" class="${t === state.tf ? 'active' : ''}">${t}</button>`)
    .join('');
  for (const el of [$('tfGroup'), $('tfGroupM')]) {
    if (!el) continue;
    el.innerHTML = html;
    el.onclick = (e) => {
      const btn = e.target.closest('button[data-tf]');
      if (btn) setTf(btn.dataset.tf);
    };
  }
}

function setTf(tf) {
  if (!tf || tf === state.tf) return;
  state.tf = tf;
  localStorage.setItem('tt_tf', state.tf);
  buildTfButtons();
  state.rows = [];
  state.bySymbol.clear();
  clearTable();
  clearCards();
  closeCard();
  connect();
  if (state.selected) fetchDetail();
  else autoSelect();

  $('signalPanel').innerHTML = `<div class="placeholder"><div class="ph-title">Loading ${state.tf} data…</div><div class="ph-sub">Fetching candles for the selected timeframe.</div></div>`;
  if (mobile()) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function buildTabs() {
  const cfg = state.config;
  if (!cfg) return;
  const counts = {};
  for (const s of cfg.symbols) counts[s.market] = (counts[s.market] || 0) + 1;
  const tabs = [{ id: 'all', label: 'All', n: cfg.symbols.length }];
  for (const m of cfg.markets) if (counts[m.id]) tabs.push({ id: m.id, label: m.label, n: counts[m.id] });
  if (counts.custom) tabs.push({ id: 'custom', label: 'Custom', n: counts.custom });
  if (!tabs.find((t) => t.id === state.market)) state.market = 'all';

  const html = tabs
    .map((t) => `<button data-market="${t.id}" class="${t.id === state.market ? 'active' : ''}">${esc(t.label)} <span class="dim">${t.n}</span></button>`)
    .join('');
  for (const el of [$('marketTabs'), $('marketTabsM')]) {
    if (!el) continue;
    el.innerHTML = html;
    el.onclick = (e) => {
      const btn = e.target.closest('button[data-market]');
      if (btn) setMarket(btn.dataset.market);
    };
  }
}

function setMarket(id) {
  if (!id || id === state.market) return;
  state.market = id;
  localStorage.setItem('tt_market', state.market);
  buildTabs();
  renderTable();
  renderCards();
}

function bindUi() {
  $('soundBtn').classList.toggle('on', state.sound);
  $('soundBtn').textContent = state.sound ? '🔔' : '🔕';
  $('soundBtn').onclick = () => {
    state.sound = !state.sound;
    localStorage.setItem('tt_sound', state.sound ? '1' : '0');
    $('soundBtn').classList.toggle('on', state.sound);
    $('soundBtn').textContent = state.sound ? '🔔' : '🔕';
    if (state.sound) beep('BUY');
  };

  $('sortSel').onchange = (e) => {
    state.sort = e.target.value;
    renderTable();
    renderCards();
  };

  $('addBtn').onclick = () => {
    $('addModal').hidden = false;
    setTimeout(() => $('addInput').focus(), 30);
  };
  $('addCancel').onclick = () => ($('addModal').hidden = true);
  $('addModal').onclick = (e) => {
    if (e.target === $('addModal')) $('addModal').hidden = true;
  };
  document.querySelectorAll('.examples button').forEach((b) => {
    b.onclick = () => ($('addInput').value = b.dataset.ex);
  });
  $('addForm').onsubmit = async (e) => {
    e.preventDefault();
    const raw = $('addInput').value.trim();
    if (!raw) return;
    try {
      const res = await fetch(`/api/watch/add?symbol=${encodeURIComponent(raw)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'failed');
      applyConfig(data.config);
      $('addModal').hidden = true;
      $('addInput').value = '';
      selectSymbol(raw.trim().toUpperCase());
    } catch (err) {
      $('addInput').value = '';
      $('addInput').placeholder = `Could not add: ${err.message}`;
    }
  };

  $('signalPanel').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (btn) removeSymbol(btn.dataset.remove);
  });

  $('mCards').addEventListener('click', (e) => {
    const head = e.target.closest('.mc-head');
    if (head) return toggleCard(head.closest('.m-card').dataset.symbol);
    const rm = e.target.closest('[data-remove]');
    if (rm) return removeSymbol(rm.dataset.remove);
    if (e.target.closest('[data-scrollchart]')) {
      document.querySelector('.chart-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  setupCollapsible();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('addModal').hidden = true;
  });

  $('toast').onclick = () => {
    const sym = $('toast').dataset.symbol;
    if (sym) selectSymbol(sym);
    hideToast();
  };
}

function setupCollapsible() {
  if (!mobile()) return;
  for (const id of ['indicatorsPanel', 'backtestPanel', 'feedPanel']) {
    const panel = $(id);
    const head = panel?.querySelector('.panel-head');
    if (!panel || !head) continue;
    if (localStorage.getItem(`tt_open_${id}`) !== '1') panel.classList.add('collapsed');
    head.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('collapsed');
      localStorage.setItem(`tt_open_${id}`, collapsed ? '0' : '1');
    });
  }
}

async function removeSymbol(sym) {
  if (!sym || !confirm(`Remove ${sym} from the watchlist?`)) return;
  const res = await fetch(`/api/watch/remove?symbol=${encodeURIComponent(sym)}`);
  const data = await res.json();
  if (!res.ok) return;
  if (state.selected === sym) state.selected = null;
  applyConfig(data.config);
  state.rows = state.rows.filter((r) => r.symbol !== sym);
  state.bySymbol.delete(sym);
  if (state.openCard === sym) closeCard();
  renderTable();
  renderCards();
  renderAll();
}

/* ------------------------------------------------------------------ */
/* snapshots                                                           */
/* ------------------------------------------------------------------ */

function onSnapshot(data) {
  if (!data || data.tf !== state.tf) return;
  state.rows = data.rows || [];
  state.bySymbol = new Map(state.rows.map((r) => [r.symbol, r]));
  state.signals = data.signals || [];
  state.lastSnapshot = data.ts || Date.now();
  renderTable();
  renderCards();
  renderPulse(data.pulse);
  renderTicker();
  renderFeed();
  $('watchMeta').textContent = `${state.rows.length} symbols · ${state.rows.filter((r) => !r.pending).length} live`;

  if (!state.selected) autoSelect();
  if (state.selected) {
    const row = state.bySymbol.get(state.selected);
    if (row && state.detail) state.detail.row = row;
  }
  for (const sig of data.fresh || []) notifySignal(sig);
}

function onSignal(sig) {
  if (!sig || sig.tf !== state.tf) return;
  notifySignal(sig);
}

function autoSelect() {
  const inMarket = state.rows.filter((r) => state.market === 'all' || r.market === state.market);
  const ready = inMarket.filter((r) => !r.pending && r.signal && r.signal !== 'NEUTRAL');
  ready.sort((a, b) => b.confidence - a.confidence);
  const pick = ready[0] || inMarket.find((r) => !r.pending);
  if (pick) selectSymbol(pick.symbol, { quiet: true });
}

function selectSymbol(sym, opts = {}) {
  if (!sym) return;
  state.selected = sym;
  clearTimeout(state.detailTimer);
  for (const [s, node] of rowMap) node.tr.classList.toggle('selected', s === sym);
  fetchDetail();
  scheduleDetail();
}

function scheduleDetail() {
  clearTimeout(state.detailTimer);
  const ms = state.tf === '1m' ? 5000 : state.tf === '5m' ? 7000 : 11000;
  state.detailTimer = setTimeout(async () => {
    if (state.selected) {
      await fetchDetail();
      scheduleDetail();
    }
  }, ms);
}

async function fetchDetail() {
  const sym = state.selected;
  if (!sym) return;
  try {
    const res = await fetch(`/api/analyze?symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(state.tf)}`);
    const data = await res.json();
    if (state.selected !== sym || data.tf !== state.tf) return;
    state.lastDetail = Date.now();
    if (!res.ok) {
      renderDetailError(sym, data.error || 'failed to load');
      return;
    }
    state.detail = data;
    renderSignalPanel(data);
    renderIndicators(data);
    renderBacktest(data.backtest, data.analysis);
    setChartData(data);
  } catch (err) {
    renderDetailError(sym, err.message);
  }
}

/* ------------------------------------------------------------------ */
/* watchlist table                                                     */
/* ------------------------------------------------------------------ */

const rowMap = new Map();

function clearTable() {
  rowMap.clear();
  $('scanBody').innerHTML = '';
}

function filteredRows() {
  let list = state.rows.filter((r) => state.market === 'all' || r.market === state.market);
  if (state.sort === 'signal') {
    list = list
      .slice()
      .sort((a, b) => {
        const av = a.signal && a.signal !== 'NEUTRAL' ? 1 : 0;
        const bv = b.signal && b.signal !== 'NEUTRAL' ? 1 : 0;
        if (av !== bv) return bv - av;
        return (b.confidence || 0) - (a.confidence || 0);
      });
  } else if (state.sort === 'change') {
    list = list.slice().sort((a, b) => Math.abs(b.chgPct || 0) - Math.abs(a.chgPct || 0));
  }
  return list;
}

function renderTable() {
  const tbody = $('scanBody');
  const list = filteredRows();
  if (!state.config) return;
  if (!list.length && !state.rows.length) {
    if (!tbody.childElementCount) tbody.innerHTML = `<tr><td colspan="5" class="empty">Waiting for market data…</td></tr>`;
    return;
  }
  if (tbody.querySelector('td.empty')) tbody.innerHTML = '';
  const seen = new Set();
  for (const r of list) {
    seen.add(r.symbol);
    let node = rowMap.get(r.symbol);
    if (!node) {
      node = createRow(r);
      rowMap.set(r.symbol, node);
    }
    updateRow(node, r);
    tbody.appendChild(node.tr);
  }
  for (const [sym, node] of [...rowMap]) {
    if (!seen.has(sym)) {
      node.tr.remove();
      rowMap.delete(sym);
    }
  }
}

function createRow(r) {
  const tr = document.createElement('tr');
  tr.dataset.symbol = r.symbol;
  tr.innerHTML = `
    <td><div class="sym-cell"><span class="sym-name"></span><span class="sym-sub"></span></div></td>
    <td class="price-cell ta-r"></td>
    <td class="chg-cell ta-r mono"></td>
    <td class="sig-cell"></td>
    <td class="conf-cell"><div class="conf-track"><div class="conf-fill"></div></div><span class="conf-num"></span></td>`;
  tr.addEventListener('click', () => selectSymbol(r.symbol));
  return {
    tr,
    name: tr.querySelector('.sym-name'),
    sub: tr.querySelector('.sym-sub'),
    price: tr.querySelector('.price-cell'),
    chg: tr.querySelector('.chg-cell'),
    sig: tr.querySelector('.sig-cell'),
    fill: tr.querySelector('.conf-fill'),
    conf: tr.querySelector('.conf-num'),
    lastPrice: null,
    lastSym: null,
  };
}

function updateRow(node, r) {
  if (node.lastSym !== r.symbol) {
    node.lastSym = r.symbol;
    node.name.textContent = r.symbol;
    node.sub.textContent = r.name || '';
  }
  if (r.pending) {
    node.price.textContent = '…';
    node.chg.textContent = '';
    node.sig.innerHTML = '<span class="badge neutral">LOAD</span>';
    node.fill.style.width = '0%';
    node.conf.textContent = '';
    node.tr.title = 'Loading candles…';
    return;
  }
  if (r.error && r.signal == null) {
    node.price.textContent = r.price != null ? fmt(r.price, 2) : '—';
    node.chg.textContent = '';
    node.sig.innerHTML = '<span class="badge neutral" title="' + esc(r.error) + '">ERR</span>';
    node.fill.style.width = '0%';
    node.conf.textContent = '';
    node.tr.title = r.error;
    return;
  }

  const dec = r.decimals ?? 2;
  node.price.textContent = fmt(r.price, dec);
  if (node.lastPrice != null && r.price != null && r.price !== node.lastPrice) {
    node.price.classList.remove('flash-up', 'flash-down');
    void node.price.offsetWidth;
    node.price.classList.add(r.price > node.lastPrice ? 'flash-up' : 'flash-down');
  }
  node.lastPrice = r.price;

  node.chg.textContent = fmtPct(r.chgPct);
  node.chg.className = `chg-cell ta-r mono ${cls(r.chgPct)}`;

  const book = r.book;
  if (book && book.status === 'CLOSED' && book.exit) {
    const xr = `${book.exit.r >= 0 ? '+' : ''}${book.exit.r}R`;
    node.sig.innerHTML = `<span class="badge exit" title="${esc(book.dir)} closed — ${esc(book.exit.reason)} at ${fmt(book.exit.price, dec)} (${xr})">EXIT</span>`;
    node.fill.style.width = '0%';
    node.fill.className = 'conf-fill';
    node.conf.textContent = xr;
    node.tr.title = `${r.name || r.symbol} · ${book.dir} closed: ${book.exit.reason} @ ${fmt(book.exit.price, dec)} (${xr})`;
    return;
  }

  const sig = r.signal || 'NEUTRAL';
  const k = sig === 'BUY' ? 'buy' : sig === 'SELL' ? 'sell' : 'neutral';
  const moveTag = r.move ? `<span class="badge move" style="min-width:0;margin-left:4px">${esc(r.move.type.slice(0, 4))}</span>` : '';
  node.sig.innerHTML = `<span class="badge ${k}">${sig}</span>${moveTag}`;

  const conf = r.confidence || 0;
  node.fill.style.width = `${conf}%`;
  node.fill.className = `conf-fill ${k}`;
  node.conf.textContent = conf ? `${conf}%` : '—';

  const tps = r.targets && r.targets.length ? r.targets.map((t, i) => `T${i + 1} ${fmt(t, dec)}`).join(' · ') : '';
  node.tr.title = [
    `${r.name || r.symbol} · ${sig}${r.state && sig !== 'NEUTRAL' ? ' (' + r.state + ')' : ''}`,
    r.strategy ? `${r.strategy.name}${r.strategy.setup ? ' — ' + r.strategy.setup : ''}` : '',
    r.entry != null ? `Entry ${fmt(r.entry, dec)}` : '',
    r.sl != null ? `SL ${fmt(r.sl, dec)}` : '',
    tps,
    r.topReason || '',
  ]
    .filter(Boolean)
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* mobile signal cards (accordion)                                     */
/* ------------------------------------------------------------------ */

const cardMap = new Map();

function clearCards() {
  cardMap.clear();
  const wrap = $('mCards');
  if (wrap) wrap.innerHTML = '';
}

function cardSigKey(r) {
  const b = r.book || {};
  const checks = r.strategy?.checklist?.map((c) => (c.ok === true ? 1 : c.ok === false ? 0 : 2)).join('') || '';
  const setups = r.strategy?.setups?.map((s) => `${s.state?.[0] || ''}${s.dir?.[0] || ''}`).join('') || '';
  const notes = `${r.topReason || ''}|${(r.warnings || []).join('|')}`;
  return [
    r.signal,
    r.state,
    r.confidence,
    r.entry,
    r.sl,
    (r.targets || []).join(','),
    b.status,
    b.be ? 1 : 0,
    b.tp1Hit ? 1 : 0,
    b.tp2Hit ? 1 : 0,
    b.exit?.at || '',
    r.strategy?.passed,
    r.strategy?.evaluated,
    checks,
    setups,
    notes,
  ].join('|');
}

function renderCards() {
  const wrap = $('mCards');
  if (!wrap || !state.config) return;
  const list = filteredRows();
  if (!list.length) {
    cardMap.clear();
    closeCard();
    wrap.innerHTML = `<div class="empty">${state.rows.length ? 'No symbols in this market.' : 'Waiting for market data…'}</div>`;
    return;
  }
  if (wrap.querySelector('.empty')) wrap.innerHTML = '';
  const seen = new Set();
  list.forEach((r, i) => {
    seen.add(r.symbol);
    let node = cardMap.get(r.symbol);
    if (!node) {
      node = createCard();
      cardMap.set(r.symbol, node);
    }
    updateCard(node, r);
    if (wrap.children[i] !== node.el) wrap.insertBefore(node.el, wrap.children[i] || null);
  });
  for (const [sym, node] of [...cardMap]) {
    if (!seen.has(sym)) {
      node.el.remove();
      cardMap.delete(sym);
      if (state.openCard === sym) closeCard();
    }
  }
}

function createCard() {
  const el = document.createElement('article');
  el.className = 'm-card';
  el.innerHTML = `
    <button type="button" class="mc-head">
      <span class="mc-id"><b class="mc-sym"></b><small class="mc-sub"></small></span>
      <span class="mc-px"><b class="mc-price"></b><small class="mc-chg"></small></span>
      <span class="mc-sig"><span class="badge neutral mc-badge">—</span><small class="mc-conf"></small></span>
      <span class="mc-chev">▾</span>
    </button>
    <div class="mc-body"></div>`;
  return {
    el,
    body: el.querySelector('.mc-body'),
    sym: el.querySelector('.mc-sym'),
    sub: el.querySelector('.mc-sub'),
    price: el.querySelector('.mc-price'),
    chg: el.querySelector('.mc-chg'),
    badge: el.querySelector('.mc-badge'),
    conf: el.querySelector('.mc-conf'),
    key: '',
  };
}

function updateCard(node, r) {
  if (node.el.dataset.symbol !== r.symbol) {
    node.el.dataset.symbol = r.symbol;
    node.sym.textContent = r.symbol;
  }
  const info = state.configBySymbol.get(r.symbol) || {};
  const sub = [r.name || info.name || '', r.strategy?.name || ''].filter(Boolean).join(' · ');
  if (node.sub.textContent !== sub) node.sub.textContent = sub;

  if (r.pending) {
    node.price.textContent = '…';
    node.chg.textContent = '';
    node.badge.className = 'badge neutral mc-badge';
    node.badge.textContent = 'LOAD';
    node.conf.textContent = '';
    return;
  }

  const dec = r.decimals ?? 2;
  node.price.textContent = fmt(r.price, dec);
  node.chg.textContent = fmtPct(r.chgPct);
  node.chg.className = `mc-chg ${cls(r.chgPct)}`;

  const b = r.book || {};
  if (b.status === 'CLOSED' && b.exit) {
    const xr = `${b.exit.r >= 0 ? '+' : ''}${Number(b.exit.r || 0).toFixed(1)}R`;
    node.badge.className = 'badge exit mc-badge';
    node.badge.textContent = 'EXIT';
    node.conf.textContent = xr;
  } else {
    const sig = r.signal || 'NEUTRAL';
    const k = sig === 'BUY' ? 'buy' : sig === 'SELL' ? 'sell' : 'neutral';
    node.badge.className = `badge ${k} mc-badge`;
    node.badge.textContent = sig === 'NEUTRAL' ? 'FLAT' : sig;
    node.conf.textContent = r.confidence ? `${r.confidence}%` : b.status === 'OPEN' ? b.dir : '';
  }

  if (!node.el.classList.contains('open')) return;
  const key = cardSigKey(r);
  if (key !== node.key) {
    node.key = key;
    renderCardBody(node, r);
    return;
  }
  if (b.status === 'OPEN') {
    const live = node.body.querySelector('[data-live-r]');
    if (live) live.textContent = `${b.pnlR >= 0 ? '+' : ''}${Number(b.pnlR || 0).toFixed(2)}R`;
    const now = node.body.querySelector('[data-now]');
    if (now) now.textContent = fmt(r.price, dec);
  }
}

const mcell = (label, val, klass) => `<div class="${klass}"><span>${label}</span><b>${val}</b></div>`;

function renderCardBody(node, r) {
  if (!r || r.pending) {
    node.body.innerHTML = `<div class="mc-flat">Loading candles…</div>`;
    return;
  }
  const dec = r.decimals ?? 2;
  const b = r.book || {};
  const open = b.status === 'OPEN';
  const closed = b.status === 'CLOSED' && !!b.exit;
  const dir = open ? b.dir : r.signal;
  const k = dir === 'BUY' ? 'buy' : dir === 'SELL' ? 'sell' : 'neutral';
  const targets = (b.targets && b.targets.length ? b.targets : r.targets) || [];
  const rText = (v) => `${v >= 0 ? '+' : ''}${Number(v || 0).toFixed(2)}R`;

  const bar = open
    ? `<div class="trade-bar ${k}">
        <span class="tb-tag">LIVE ${esc(b.dir)}</span>
        <span>Entry ${fmt(b.entry, dec)} · now <b data-now>${fmt(r.price, dec)}</b> · <b data-live-r>${rText(b.pnlR)}</b></span>
        ${b.tp2Hit ? '<span class="tb-sub">trailing to T1</span>' : b.be ? '<span class="tb-sub">stop at break-even</span>' : b.tp1Hit ? '<span class="tb-sub">T1 booked · stop moved</span>' : ''}
      </div>`
    : closed
      ? `<div class="trade-bar exit">
          <span class="tb-tag">EXIT</span>
          <span>${esc(b.exit.reason)} at ${fmt(b.exit.price, dec)} · <b>${rText(b.exit.r)}</b></span>
        </div>`
      : '';

  const plan =
    open || closed
      ? `<div class="mplan">
          ${mcell('Entry', fmt(b.entry ?? r.entry, dec), 'entry')}
          ${mcell('Stop', fmt(b.stop ?? b.sl ?? r.sl, dec), 'sl')}
          ${mcell('T1', fmt(targets[0], dec), 'tp')}
          ${mcell('T2', fmt(targets[1], dec), 'tp')}
          ${mcell('T3', fmt(targets[2], dec), 'tp')}
          ${mcell('Risk', b.riskPct != null ? `${b.riskPct}%` : r.riskPct != null ? `${r.riskPct}%` : '—', 'risk')}
        </div>`
      : `<div class="mc-flat">${esc(r.topReason || 'No trade — the engine is scanning for a setup on this timeframe.')}</div>`;

  const st = r.strategy || {};
  const checks = Array.isArray(st.checklist) && st.checklist.length
    ? `<details>
        <summary>Market checks <em>${st.passed}/${st.evaluated} passed</em></summary>
        <div class="checks">${st.checklist
          .map(
            (c) => `<div class="chk ${c.ok === true ? 'ok' : c.ok === false ? 'no' : 'na'}">
              <span class="chk-ic">${c.ok === true ? '✓' : c.ok === false ? '✗' : '–'}</span>
              <span class="chk-l">${esc(c.label)}</span>
              <span class="chk-n">${esc(c.note)}</span>
            </div>`,
          )
          .join('')}</div>
      </details>`
    : '';

  const setups = Array.isArray(st.setups) && st.setups.length
    ? `<details>
        <summary>Strategy scan <em>${st.setups.filter((s) => s.state === 'FIRED' || s.state === 'READY').length} of ${st.setups.length} active</em></summary>
        <div class="scan">${st.setups
          .map(
            (s) => `<div class="scan-row ${s.state === 'FIRED' ? 'fired' : s.state === 'READY' ? 'ready' : ''}">
              <span class="scan-name">${esc(s.name)}</span>
              <span class="scan-dir ${s.dir === 'BUY' ? 'b' : s.dir === 'SELL' ? 's' : ''}">${esc(s.dir || '—')}</span>
              <span class="scan-score"><i style="width:${Math.max(0, Math.min(100, s.score || 0))}%"></i></span>
              <span class="scan-st">${esc(s.state)}</span>
              <span class="scan-note">${esc(s.note || '')}</span>
            </div>`,
          )
          .join('')}</div>
      </details>`
    : '';

  const notes = [r.topReason, ...(r.warnings || [])].filter(Boolean);
  const noteBlock = notes.length
    ? `<details>
        <summary>Why / watch out <em>${notes.length}</em></summary>
        <div class="mc-notes">${notes.map((n) => `<div class="mc-note">${esc(n)}</div>`).join('')}</div>
      </details>`
    : '';

  const custom = state.configBySymbol.get(r.symbol)?.custom;
  node.body.innerHTML = `
    ${bar}
    ${plan}
    <div class="macc">${checks}${setups}${noteBlock}</div>
    <div class="mc-actions">
      <button type="button" class="btn ghost" data-scrollchart>Chart &amp; indicators ↓</button>
      ${custom ? `<button type="button" class="btn ghost mc-remove" data-remove="${esc(r.symbol)}">Remove</button>` : ''}
    </div>`;
}

function toggleCard(sym) {
  if (!sym) return;
  if (state.openCard === sym) return closeCard();
  const node = cardMap.get(sym);
  if (!node) return;
  closeCard();
  state.openCard = sym;
  node.el.classList.add('open');
  const row = state.bySymbol.get(sym);
  node.key = row ? cardSigKey(row) : '';
  renderCardBody(node, row || { symbol: sym, pending: true });
  selectSymbol(sym);
  requestAnimationFrame(() => {
    const head = node.el.querySelector('.mc-head');
    const barBottom = document.querySelector('.topbar')?.getBoundingClientRect().bottom || 0;
    const top = head.getBoundingClientRect().top;
    if (top < barBottom + 6) window.scrollBy({ top: top - barBottom - 10, behavior: 'smooth' });
  });
}

function closeCard() {
  if (state.openCard) cardMap.get(state.openCard)?.el.classList.remove('open');
  state.openCard = null;
}

/* ------------------------------------------------------------------ */
/* header strip + pulse                                                */
/* ------------------------------------------------------------------ */

const TICKER_SYMBOLS = ['^NSEI', '^BSESN', '^NSEBANK', 'XAUUSD', 'XAUTUSD', 'BTCUSD', 'ETHUSD'];

function renderTicker() {
  const wrap = $('tickerStrip');
  const chips = [];
  for (const sym of TICKER_SYMBOLS) {
    const r = state.bySymbol.get(sym);
    if (!r || r.pending) continue;
    const dec = r.decimals ?? 2;
    chips.push(`<div class="tick-chip" data-symbol="${esc(sym)}">
      <span class="tk-sym">${esc(r.name || sym)}</span>
      <span class="tk-price">${fmt(r.price, dec)}</span>
      <span class="tk-chg ${cls(r.chgPct)}">${fmtPct(r.chgPct)}</span>
    </div>`);
  }
  wrap.innerHTML = chips.join('');
  wrap.onclick = (e) => {
    const chip = e.target.closest('[data-symbol]');
    if (chip) selectSymbol(chip.dataset.symbol);
  };
}

function istNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return { day: get('weekday'), h: Number(get('hour')) % 24, m: Number(get('minute')) };
}

function sessions() {
  const ist = istNow();
  const mins = ist.h * 60 + ist.m;
  const weekday = !['Sat', 'Sun'].includes(ist.day);
  const inWin = (ranges) => weekday && ranges.some(([a, b]) => mins >= a && mins < b);
  return [
    { label: 'Crypto', open: !(ist.day === 'Sat' && mins >= 120 && mins < 600) },
    { label: 'India', open: inWin([[555, 690], [810, 900]]) },
    { label: 'Gold', open: inWin([[750, 900], [1080, 1260]]) },
  ];
}

function renderPulse(p) {
  if (!p) return;
  const ses = sessions()
    .map((s) => `<span class="session-chip ${s.open ? 'open' : ''}"><i></i>${s.label} ${s.open ? 'open' : 'closed'}</span>`)
    .join('');
  const movers = (p.movers || [])
    .slice(0, 3)
    .map((m) => `<span class="mover">${esc(m.symbol)} <span class="${cls(m.chgPct)}">${fmtPct(m.chgPct)}</span></span>`)
    .join(' ');
  $('pulseBar').innerHTML = `
    <div class="pulse-item"><span>Signals</span><b class="pos">${p.buy} BUY</b><b class="neg">${p.sell} SELL</b><b class="muted">${p.neutral} flat</b></div>
    <div class="pulse-sep"></div>
    <div class="pulse-item"><span>Breadth</span><b class="pos">${p.up} up</b><b class="neg">${p.down} down</b></div>
    <div class="pulse-sep"></div>
    <div class="pulse-item"><span>Movers</span>${movers || '<span class="dim">—</span>'}</div>
    <div class="pulse-sep"></div>
    <div class="pulse-item" style="gap:12px">${ses}</div>
    <div class="pulse-item sync" style="margin-left:auto"><span>Last sync</span><b>${ago(Date.now() - state.lastSnapshot)}</b></div>`;
}

/* ------------------------------------------------------------------ */
/* detail: signal panel                                                */
/* ------------------------------------------------------------------ */

function renderDetailError(sym, msg) {
  $('signalPanel').innerHTML = `<div class="placeholder">
    <div class="ph-title">${esc(sym)}</div>
    <div class="ph-sub">Could not load data: ${esc(msg)}. Retrying automatically…</div>
  </div>`;
  $('indGrid').innerHTML = '<div class="empty">No data</div>';
  $('chartEmpty').style.display = 'grid';
  $('chartEmpty').textContent = 'No chart data';
  setChartData(null);
  $('chartTitle').textContent = sym;
}

function renderSignalPanel(d) {
  const a = d.analysis;
  const panel = $('signalPanel');
  if (!a || !a.ok) {
    panel.innerHTML = `<div class="placeholder"><div class="ph-title">${esc(d.symbol)}</div><div class="ph-sub">${esc(a?.reason || 'Not enough data yet')}</div></div>`;
    return;
  }
  const dec = a.decimals ?? 2;
  const dir = a.signal;
  const k = dir === 'BUY' ? 'buy' : dir === 'SELL' ? 'sell' : 'neutral';
  const info = state.configBySymbol.get(d.symbol) || {};
  const mk = d.marketLabel || info.market || '';
  const st = a.strategy || null;
  const ses = st?.session || null;
  const book = a.book || d.book || null;
  const openTrade = book?.status === 'OPEN';
  const closedTrade = book?.status === 'CLOSED' && book.exit;

  const pills = [];
  pills.push(`<span class="pill info">${esc(d.source ? d.source.toUpperCase() : 'DATA')}</span>`);
  if (st) pills.push(`<span class="pill info" title="${esc(st.setup || '')}">${esc(st.name)}</span>`);
  if (ses) {
    const sc = !ses.active ? 'bad' : ses.preferred ? 'ok' : 'warn';
    const title = ses.next || ses.window || '';
    pills.push(`<span class="pill ${sc}" title="${esc(title)}">${esc(ses.label)}</span>`);
  }
  if (openTrade) {
    pills.push(`<span class="pill ok">TRADE OPEN · LOCKED</span>`);
    pills.push(`<span class="pill">GRADE ${esc(a.grade)}</span>`);
  } else if (closedTrade) {
    pills.push(`<span class="pill warn">DONE · ${esc(book.exit.reason)}</span>`);
  } else if (dir !== 'NEUTRAL') {
    pills.push(`<span class="pill ${a.state === 'CONFIRMED' ? 'ok' : 'warn'}">${esc(a.state)}</span>`);
    pills.push(`<span class="pill">GRADE ${esc(a.grade)}</span>`);
  }
  if (st && a.strategy.checklist) pills.push(`<span class="pill ${st.passed >= 4 ? 'ok' : 'warn'}">${st.passed}/${st.evaluated} CHECKS</span>`);
  if (a.move) pills.push(`<span class="pill warn">${esc(a.move.type)}</span>`);
  if (d.stale) pills.push(`<span class="pill warn" title="${esc(d.error || '')}">STALE</span>`);
  if (info.custom) pills.push(`<button class="pill bad" data-remove="${esc(d.symbol)}" style="cursor:pointer">REMOVE</button>`);

  const planCell = (label, val, extraCls, sub) => `
    <div class="plan-cell ${extraCls}">
      <div class="lbl">${label}</div>
      <div class="val">${val}</div>
      <div class="rr">${sub || ''}</div>
    </div>`;

  const dist = a.entry != null && a.stopLoss != null ? Math.abs(a.entry - a.stopLoss) : null;
  const rOf = (t) => (dist && Number.isFinite(t) ? `${(Math.abs(t - a.entry) / dist).toFixed(2)} R` : '');

  const plan =
    a.entry == null
      ? `<div class="plan-grid">${planCell('Entry', '—', '', '')}${planCell('Stop loss', '—', '', '')}${planCell('Target 1', '—', '', '')}${planCell('Target 2', '—', '', '')}${planCell('Target 3', '—', '', '')}${planCell('Risk', '—', '', '')}</div>`
      : `<div class="plan-grid">
          ${planCell('Entry', fmt(a.entry, dec), 'entry', openTrade ? 'locked at trigger' : closedTrade ? 'trade closed' : 'next bar')}
          ${planCell('Stop loss', fmt(a.stopLoss, dec), 'sl', book?.be ? 'break-even (T1 hit)' : `${a.riskPct}% risk`)}
          ${planCell('Target 1', fmt(a.targets[0], dec), 'tp', `${rOf(a.targets[0])} · book 50%${book?.tp1Hit ? ' ✓' : ''}`)}
          ${planCell('Target 2', fmt(a.targets[1], dec), 'tp', `${rOf(a.targets[1])} · runner`)}
          ${planCell('Target 3', fmt(a.targets[2], dec), 'tp', rOf(a.targets[2]))}
          ${planCell('ATR', `${a.atrPct}%`, 'risk', `ATR ${fmt(a.atr, dec)}`)}
        </div>`;

  const pnlR = book && Number.isFinite(book.pnlR) ? book.pnlR : 0;
  const rTxt = (v) => `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}R`;
  const tradeBar = openTrade
    ? `<div class="trade-bar ${k}">
        <span class="tb-tag">LIVE ${dir}</span>
        <span>Entry ${fmt(book.entry, dec)} · now ${fmt(a.price, dec)} · <b>${rTxt(pnlR)}</b>${book.be ? ' · stop at entry' : ''}${book.tp1Hit ? ' · T1 booked' : ''}</span>
        <span class="tb-sub">Plan locked — T1 books 50% and moves the stop; exits on SL / T2 / reversal</span>
      </div>`
    : closedTrade
      ? `<div class="trade-bar exit">
          <span class="tb-tag">EXIT</span>
          <span>${esc(book.dir)} closed — ${esc(book.exit.reason)} at ${fmt(book.exit.price, dec)}</span>
          <span class="tb-sub">${rTxt(book.exit.r)} · ${hhmm(book.exit.at / 1000)} · re-scanning — next fresh setup opens after ${a.tf === '4h' || a.tf === '1d' ? '1 bar' : '2 bars'} (same side)</span>
        </div>`
      : '';

  const checklist = st
    ? `<div class="checklist">
        <div class="checklist-head">
          <h4>Market checks</h4>
          <span class="${st.passed >= 4 ? 'pos' : 'muted'}">${st.passed}/${st.evaluated} passed · ${st.evaluated && st.passed >= st.evaluated ? 'high conviction' : st.passed >= 4 ? 'strong setup' : 'needs confirmation'}</span>
        </div>
        <div class="checks">${(st.checklist || [])
          .map(
            (c) =>
              `<div class="chk ${c.ok === true ? 'ok' : c.ok === false ? 'no' : 'na'}">
                <span class="chk-ic">${c.ok === true ? '✓' : c.ok === false ? '✗' : '–'}</span>
                <span class="chk-l">${esc(c.label)}</span>
                <span class="chk-n">${esc(c.note)}</span>
              </div>`,
          )
          .join('')}</div>
      </div>`
    : '';

  const setups = Array.isArray(st?.setups) ? st.setups : [];
  const scan = setups.length
    ? `<div class="scan">
        <div class="checklist-head">
          <h4>Strategy scan</h4>
          <span>${setups.filter((s) => s.state === 'FIRED' || s.state === 'READY').length} of ${setups.length} active</span>
        </div>
        ${setups
          .map(
            (s) => `<div class="scan-row ${s.state === 'FIRED' ? 'fired' : s.state === 'READY' ? 'ready' : ''}">
              <span class="scan-name">${esc(s.name)}</span>
              <span class="scan-dir ${s.dir === 'BUY' ? 'b' : s.dir === 'SELL' ? 's' : ''}">${esc(s.dir || '—')}</span>
              <span class="scan-score"><i style="width:${Math.max(0, Math.min(100, s.score || 0))}%"></i></span>
              <span class="scan-st">${esc(s.state)}</span>
              <span class="scan-note">${esc(s.note || '')}</span>
            </div>`,
          )
          .join('')}
      </div>`
    : '';

  const reasons = (a.reasons || [])
    .map(
      (r) =>
        `<div class="reason ${r.side}"><span class="r-pts">${r.side === 'bull' ? '▲' : '▼'}</span><span>${esc(r.text)}</span></div>`,
    )
    .join('');

  const warnings = (a.warnings || []).length
    ? a.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('')
    : `<div class="no-warn">No major flags — structure and momentum aligned.</div>`;

  const neutralSub = st?.setup ? esc(st.setup) : ses ? (ses.active ? esc(ses.label) : 'session closed') : 'no trigger';

  panel.innerHTML = `
    <div class="sig-top">
      <div class="sig-id">
        <div>
          <div class="sig-symbol">${esc(d.symbol)}</div>
          <div class="sig-name">${esc(d.name || info.name || '')} · ${esc(mk)}${st ? ' · ' + esc(st.targetTf) : ''}</div>
        </div>
        <div class="pills">${pills.join('')}</div>
      </div>
      <div class="sig-dir">
        <div class="dir-block ${k}">
          <div class="dir-label">${dir === 'NEUTRAL' ? (closedTrade ? 'DONE' : 'NO TRADE') : dir}</div>
          <div class="dir-sub">${openTrade ? `${rTxt(pnlR)} · ${a.confidence}%` : dir === 'NEUTRAL' ? neutralSub : `confidence ${a.confidence}%`}</div>
        </div>
        <div class="sig-price">
          <div class="price-big">${fmt(a.price, dec)}</div>
          <div class="price-chg ${cls(a.changePct)}">${fmtPct(a.changePct)} today</div>
        </div>
      </div>
    </div>
    ${tradeBar}
    ${plan}
    ${checklist}
    ${scan}
    <div class="sig-bottom">
      <div class="reasons">
        <h4>${openTrade ? `Why ${dir}` : closedTrade ? 'Exit' : 'Setup state'}</h4>
        ${reasons || `<div class="no-warn">${esc(st?.setup || 'No trigger yet')}.</div>`}
      </div>
      <div class="warns">
        <h4>Watch out</h4>
        ${warnings}
        <div class="no-warn" style="margin-top:8px">${st ? esc(st.name) + ' · ' : ''}${a.tf} · ${a.bars} bars${ses ? ' · ' + esc(ses.window) : ''}</div>
      </div>
    </div>`;
}

const IND = [
  ['RSI 14', (a) => fmt(a.indicators.rsi, 1), (a) => (a.indicators.rsi >= 70 || a.indicators.rsi <= 30 ? 'a' : '')],
  ['Stoch RSI', (a) => (a.indicators.stochRsi == null ? '—' : `${fmt(a.indicators.stochRsi, 0)} / ${fmt(a.indicators.stochD, 0)}`), (a) => (a.indicators.stochRsi > 80 || a.indicators.stochRsi < 20 ? 'a' : '')],
  ['ADX 14', (a) => fmt(a.indicators.adx, 1), (a) => (a.indicators.adx >= 25 ? 'g' : a.indicators.adx < 15 ? 'r' : '')],
  ['+DI / −DI', (a) => `${fmt(a.indicators.pdi, 1)} / ${fmt(a.indicators.mdi, 1)}`, (a) => (a.indicators.pdi > a.indicators.mdi ? 'g' : 'r')],
  ['MACD hist', (a) => fmt(a.indicators.macdHist, a.indicators.macdHist != null && Math.abs(a.indicators.macdHist) < 1 ? 3 : 2), (a) => (a.indicators.macdHist > 0 ? 'g' : 'r')],
  ['SuperTrend', (a) => (a.indicators.supertrendDir === 1 ? 'BULL' : a.indicators.supertrendDir === -1 ? 'BEAR' : '—'), (a) => (a.indicators.supertrendDir === 1 ? 'g' : 'r')],
  ['EMA trend', (a) => a.indicators.trend, (a) => (a.indicators.trend === 'UP' ? 'g' : a.indicators.trend === 'DOWN' ? 'r' : 'a')],
  ['VWAP', (a) => fmt(a.indicators.vwap, a.decimals), (a) => (a.indicators.vwap == null ? '' : a.price > a.indicators.vwap ? 'g' : 'r')],
  ['Volume', (a) => (a.indicators.volRatio != null ? `${a.indicators.volRatio.toFixed(2)}x` : '—'), (a) => (a.indicators.volRatio > 1.3 ? 'a' : '')],
  ['Daily PP', (a) => fmt(a.indicators.pivotPP, a.decimals), (a) => (a.indicators.pivotPP == null ? '' : a.price > a.indicators.pivotPP ? 'g' : 'r')],
  ['Opening range', (a) => (a.indicators.orReady ? `${fmt(a.indicators.orLow, a.decimals)} – ${fmt(a.indicators.orHigh, a.decimals)}` : 'forming'), () => ''],
  ['Support', (a) => fmt(a.indicators.support, a.decimals), () => ''],
  ['Resistance', (a) => fmt(a.indicators.resistance, a.decimals), () => ''],
  ['Checks', (a) => (a.strategy ? `${a.strategy.passed}/${a.strategy.evaluated}` : '—'), (a) => (a.strategy && a.strategy.passed >= 4 ? 'g' : 'a')],
  ['Confidence', (a) => `${a.confidence}%`, (a) => (a.confidence >= 65 ? 'g' : a.confidence >= 50 ? 'a' : '')],
];

function renderIndicators(d) {
  const a = d.analysis;
  if (!a || !a.ok) {
    $('indGrid').innerHTML = '<div class="empty">No data</div>';
    return;
  }
  $('indGrid').innerHTML = IND.map(([label, val, klass]) => {
    const v = val(a);
    return `<div class="ind-cell"><div class="k">${label}</div><div class="v ${klass(a)}">${esc(v)}</div></div>`;
  }).join('');
}

/* ------------------------------------------------------------------ */
/* detail: signal feed                                                 */
/* ------------------------------------------------------------------ */

function renderFeed() {
  const list = state.signals || [];
  $('feedCount').textContent = list.length;
  const el = $('signalFeed');
  if (!list.length) {
    el.innerHTML = `<div class="empty">No signals yet for ${esc(state.tf)}. The feed fills as signals flip or confirm.</div>`;
    return;
  }
  el.innerHTML = list
    .map((s) => {
      const isExit = s.type === 'EXIT';
      const k = isExit ? 'exit' : s.dir === 'SELL' ? 'sell' : 'buy';
      const dec = s.decimals ?? 2;
      const t1 = Array.isArray(s.targets) && s.targets.length ? s.targets[0] : null;
      const tag = isExit ? 'EXIT' : s.type === 'ENTRY' ? 'ENTRY' : s.dir;
      const detail = isExit
        ? `${esc(s.exitReason || 'closed')} · ${fmt(s.price, dec)} · ${s.pnlR >= 0 ? '+' : ''}${Number(s.pnlR || 0).toFixed(2)}R`
        : `${fmt(s.entry ?? s.price, dec)} → SL ${fmt(s.sl, dec)} · T1 ${fmt(t1, dec)}`;
      return `<div class="feed-item" data-symbol="${esc(s.symbol)}">
        <div class="feed-time">${hhmm(s.ts / 1000)}</div>
        <div class="feed-main">
          <div class="feed-sym">${esc(s.symbol)} <span class="badge ${k}">${esc(tag)}</span></div>
          <div class="feed-detail">${detail}</div>
        </div>
        <div class="feed-conf">${isExit ? (s.pnlR >= 0 ? '+' : '') + Number(s.pnlR || 0).toFixed(1) + 'R' : s.confidence + '%'}</div>
      </div>`;
    })
    .join('');
  el.onclick = (e) => {
    const item = e.target.closest('[data-symbol]');
    if (item) selectSymbol(item.dataset.symbol);
  };
}

const seenSignals = new Set();
function notifySignal(sig) {
  if (!sig || seenSignals.has(sig.id)) return;
  seenSignals.add(sig.id);
  if (seenSignals.size > 400) seenSignals.clear();
  beep(sig.type === 'EXIT' ? 'EXIT' : sig.dir);
  const toast = $('toast');
  const dec = sig.decimals ?? 2;
  const t1 = Array.isArray(sig.targets) && sig.targets.length ? sig.targets[0] : null;
  toast.dataset.symbol = sig.symbol;
  if (sig.type === 'EXIT') {
    toast.className = 'toast show exit';
    toast.innerHTML = `<div class="toast-title">EXIT ${esc(sig.dir)} · ${esc(sig.symbol)} · ${esc(sig.tf)}</div>
      <div class="toast-body">${esc(sig.exitReason || 'closed')} at ${fmt(sig.price, dec)} · ${sig.pnlR >= 0 ? '+' : ''}${Number(sig.pnlR || 0).toFixed(2)}R</div>`;
  } else {
    toast.className = `toast show ${sig.dir === 'SELL' ? 'sell' : ''}`;
    toast.innerHTML = `<div class="toast-title">${esc(sig.type === 'ENTRY' ? 'ENTRY' : '')} ${sig.dir} · ${esc(sig.symbol)} · ${esc(sig.tf)}</div>
      <div class="toast-body">Entry ${fmt(sig.entry ?? sig.price, dec)} · SL ${fmt(sig.sl, dec)} · T1 ${fmt(t1, dec)} · ${sig.confidence}%</div>`;
  }
  clearTimeout(notifySignal.t);
  notifySignal.t = setTimeout(hideToast, 7000);
}

function hideToast() {
  $('toast').className = 'toast';
}

let audioCtx = null;
function beep(dir) {
  if (!state.sound) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g);
    g.connect(audioCtx.destination);
    o.type = 'sine';
    if (dir === 'BUY') {
      o.frequency.setValueAtTime(620, now);
      o.frequency.setValueAtTime(940, now + 0.1);
    } else if (dir === 'EXIT') {
      o.frequency.setValueAtTime(880, now);
      o.frequency.setValueAtTime(520, now + 0.12);
      o.frequency.setValueAtTime(400, now + 0.24);
    } else {
      o.frequency.setValueAtTime(540, now);
      o.frequency.setValueAtTime(320, now + 0.1);
    }
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.14, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    o.start(now);
    o.stop(now + 0.36);
  } catch {
    /* audio unavailable */
  }
}

/* ------------------------------------------------------------------ */
/* detail: backtest                                                    */
/* ------------------------------------------------------------------ */

function renderBacktest(bt, a) {
  const panel = $('backtestPanel');
  const strat = a && a.ok ? a.strategy : null;
  const hint = bt && bt.ok ? `${bt.bars} bars · ${bt.tf}${strat ? ' · ' + strat.name : ''}` : '—';
  if (!bt || !bt.ok || !bt.trades) {
    panel.innerHTML = `<div class="panel-head"><h2>Backtest</h2><span class="hint" id="btHint">${esc(hint)}</span></div>
      <div class="empty">${esc(bt?.reason || bt?.note || 'Run a symbol to see strategy stats on its history.')}</div>`;
    return;
  }
  const cell = (k, v, c) => `<div class="bt-cell"><div class="k">${k}</div><div class="v ${c || ''}">${v}</div></div>`;
  const exits = bt.byReason
    ? Object.entries(bt.byReason)
        .map(([reason, n]) => `${esc(reason)} ${n}`)
        .join(' · ')
    : '';
  panel.innerHTML = `
    <div class="panel-head"><h2>Backtest</h2><span class="hint" id="btHint">${esc(hint)}</span></div>
    <div class="bt-grid">
      ${cell('Trades', bt.trades)}
      ${cell('Win rate', `${bt.winRate}%`, bt.winRate >= 50 ? 'g' : 'r')}
      ${cell('Total R', `${bt.totalR > 0 ? '+' : ''}${bt.totalR}`, bt.totalR > 0 ? 'g' : 'r')}
      ${cell('Avg R', `${bt.avgR > 0 ? '+' : ''}${bt.avgR}`, bt.avgR > 0 ? 'g' : 'r')}
      ${cell('Profit factor', bt.profitFactor)}
      ${cell('Max DD', `${bt.maxDrawdownR}R`, 'r')}
      ${cell('Buy & hold', `${bt.buyHoldPct}%`, bt.buyHoldPct > 0 ? 'g' : 'r')}
      ${cell('Avg hold', `${bt.avgBars} bars`)}
    </div>
    <div class="bt-curve"><canvas id="btCurve"></canvas></div>
    <div class="bt-note">
      Next-bar entry on a confirmed ${esc(strat?.name || 'strategy')} signal · 50% booked at T1 with stop to break-even,
      runner exits at T2 / opposite signal / 40-bar time stop.${exits ? `<br>Exits: ${exits}.` : ''}
      Sample: <b>${esc(bt.sample)}</b>. Past performance does not guarantee future results.
    </div>`;
  drawCurve($('btCurve'), bt.curve);
}

function drawCurve(canvas, curve) {
  if (!canvas || !curve || !curve.length) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || 260;
  const h = rect.height || 56;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const vals = curve.map((p) => p.r);
  let min = Math.min(0, ...vals);
  let max = Math.max(0, ...vals);
  if (max === min) max = min + 1;
  const pad = (max - min) * 0.12;
  min -= pad;
  max += pad;
  const x = (i) => (i / Math.max(1, vals.length - 1)) * (w - 4) + 2;
  const y = (v) => h - 4 - ((v - min) / (max - min)) * (h - 8);

  ctx.strokeStyle = 'rgba(120,140,170,0.25)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(0, y(0));
  ctx.lineTo(w, y(0));
  ctx.stroke();
  ctx.setLineDash([]);

  const up = vals[vals.length - 1] >= 0;
  ctx.beginPath();
  vals.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = up ? '#17c784' : '#ef4643';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.lineTo(x(vals.length - 1), y(0));
  ctx.lineTo(x(0), y(0));
  ctx.closePath();
  ctx.fillStyle = up ? 'rgba(23,199,132,0.12)' : 'rgba(239,70,67,0.12)';
  ctx.fill();
}

/* ------------------------------------------------------------------ */
/* chart                                                               */
/* ------------------------------------------------------------------ */

const chart = {
  cv: null,
  ctx: null,
  candles: [],
  series: {},
  analysis: null,
  meta: null,
  view: 150,
  w: 0,
  h: 0,
  hoverIdx: -1,
  hoverY: 0,
  show: { ema9: true, ema21: true, ema50: true, st: true, vwap: false },
  PAD: { l: 8, r: 76, t: 10, b: 24 },
};

const LG = [
  ['ema9', 'EMA 9', '#4c9dff'],
  ['ema21', 'EMA 21', '#f2b134'],
  ['ema50', 'EMA 50', '#a78bfa'],
  ['st', 'SuperTrend', '#f472b6'],
  ['vwap', 'VWAP', '#22d3ee'],
];

function setupChart() {
  chart.cv = $('chart');
  chart.ctx = chart.cv.getContext('2d');
  layoutChart();

  const ro = new ResizeObserver(() => {
    layoutChart();
    drawChart();
  });
  ro.observe(chart.cv.parentElement);

  chart.cv.addEventListener('mousemove', (e) => {
    const rect = chart.cv.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const g = geom();
    if (!g) return;
    const idx = g.start + Math.floor((mx - chart.PAD.l) / g.step);
    chart.hoverIdx = idx >= g.start && idx < chart.candles.length ? idx : -1;
    chart.hoverY = my;
    drawChart();
    updateChartTip(chart.hoverIdx);
  });
  chart.cv.addEventListener('mouseleave', () => {
    chart.hoverIdx = -1;
    $('chartTip').classList.remove('show');
    drawChart();
  });
  chart.cv.addEventListener(
    'wheel',
    (e) => {
      if (!chart.candles.length) return;
      e.preventDefault();
      const maxView = clamp(chart.candles.length, 40, 320);
      chart.view = clamp(chart.view + (e.deltaY > 0 ? 25 : -25), 40, maxView);
      drawChart();
    },
    { passive: false },
  );
}

function initLegend() {
  $('chartLegend').innerHTML = LG.map(
    ([k, label, color]) =>
      `<span class="lg-item ${chart.show[k] ? '' : 'off'}" data-lg="${k}"><span class="lg-dot" style="background:${color}"></span>${label}</span>`,
  ).join('');
  $('chartLegend').onclick = (e) => {
    const item = e.target.closest('[data-lg]');
    if (!item) return;
    const k = item.dataset.lg;
    chart.show[k] = !chart.show[k];
    item.classList.toggle('off', !chart.show[k]);
    drawChart();
  };
}

function layoutChart() {
  const cv = chart.cv;
  if (!cv) return;
  const rect = cv.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  chart.w = Math.max(1, rect.width);
  chart.h = Math.max(1, rect.height);
  cv.width = Math.round(chart.w * dpr);
  cv.height = Math.round(chart.h * dpr);
  chart.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function geom() {
  const { candles } = chart;
  if (!candles.length) return null;
  const count = Math.min(chart.view, candles.length);
  const start = candles.length - count;
  const plotW = chart.w - chart.PAD.l - chart.PAD.r;
  const plotH = chart.h - chart.PAD.t - chart.PAD.b;
  let maxVol = 0;
  for (let i = start; i < candles.length; i++) maxVol = Math.max(maxVol, candles[i].v || 0);
  const hasVol = maxVol > 0;
  const volH = hasVol ? Math.max(26, Math.round(plotH * 0.13)) : 0;
  const priceH = plotH - volH - (hasVol ? 10 : 0);
  return { count, start, plotW, plotH, volH, priceH, maxVol, hasVol };
}

function setChartData(d) {
  if (!d) {
    chart.candles = [];
    chart.series = {};
    chart.analysis = null;
    chart.meta = null;
    $('chartTitle').textContent = '—';
    $('chartEmpty').style.display = 'grid';
    $('chartEmpty').textContent = 'No chart data';
    drawChart();
    return;
  }
  chart.candles = d.candles || [];
  chart.series = d.series || {};
  chart.analysis = d.analysis?.ok ? d.analysis : null;
  chart.meta = d;
  chart.view = clamp(chart.view, 40, clamp(chart.candles.length, 40, 320));

  const a = d.analysis;
  const dec = a?.decimals ?? 2;
  $('chartTitle').innerHTML = `
    <span>${esc(d.symbol)}</span>
    <span class="dim" style="font-weight:400">${esc(d.name || '')}</span>
    <span class="ct-tf">${esc(d.tf)}</span>
    <span class="ct-price ${cls(a?.changePct)}">${fmt(a?.price, dec)} <span style="font-size:10px">${fmtPct(a?.changePct)}</span></span>
    <span class="dim" style="font-size:9.5px">${esc(d.source ? d.source.toUpperCase() : '')} · ${esc(d.exchange || '')}</span>`;
  drawChart();
}

function drawChart() {
  const ctx = chart.ctx;
  if (!ctx || !chart.w) return;
  const { w, h, PAD } = chart;
  ctx.clearRect(0, 0, w, h);
  const g = geom();
  if (!g || !chart.candles.length) {
    $('chartEmpty').style.display = 'grid';
    return;
  }
  $('chartEmpty').style.display = 'none';

  const { count, start, plotW, priceH, volH } = g;
  const candles = chart.candles;
  const a = chart.analysis;
  const dec = a?.decimals ?? 2;

  const levels = [];
  if (a) {
    if (a.entry != null) levels.push({ p: a.entry, color: '#9fb4cc', label: 'ENTRY', dash: [5, 4] });
    if (a.stopLoss != null) levels.push({ p: a.stopLoss, color: '#ef4643', label: 'SL', dash: [4, 4] });
    (a.targets || []).forEach((t, i) =>
      levels.push({ p: t, color: '#17c784', label: `T${i + 1}`, dash: [4, 4], soft: i > 0 }),
    );
    const ind = a.indicators || {};
    if (ind.orReady && ind.orHigh != null) levels.push({ p: ind.orHigh, color: '#f2b134', label: 'ORH', dash: [2, 4], soft: true });
    if (ind.orReady && ind.orLow != null) levels.push({ p: ind.orLow, color: '#f2b134', label: 'ORL', dash: [2, 4], soft: true });
    if (ind.pivotPP != null) levels.push({ p: ind.pivotPP, color: '#8b9bb4', label: 'PP', dash: [1, 5], soft: true });
  }

  let min = Infinity;
  let max = -Infinity;
  for (let i = start; i < candles.length; i++) {
    if (candles[i].l < min) min = candles[i].l;
    if (candles[i].h > max) max = candles[i].h;
  }
  for (const L of levels) {
    if (Number.isFinite(L.p)) {
      min = Math.min(min, L.p);
      max = Math.max(max, L.p);
    }
  }
  const cushion = (max - min) * 0.07 || Math.abs(max || 1) * 0.002;
  min -= cushion;
  max += cushion;

  const y = (p) => PAD.t + ((max - p) / (max - min)) * priceH;
  const step = plotW / count;
  const x = (i) => PAD.l + (i - start + 0.5) * step;
  const bottom = PAD.t + g.plotH;

  // grid + price axis
  ctx.font = '9px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  for (let k = 0; k <= 4; k++) {
    const price = max - ((max - min) * k) / 4;
    const yy = Math.round(y(price)) + 0.5;
    ctx.strokeStyle = 'rgba(30, 44, 62, 0.55)';
    ctx.beginPath();
    ctx.moveTo(PAD.l, yy);
    ctx.lineTo(w - PAD.r, yy);
    ctx.stroke();
    ctx.fillStyle = '#5a6b82';
    ctx.textAlign = 'left';
    ctx.fillText(axisFmt(price), w - PAD.r + 6, yy);
  }

  // time axis
  const labelEvery = Math.max(1, Math.ceil(count / 6));
  ctx.textAlign = 'center';
  for (let i = start; i < candles.length; i += labelEvery) {
    const xx = x(i);
    ctx.strokeStyle = 'rgba(30, 44, 62, 0.4)';
    ctx.beginPath();
    ctx.moveTo(Math.round(xx) + 0.5, PAD.t);
    ctx.lineTo(Math.round(xx) + 0.5, bottom);
    ctx.stroke();
    ctx.fillStyle = '#4e5e74';
    ctx.fillText(chartTime(candles[i].t, chart.meta?.tf || state.tf), xx, h - PAD.b + 13);
  }

  // volume
  const maxVol = g.maxVol;
  if (maxVol > 0) {
    const cw = Math.max(1, Math.min(13, step * 0.62));
    for (let i = start; i < candles.length; i++) {
      const c = candles[i];
      const vh = ((c.v || 0) / maxVol) * (volH - 4);
      ctx.fillStyle = c.c >= c.o ? 'rgba(23,199,132,0.26)' : 'rgba(239,70,67,0.26)';
      ctx.fillRect(x(i) - cw / 2, bottom - vh, cw, vh);
    }
  }

  // candles
  const cw = Math.max(1.2, Math.min(13, step * 0.62));
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const up = c.c >= c.o;
    const color = up ? '#17c784' : '#ef4643';
    const xi = x(i);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(xi) + 0.5, y(c.h));
    ctx.lineTo(Math.round(xi) + 0.5, y(c.l));
    ctx.stroke();
    const yO = y(c.o);
    const yC = y(c.c);
    const top = Math.min(yO, yC);
    const bh = Math.max(1, Math.abs(yC - yO));
    ctx.fillRect(xi - cw / 2, top, cw, bh);
  }

  // overlays
  const lineFor = (arr, color, width, dash) => {
    if (!arr || !arr.length) return;
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash || []);
    let started = false;
    for (let i = start; i < candles.length; i++) {
      const v = arr[i];
      if (v == null || !Number.isFinite(v)) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(x(i), y(v));
        started = true;
      } else ctx.lineTo(x(i), y(v));
    }
    ctx.stroke();
    ctx.restore();
  };

  if (chart.show.ema9) lineFor(chart.series.ema9, '#4c9dff', 1.1);
  if (chart.show.ema21) lineFor(chart.series.ema21, '#f2b134', 1.1);
  if (chart.show.ema50) lineFor(chart.series.ema50, '#a78bfa', 1.1);
  if (chart.show.st) lineFor(chart.series.supertrend, '#f472b6', 1.2, [5, 3]);
  if (chart.show.vwap) lineFor(chart.series.vwap, '#22d3ee', 1.1, [2, 3]);

  // SL / TP / entry levels
  for (const L of levels) {
    const yy = Math.round(y(L.p)) + 0.5;
    ctx.save();
    ctx.globalAlpha = L.soft ? 0.5 : 0.85;
    ctx.strokeStyle = L.color;
    ctx.setLineDash(L.dash);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD.l, yy);
    ctx.lineTo(w - PAD.r, yy);
    ctx.stroke();
    ctx.restore();

    const text = `${L.label} ${fmt(L.p, dec)}`;
    ctx.font = '9px ui-monospace, monospace';
    const tw = ctx.measureText(text).width;
    const bx = Math.max(PAD.l + 2, w - PAD.r - tw - 10);
    ctx.fillStyle = 'rgba(8, 13, 20, 0.85)';
    ctx.fillRect(bx - 3, yy - 12, tw + 6, 11);
    ctx.fillStyle = L.color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx, yy - 6.5);
  }

  // last price tag
  const last = candles[candles.length - 1];
  const ly = Math.round(y(last.c)) + 0.5;
  const lastUp = last.c >= last.o;
  ctx.save();
  ctx.strokeStyle = lastUp ? 'rgba(23,199,132,0.55)' : 'rgba(239,70,67,0.55)';
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(PAD.l, ly);
  ctx.lineTo(w - PAD.r, ly);
  ctx.stroke();
  ctx.restore();

  const priceText = fmt(last.c, dec);
  ctx.font = 'bold 9px ui-monospace, monospace';
  const pw = ctx.measureText(priceText).width + 10;
  ctx.fillStyle = lastUp ? '#125c41' : '#6e2422';
  ctx.fillRect(w - PAD.r + 2, ly - 7, Math.max(pw, 0), 14);
  ctx.fillStyle = lastUp ? '#7ff0c0' : '#ffb3b0';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(priceText, w - PAD.r + 6, ly + 0.5);

  // crosshair
  if (chart.hoverIdx >= start && chart.hoverIdx < candles.length) {
    const i = chart.hoverIdx;
    const hx = Math.round(x(i)) + 0.5;
    ctx.strokeStyle = 'rgba(150,175,205,0.35)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx, PAD.t);
    ctx.lineTo(hx, bottom);
    ctx.stroke();
    if (chart.hoverY > PAD.t && chart.hoverY < PAD.t + priceH) {
      const hy = Math.round(chart.hoverY) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.l, hy);
      ctx.lineTo(w - PAD.r, hy);
      ctx.stroke();
      const price = max - ((hy - PAD.t) / priceH) * (max - min);
      ctx.setLineDash([]);
      ctx.fillStyle = '#16212e';
      ctx.fillRect(w - PAD.r + 2, hy - 7, PAD.r - 4, 14);
      ctx.fillStyle = '#c7d6e8';
      ctx.textAlign = 'left';
      ctx.fillText(axisFmt(price), w - PAD.r + 6, hy);
    }
    ctx.setLineDash([]);
  }
}

function updateChartTip(idx) {
  const tip = $('chartTip');
  if (idx < 0 || !chart.candles[idx]) {
    tip.classList.remove('show');
    return;
  }
  const c = chart.candles[idx];
  const dec = chart.analysis?.decimals ?? 2;
  const d = new Date(c.t * 1000);
  tip.innerHTML = `
    <div class="t-row"><span>${d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></div>
    <div class="t-row"><span>O</span><b>${fmt(c.o, dec)}</b></div>
    <div class="t-row"><span>H</span><b>${fmt(c.h, dec)}</b></div>
    <div class="t-row"><span>L</span><b>${fmt(c.l, dec)}</b></div>
    <div class="t-row"><span>C</span><b class="${c.c >= c.o ? 'pos' : 'neg'}">${fmt(c.c, dec)}</b></div>
    <div class="t-row"><span>V</span><b>${compact(c.v)}</b></div>`;
  tip.classList.add('show');
}

function axisFmt(p) {
  const abs = Math.abs(p);
  if (abs >= 1000) return p.toFixed(0);
  if (abs >= 100) return p.toFixed(1);
  if (abs >= 1) return p.toFixed(3);
  if (abs >= 0.01) return p.toFixed(5);
  return p.toFixed(7);
}

function compact(v) {
  if (!Number.isFinite(v) || v === 0) return '0';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(2);
}

/* ------------------------------------------------------------------ */

function renderAll() {
  renderTable();
  renderCards();
  const p = pulseFromRows(state.rows);
  renderPulse(p);
  renderTicker();
  renderFeed();
}

function pulseFromRows(rows) {
  const live = rows.filter((r) => r.signal);
  const c = (s) => live.filter((r) => r.signal === s).length;
  return {
    buy: c('BUY'),
    sell: c('SELL'),
    neutral: c('NEUTRAL'),
    up: live.filter((r) => (r.chgPct ?? 0) > 0).length,
    down: live.filter((r) => (r.chgPct ?? 0) < 0).length,
    movers: live
      .filter((r) => Number.isFinite(r.chgPct))
      .sort((a, b) => Math.abs(b.chgPct) - Math.abs(a.chgPct))
      .slice(0, 3)
      .map((r) => ({ symbol: r.symbol, chgPct: r.chgPct })),
  };
}
