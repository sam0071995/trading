import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MARKETS, TFS, aliasFor, detectMarket, marketLabel } from './src/markets.js';
import {
  cacheAge,
  getCandles,
  peekCache,
  refreshTickers,
  tickerFor,
  ttlFor,
} from './src/providers.js';
import { analyze, computeContext, priceDecimals } from './src/strategy.js';
import { isSmcSymbol } from './src/strategies.js';
import { backtest } from './src/backtest.js';
import { updateBook, bookView, snapshotBooks, restoreBooks } from './src/tradebook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const SIGNALS_FILE = path.join(DATA_DIR, 'signals.json');
const WATCH_FILE = path.join(DATA_DIR, 'watchlist.json');
const TRADES_FILE = path.join(DATA_DIR, 'trades.json');
const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* Symbol registry                                                     */
/* ------------------------------------------------------------------ */

const symbolIndex = new Map();
for (const m of MARKETS) {
  for (const [s, n] of m.symbols) {
    symbolIndex.set(s, { symbol: s, name: n, market: m.id, custom: false });
  }
}

let customSymbols = [];
try {
  customSymbols = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8'));
  if (!Array.isArray(customSymbols)) customSymbols = [];
} catch {
  customSymbols = [];
}
for (const info of customSymbols) {
  if (info && info.symbol && !symbolIndex.has(info.symbol)) symbolIndex.set(info.symbol, { ...info, custom: true });
}

const saveWatch = () =>
  fs.writeFile(WATCH_FILE, JSON.stringify([...symbolIndex.values()].filter((s) => s.custom), null, 2), () => {});

const cryptoList = () => [...symbolIndex.values()].filter((i) => detectMarket(i.symbol) === 'crypto');
const allSymbols = () => [...symbolIndex.values()];
const watched = (s) => !!s && symbolIndex.has(s.symbol);

function tzFor(market) {
  const m = MARKETS.find((x) => x.id === market);
  return m ? m.tzOffset : 0;
}

function normalizeSymbol(raw) {
  let s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9.^=\-]{1,24}$/.test(s)) return null;
  if (/^[A-Z]{6}$/.test(s) && /^(USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|INR)/.test(s)) s = `${s}=X`;
  return s;
}

function resolveInfo(symbol) {
  const known = symbolIndex.get(symbol);
  if (known) return known;
  const alias = aliasFor(symbol);
  const m = detectMarket(symbol);
  return {
    symbol,
    name: alias?.name || symbol,
    market: m === 'other' ? 'custom' : m,
    custom: true,
  };
}

/* ------------------------------------------------------------------ */
/* Analysis with memoisation                                           */
/* ------------------------------------------------------------------ */

const analysisCache = new Map();

/* BTC/ETH SMC engine needs 15m and 1H context for the 5m entry chart. */
const htfCache = new Map();

function htfFor(symbol) {
  const e15 = peekCache(symbol, '15m');
  const e60 = peekCache(symbol, '1h');
  if (!e15 || !e60) return null;
  const key = `${symbol}|${e15.at}|${e60.at}`;
  let hit = htfCache.get(key);
  if (!hit) {
    const build = (entry, tf, sec) => {
      const cx = computeContext(entry.candles, { tf, tzOffsetMinutes: 0 });
      return { sec, bars: entry.candles, e50: cx.e50, e200: cx.e200 || new Array(entry.candles.length).fill(null) };
    };
    hit = { m15: build(e15, '15m', 900), h1: build(e60, '1h', 3600), stamp: key };
    htfCache.set(key, hit);
    if (htfCache.size > 200) htfCache.clear();
  }
  return hit;
}

async function ensureHtf(symbol, tf) {
  if (tf !== '5m' || !isSmcSymbol(symbol)) return null;
  await Promise.allSettled([getCandles(symbol, '15m'), getCandles(symbol, '1h')]);
  return htfFor(symbol);
}

function analysisFor(info, tf) {
  const entry = peekCache(info.symbol, tf);
  if (!entry) return { pending: true };
  const tick = tickerFor(info.symbol);
  const price = tick?.price ?? entry.meta?.price ?? entry.candles[entry.candles.length - 1].c;
  const changePct = tick?.chgPct ?? entry.meta?.changePct ?? null;
  const minute = Math.floor(Date.now() / 60000);
  const htf = tf === '5m' && isSmcSymbol(info.symbol) ? htfFor(info.symbol) : null;
  const key = `${info.symbol}|${tf}|${entry.at}|${price}|${minute}|${htf?.stamp || ''}`;
  let a = analysisCache.get(key);
  if (!a) {
    a = analyze(entry.candles, {
      tf,
      symbol: info.symbol,
      market: info.market,
      livePrice: price,
      prevClose: entry.meta?.prevClose ?? null,
      changePct,
      tzOffsetMinutes: tzFor(info.market),
      nowSec: Math.floor(Date.now() / 1000),
      htf,
    });
    analysisCache.set(key, a);
    if (analysisCache.size > 4000) analysisCache.clear();
  }
  return { entry, analysis: a, price, changePct };
}

function buildRows(tf) {
  const rows = [];
  for (const info of allSymbols()) {
    const res = analysisFor(info, tf);
    if (res.pending) {
      rows.push({ symbol: info.symbol, name: info.name, market: info.market, pending: true });
      continue;
    }
    const { entry, analysis: a, price, changePct } = res;
    if (!a || !a.ok) {
      rows.push({
        symbol: info.symbol,
        name: info.name,
        market: info.market,
        price: Number.isFinite(price) ? price : null,
        error: a?.reason || entry?.error || 'analysis failed',
      });
      continue;
    }
    const book = updateBook(info, tf, a, price, emitTrade);
    saveBooks();
    const view = bookView(book, price);
    rows.push({
      symbol: info.symbol,
      name: info.name,
      market: info.market,
      price: a.price,
      chgPct: a.changePct,
      signal: view.status === 'OPEN' ? view.dir : 'NEUTRAL',
      state: view.status === 'FLAT' ? 'NONE' : view.status,
      confidence: view.status === 'OPEN' ? view.confidence : 0,
      grade: view.status === 'OPEN' ? view.grade : 'D',
      score: view.status === 'OPEN' ? (view.dir === 'BUY' ? view.confidence : -view.confidence) : 0,
      entry: view.status === 'FLAT' ? null : view.entry,
      sl: view.status === 'FLAT' ? null : view.sl,
      targets: view.status === 'FLAT' ? [] : view.targets,
      riskPct: view.status === 'FLAT' ? null : view.riskPct,
      atrPct: a.atrPct,
      trend: a.indicators.trend,
      rsi: a.indicators.rsi,
      adx: a.indicators.adx,
      move: a.move,
      strategy: a.strategy,
      book: view,
      topReason: view.status === 'OPEN' ? callTopReason(book) : a.reasons[0]?.text || null,
      warnings: a.warnings,
      decimals: a.decimals,
      source: entry.source,
      stale: !!entry.stale || !!entry.error,
      age: Date.now() - entry.at,
      updatedAt: Date.now(),
      time: a.time,
    });
  }
  return rows;
}

function pulse(rows) {
  const live = rows.filter((r) => !r.pending && r.signal);
  const count = (s) => live.filter((r) => r.signal === s).length;
  const up = live.filter((r) => (r.chgPct ?? 0) > 0).length;
  const down = live.filter((r) => (r.chgPct ?? 0) < 0).length;
  return {
    total: live.length,
    buy: count('BUY'),
    sell: count('SELL'),
    neutral: count('NEUTRAL'),
    up,
    down,
    movers: live
      .filter((r) => Number.isFinite(r.chgPct))
      .sort((a, b) => Math.abs(b.chgPct) - Math.abs(a.chgPct))
      .slice(0, 5)
      .map((r) => ({ symbol: r.symbol, name: r.name, chgPct: r.chgPct })),
  };
}

/* ------------------------------------------------------------------ */
/* Signal log                                                          */
/* ------------------------------------------------------------------ */

const MAX_SIGNALS = 12000;
const REPORT_SYMBOLS = new Set(['GC=F', 'BTCUSDT', 'ETHUSDT', 'BTC-USD', 'ETH-USD', 'XAUUSD=X']);
let signals = [];
try {
  const raw = JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8'));
  // Entries from the pre-playbook scoring engine are not comparable; keep only
  // signals produced by the strategy engine (they always carry `strategy`).
  // Signals from markets that are no longer on the watchlist are dropped, except
  // the legacy provider symbols folded into the XAUUSD/BTCUSD/ETHUSD reports.
  if (Array.isArray(raw)) {
    signals = raw
      .filter((s) => s && s.strategy && (symbolIndex.has(s.symbol) || REPORT_SYMBOLS.has(s.symbol)))
      .slice(0, MAX_SIGNALS);
  }
} catch {
  signals = [];
}

let saveTimer = null;
function saveSignals() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(SIGNALS_FILE, JSON.stringify(signals.slice(0, MAX_SIGNALS)), () => {});
  }, 1500);
}
if (signals.length) saveSignals();

try {
  const raw = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  const kept = Array.isArray(raw) ? raw.filter((row) => row?.key && symbolIndex.has(row.key.split('|')[0])) : raw;
  const n = restoreBooks(kept);
  if (n) console.log(`[tradebook] restored ${n} trades`);
} catch {
  /* first run */
}

let tradesTimer = null;
function saveBooks() {
  clearTimeout(tradesTimer);
  tradesTimer = setTimeout(() => {
    fs.writeFile(TRADES_FILE, JSON.stringify(snapshotBooks()), () => {});
  }, 1000);
}

/* ------------------------------------------------------------------ */
/* Trade book — one fixed trade per symbol/timeframe                   */
/*                                                                     */
/* A signal is opened once on a confirmed closed bar and its entry,    */
/* stop and targets are frozen. It stays open until the stop/target is */
/* reached, the session closes, or a confirmed opposite signal fires.  */
/* ------------------------------------------------------------------ */

const lastEmit = new Map();
let tradeSeq = 0;
for (const tf of TFS) lastEmit.set(tf, Date.now());

function emitTrade(tf, type, b, info, price, extra = {}) {
  const sig = {
    id: `${Date.now()}-${++tradeSeq}`,
    ts: Date.now(),
    type,
    tf,
    symbol: info.symbol,
    name: info.name,
    market: info.market,
    dir: b.dir,
    state: type === 'EXIT' ? 'CLOSED' : 'OPEN',
    price,
    entry: b.entry,
    sl: b.sl,
    targets: b.targets,
    riskPct: b.riskPct,
    confidence: b.confidence,
    grade: b.grade,
    decimals: priceDecimals(price),
    strategy: b.strategy,
    ...extra,
  };
  signals.unshift(sig);
  signals = signals.slice(0, MAX_SIGNALS);
  saveSignals();
}

const callTopReason = (b) =>
  b.reasons?.[0]?.text || (b.dir === 'BUY' ? 'Long trade active — plan locked' : 'Short trade active — plan locked');

function decorateAnalysis(a, b, price) {
  const view = { ...a, book: bookView(b, price) };
  const open = b && b.status === 'OPEN';
  const closed = b && b.status === 'CLOSED';
  const snap = open || closed
    ? {
        id: b.strategy?.id,
        name: b.strategy?.name,
        checklist: b.checklist,
        passed: b.passed,
        evaluated: b.evaluated,
        setup: b.setup,
      }
    : null;

  if (open) {
    view.direction = b.dir;
    view.signal = b.dir;
    view.state = 'OPEN';
    view.confidence = b.confidence;
    view.grade = b.grade;
    view.score = b.dir === 'BUY' ? b.confidence : -b.confidence;
    view.entry = b.entry;
    view.stopLoss = view.book?.stop ?? (b.be ? b.entry : b.sl);
    view.targets = b.targets;
    view.riskPct = b.riskPct;
    view.rr = b.rr;
    view.reasons = b.reasons || [];
  } else {
    view.direction = 'NEUTRAL';
    view.signal = 'NEUTRAL';
    view.state = closed ? 'CLOSED' : 'NONE';
    view.confidence = 0;
    view.grade = 'D';
    view.score = 0;
    if (closed) {
      view.entry = b.entry;
      view.stopLoss = b.sl;
      view.targets = b.targets;
      view.riskPct = b.riskPct;
      view.rr = b.rr;
      view.reasons = b.reasons || [];
    } else {
      view.entry = null;
      view.stopLoss = null;
      view.targets = [];
      view.riskPct = null;
      view.rr = null;
    }
  }
  if (open && snap && view.strategy) view.strategy = { ...view.strategy, ...snap, session: view.strategy.session };
  return view;
}

/* ------------------------------------------------------------------ */
/* Refresh loop                                                        */
/* ------------------------------------------------------------------ */

const cursors = new Map();
const warmed = new Set();

async function refreshSlice(tf, count) {
  const list = allSymbols();
  if (!list.length) return;
  const start = cursors.get(tf) || 0;
  const jobs = [];
  for (let k = 0; k < count; k++) {
    const info = list[(start + k) % list.length];
    if (cacheAge(info.symbol, tf) >= ttlFor(tf)) jobs.push(getCandles(info.symbol, tf).catch(() => null));
    if (tf === '5m' && isSmcSymbol(info.symbol)) {
      if (cacheAge(info.symbol, '15m') >= ttlFor('15m')) jobs.push(getCandles(info.symbol, '15m').catch(() => null));
      if (cacheAge(info.symbol, '1h') >= ttlFor('1h')) jobs.push(getCandles(info.symbol, '1h').catch(() => null));
    }
  }
  cursors.set(tf, (start + count) % list.length);
  await Promise.allSettled(jobs);
}

async function warmTf(tf) {
  if (warmed.has(tf)) return;
  warmed.add(tf);
  const queue = allSymbols();
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const info = queue.shift();
      try {
        await getCandles(info.symbol, tf);
      } catch {
        /* keep going */
      }
    }
  });
  await Promise.all(workers);
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

const clients = new Set();

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* client is gone */
  }
}

function snapshotFor(tf) {
  const rows = buildRows(tf);
  const now = Date.now();
  return {
    type: 'snapshot',
    tf,
    ts: now,
    rows,
    pulse: pulse(rows),
    signals: signals.filter((s) => s.tf === tf && watched(s)).slice(0, 50),
    fresh: signals.filter((s) => s.tf === tf && watched(s) && now - s.ts < 15000).slice(0, 20),
  };
}

let ticking = false;
async function tick() {
  if (ticking || !clients.size) return;
  ticking = true;
  try {
    const tfs = new Set([...clients].map((c) => c.tf));
    for (const tf of tfs) {
      await refreshSlice(tf, 8);
    }
    const crypto = cryptoList();
    if (crypto.length) refreshTickers(crypto.map((c) => c.symbol)).catch(() => {});
    for (const tf of tfs) {
      const payload = snapshotFor(tf);
      const cutoff = lastEmit.get(tf) ?? Date.now();
      const fresh = signals.filter((s) => s.tf === tf && watched(s) && s.ts > cutoff);
      lastEmit.set(tf, Date.now());
      for (const c of clients) {
        if (c.tf !== tf) continue;
        for (const sig of fresh) sseSend(c.res, 'signal', sig);
        sseSend(c.res, 'snapshot', payload);
      }
    }
  } catch (err) {
    console.error('[tick]', err.message);
  } finally {
    ticking = false;
  }
}

setInterval(tick, 4000);
setInterval(() => {
  for (const c of clients) {
    try {
      c.res.write(': ping\n\n');
    } catch {
      clients.delete(c);
    }
  }
}, 20000);

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

function configPayload() {
  return {
    tfs: TFS,
    markets: MARKETS.map((m) => ({ id: m.id, label: m.label, hours: m.hours })),
    symbols: allSymbols().map((s) => ({ symbol: s.symbol, name: s.name, market: s.market, custom: !!s.custom })),
    dataSources: {
      crypto: 'Binance / Bybit / OKX (live tickers + candles)',
      forex: 'Yahoo Finance',
      india: 'Yahoo Finance (NSE)',
      commodities: 'Yahoo Finance futures (spot aliases: XAUUSD→GC=F, XAGUSD→SI=F, WTI→CL=F, …)',
    },
  };
}

const backtestCache = new Map();

function backtestFor(symbol, tf, htf = null) {
  const entry = peekCache(symbol, tf);
  if (!entry) return { ok: false, reason: 'No cached history yet' };
  const key = `${symbol}|${tf}|${entry.at}|${htf?.stamp || ''}`;
  const hit = backtestCache.get(key);
  if (hit) return hit;
  const info = resolveInfo(symbol);
  const res = backtest(entry.candles, {
    tf,
    tzOffsetMinutes: tzFor(info.market),
    symbol,
    market: info.market,
    htf,
  });
  backtestCache.set(key, res);
  if (backtestCache.size > 300) backtestCache.clear();
  return res;
}

/* ------------------------------------------------------------------ */
/* Performance report                                                  */
/* ------------------------------------------------------------------ */

const IST_MS = 330 * 60000;
const istDayOf = (ts) => new Date(ts + IST_MS).toISOString().slice(0, 10);
const dayMs = (iso) => Date.parse(`${iso}T00:00:00+05:30`);
const rOf = (e) => (Number.isFinite(e.pnlR) ? e.pnlR : 0);
const r2 = (v) => (Number.isFinite(v) ? Number(v.toFixed(2)) : null);
const pct1 = (v) => (Number.isFinite(v) ? Number(v.toFixed(1)) : null);

// Old provider symbols fold into the current report names.
const reportSymbol = (sym) => {
  if (['BTCUSD', 'BTCUSDT', 'BTC-USD'].includes(sym)) return 'BTCUSD';
  if (['ETHUSD', 'ETHUSDT', 'ETH-USD'].includes(sym)) return 'ETHUSD';
  if (['XAUTUSD', 'XAUTUSDT', 'XAUT-USD'].includes(sym)) return 'XAUTUSD';
  if (['XAUUSD', 'XAUUSD=X', 'GC=F'].includes(sym)) return 'XAUUSD';
  return sym;
};

const REPORT_GROUPS = [
  {
    id: 'india',
    label: 'India',
    test: (s) => s.market === 'india' || (s.symbol || '').startsWith('^') || (s.symbol || '').endsWith('.NS') || (s.symbol || '').endsWith('.BO'),
  },
  { id: 'xauusd', label: 'XAUUSD', test: (s) => ['XAUUSD', 'XAUUSD=X', 'GC=F'].includes(s.symbol) },
  { id: 'xautusd', label: 'XAUTUSD', test: (s) => ['XAUTUSD', 'XAUTUSDT', 'XAUT-USD'].includes(s.symbol) },
  { id: 'btcusd', label: 'BTCUSD', test: (s) => ['BTCUSD', 'BTCUSDT', 'BTC-USD'].includes(s.symbol) },
  { id: 'ethusd', label: 'ETHUSD', test: (s) => ['ETHUSD', 'ETHUSDT', 'ETH-USD'].includes(s.symbol) },
];

function reportDayList(from, to) {
  const out = [];
  for (let t = dayMs(from), end = dayMs(to) + 86400000; t < end; t += 86400000) out.push(istDayOf(t));
  return out;
}

function slimTrade(e) {
  const grp = REPORT_GROUPS.find((g) => g.test(e));
  return {
    ts: e.ts,
    date: istDayOf(e.ts),
    group: grp ? grp.id : null,
    symbol: reportSymbol(e.symbol),
    name: e.name || e.symbol,
    tf: e.tf,
    dir: e.dir,
    reason: e.exitReason || 'CLOSE',
    r: r2(rOf(e)),
    entry: e.entry ?? null,
    sl: e.sl ?? null,
    exit: e.price ?? null,
    confidence: e.confidence ?? null,
    grade: e.grade || null,
  };
}

function reportStats(list, days) {
  const entries = list.filter((s) => s.type === 'ENTRY');
  const exits = list.filter((s) => s.type === 'EXIT').sort((a, b) => a.ts - b.ts);
  const wins = exits.filter((e) => rOf(e) > 0);
  const losses = exits.filter((e) => rOf(e) < 0);
  const sumR = (arr) => arr.reduce((a, e) => a + rOf(e), 0);
  const grossWin = sumR(wins);
  const grossLoss = Math.abs(sumR(losses));
  const totalR = sumR(exits);
  const avgWin = wins.length ? grossWin / wins.length : null;
  const avgLoss = losses.length ? -grossLoss / losses.length : null;

  let peak = 0;
  let cum = 0;
  let maxDD = 0;
  for (const e of exits) {
    cum += rOf(e);
    if (cum > peak) peak = cum;
    if (cum - peak < maxDD) maxDD = cum - peak;
  }

  const reasons = { target: 0, stop: 0, breakeven: 0, reversal: 0, session: 0, other: 0 };
  for (const e of exits) {
    if (e.exitReason === 'TARGET HIT') reasons.target++;
    else if (e.exitReason === 'STOP LOSS') reasons.stop++;
    else if (e.exitReason === 'BREAKEVEN') reasons.breakeven++;
    else if (e.exitReason === 'REVERSAL') reasons.reversal++;
    else if (e.exitReason === 'SESSION CLOSE') reasons.session++;
    else reasons.other++;
  }

  const byTf = new Map(TFS.map((tf) => [tf, { tf, entries: 0, exits: 0, wins: 0, losses: 0, r: 0 }]));
  for (const s of list) {
    const b = byTf.get(s.tf);
    if (!b) continue;
    if (s.type === 'ENTRY') b.entries++;
    else {
      b.exits++;
      if (rOf(s) > 0) b.wins++;
      else if (rOf(s) < 0) b.losses++;
      b.r += rOf(s);
    }
  }

  const bySymbol = new Map();
  for (const s of list) {
    const key = reportSymbol(s.symbol);
    let b = bySymbol.get(key);
    if (!b) {
      b = {
        symbol: key,
        name: s.name || key,
        entries: 0,
        exits: 0,
        wins: 0,
        losses: 0,
        target: 0,
        stop: 0,
        breakeven: 0,
        reversal: 0,
        session: 0,
        other: 0,
        wonR: 0,
        lostR: 0,
        r: 0,
      };
      bySymbol.set(key, b);
    }
    if (s.type === 'ENTRY') {
      b.entries++;
      continue;
    }
    b.exits++;
    const r = rOf(s);
    if (r > 0) {
      b.wins++;
      b.wonR += r;
    } else if (r < 0) {
      b.losses++;
      b.lostR += -r;
    }
    if (s.exitReason === 'TARGET HIT') b.target++;
    else if (s.exitReason === 'STOP LOSS') b.stop++;
    else if (s.exitReason === 'BREAKEVEN') b.breakeven++;
    else if (s.exitReason === 'REVERSAL') b.reversal++;
    else if (s.exitReason === 'SESSION CLOSE') b.session++;
    else b.other++;
    b.r += r;
  }

  const dayMap = new Map(
    days.map((d) => [d, { date: d, entries: 0, exits: 0, target: 0, stop: 0, other: 0, wins: 0, losses: 0, r: 0 }]),
  );
  for (const s of list) {
    const row = dayMap.get(istDayOf(s.ts));
    if (!row) continue;
    if (s.type === 'ENTRY') row.entries++;
    else {
      row.exits++;
      if (s.exitReason === 'TARGET HIT') row.target++;
      else if (s.exitReason === 'STOP LOSS') row.stop++;
      else row.other++;
      if (rOf(s) > 0) row.wins++;
      else if (rOf(s) < 0) row.losses++;
      row.r += rOf(s);
    }
  }
  let run = 0;
  const daily = [...dayMap.values()]
    .filter((d) => d.entries || d.exits)
    .map((d) => {
      run += d.r;
      return { ...d, r: r2(d.r), cumR: r2(run) };
    });

  const avgConf = (arr) => (arr.length ? Number((arr.reduce((a, e) => a + (Number(e.confidence) || 0), 0) / arr.length).toFixed(0)) : null);
  const best = exits.length ? exits.reduce((a, e) => (rOf(e) > rOf(a) ? e : a)) : null;
  const worst = exits.length ? exits.reduce((a, e) => (rOf(e) < rOf(a) ? e : a)) : null;

  return {
    entries: entries.length,
    exits: exits.length,
    wins: wins.length,
    losses: losses.length,
    flat: exits.length - wins.length - losses.length,
    winRate: exits.length ? pct1((wins.length / exits.length) * 100) : null,
    totalR: r2(totalR),
    avgR: exits.length ? r2(totalR / exits.length) : null,
    avgWinR: avgWin != null ? r2(avgWin) : null,
    avgLossR: avgLoss != null ? r2(avgLoss) : null,
    payoff: avgWin != null && avgLoss != null && avgLoss !== 0 ? r2(avgWin / Math.abs(avgLoss)) : null,
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : grossWin > 0 ? null : 0,
    grossWinR: r2(grossWin),
    grossLossR: r2(grossLoss),
    maxDD: r2(maxDD),
    avgConf: avgConf(exits),
    avgWinConf: avgConf(wins),
    avgLossConf: avgConf(losses),
    bestR: best ? r2(rOf(best)) : null,
    worstR: worst ? r2(rOf(worst)) : null,
    best: best ? slimTrade(best) : null,
    worst: worst ? slimTrade(worst) : null,
    reasons,
    byTf: [...byTf.values()].filter((b) => b.entries || b.exits).map((b) => ({ ...b, r: r2(b.r) })),
    bySymbol: [...bySymbol.values()]
      .sort((a, b) => b.r - a.r)
      .map((b) => ({
        ...b,
        winRate: b.exits ? pct1((b.wins / b.exits) * 100) : null,
        wonR: r2(b.wonR),
        lostR: r2(b.lostR),
        r: r2(b.r),
      })),
    daily,
  };
}

function buildReport(params) {
  const now = Date.now();
  const today = istDayOf(now);
  let to = String(params.get('to') || today);
  let from = String(params.get('from') || istDayOf(now - 6 * 86400000));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) from = istDayOf(now - 6 * 86400000);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) to = today;
  if (dayMs(from) > dayMs(to)) [from, to] = [to, from];
  const fromMs = dayMs(from);
  const toMs = dayMs(to) + 86400000 - 1;
  const days = reportDayList(from, to);
  const reported = (s) => REPORT_GROUPS.some((g) => g.test(s));
  const base = signals.filter((s) => (s.type === 'ENTRY' || s.type === 'EXIT') && s.ts >= fromMs && s.ts <= toMs && reported(s));
  const stamps = signals.filter(reported).map((s) => s.ts);
  return {
    from,
    to,
    generatedAt: now,
    availableFrom: stamps.length ? istDayOf(Math.min(...stamps)) : null,
    availableTo: stamps.length ? istDayOf(Math.max(...stamps)) : null,
    overall: reportStats(base, days),
    groups: REPORT_GROUPS.map((g) => ({ id: g.id, label: g.label, ...reportStats(base.filter(g.test), days) })),
    losses: base
      .filter((s) => s.type === 'EXIT' && rOf(s) < 0)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 500)
      .map(slimTrade),
  };
}

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/config') return sendJson(res, 200, configPayload());

  if (p === '/api/stream') {
    const tf = TFS.includes(url.searchParams.get('tf')) ? url.searchParams.get('tf') : '15m';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\n: connected\n\n`);
    const client = { res, tf };
    clients.add(client);
    req.on('close', () => clients.delete(client));
    if (!warmed.has(tf)) warmTf(tf).catch(() => {});
    refreshTickers(cryptoList().map((c) => c.symbol)).catch(() => {});
    sseSend(res, 'snapshot', snapshotFor(tf));
    return;
  }

  if (p === '/api/scan') {
    const tf = TFS.includes(url.searchParams.get('tf')) ? url.searchParams.get('tf') : '15m';
    if (!warmed.has(tf)) warmTf(tf).catch(() => {});
    const rows = buildRows(tf);
    return sendJson(res, 200, { tf, ts: Date.now(), rows, pulse: pulse(rows), signals: signals.filter((s) => s.tf === tf && watched(s)).slice(0, 50) });
  }

  if (p === '/api/signals') {
    const tf = url.searchParams.get('tf');
    const list = signals.filter((s) => watched(s) && (!tf || s.tf === tf));
    return sendJson(res, 200, { signals: list.slice(0, 100) });
  }

  if (p === '/api/report') {
    return sendJson(res, 200, buildReport(url.searchParams));
  }

  if (p === '/api/analyze') {
    const symbol = normalizeSymbol(url.searchParams.get('symbol'));
    const tf = TFS.includes(url.searchParams.get('tf')) ? url.searchParams.get('tf') : '15m';
    if (!symbol) return sendJson(res, 400, { error: 'invalid symbol' });
    try {
      const entry = await getCandles(symbol, tf, { maxAge: Math.max(12000, ttlFor(tf) / 2) });
      const info = resolveInfo(symbol);
      const tz = tzFor(info.market);
      const htf = await ensureHtf(symbol, tf);
      const tick = tickerFor(symbol);
      const price = tick?.price ?? entry.meta?.price ?? entry.candles[entry.candles.length - 1].c;
      const a = analyze(entry.candles, {
        tf,
        symbol,
        market: info.market,
        livePrice: price,
        prevClose: entry.meta?.prevClose ?? null,
        changePct: tick?.chgPct ?? entry.meta?.changePct ?? null,
        tzOffsetMinutes: tz,
        nowSec: Math.floor(Date.now() / 1000),
        htf,
      });
      const ctx = computeContext(entry.candles, { tf, tzOffsetMinutes: tz });
      const book = updateBook(info, tf, a, price, emitTrade);
      saveBooks();
      const from = Math.max(0, entry.candles.length - 320);
      const rd = (v) => (Number.isFinite(v) ? Number(v.toPrecision(10)) : null);
      return sendJson(res, 200, {
        symbol,
        name: entry.meta?.name || info.name,
        market: info.market,
        marketLabel: marketLabel(info.market),
        tf,
        source: entry.source,
        exchange: entry.meta?.exchange || '',
        currency: entry.meta?.currency || '',
        cachedAt: entry.at,
        stale: !!entry.stale,
        error: entry.error || null,
        analysis: decorateAnalysis(a, book, price),
        book: bookView(book, price),
        meta: entry.meta,
        candles: entry.candles.slice(from).map((c) => ({ t: c.t, o: rd(c.o), h: rd(c.h), l: rd(c.l), c: rd(c.c), v: c.v })),
        series: {
          ema9: ctx.e9.slice(from).map(rd),
          ema21: ctx.e21.slice(from).map(rd),
          ema50: ctx.e50.slice(from).map(rd),
          supertrend: ctx.st.line.slice(from).map(rd),
          vwap: ctx.vwap ? ctx.vwap.slice(from).map(rd) : null,
        },
        backtest: backtestFor(symbol, tf, htf),
      });
    } catch (err) {
      return sendJson(res, 502, { error: err.message, symbol, tf });
    }
  }

  if (p === '/api/backtest') {
    const symbol = normalizeSymbol(url.searchParams.get('symbol'));
    const tf = TFS.includes(url.searchParams.get('tf')) ? url.searchParams.get('tf') : '15m';
    if (!symbol) return sendJson(res, 400, { error: 'invalid symbol' });
    try {
      await getCandles(symbol, tf);
      const htf = await ensureHtf(symbol, tf);
      return sendJson(res, 200, backtestFor(symbol, tf, htf));
    } catch (err) {
      return sendJson(res, 502, { error: err.message });
    }
  }

  if (p === '/api/watch/add' || p === '/api/watch/remove') {
    const symbol = normalizeSymbol(url.searchParams.get('symbol'));
    if (!symbol) return sendJson(res, 400, { error: 'invalid symbol' });
    if (p.endsWith('remove')) {
      const existing = symbolIndex.get(symbol);
      if (!existing || !existing.custom) {
        return sendJson(res, 400, { error: 'built-in symbol cannot be removed' });
      }
      symbolIndex.delete(symbol);
      sendJson(res, 200, { ok: true, config: configPayload() });
      saveWatch();
      return;
    }
    const info = resolveInfo(symbol);
    const alias = aliasFor(symbol);
    symbolIndex.set(symbol, {
      ...info,
      symbol,
      name: alias?.name || info.name || symbol,
      custom: true,
    });
    saveWatch();
    getCandles(symbol, '15m').catch(() => {});
    return sendJson(res, 200, { ok: true, config: configPayload() });
  }

  return sendJson(res, 404, { error: 'unknown endpoint' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res);
  } catch (err) {
    console.error('[http]', err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  TRADING TERMINAL');
  console.log(`  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  ${allSymbols().length} symbols | ${MARKETS.length} markets | cache-friendly polling`);
  console.log('');
  warmTf('15m').catch(() => {});
});
