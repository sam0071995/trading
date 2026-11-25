// Strategy playbook engine.
//
// One evaluator per market, all causal (bar-by-bar safe) so live signals and
// the backtester share the exact same rules:
//
//   india       Opening Range Breakout + EMA/VWAP/SuperTrend filter
//   forex       Adaptive: trend pullback / momentum breakout / level reversal
//   crypto      Adaptive + RSI divergence + 18:30 momentum
//   commodities Adaptive + pivot/band reversal
//   custom      Same adaptive engine, 24/7
//   swing       EMA trend continuation on 4h/1d (session filter off)
//
// The adaptive engine scores several independent setups on every closed bar and
// picks the strongest, so a market can produce signals in trend, breakout and
// range conditions instead of waiting for one rare pattern.

import { clamp } from './indicators.js';
import { istParts, sessionInfo } from './sessions.js';

export const STRATEGIES = {
  india: { id: 'india-orb', name: 'Opening Range Breakout + EMA', targetTf: '5m' },
  forex: { id: 'forex-adaptive', name: 'Trend + Momentum + Reversal (FX)', targetTf: '5m' },
  crypto: { id: 'crypto-adaptive', name: 'Trend / Breakout / Reversal', targetTf: '1m–5m' },
  commodities: { id: 'comm-adaptive', name: 'Breakout + Pivot Reversal', targetTf: '5m' },
  custom: { id: 'custom-adaptive', name: 'Trend Pullback + Breakout', targetTf: '5m' },
  smc: { id: 'crypto-smc', name: 'SMC Liquidity Sweep + FVG', targetTf: '5m' },
  swing: { id: 'swing-trend', name: 'Swing Trend Continuation', targetTf: '4h/1d' },
};

const INTRADAY = new Set(['1m', '5m', '15m', '1h']);

const r4 = (v) => (Number.isFinite(v) ? Number(v.toPrecision(6)) : '—');
const bodyOf = (c) => Math.abs(c.c - c.o);
const rangeOf = (c) => Math.max(c.h - c.l, 1e-9);
const bodyRatio = (c) => bodyOf(c) / rangeOf(c);
const isBull = (c) => c.c > c.o;
const isBear = (c) => c.c < c.o;

function bullEngulf(c, p) {
  return c.c > c.o && p.c < p.o && c.c >= p.o && c.o <= p.c;
}
function bearEngulf(c, p) {
  return c.c < c.o && p.c > p.o && c.c <= p.o && c.o >= p.c;
}
function pinBull(c) {
  const r = rangeOf(c);
  return c.c >= c.o && Math.min(c.o, c.c) - c.l >= 0.55 * r && c.c >= c.l + 0.6 * r;
}
function pinBear(c) {
  const r = rangeOf(c);
  return c.c <= c.o && c.h - Math.max(c.o, c.c) >= 0.55 * r && c.c <= c.l + 0.4 * r;
}

function hasVolume(candles, i, n = 30) {
  for (let k = i; k >= Math.max(0, i - n); k--) if ((candles[k].v || 0) > 0) return true;
  return false;
}

function volRatioAt(ctx, i) {
  const s = ctx.volSma[i];
  return s && s > 0 ? (ctx.vols[i] || 0) / s : null;
}

function crossUp(a, b, j, look = 3) {
  if (a[j] == null || b[j] == null || !(a[j] > b[j])) return false;
  for (let k = j - 1; k >= Math.max(1, j - look); k--) {
    if (a[k] != null && b[k] != null && a[k] <= b[k]) return true;
  }
  return false;
}
function crossDown(a, b, j, look = 3) {
  if (a[j] == null || b[j] == null || !(a[j] < b[j])) return false;
  for (let k = j - 1; k >= Math.max(1, j - look); k--) {
    if (a[k] != null && b[k] != null && a[k] >= b[k]) return true;
  }
  return false;
}

// Fractal pivots confirmed by k bars on each side. Only completed pivots
// (p + k <= j) are used, so values are safe for replay.
function pivotsAt(candles, j, look = 60, k = 2) {
  const lows = [];
  const highs = [];
  const from = Math.max(k, j - look);
  for (let p = j - k; p >= from; p--) {
    let isL = true;
    let isH = true;
    for (let q = p - k; q <= p + k; q++) {
      if (q < 0 || q > j || q === p) continue;
      if (candles[q].l <= candles[p].l) isL = false;
      if (candles[q].h >= candles[p].h) isH = false;
      if (!isL && !isH) break;
    }
    if (isL) lows.push({ i: p, p: candles[p].l });
    if (isH) highs.push({ i: p, p: candles[p].h });
  }
  lows.sort((a, b) => b.i - a.i);
  highs.sort((a, b) => b.i - a.i);
  return { lows, highs };
}

function nearestBelow(list, price, maxDist) {
  let best = null;
  for (const p of list) {
    if (p.p > price) continue;
    if (maxDist != null && price - p.p > maxDist) continue;
    if (!best || p.p > best.p) best = p;
  }
  return best;
}
function nearestAbove(list, price, maxDist) {
  let best = null;
  for (const p of list) {
    if (p.p < price) continue;
    if (maxDist != null && p.p - price > maxDist) continue;
    if (!best || p.p < best.p) best = p;
  }
  return best;
}

function clampStop(entry, sl, atr, minMult = 0.35, maxMult = 2.5) {
  const long = sl < entry;
  let dist = Math.abs(entry - sl);
  if (!(dist > 0)) dist = atr * 0.8;
  dist = clamp(dist, Math.max(minMult * atr, 1e-9), maxMult * atr);
  return long ? entry - dist : entry + dist;
}

function makePlan(entry, sl, targets) {
  if (!Number.isFinite(entry) || !Number.isFinite(sl)) return null;
  const dist = Math.abs(entry - sl);
  if (!(dist > 0)) return null;
  const list = targets.filter((t) => Number.isFinite(t));
  if (list.length < 3) return null;
  const [t1, t2, t3] = list.slice(0, 3);
  return { entry, sl, targets: [t1, t2, t3], dist, riskPct: (dist / entry) * 100, rr: Math.abs(t2 - entry) / dist };
}

function reason(side, pts, text) {
  return { side, pts: Math.round(pts), text };
}

function emptyChecks() {
  return {
    trend: { ok: false, note: 'not aligned' },
    level: { ok: false, note: 'no key level' },
    momentum: { ok: false, note: 'neutral' },
    volume: { ok: null, note: 'volume unavailable' },
  };
}

function strengthOf(base, extra) {
  return Math.round(clamp(base + extra, 40, 96));
}

/* ------------------------------------------------------------------ */
/* India — Opening Range Breakout + EMA filter                         */
/* ------------------------------------------------------------------ */

function indiaMomentum(candles, ctx, i, opts, session) {
  if (!['1m', '5m'].includes(opts.tf)) return null;
  const now = istParts(opts.nowSec ?? candles[i].t);
  if (!(now.mins >= 560 && now.mins <= 615)) return null;
  const targetStart = opts.tf === '5m' ? 555 : 560;
  const entry = Number.isFinite(opts.livePrice) && opts.livePrice > 0 ? opts.livePrice : candles[i].c;

  for (const k of [i - 1, i - 2]) {
    if (k < 1) continue;
    const p = istParts(candles[k].t);
    if (p.mins !== targetStart) continue;
    const c = candles[k];
    const br = bodyRatio(c);
    if (br < 0.6 || Math.abs(c.c - c.o) < 1e-9) continue;
    const long = isBull(c);
    const atr = ctx.atr[k] ?? entry * 0.004;
    const sl = clampStop(entry, long ? c.l : c.h, atr, 0.25, 2.5);
    const d = Math.abs(entry - sl);
    const targets = long ? [entry + 2 * d, entry + 3 * d, entry + 4 * d] : [entry - 2 * d, entry - 3 * d, entry - 4 * d];
    const st = ctx.st.dir[k];
    const stOk = long ? st === 1 : st === -1;
    const strength = strengthOf(56, Math.min(16, br * 20) + (stOk ? 8 : 0) + (session.preferred ? 6 : 0));
    const side = long ? 'bull' : 'bear';

    return {
      dir: long ? 'BUY' : 'SELL',
      sigIdx: k,
      strength,
      sl,
      targets,
      setup: `9:${opts.tf === '5m' ? '15' : '20'} momentum candle ${long ? 'bullish' : 'bearish'} (${Math.round(br * 100)}% body)`,
      reasons: [
        reason(side, 18, `${opts.tf === '5m' ? '09:15–09:20' : '09:20'} candle closed ${long ? 'bullish' : 'bearish'} with ${Math.round(br * 100)}% body`),
        reason(side, 8, stOk ? `SuperTrend ${long ? 'bullish' : 'bearish'}` : 'SuperTrend not aligned'),
        reason(side, 6, `${session.label}`),
      ],
      warnings: stOk ? [] : ['9:20 momentum trade against SuperTrend — lower conviction'],
      checks: {
        trend: { ok: stOk, note: stOk ? `SuperTrend ${long ? 'bullish' : 'bearish'}` : 'SuperTrend disagrees' },
        level: { ok: true, note: `Momentum candle ${long ? 'high' : 'low'} ${r4(long ? c.h : c.l)}` },
        momentum: { ok: true, note: `${Math.round(br * 100)}% body candle` },
        volume: hasVolume(candles, k) ? { ok: (volRatioAt(ctx, k) || 0) >= 1.3, note: `${volRatioAt(ctx, k)?.toFixed(1)}x average` } : { ok: null, note: 'volume unavailable' },
      },
      move: { type: 'MOMENTUM', atr: Number((bodyOf(c) / atr).toFixed(2)) },
    };
  }
  return null;
}

function evaluateIndia(candles, ctx, i, opts, session) {
  const warnings = [];
  const checks = emptyChecks();
  const j = i - 1;
  if (j < 2) return { dir: 'NEUTRAL', warnings: ['Not enough bars yet'], checks, setup: 'Loading' };

  const atrD = ctx.atr[j];
  const orH = ctx.or.high[j];
  const orL = ctx.or.low[j];
  const vw = ctx.vwap ? ctx.vwap[j] : null;
  const stD = ctx.st.dir[j];
  const e9 = ctx.e9[j];
  const e21 = ctx.e21[j];
  const vol = hasVolume(candles, j);
  const vr = volRatioAt(ctx, j);
  const longNow = ctx.or.ready[j] && orH != null && candles[j].c > orH;
  const shortNow = ctx.or.ready[j] && orL != null && candles[j].c < orL;
  const upAlign = stD === 1 && e9 != null && e21 != null && e9 > e21;
  const downAlign = stD === -1 && e9 != null && e21 != null && e9 < e21;

  checks.trend = { ok: upAlign || downAlign, note: upAlign ? 'SuperTrend + EMA9/21 bullish' : downAlign ? 'SuperTrend + EMA9/21 bearish' : 'SuperTrend / EMA not aligned' };
  checks.level = {
    ok: longNow || shortNow,
    note: ctx.or.ready[j] ? `OR ${r4(orL)}–${r4(orH)} · price ${longNow ? 'above' : shortNow ? 'below' : 'inside'}` : 'Opening range still forming',
  };
  checks.momentum = { ok: crossUp(ctx.e9, ctx.e21, j) || crossDown(ctx.e9, ctx.e21, j), note: 'recent EMA 9/21 cross' };
  checks.volume = vol ? { ok: vr != null && vr >= 1.5, note: `${vr?.toFixed(1)}x average` } : { ok: null, note: 'index/forex feed has no volume' };

  const entry = Number.isFinite(opts.livePrice) && opts.livePrice > 0 ? opts.livePrice : candles[i].c;

  for (const k of [i - 1, i - 2, i - 3]) {
    if (k < 2) continue;
    if (!ctx.or.ready[k]) continue;
    const h = ctx.or.high[k];
    const l = ctx.or.low[k];
    if (h == null || l == null) continue;
    const c = candles[k];
    const long = c.c > h;
    const short = c.c < l;
    if (!long && !short) continue;

    const kvw = ctx.vwap ? ctx.vwap[k] : null;
    if (kvw != null && (long ? c.c <= kvw : c.c >= kvw)) continue;
    const st = ctx.st.dir[k];
    if (!(long ? st === 1 : st === -1)) continue;
    const emaOk = long
      ? crossUp(ctx.e9, ctx.e21, k) || (ctx.e9[k] != null && ctx.e21[k] != null && ctx.e9[k] > ctx.e21[k] && ctx.e9[k] > ctx.e9[k - 1])
      : crossDown(ctx.e9, ctx.e21, k) || (ctx.e9[k] != null && ctx.e21[k] != null && ctx.e9[k] < ctx.e21[k] && ctx.e9[k] < ctx.e9[k - 1]);
    if (!emaOk) continue;

    const kv = hasVolume(candles, k);
    const kvr = volRatioAt(ctx, k);
    const aV = ctx.atr[k] || ctx.atr[j] || c.c * 0.005;
    const expansion = rangeOf(c) >= aV * 0.9 && bodyRatio(c) >= 0.55;
    if (kv ? !(kvr != null && kvr >= 1.8) : !expansion) continue;

    const orSize = Math.max(h - l, aV * 0.4);
    const rawStop = long ? Math.min(kvw ?? c.l, c.l) - 0.15 * aV : Math.max(kvw ?? c.h, c.h) + 0.15 * aV;
    const sl = clampStop(entry, rawStop, aV, 0.35, 2.5);
    const d = Math.abs(entry - sl);
    const targets = long
      ? [entry + Math.max(1.5 * orSize, 1.2 * d), entry + Math.max(2.0 * orSize, 1.8 * d), entry + Math.max(2.5 * orSize, 2.5 * d)]
      : [entry - Math.max(1.5 * orSize, 1.2 * d), entry - Math.max(2.0 * orSize, 1.8 * d), entry - Math.max(2.5 * orSize, 2.5 * d)];
    const side = long ? 'bull' : 'bear';
    const strength = strengthOf(52, 10 + (crossUp(ctx.e9, ctx.e21, k) || crossDown(ctx.e9, ctx.e21, k) ? 8 : 4) + 12 + 10 + (kv ? 10 : 6) + (session.preferred ? 6 : 0));

    return {
      dir: long ? 'BUY' : 'SELL',
      sigIdx: k,
      strength,
      sl,
      targets,
      setup: `${long ? 'Close above' : 'Close below'} opening range ${r4(long ? h : l)}`,
      reasons: [
        reason(side, 20, `${long ? 'Closed above' : 'Closed below'} opening range ${r4(long ? h : l)}`),
        reason(side, 12, `${long ? 'Above' : 'Below'} session VWAP ${kvw != null ? r4(kvw) : ''}`.trim()),
        reason(side, 14, long ? 'EMA 9 above EMA 21' : 'EMA 9 below EMA 21'),
        reason(side, 10, `SuperTrend ${long ? 'bullish' : 'bearish'}`),
        kv ? reason(side, 10, `Volume ${kvr?.toFixed(1)}x average`) : reason(side, 5, 'Range expansion on the breakout bar'),
        reason(side, 6, `${session.label} (${session.window})`),
      ],
      warnings: kv ? [] : ['No volume on this feed — range expansion used instead'],
      checks: {
        trend: { ok: true, note: `SuperTrend + EMA 9/21 ${long ? 'bullish' : 'bearish'}` },
        level: { ok: true, note: `OR breakout ${r4(long ? h : l)}` },
        momentum: { ok: true, note: `EMA 9/21 ${long ? 'bullish' : 'bearish'} cross` },
        volume: kv ? { ok: true, note: `${kvr?.toFixed(1)}x average` } : { ok: null, note: 'volume unavailable' },
      },
      move: { type: long ? 'ORB LONG' : 'ORB SHORT', atr: Number((bodyOf(c) / aV).toFixed(2)) },
    };
  }

  const mom = indiaMomentum(candles, ctx, i, opts, session);
  if (mom) return mom;

  if (!ctx.or.ready[j]) warnings.push('Opening range still forming (first 5 minutes after 09:15 IST)');
  else warnings.push(`Waiting for a 5m close outside OR ${r4(orL)}–${r4(orH)}`);
  if (vw != null) warnings.push(`Price ${candles[j].c > vw ? 'above' : 'below'} VWAP ${r4(vw)}`);
  if (!(upAlign || downAlign)) warnings.push('SuperTrend and EMA 9/21 not aligned');
  return { dir: 'NEUTRAL', warnings, checks, setup: 'Waiting for ORB trigger' };
}

/* ------------------------------------------------------------------ */
/* Adaptive engine — forex / crypto / commodities / custom             */
/* ------------------------------------------------------------------ */

// Tunables. The backtester replays these exact numbers.
const ADAPTIVE = {
  minScore: 64,
  lookback: 3,
  rotation: 0.85,
  impulse: 1.35,
};

// Each market runs the setups that survive its own backtest:
// FX mean-reverts at zones, commodities trend and break out, crypto
// breaks out of squeezes.
const ADAPTIVE_FAMILIES = {
  forex: ['trend-pullback', 'level-reversal'],
  crypto: ['trend-pullback', 'breakout', 'squeeze', 'divergence', 'us-open'],
  commodities: ['breakout', 'trend-pullback', 'asia-break'],
  custom: ['trend-pullback', 'level-reversal', 'breakout'],
};

const FAMILY_NAMES = {
  'trend-pullback': 'Trend pullback',
  breakout: 'Range breakout',
  squeeze: 'Squeeze breakout',
  'level-reversal': 'Level reversal',
  divergence: 'RSI divergence',
  'us-open': 'US-open momentum',
  'asia-break': 'Asian range break',
};

const dirLabel = (d) => (d === 1 ? 'bullish' : 'bearish');

function avgAtr(ctx, from, to) {
  let s = 0;
  let n = 0;
  for (let p = from; p <= to; p++) {
    if (ctx.atr[p] != null) {
      s += ctx.atr[p];
      n++;
    }
  }
  return n ? s / n : null;
}

// Volatility regime: recent ATR vs its own 50-bar average.
function atrRegime(ctx, j) {
  const fast = avgAtr(ctx, j - 13, j);
  const slow = avgAtr(ctx, j - 49, j);
  if (fast == null || slow == null || !(slow > 0)) return { kind: 'trend', ratio: 1 };
  const ratio = fast / slow;
  return { kind: ratio < ADAPTIVE.rotation ? 'rotation' : ratio > ADAPTIVE.impulse ? 'impulse' : 'trend', ratio };
}

function trendRead(ctx, j) {
  const price = ctx.closes[j];
  const e20 = ctx.e20[j];
  const e50 = ctx.e50[j];
  const e200 = ctx.e200 ? ctx.e200[j] : null;
  const atr = ctx.atr[j];
  const base = ctx.e50[j - 6];
  let dir = 0;
  if (price != null && e20 != null && e50 != null) {
    if (price > e20 && e20 > e50) dir = 1;
    else if (price < e20 && e20 < e50) dir = -1;
  }
  return {
    dir,
    slope: e50 != null && base != null && atr ? (e50 - base) / (6 * atr) : null,
    adx: ctx.adx.adx[j] ?? null,
    st: ctx.st.dir[j] ?? 0,
    e200: e200 != null && price != null ? (price > e200 ? 1 : -1) : 0,
    e20,
    e50,
    e200Val: e200,
  };
}

// Nearest support/resistance mapped from pivots, VWAP, bands, range edges
// and the EMAs. Sorted by distance to the current close.
function levelsAt(candles, ctx, j) {
  const price = candles[j].c;
  const sup = [];
  const res = [];
  const add = (v, tag) => {
    if (!Number.isFinite(v)) return;
    const item = { p: v, tag };
    if (v <= price) sup.push(item);
    else res.push(item);
  };
  add(ctx.piv.pp[j], 'pivot PP');
  add(ctx.piv.s1[j], 'S1');
  add(ctx.piv.s2[j], 'S2');
  add(ctx.piv.r1[j], 'R1');
  add(ctx.piv.r2[j], 'R2');
  add(ctx.vwap ? ctx.vwap[j] : null, 'VWAP');
  add(ctx.bb.lower[j], 'lower band');
  add(ctx.bb.upper[j], 'upper band');
  add(ctx.bb.mid[j], 'mid band');
  add(ctx.ll[j], '20-bar low');
  add(ctx.hh[j], '20-bar high');
  add(ctx.e20[j], 'EMA 20');
  add(ctx.e50[j], 'EMA 50');
  add(ctx.e200 ? ctx.e200[j] : null, 'EMA 200');
  sup.sort((a, b) => b.p - a.p);
  res.sort((a, b) => a.p - b.p);
  return { sup, res };
}

function planTargets(long, entry, sl, atr, nextLevel) {
  const d = Math.abs(entry - sl);
  const s = long ? 1 : -1;
  let t1 = entry + s * Math.max(1.2 * atr, 1.5 * d);
  if (nextLevel != null && (long ? nextLevel > entry + 0.4 * atr : nextLevel < entry - 0.4 * atr)) {
    const cap = entry + s * Math.min(Math.abs(nextLevel - entry), 2.6 * atr);
    t1 = long ? Math.max(t1, cap) : Math.min(t1, cap);
  }
  const t2 = t1 + s * Math.max(0.8 * atr, 0.6 * d);
  const t3 = t2 + s * Math.max(1.0 * atr, 0.6 * d);
  return [t1, t2, t3];
}

function volCheck(candles, ctx, j, min) {
  if (!hasVolume(candles, j)) return { ok: null, note: 'volume unavailable' };
  const vr = volRatioAt(ctx, j);
  return { ok: vr != null && vr >= min, note: `${vr != null ? vr.toFixed(1) : '—'}x average` };
}

function widthPercentile(ctx, j, look = 120) {
  const w = ctx.bbw[j];
  if (w == null) return null;
  let count = 0;
  let total = 0;
  for (let p = Math.max(0, j - look); p <= j; p++) {
    const v = ctx.bbw[p];
    if (v == null) continue;
    total++;
    if (v <= w) count++;
  }
  return total ? count / total : null;
}

function squeezedRecently(ctx, j, bars = 8) {
  for (let k = j - 1; k >= Math.max(0, j - bars); k--) {
    const pct = widthPercentile(ctx, k);
    if (pct != null && pct <= 0.32) return true;
  }
  return false;
}

function asianRange(candles, j) {
  const cur = istParts(candles[j].t);
  let hi = -Infinity;
  let lo = Infinity;
  let found = false;
  let prevDayIncluded = false;
  for (let p = j; p >= 0 && p > j - 600; p--) {
    const q = istParts(candles[p].t);
    const c = candles[p];
    if (q.date === cur.date) {
      if (q.mins <= 450) {
        if (c.h > hi) hi = c.h;
        if (c.l < lo) lo = c.l;
        found = true;
      }
    } else {
      if (!prevDayIncluded && q.mins >= 1410) {
        if (c.h > hi) hi = c.h;
        if (c.l < lo) lo = c.l;
        found = true;
        prevDayIncluded = true;
        continue;
      }
      if (q.mins < 1410) break;
    }
  }
  return found ? { high: hi, low: lo } : null;
}

/* --- Setup 1: pullback into the trend EMA ------------------------- */

function trendPullback(candles, ctx, j, entry, tr, levels, regime, session) {
  if (tr.dir === 0 || !(Math.abs(tr.slope ?? 0) >= 0.006)) return null;
  const atr = ctx.atr[j];
  const e20 = ctx.e20[j];
  if (!atr || e20 == null) return null;
  const long = tr.dir === 1;
  const c = candles[j];
  const touch = long ? c.l <= e20 + 0.3 * atr : c.h >= e20 - 0.3 * atr;
  const hold = long ? c.c >= e20 - 0.1 * atr : c.c <= e20 + 0.1 * atr;
  if (!touch || !hold || Math.abs(c.c - e20) > 0.9 * atr) return null;
  const br = bodyRatio(c);
  if (!(long ? isBull(c) : isBear(c)) || br < 0.3) return null;

  const r = ctx.rsi[j];
  const rOk = r != null && (long ? r >= 33 && r <= 66 : r >= 34 && r <= 67);
  const macdOk = ctx.macd.hist[j] != null && (long ? ctx.macd.hist[j] > 0 : ctx.macd.hist[j] < 0);
  const vr = volRatioAt(ctx, j);
  let score = 48;
  if (tr.adx != null && tr.adx >= 22) score += 8;
  if (tr.adx != null && tr.adx >= 30) score += 4;
  if (tr.st === tr.dir) score += 6;
  if (tr.e200 === tr.dir) score += 4;
  score += br >= 0.5 ? 6 : 3;
  if (rOk) score += 6;
  if (macdOk) score += 4;
  if (vr != null && vr >= 1.2) score += 5;
  if (session.preferred) score += 4;
  if (regime.kind === 'impulse') score += 2;

  const raw = long ? Math.min(c.l, e20) - 0.45 * atr : Math.max(c.h, e20) + 0.45 * atr;
  const sl = clampStop(entry, raw, atr, 0.7, 2.2);
  const targets = planTargets(long, entry, sl, atr, long ? levels.res[0]?.p ?? null : levels.sup[0]?.p ?? null);
  const side = long ? 'bull' : 'bear';

  return {
    family: 'trend-pullback',
    dir: long ? 'BUY' : 'SELL',
    sigIdx: j,
    score,
    strength: Math.round(clamp(score, 40, 96)),
    sl,
    targets,
    setup: `${long ? 'Bullish' : 'Bearish'} pullback into EMA 20 ${r4(e20)}`,
    reasons: [
      reason(side, 18, `EMA 20 ${long ? 'above' : 'below'} EMA 50 — ${long ? 'bullish' : 'bearish'} trend`),
      reason(side, 16, `Pullback held the EMA 20 at ${r4(e20)}`),
      reason(side, 14, `${long ? 'Bullish' : 'Bearish'} ${Math.round(br * 100)}% body reaction bar`),
      rOk && r != null ? reason(side, 8, `RSI ${r.toFixed(1)} reset into the trend`) : null,
      tr.adx != null ? reason(side, 6, `ADX ${tr.adx.toFixed(0)} — ${tr.adx >= 22 ? 'trend strength' : 'trend still building'}`) : null,
      vr != null && vr >= 1.2 ? reason(side, 6, `Volume ${vr.toFixed(1)}x average`) : null,
      session.preferred ? reason(side, 4, session.label) : null,
    ].filter(Boolean),
    warnings: [
      ...(tr.adx != null && tr.adx < 18 ? ['ADX below 18 — trend may be choppy'] : []),
    ],
    checks: {
      trend: { ok: true, note: `EMA 20/50 ${long ? 'bullish' : 'bearish'}${tr.adx != null ? ` · ADX ${tr.adx.toFixed(0)}` : ''}` },
      level: { ok: true, note: `EMA 20 pullback ${r4(e20)}` },
      momentum: { ok: rOk, note: r != null ? `RSI ${r.toFixed(1)}` : 'RSI not ready' },
      volume: volCheck(candles, ctx, j, 1.2),
    },
    move: { type: long ? 'PULLBACK LONG' : 'PULLBACK SHORT', atr: Number((bodyOf(c) / atr).toFixed(2)) },
  };
}

/* --- Setup 2: close outside the 20-bar range ---------------------- */

function breakoutSetup(candles, ctx, j, entry, tr, levels, regime, session) {
  const atr = ctx.atr[j];
  const hh = ctx.hh[j];
  const ll = ctx.ll[j];
  if (!atr || hh == null || ll == null) return null;
  const c = candles[j];
  const long = c.c > hh;
  const short = c.c < ll;
  if (!long && !short) return null;
  if (!(long ? isBull(c) : isBear(c))) return null;

  const br = bodyRatio(c);
  const pen = long ? (c.c - hh) / atr : (ll - c.c) / atr;
  const r = ctx.rsi[j];
  const dirIdx = long ? 1 : -1;
  const vr = volRatioAt(ctx, j);
  let score = 46;
  if (pen >= 0.08) score += 8;
  if (pen >= 0.35) score += 4;
  if (br >= 0.5) score += 8;
  if (br >= 0.65) score += 3;
  if (rangeOf(c) >= 0.9 * atr) score += 4;
  if (vr != null) score += vr >= 1.4 ? 10 : vr >= 1.05 ? 4 : 0;
  else score += 4;
  if (tr.dir === dirIdx) score += 8;
  else if (tr.dir === -dirIdx) score -= 8;
  if (tr.adx != null && tr.adx >= 22) score += 6;
  if (r != null && (long ? r >= 48 && r <= 82 : r >= 18 && r <= 52)) score += 6;
  if (ctx.macd.hist[j] != null && (long ? ctx.macd.hist[j] > 0 : ctx.macd.hist[j] < 0)) score += 4;
  if (squeezedRecently(ctx, j)) score += 4;
  if (session.preferred) score += 4;
  if (regime.kind === 'rotation') score -= 6;

  const level = long ? hh : ll;
  const raw = long ? Math.min(c.l, level) - 0.3 * atr : Math.max(c.h, level) + 0.3 * atr;
  const sl = clampStop(entry, raw, atr, 0.6, 2.5);
  const targets = planTargets(long, entry, sl, atr, long ? levels.res[0]?.p ?? null : levels.sup[0]?.p ?? null);
  const side = long ? 'bull' : 'bear';

  return {
    family: 'breakout',
    dir: long ? 'BUY' : 'SELL',
    sigIdx: j,
    score,
    strength: Math.round(clamp(score, 40, 96)),
    sl,
    targets,
    setup: `${long ? 'Breakout above' : 'Breakdown below'} the 20-bar ${long ? 'high' : 'low'} ${r4(level)}`,
    reasons: [
      reason(side, 20, `Closed ${long ? 'above' : 'below'} the 20-bar ${long ? 'high' : 'low'} ${r4(level)}`),
      reason(side, 12, `${Math.round(br * 100)}% body · ${pen.toFixed(2)} ATR beyond the level`),
      tr.dir === dirIdx ? reason(side, 10, `Aligned with the EMA 20/50 ${long ? 'uptrend' : 'downtrend'}`) : null,
      vr != null ? reason(side, 8, `Volume ${vr.toFixed(1)}x average`) : reason(side, 4, 'Volume feed unavailable — range expansion used'),
      tr.adx != null ? reason(side, 6, `ADX ${tr.adx.toFixed(0)}`) : null,
      session.preferred ? reason(side, 4, session.label) : null,
    ].filter(Boolean),
    warnings: [
      ...(tr.dir === -dirIdx ? ['Breakout against the EMA trend — treat as a counter-trend move'] : []),
    ],
    checks: {
      trend: { ok: tr.dir === dirIdx, note: tr.dir === dirIdx ? `EMA trend ${long ? 'bullish' : 'bearish'}` : 'EMA trend not aligned' },
      level: { ok: true, note: `${long ? '20-bar high' : '20-bar low'} break ${r4(level)}` },
      momentum: { ok: r != null && (long ? r >= 48 : r <= 52), note: r != null ? `RSI ${r.toFixed(1)}` : 'RSI not ready' },
      volume: volCheck(candles, ctx, j, 1.4),
    },
    move: { type: long ? 'BREAKOUT' : 'BREAKDOWN', atr: Number((rangeOf(c) / atr).toFixed(2)) },
  };
}

/* --- Setup 3: Bollinger squeeze breakout -------------------------- */

function squeezeSetup(candles, ctx, j, entry, tr, levels, regime, session) {
  const atr = ctx.atr[j];
  const upper = ctx.bb.upper[j];
  const lower = ctx.bb.lower[j];
  if (!atr || upper == null || lower == null) return null;
  const c = candles[j];
  const long = c.c > upper;
  const short = c.c < lower;
  if (!long && !short) return null;
  if (!(long ? isBull(c) : isBear(c))) return null;
  if (!squeezedRecently(ctx, j, 8)) return null;
  if (bodyRatio(c) < 0.45) return null;
  const r = ctx.rsi[j];
  if (r == null) return null;
  if (long && r < 48) return null;
  if (short && r > 52) return null;

  const pct = widthPercentile(ctx, j);
  const vr = volRatioAt(ctx, j);
  if (vr != null && vr < 1.0) return null;
  const bias = ctx.e200 ? ctx.e200[j] : ctx.e50[j];
  let score = 64;
  if (pct != null && pct <= 0.32) score += 8;
  if (pct != null && pct <= 0.2) score += 4;
  if (vr != null) score += vr >= 1.5 ? 10 : vr >= 1.1 ? 5 : 0;
  else score += 3;
  if (bias != null) score += long ? (c.c > bias ? 6 : -6) : (c.c < bias ? 6 : -6);
  if (bodyRatio(c) >= 0.55) score += 4;
  if (regime.kind === 'impulse') score += 2;
  if (session.preferred) score += 4;

  const raw = long ? Math.min(c.l, candles[j - 1].l) - 0.2 * atr : Math.max(c.h, candles[j - 1].h) + 0.2 * atr;
  const sl = clampStop(entry, raw, atr, 0.9, 2.5);
  const targets = planTargets(long, entry, sl, atr, long ? levels.res[0]?.p ?? null : levels.sup[0]?.p ?? null);
  const side = long ? 'bull' : 'bear';

  return {
    family: 'squeeze',
    dir: long ? 'BUY' : 'SELL',
    sigIdx: j,
    score,
    strength: Math.round(clamp(score, 40, 96)),
    sl,
    targets,
    setup: `${long ? 'Upper' : 'Lower'} band breakout after a ${Math.round((pct ?? 0) * 100)}% squeeze`,
    reasons: [
      reason(side, 20, `Closed ${long ? 'above the upper' : 'below the lower'} Bollinger band ${r4(long ? upper : lower)}`),
      reason(side, 14, `Bands were contracting (${Math.round((pct ?? 0) * 100)}% width percentile)`),
      reason(side, 10, `RSI ${r.toFixed(1)} momentum`),
      bias != null ? reason(side, 8, `Price ${long ? 'above' : 'below'} the long-term EMA ${r4(bias)}`) : null,
      vr != null ? reason(side, 8, `Volume ${vr.toFixed(1)}x average`) : reason(side, 3, 'Volume feed unavailable'),
      session.preferred ? reason(side, 4, session.label) : null,
    ].filter(Boolean),
    warnings: [
      ...(bias != null && (long ? c.c < bias : c.c > bias) ? ['Band break against the long-term EMA bias'] : []),
    ],
    checks: {
      trend: { ok: bias != null && (long ? c.c > bias : c.c < bias), note: bias != null ? `EMA bias ${long ? 'bullish' : 'bearish'}` : 'EMA bias not ready' },
      level: { ok: true, note: `${long ? 'Upper' : 'Lower'} band break` },
      momentum: { ok: true, note: `RSI ${r.toFixed(1)}` },
      volume: volCheck(candles, ctx, j, 1.5),
    },
    move: { type: 'SQUEEZE', atr: Number((bodyOf(c) / atr).toFixed(2)) },
  };
}

/* --- Setup 4: rejection at a mapped level ------------------------- */

function levelReversal(candles, ctx, j, entry, tr, levels, regime, session) {
  const atr = ctx.atr[j];
  if (!atr || j < 20) return null;
  const c = candles[j];
  const prev = candles[j - 1];
  const r = ctx.rsi[j];
  const kk = ctx.stoch.k[j];
  const kp = ctx.stoch.k[j - 1];

  const sup = levels.sup.find((l) => c.l <= l.p + 0.3 * atr && c.l >= l.p - 0.7 * atr && c.c - l.p <= 0.9 * atr);
  const res = levels.res.find((l) => c.h >= l.p - 0.3 * atr && c.h <= l.p + 0.7 * atr && l.p - c.c <= 0.9 * atr);

  const bullBar = bullEngulf(c, prev) || pinBull(c) || (isBull(c) && Math.min(c.o, c.c) - c.l >= 0.4 * rangeOf(c));
  const bearBar = bearEngulf(c, prev) || pinBear(c) || (isBear(c) && c.h - Math.max(c.o, c.c) >= 0.4 * rangeOf(c));

  const canLong = !!sup && bullBar && (r == null || r <= 66) && !(tr.dir === -1 && tr.adx != null && tr.adx >= 30);
  const canShort = !!res && bearBar && (r == null || r >= 34) && !(tr.dir === 1 && tr.adx != null && tr.adx >= 30);
  if (!canLong && !canShort) return null;

  const isLong = canLong;
  const lvl = isLong ? sup : res;
  const s = isLong ? 1 : -1;
  const side = isLong ? 'bull' : 'bear';
  const vr = volRatioAt(ctx, j);
  const engulf = isLong ? bullEngulf(c, prev) : bearEngulf(c, prev);
  const pin = isLong ? pinBull(c) : pinBear(c);
  const stochCross = isLong ? kk != null && kp != null && kk > kp && kp <= 35 : kk != null && kp != null && kk < kp && kp >= 65;

  let score = 50;
  if (Math.abs(c.c - lvl.p) <= 0.3 * atr) score += 8;
  score += engulf ? 12 : pin ? 10 : 7;
  if (isLong ? r != null && r <= 48 : r != null && r >= 52) score += 6;
  if (isLong ? kk != null && kk <= 28 : kk != null && kk >= 72) score += 4;
  if (stochCross) score += 6;
  if (regime.kind === 'rotation') score += 6;
  if (tr.dir === (isLong ? 1 : -1)) score += 4;
  if (tr.dir === (isLong ? -1 : 1) && tr.adx != null && tr.adx >= 26) score -= 8;
  if (vr != null && vr >= 1.2) score += 6;
  if (session.preferred) score += 4;

  const raw = lvl.p - s * 0.75 * atr;
  const sl = clampStop(entry, raw, atr, 0.7, 2.4);
  const next = isLong
    ? levels.res.find((x) => x.p > lvl.p + 0.2 * atr)?.p ?? null
    : levels.sup.find((x) => x.p < lvl.p - 0.2 * atr)?.p ?? null;
  const targets = planTargets(isLong, entry, sl, atr, next);

  return {
    family: 'level-reversal',
    dir: isLong ? 'BUY' : 'SELL',
    sigIdx: j,
    score,
    strength: Math.round(clamp(score, 40, 96)),
    sl,
    targets,
    setup: `${isLong ? 'Bounce' : 'Rejection'} at ${lvl.tag} ${r4(lvl.p)}`,
    reasons: [
      reason(side, 18, `Price ${isLong ? 'bounced from' : 'turned down at'} ${lvl.tag} ${r4(lvl.p)}`),
      reason(side, 14, engulf ? `${isLong ? 'Bullish' : 'Bearish'} engulfing at the level` : pin ? `${isLong ? 'Bullish pin bar' : 'Shooting star'} at the level` : `${isLong ? 'Bullish' : 'Bearish'} rejection wick`),
      r != null ? reason(side, 8, `RSI ${r.toFixed(1)}`) : null,
      stochCross ? reason(side, 6, `Stoch RSI crossed ${isLong ? 'up' : 'down'}`) : null,
      regime.kind === 'rotation' ? reason(side, 6, 'Rotation regime favours mean reversion') : null,
      vr != null && vr >= 1.2 ? reason(side, 6, `Volume ${vr.toFixed(1)}x average`) : null,
      session.preferred ? reason(side, 4, session.label) : null,
    ].filter(Boolean),
    warnings: [
      ...(tr.dir === (isLong ? -1 : 1) && tr.adx != null && tr.adx >= 26 ? ['Counter-trend reversal — trend is strong'] : []),
    ],
    checks: {
      trend: { ok: tr.dir === (isLong ? 1 : -1), note: tr.dir === 0 ? 'Range-bound' : `EMA trend ${dirLabel(tr.dir)}` },
      level: { ok: true, note: `${lvl.tag} ${r4(lvl.p)}` },
      momentum: { ok: stochCross || (isLong ? r != null && r <= 50 : r != null && r >= 50), note: `${r != null ? `RSI ${r.toFixed(1)}` : 'RSI —'}${kk != null ? ` · Stoch ${kk.toFixed(0)}` : ''}` },
      volume: volCheck(candles, ctx, j, 1.2),
    },
    move: { type: isLong ? 'BOUNCE' : 'REJECTION', atr: Number((bodyOf(c) / atr).toFixed(2)) },
  };
}

/* --- Setup 5: RSI divergence at a new swing ----------------------- */

function divergenceSetup(candles, ctx, j, entry, tr, session) {
  if (j < 25) return null;
  const atr = ctx.atr[j];
  if (!atr) return null;
  const { lows, highs } = pivotsAt(candles, j, 70, 2);
  const c = candles[j];
  const vr = volRatioAt(ctx, j);

  const kk = ctx.stoch.k[j];
  const kd = ctx.stoch.d[j];

  let long = null;
  if (lows.length >= 2) {
    const [nw, old] = lows;
    const d = ctx.rsi[nw.i];
    const o = ctx.rsi[old.i];
    if (j - nw.i <= 10 && candles[nw.i].l < candles[old.i].l && d != null && o != null && d > o + 3 && d < 55 && kk != null && kd != null && kk > kd && isBull(c) && ctx.e21[j] != null && c.c > ctx.e21[j]) {
      long = { nw, old, delta: d - o, now: d, before: o };
    }
  }
  let short = null;
  if (!long && highs.length >= 2) {
    const [nw, old] = highs;
    const d = ctx.rsi[nw.i];
    const o = ctx.rsi[old.i];
    if (j - nw.i <= 10 && candles[nw.i].h > candles[old.i].h && d != null && o != null && d < o - 3 && d > 45 && kk != null && kd != null && kk < kd && isBear(c) && ctx.e21[j] != null && c.c < ctx.e21[j]) {
      short = { nw, old, delta: o - d, now: d, before: o };
    }
  }
  const div = long || short;
  if (!div) return null;
  const isLong = !!long;
  const side = isLong ? 'bull' : 'bear';

  let score = 58 + Math.min(12, div.delta * 2.5) + 4;
  if (tr.dir === (isLong ? 1 : -1)) score += 3;
  if (vr != null && vr >= 1.2) score += 4;
  if (session.preferred) score += 3;

  const raw = isLong ? candles[div.nw.i].l - 0.35 * atr : candles[div.nw.i].h + 0.35 * atr;
  const sl = clampStop(entry, raw, atr, 0.8, 2.4);
  const targets = planTargets(isLong, entry, sl, atr, null);

  return {
    family: 'divergence',
    dir: isLong ? 'BUY' : 'SELL',
    sigIdx: j,
    score,
    strength: Math.round(clamp(score, 40, 96)),
    sl,
    targets,
    setup: `${isLong ? 'Bullish' : 'Bearish'} RSI divergence swing`,
    reasons: [
      reason(side, 20, isLong ? `Price made a lower low ${r4(candles[div.nw.i].l)} vs ${r4(candles[div.old.i].l)}` : `Price made a higher high ${r4(candles[div.nw.i].h)} vs ${r4(candles[div.old.i].h)}`),
      reason(side, 18, `RSI ${isLong ? 'higher low' : 'lower high'} ${div.now.toFixed(1)} vs ${div.before.toFixed(1)}`),
      reason(side, 10, isLong ? 'Reclaimed EMA 21' : 'Lost EMA 21'),
      vr != null && vr >= 1.2 ? reason(side, 6, `Volume ${vr.toFixed(1)}x average`) : null,
      session.preferred ? reason(side, 3, session.label) : null,
    ].filter(Boolean),
    warnings: [],
    checks: {
      trend: { ok: ctx.e21[j] != null && (isLong ? c.c > ctx.e21[j] : c.c < ctx.e21[j]), note: isLong ? 'Reclaimed EMA 21' : 'Lost EMA 21' },
      level: { ok: true, note: isLong ? `Swing low ${r4(candles[div.nw.i].l)}` : `Swing high ${r4(candles[div.nw.i].h)}` },
      momentum: { ok: true, note: `RSI divergence (${div.now.toFixed(1)})` },
      volume: volCheck(candles, ctx, j, 1.2),
    },
    move: { type: 'DIVERGENCE', atr: 1 },
  };
}

/* --- Setup 6: crypto US-open momentum candle ---------------------- */

function usOpenSetup(candles, ctx, i, opts, session) {
  if (opts.tf !== '5m') return null;
  const now = istParts(opts.nowSec ?? candles[i].t);
  if (!(now.mins >= 1110 && now.mins <= 1160)) return null;
  const entry = Number.isFinite(opts.livePrice) && opts.livePrice > 0 ? opts.livePrice : candles[i].c;
  for (const k of [i - 1, i - 2]) {
    if (k < 2) continue;
    if (istParts(candles[k].t).mins !== 1110) continue;
    const c = candles[k];
    const movePct = (Math.abs(c.c - c.o) / c.o) * 100;
    if (movePct < 0.3 || Math.abs(c.c - c.o) < 1e-9) continue;
    const long = isBull(c);
    const atr = ctx.atr[k] || entry * 0.004;
    const sl = clampStop(entry, long ? c.l : c.h, atr, 0.3, 3);
    const d = Math.abs(entry - sl);
    const targets = long ? [entry + 2 * d, entry + 3 * d, entry + 4 * d] : [entry - 2 * d, entry - 3 * d, entry - 4 * d];
    const bias = ctx.e200 ? ctx.e200[k] : ctx.e50[k];
    const biasOk = bias == null || (long ? c.c > bias : c.c < bias);
    const vr = volRatioAt(ctx, k);
    const side = long ? 'bull' : 'bear';
    let score = 58 + Math.min(14, movePct * 12);
    if (biasOk) score += 6;
    if (vr != null && vr >= 1.5) score += 6;
    if (session.preferred) score += 4;
    return {
      family: 'us-open',
      dir: long ? 'BUY' : 'SELL',
      sigIdx: k,
      score,
      strength: Math.round(clamp(score, 40, 96)),
      sl,
      targets,
      setup: `US-open 5m candle moved ${movePct.toFixed(2)}%`,
      reasons: [
        reason(side, 24, `18:30 IST candle closed ${long ? 'up' : 'down'} ${movePct.toFixed(2)}%`),
        reason(side, 8, biasOk ? 'Aligned with the EMA bias' : 'Against the EMA bias'),
        reason(side, 6, 'US market open momentum'),
        session.preferred ? reason(side, 4, session.label) : null,
      ].filter(Boolean),
      warnings: biasOk ? [] : ['Trade against the higher-timeframe bias'],
      checks: {
        trend: { ok: biasOk, note: biasOk ? 'EMA bias aligned' : 'EMA bias against' },
        level: { ok: true, note: `18:30 candle ${long ? 'high' : 'low'} ${r4(long ? c.h : c.l)}` },
        momentum: { ok: true, note: `Breakout ${movePct.toFixed(2)}%` },
        volume: volCheck(candles, ctx, k, 1.5),
      },
      move: { type: 'US OPEN', atr: Number((Math.abs(c.c - c.o) / atr).toFixed(2)) },
    };
  }
  return null;
}

/* --- Setup 7: commodities Asian-range break ----------------------- */

function asiaBreakSetup(candles, ctx, j, entry, tr, session) {
  if (!session.preferred) return null;
  const atr = ctx.atr[j];
  const ar = asianRange(candles, j);
  if (!atr || !ar) return null;
  const size = ar.high - ar.low;
  if (size < 0.6 * atr) return null;
  const c = candles[j];
  const prev = candles[j - 1];
  const long = c.c > ar.high && prev.c <= ar.high;
  const short = c.c < ar.low && prev.c >= ar.low;
  if (!long && !short) return null;
  const vr = volRatioAt(ctx, j);
  if (vr != null && vr < 0.9) return null;

  const mid = (ar.high + ar.low) / 2;
  const sl = clampStop(entry, mid, atr, 0.6, 3.5);
  const d = Math.abs(entry - sl);
  const targets = long
    ? [entry + 1.5 * size, entry + Math.max(2 * d, 1.5 * size + 0.5 * d), entry + Math.max(3 * d, 1.5 * size + d)]
    : [entry - 1.5 * size, entry - Math.max(2 * d, 1.5 * size + 0.5 * d), entry - Math.max(3 * d, 1.5 * size + d)];
  const side = long ? 'bull' : 'bear';
  let score = 56 + 8;
  if (size >= 1.2 * atr) score += 4;
  if (vr != null) score += vr >= 1.3 ? 8 : 4;
  if (tr.dir === (long ? 1 : -1)) score += 6;
  score += 6;

  return {
    family: 'asia-break',
    dir: long ? 'BUY' : 'SELL',
    sigIdx: j,
    score,
    strength: Math.round(clamp(score, 40, 96)),
    sl,
    targets,
    setup: `Asian range ${long ? 'breakout above' : 'breakdown below'} ${r4(long ? ar.high : ar.low)}`,
    reasons: [
      reason(side, 20, `${long ? 'Broke above' : 'Broke below'} the Asian range ${r4(ar.low)}–${r4(ar.high)}`),
      reason(side, 10, `Range size ${r4(size)}`),
      vr != null ? reason(side, 8, `Volume ${vr.toFixed(1)}x average`) : reason(side, 4, 'Volume feed unavailable'),
      reason(side, 6, session.label),
    ],
    warnings: ['Stop sits at the 50% range level'],
    checks: {
      trend: { ok: ctx.e50[j] != null && (long ? c.c > ctx.e50[j] : c.c < ctx.e50[j]), note: 'Checked vs EMA 50' },
      level: { ok: true, note: `Asian range ${r4(ar.low)}–${r4(ar.high)}` },
      momentum: { ok: true, note: `${long ? 'Bullish' : 'Bearish'} range break` },
      volume: volCheck(candles, ctx, j, 1.3),
    },
    move: { type: 'ASIA BREAK', atr: Number((Math.abs(c.c - c.o) / atr).toFixed(2)) },
  };
}

/* --- Orchestrator: score every setup, fire the best ---------------- */

function familyOff(fam, session, opts) {
  if (fam === 'asia-break' && !session.preferred) return 'NY metals session only';
  if (fam === 'us-open' && opts.tf !== '5m') return '5m only';
  return null;
}

function familyNote(fam, ctx, j, tr, levels, session, opts) {
  if (fam === 'trend-pullback') return tr.dir === 0 ? 'No clean EMA 20/50 trend' : `Waiting for a pullback into EMA 20 ${r4(ctx.e20[j])}`;
  if (fam === 'breakout') return ctx.hh[j] != null ? `Needs a close outside ${r4(ctx.ll[j])}–${r4(ctx.hh[j])}` : 'Range not ready';
  if (fam === 'squeeze') {
    const p = widthPercentile(ctx, j);
    return p != null && p <= 0.32 ? `Squeeze ${Math.round(p * 100)}% — waiting for a band break` : p != null ? `Band width percentile ${Math.round(p * 100)}%` : 'Bands not ready';
  }
  if (fam === 'level-reversal') {
    const s = levels.sup[0];
    const rr = levels.res[0];
    return s || rr ? `Watching ${s ? `support ${r4(s.p)}` : ''}${s && rr ? ' / ' : ''}${rr ? `resistance ${r4(rr.p)}` : ''}` : 'No level nearby';
  }
  if (fam === 'divergence') return 'Waiting for a new swing with RSI divergence';
  if (fam === 'us-open') return opts.tf === '5m' ? 'US-open candle only (18:30 IST)' : '5m only';
  if (fam === 'asia-break') return session.preferred ? 'No Asian-range break yet' : 'NY metals session only';
  return '';
}

function evaluateAdaptive(candles, ctx, i, opts, session, market) {
  const j = i - 1;
  const checks = emptyChecks();
  if (j < 30) return { dir: 'NEUTRAL', warnings: ['Loading history for the adaptive engine'], checks, setup: 'Loading', setups: [] };

  const entry = Number.isFinite(opts.livePrice) && opts.livePrice > 0 ? opts.livePrice : candles[i].c;
  const fams = ADAPTIVE_FAMILIES[market] || ADAPTIVE_FAMILIES.custom;
  const tr = trendRead(ctx, j);
  const regime = atrRegime(ctx, j);
  const levels = levelsAt(candles, ctx, j);
  const r = ctx.rsi[j];

  checks.trend = {
    ok: tr.dir !== 0,
    note: tr.dir === 0 ? 'EMA 20/50 not stacked' : `EMA 20/50 ${dirLabel(tr.dir)}${tr.adx != null ? ` · ADX ${tr.adx.toFixed(0)}` : ''}`,
  };
  checks.level = {
    ok: !!(levels.sup[0] || levels.res[0]),
    note: `Support ${levels.sup[0] ? r4(levels.sup[0].p) : '—'} · resistance ${levels.res[0] ? r4(levels.res[0].p) : '—'}`,
  };
  checks.momentum = { ok: r != null, note: `${r != null ? `RSI ${r.toFixed(1)}` : 'RSI not ready'}${tr.adx != null ? ` · ADX ${tr.adx.toFixed(0)}` : ''}` };
  checks.volume = volCheck(candles, ctx, j, 1.2);

  const fns = {
    'trend-pullback': trendPullback,
    breakout: breakoutSetup,
    squeeze: squeezeSetup,
    'level-reversal': levelReversal,
    divergence: (cd, cx, k, en, trK, lv, rg, ss) => divergenceSetup(cd, cx, k, en, trK, ss),
    'us-open': (cd, cx, k, en, trK, lv, rg, ss) => usOpenSetup(cd, cx, i, opts, ss),
    'asia-break': (cd, cx, k, en, trK, lv, rg, ss) => asiaBreakSetup(cd, cx, k, en, trK, ss),
  };

  const best = new Map();
  for (let k = i - 1; k >= Math.max(30, i - ADAPTIVE.lookback); k--) {
    const trK = k === j ? tr : trendRead(ctx, k);
    const rgK = k === j ? regime : atrRegime(ctx, k);
    const lvK = k === j ? levels : levelsAt(candles, ctx, k);
    for (const fam of fams) {
      const cand = fns[fam](candles, ctx, k, entry, trK, lvK, rgK, session);
      if (!cand) continue;
      cand.score = Math.round(clamp(cand.score, 0, 96));
      const prev = best.get(fam);
      if (!prev || cand.score > prev.score || (cand.score === prev.score && cand.sigIdx > prev.sigIdx)) best.set(fam, cand);
    }
  }

  const setups = fams.map((fam) => {
    const c = best.get(fam);
    const name = FAMILY_NAMES[fam];
    if (c) {
      const state = c.score >= ADAPTIVE.minScore ? 'READY' : c.score >= 55 ? 'NEAR' : 'WAITING';
      return { id: fam, name, state, score: c.score, dir: c.dir, note: c.setup };
    }
    const off = familyOff(fam, session, opts);
    return {
      id: fam,
      name,
      state: off ? 'OFF' : 'WAITING',
      score: 0,
      dir: null,
      note: off || familyNote(fam, ctx, j, tr, levels, session, opts),
    };
  });

  const ranked = [...best.values()].filter((c) => c.score >= ADAPTIVE.minScore).sort((a, b) => b.score - a.score);
  const win = ranked[0];
  if (win) {
    for (const s of setups) if (s.id === win.family) s.state = 'FIRED';
    return { ...win, checks: win.checks, setups };
  }

  const warnings = [];
  const top = [...best.values()].sort((a, b) => b.score - a.score)[0];
  warnings.push(top ? `${FAMILY_NAMES[top.family]} setup building (${top.score}/100)` : 'No setup matched yet — market is between signals');
  warnings.push(`Regime ${regime.kind} · ADX ${tr.adx != null ? tr.adx.toFixed(0) : '—'} · RSI ${r != null ? r.toFixed(1) : '—'}`);
  if (!session.preferred) warnings.push('Outside preferred session hours — reduced conviction');
  return { dir: 'NEUTRAL', warnings, checks, setup: 'Scanning all setups', setups };
}

/* ------------------------------------------------------------------ */
/* Swing — 4h / 1d trend continuation                                  */
/* ------------------------------------------------------------------ */

function evaluateSwing(candles, ctx, i, opts) {
  const warnings = [];
  const checks = emptyChecks();
  const j = i - 1;
  if (j < 30) return { dir: 'NEUTRAL', warnings: ['Not enough bars yet'], checks, setup: 'Loading' };
  const entry = Number.isFinite(opts.livePrice) && opts.livePrice > 0 ? opts.livePrice : candles[i].c;
  const e9 = ctx.e9[j];
  const e21 = ctx.e21[j];
  const e50 = ctx.e50[j];
  const st = ctx.st.dir[j];
  const r = ctx.rsi[j];
  const up = e9 != null && e21 != null && e50 != null && e9 > e21 && e21 > e50 && st === 1;
  const down = e9 != null && e21 != null && e50 != null && e9 < e21 && e21 < e50 && st === -1;
  checks.trend = { ok: up || down, note: up ? 'EMA 9 > 21 > 50 · SuperTrend up' : down ? 'EMA 9 < 21 < 50 · SuperTrend down' : 'EMA stack not aligned' };
  checks.momentum = { ok: r != null && ((up && r >= 50) || (down && r <= 50)), note: r != null ? `RSI ${r.toFixed(1)}` : 'RSI not ready' };
  const vol = hasVolume(candles, j);
  const vr = volRatioAt(ctx, j);
  checks.volume = vol ? { ok: vr != null && vr >= 1.2, note: `${vr?.toFixed(1)}x average` } : { ok: null, note: 'volume unavailable' };

  for (const k of [i - 1, i - 2]) {
    if (k < 25) continue;
    const c = candles[k];
    const hh = ctx.hh[k];
    const ll = ctx.ll[k];
    if (hh == null || ll == null) continue;
    const long = up && c.c > hh;
    const short = down && c.c < ll;
    if (!long && !short) continue;
    const atr = ctx.atr[k] || entry * 0.005;
    const rawStop = long ? Math.min(ll, c.l) - 0.25 * atr : Math.max(hh, c.h) + 0.25 * atr;
    const sl = clampStop(entry, rawStop, atr, 0.8, 3);
    const d = Math.abs(entry - sl);
    const targets = long ? [entry + 1.5 * d, entry + 2.5 * d, entry + 4 * d] : [entry - 1.5 * d, entry - 2.5 * d, entry - 4 * d];
    const side = long ? 'bull' : 'bear';
    return {
      dir: long ? 'BUY' : 'SELL',
      sigIdx: k,
      strength: strengthOf(52, 16 + (vol ? 8 : 4) + (ctx.adx.adx[k] >= 22 ? 8 : 0)),
      sl,
      targets,
      setup: `${long ? 'Breakout above' : 'Breakdown below'} ${long ? '20-bar high' : '20-bar low'}`,
      reasons: [
        reason(side, 22, `EMA 9/21/50 stack ${long ? 'bullish' : 'bearish'}`),
        reason(side, 16, `SuperTrend ${long ? 'bullish' : 'bearish'}`),
        reason(side, 14, `${long ? 'Breakout above' : 'Breakdown below'} 20-bar ${long ? 'high' : 'low'} ${r4(long ? hh : ll)}`),
        reason(side, 10, `RSI ${r != null ? r.toFixed(1) : '—'}`),
        vol ? reason(side, 6, `Volume ${vr?.toFixed(1)}x average`) : reason(side, 2, 'Volume unavailable'),
      ],
      warnings: [],
      checks: {
        trend: { ok: true, note: `EMA stack ${long ? 'bullish' : 'bearish'}` },
        level: { ok: true, note: `${long ? '20-bar high' : '20-bar low'} break` },
        momentum: { ok: true, note: `RSI ${r != null ? r.toFixed(1) : '—'}` },
        volume: vol ? { ok: true, note: `${vr?.toFixed(1)}x average` } : { ok: null, note: 'volume unavailable' },
      },
      move: { type: 'SWING', atr: Number((bodyOf(c) / atr).toFixed(2)) },
    };
  }

  checks.level = { ok: false, note: 'No 20-bar structure break yet' };
  warnings.push('Waiting for EMA stack + 20-bar structure break');
  return { dir: 'NEUTRAL', warnings, checks, setup: 'Waiting for swing breakout' };
}

/* ------------------------------------------------------------------ */
/* BTCUSD / ETHUSD — Smart Money Concepts, 5m entry                    */
/* 1H trend + 15m EMA stack, liquidity sweep -> MSS -> displacement    */
/* -> FVG -> retrace confirmation. Stops behind the sweep (-0.2 ATR),  */
/* targets 1R / 2R / 3R.                                               */
/* ------------------------------------------------------------------ */

const SMC_SYMBOLS = new Set(['BTCUSD', 'ETHUSD', 'BTCUSDT', 'ETHUSDT', 'BTC-USD', 'ETH-USD']);

export const isSmcSymbol = (symbol) => SMC_SYMBOLS.has(String(symbol || '').toUpperCase());

// Last higher-timeframe bar fully closed by the signal bar's close.
function htfIndex(series, tSec, barSec = 300) {
  if (!series || !series.bars || !series.bars.length) return null;
  const closedBy = tSec + barSec;
  let lo = 0;
  let hi = series.bars.length - 1;
  let ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series.bars[mid].t + series.sec <= closedBy) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function htfTrend(series, k, price) {
  if (!series || k == null || k < 1) return 0;
  const e50 = series.e50[k];
  const e200 = series.e200[k];
  if (e50 == null || e200 == null) return 0;
  if (price > e200 && e50 > e200) return 1;
  if (price < e200 && e50 < e200) return -1;
  return 0;
}

function priceVsEma(series, k, price) {
  if (!series || k == null || k < 1) return 0;
  const e200 = series.e200[k];
  if (e200 == null) return 0;
  return price > e200 ? 1 : price < e200 ? -1 : 0;
}

const SMC_P = { sweepBars: 30, swingBars: 50, mssBars: 6, disRatio: 1.2, confirmBars: 6, maxStopAtr: 4 };

export function smcLong(candles, ctx, j, P = SMC_P) {
  const atr = ctx.atr[j];
  if (!atr) return null;
  const { lows, highs } = pivotsAt(candles, j, P.swingBars, 2);

  let sweep = null;
  for (let k = j; k >= Math.max(4, j - P.sweepBars); k--) {
    const L = lows.find((p) => p.i < k && p.i >= k - 40);
    if (!L) continue;
    if (candles[k].l < L.p && candles[k].c > L.p) {
      sweep = { k, level: L.p, low: Math.min(candles[k].l, L.p) };
      break;
    }
  }
  if (!sweep) return { sweep: null };

  const H = highs.find((p) => p.i < sweep.k && p.i >= sweep.k - 25);
  if (!H) return { sweep };
  let mssBar = null;
  for (let m = sweep.k + 1; m <= Math.min(j, sweep.k + P.mssBars); m++) {
    if (candles[m].c > H.p) {
      mssBar = m;
      break;
    }
  }
  if (mssBar == null) return { sweep, mssLevel: H.p };

  let dis = null;
  for (let d = sweep.k; d <= mssBar; d++) {
    const body = candles[d].c - candles[d].o;
    const a = ctx.atr[d] ?? atr;
    const ratio = body / a;
    if (body > 0 && ratio >= P.disRatio && (!dis || ratio > dis.ratio)) dis = { i: d, ratio };
  }
  if (!dis) return { sweep, mssBar, mssLevel: H.p };

  let fvg = null;
  for (let g = j; g >= Math.max(3, dis.i - 1); g--) {
    const bottom = candles[g - 2].h;
    const top = candles[g].l;
    if (top > bottom && bottom >= sweep.low - 0.5 * atr) {
      fvg = { g, bottom, top };
      break;
    }
  }
  if (!fvg) return { sweep, mssBar, mssLevel: H.p, dis };

  let retrace = null;
  for (let r = fvg.g + 1; r <= j; r++) {
    if (candles[r].l <= fvg.top && candles[r].c >= fvg.bottom - 0.1 * atr) {
      retrace = { i: r };
      break;
    }
  }
  if (!retrace) return { sweep, mssBar, mssLevel: H.p, dis, fvg };

  let confirm = null;
  for (let c2 = retrace.i; c2 <= Math.min(j, retrace.i + P.confirmBars); c2++) {
    if (candles[c2].c > fvg.top && candles[c2].c > candles[c2].o) {
      confirm = { i: c2 };
      break;
    }
  }
  return { sweep, mssBar, mssLevel: H.p, dis, fvg, retrace, confirm };
}

const SMC_S = { sweepBars: 30, swingBars: 50, mssBars: 6, disRatio: 1.2, confirmBars: 6, maxStopAtr: 4 };

export function smcShort(candles, ctx, j, P = SMC_S) {
  const atr = ctx.atr[j];
  if (!atr) return null;
  const { lows, highs } = pivotsAt(candles, j, P.swingBars, 2);

  let sweep = null;
  for (let k = j; k >= Math.max(4, j - P.sweepBars); k--) {
    const H = highs.find((p) => p.i < k && p.i >= k - 40);
    if (!H) continue;
    if (candles[k].h > H.p && candles[k].c < H.p) {
      sweep = { k, level: H.p, high: Math.max(candles[k].h, H.p) };
      break;
    }
  }
  if (!sweep) return { sweep: null };

  const L = lows.find((p) => p.i < sweep.k && p.i >= sweep.k - 25);
  if (!L) return { sweep };
  let mssBar = null;
  for (let m = sweep.k + 1; m <= Math.min(j, sweep.k + P.mssBars); m++) {
    if (candles[m].c < L.p) {
      mssBar = m;
      break;
    }
  }
  if (mssBar == null) return { sweep, mssLevel: L.p };

  let dis = null;
  for (let d = sweep.k; d <= mssBar; d++) {
    const body = candles[d].o - candles[d].c;
    const a = ctx.atr[d] ?? atr;
    const ratio = body / a;
    if (body > 0 && ratio >= P.disRatio && (!dis || ratio > dis.ratio)) dis = { i: d, ratio };
  }
  if (!dis) return { sweep, mssBar, mssLevel: L.p };

  let fvg = null;
  for (let g = j; g >= Math.max(3, dis.i - 1); g--) {
    const top = candles[g - 2].l;
    const bottom = candles[g].h;
    if (bottom < top && top <= sweep.high + 0.5 * atr) {
      fvg = { g, bottom, top };
      break;
    }
  }
  if (!fvg) return { sweep, mssBar, mssLevel: L.p, dis };

  let retrace = null;
  for (let r = fvg.g + 1; r <= j; r++) {
    if (candles[r].h >= fvg.bottom && candles[r].c <= fvg.top + 0.1 * atr) {
      retrace = { i: r };
      break;
    }
  }
  if (!retrace) return { sweep, mssBar, mssLevel: L.p, dis, fvg };

  let confirm = null;
  for (let c2 = retrace.i; c2 <= Math.min(j, retrace.i + P.confirmBars); c2++) {
    if (candles[c2].c < fvg.bottom && candles[c2].c < candles[c2].o) {
      confirm = { i: c2 };
      break;
    }
  }
  return { sweep, mssBar, mssLevel: L.p, dis, fvg, retrace, confirm };
}

function smcSteps(stages, side, vwapOk, trendOk) {
  const p = (v) => r4(v);
  const done = stages.confirm;
  const steps = [
    { id: 'htf', name: '1H / 15M trend', state: trendOk ? 'READY' : 'WAITING', note: trendOk ? '1H EMA 50/200 stacked with price on that side' : '1H EMA 50/200 stack not aligned' },
    { id: 'sweep', name: 'Liquidity sweep', state: stages.sweep ? 'READY' : 'WAITING', note: stages.sweep ? `Swept ${side === 'bull' ? 'swing low' : 'swing high'} ${p(stages.sweep.level)}` : 'Waiting for a sweep of a confirmed swing' },
    { id: 'mss', name: 'Market structure shift', state: stages.mssBar ? 'READY' : 'WAITING', note: stages.mssBar ? `Close through structure ${p(stages.mssLevel)}` : stages.sweep ? `Needs a close ${side === 'bull' ? 'above' : 'below'} ${p(stages.mssLevel)}` : 'Waiting for sweep first' },
    { id: 'fvg', name: 'Displacement + FVG', state: stages.fvg ? 'READY' : stages.dis ? 'NEAR' : 'WAITING', note: stages.fvg ? `Fair value gap ${p(stages.fvg.bottom)}–${p(stages.fvg.top)}` : stages.dis ? `Displacement ${stages.dis.ratio.toFixed(1)}× ATR — gap not formed yet` : 'Waiting for a displacement candle' },
    { id: 'entry', name: 'FVG retrace entry', state: done ? 'FIRED' : stages.retrace ? 'NEAR' : 'WAITING', note: done ? 'Confirmed candle closed back out of the gap' : stages.retrace ? 'Price is inside the gap — waiting for the confirmation close' : 'Waiting for a retrace into the gap' },
  ];
  return steps;
}

function evaluateSmc(candles, ctx, i, opts, session) {
  const j = i - 1;
  const checks = emptyChecks();
  if (j < 60) return { dir: 'NEUTRAL', warnings: ['Loading 5m history for the SMC engine'], checks, setup: 'Loading', setups: [] };
  const htf = opts.htf;
  if (!htf || !htf.m15 || !htf.h1) {
    return { dir: 'NEUTRAL', warnings: ['Waiting for 15m / 1H context'], checks, setup: 'Loading higher timeframes', setups: [] };
  }

  const atr = ctx.atr[j];
  const slowAtr = avgAtr(ctx, j - 49, j);
  const lowVol = atr == null || slowAtr == null || atr < 0.6 * slowAtr;
  const vwap = ctx.vwap ? ctx.vwap[j] : null;
  const vr = volRatioAt(ctx, j);
  const barSec = opts.tfSec || 300;

  const k15 = htfIndex(htf.m15, candles[j].t, barSec);
  const k60 = htfIndex(htf.h1, candles[j].t, barSec);
  const t15 = htfTrend(htf.m15, k15, candles[j].c);
  const t60 = htfTrend(htf.h1, k60, candles[j].c);
  const p15 = priceVsEma(htf.m15, k15, candles[j].c);
  const long = smcLong(candles, ctx, j);
  const short = smcShort(candles, ctx, j);

  const checksFor = (side, stages, trendOk, vwapOk) => {
    const c = emptyChecks();
    c.trend = { ok: trendOk, note: trendOk ? `1H + 15M ${side === 'bull' ? 'bullish' : 'bearish'} — EMA 50/200 stacked in both` : `1H ${t60 === 1 ? 'bull' : t60 === -1 ? 'bear' : 'flat'} · 15M ${t15 === 1 ? 'bull' : t15 === -1 ? 'bear' : 'flat'} — not aligned` };
    c.level = { ok: !!stages.fvg, note: stages.fvg ? `${side === 'bull' ? 'Bullish' : 'Bearish'} FVG ${r4(stages.fvg.bottom)}–${r4(stages.fvg.top)}` : 'No fair value gap yet' };
    c.momentum = {
      ok: !!stages.mssBar && !!stages.dis,
      note: stages.dis ? `Displacement ${stages.dis.ratio.toFixed(1)}× ATR${stages.mssBar ? ` · MSS ${r4(stages.mssLevel)}` : ''}` : stages.mssBar ? `MSS ${r4(stages.mssLevel)}` : 'No structure shift yet',
    };
    c.volume = { ok: vr != null ? vr >= 1.2 : null, note: vr != null ? `Volume ${vr.toFixed(1)}× 20-avg${vwapOk ? ' · VWAP side ok' : ''}` : 'Volume unavailable' };
    return c;
  };

  // Hard gates: 1H and 15M EMA 50/200 stacks agree, volume confirms, ATR not dead.
  // VWAP side is scored instead of blocking — the FVG retrace entry usually
  // fills before price has reclaimed VWAP again.
  const longTrend = t60 === 1 && t15 === 1;
  const shortTrend = t60 === -1 && t15 === -1;
  const longVwap = vwap != null && candles[j].c > vwap;
  const shortVwap = vwap != null && candles[j].c < vwap;
  const longFresh = long?.confirm && long.confirm.i >= j - 3;
  const shortFresh = short?.confirm && short.confirm.i >= j - 3;
  const longOk = longTrend && longFresh && !lowVol && (vr == null || vr >= 1.2);
  const shortOk = shortTrend && shortFresh && !lowVol && (vr == null || vr >= 1.2);

  const pick = longOk && (!shortOk || long.confirm.i >= short.confirm.i) ? { side: 'bull', st: long, vwapOk: longVwap, trendOk: longTrend } : shortOk ? { side: 'bear', st: short, vwapOk: shortVwap, trendOk: shortTrend } : null;

  if (pick) {
    const { side, st } = pick;
    const bull = side === 'bull';
    const entry = candles[st.confirm.i].c;
    const sweepLevel = st.sweep.low ?? st.sweep.level;
    const rawSl = bull ? sweepLevel - 0.2 * atr : sweepLevel + 0.2 * atr;
    const dist = Math.abs(entry - rawSl);
    if (!(dist > 0) || dist > SMC_P.maxStopAtr * atr) {
      return {
        dir: 'NEUTRAL',
        warnings: [`SMC setup rejected — stop distance ${(dist / atr).toFixed(1)}× ATR is excessive`, ...(lowVol ? ['ATR abnormally low — no-trade filter'] : [])],
        checks: checksFor(side, st, pick.trendOk, pick.vwapOk),
        setup: 'SMC setup rejected',
        setups: smcSteps(st, side, pick.vwapOk, pick.trendOk),
      };
    }
    const targets = bull ? [entry + dist, entry + 2 * dist, entry + 3 * dist] : [entry - dist, entry - 2 * dist, entry - 3 * dist];
    const bodyRatio = st.dis ? st.dis.ratio : 1;
    let score = 58;
    if (bodyRatio >= 1.6) score += 7;
    else if (bodyRatio >= 1.3) score += 4;
    if (vr != null && vr >= 1.5) score += 7;
    else if (vr != null && vr >= 1.2) score += 4;
    if (pick.vwapOk) score += 6;
    if (session.preferred) score += 3;
    const strength = Math.round(clamp(score, 60, 94));
    const reasons = [
      reason(side, 18, `Liquidity sweep ${bull ? 'below' : 'above'} ${r4(st.sweep.level)} — stops taken, price reclaimed`),
      reason(side, 16, `${bull ? 'Bullish' : 'Bearish'} MSS confirmed through ${r4(st.mssLevel)}`),
      reason(side, 14, `Displacement ${bodyRatio.toFixed(1)}× ATR${vr != null ? ` on ${vr.toFixed(1)}× volume` : ''}`),
      reason(side, 14, `${bull ? 'Bullish' : 'Bearish'} FVG ${r4(st.fvg.bottom)}–${r4(st.fvg.top)} retested and confirmed`),
      reason(side, 10, `1H + 15M trend aligned${vwap != null ? ` · price ${bull ? 'above' : 'below'} VWAP ${r4(vwap)}` : ''}`),
    ];
    const checks2 = checksFor(side, st, pick.trendOk, pick.vwapOk);
    const warnings = [];
    if (!pick.vwapOk) warnings.push(`Entry is on the wrong side of VWAP ${vwap != null ? r4(vwap) : ''} — confidence reduced`.replace('  ', ' '));
    return {
      family: 'smc',
      dir: bull ? 'BUY' : 'SELL',
      sigIdx: st.confirm.i,
      score,
      strength,
      sl: rawSl,
      targets,
      setup: `${bull ? 'Bullish' : 'Bearish'} SMC: sweep → MSS → FVG ${r4(st.fvg.bottom)}–${r4(st.fvg.top)}`,
      reasons,
      warnings,
      checks: checks2,
      setups: smcSteps(st, side, pick.vwapOk, pick.trendOk),
      move: { type: 'SMC', atr: Number(bodyRatio.toFixed(2)) },
    };
  }

  // No trade — report how far the pattern progressed on the side the trend favours.
  const preferredSide = t60 === -1 || (t60 === 0 && p15 === -1) ? 'bear' : 'bull';
  const diag = preferredSide === 'bear' ? short : long;
  const trendOk = preferredSide === 'bear' ? shortTrend : longTrend;
  const warnings = [];
  if (lowVol) warnings.push('ATR below 0.6× its 50-bar average — no-trade filter');
  if (!trendOk) warnings.push(`Trend filter: 1H ${t60 === 1 ? 'bullish' : t60 === -1 ? 'bearish' : 'flat'} · 15M ${p15 === 1 ? 'above' : p15 === -1 ? 'below' : 'flat'} EMA 200 (need the 1H stack aligned)`);
  if (diag && !diag.sweep) warnings.push(`No liquidity sweep ${preferredSide === 'bull' ? 'of a swing low' : 'of a swing high'} in the last 30 bars`);
  else if (diag && !diag.mssBar) warnings.push(`Sweep at ${r4(diag.sweep.level)} — waiting for an MSS close through ${r4(diag.mssLevel)}`);
  else if (diag && !diag.dis) warnings.push('Structure shifted — waiting for a displacement candle (≥1.2× ATR)');
  else if (diag && !diag.fvg) warnings.push('Displacement found — waiting for a fair value gap');
  else if (diag && !diag.retrace) warnings.push(`FVG ${r4(diag.fvg.bottom)}–${r4(diag.fvg.top)} formed — waiting for a retrace`);
  else if (diag && !diag.confirm) warnings.push('Price in the FVG — waiting for the confirmation close');
  else if (diag?.confirm && trendOk) warnings.push('Setup formed — confirmation close is stale, waiting for a fresh one');
  if (!warnings.length) warnings.push('SMC engine scanning — no completed 10-step setup');
  return {
    dir: 'NEUTRAL',
    warnings,
    checks: checksFor(preferredSide, diag || {}, trendOk, preferredSide === 'bull' ? longVwap : shortVwap),
    setup: 'SMC scan',
    setups: smcSteps(diag || {}, preferredSide, preferredSide === 'bull' ? longVwap : shortVwap, trendOk),
  };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function evaluate(candles, ctx, i, opts = {}) {
  const tf = opts.tf || '5m';
  const rawMarket = opts.market || 'custom';
  const nowSec = Number.isFinite(opts.nowSec) ? opts.nowSec : candles[i].t;
  const live = Number.isFinite(opts.livePrice) && opts.livePrice > 0 ? opts.livePrice : candles[i].c;
  const swing = !INTRADAY.has(tf);
  const smc = !swing && tf === '5m' && isSmcSymbol(opts.symbol);
  const meta = swing ? STRATEGIES.swing : smc ? STRATEGIES.smc : STRATEGIES[rawMarket] || STRATEGIES.custom;
  const marketKey = swing ? 'swing' : rawMarket;
  const session = swing
    ? { active: true, preferred: true, mode: 'swing', label: 'Swing mode', window: 'session filter off for 4h/1d', ist: istParts(nowSec).hm, day: istParts(nowSec).day, next: null }
    : sessionInfo(rawMarket, nowSec, tf);

  let res;
  if (!swing && !session.active) {
    res = {
      dir: 'NEUTRAL',
      warnings: [`${session.label} — ${session.window}${session.next ? '. ' + session.next : ''}`],
      checks: emptyChecks(),
      setup: 'Session closed',
    };
  } else if (swing) {
    res = evaluateSwing(candles, ctx, i, opts);
  } else if (smc) {
    res = evaluateSmc(candles, ctx, i, opts, session);
  } else if (rawMarket === 'india') {
    res = evaluateIndia(candles, ctx, i, opts, session);
  } else {
    const key = ADAPTIVE_FAMILIES[rawMarket] ? rawMarket : 'custom';
    res = evaluateAdaptive(candles, ctx, i, opts, session, key);
  }

  let dir = res.dir || 'NEUTRAL';
  let plan = null;
  let invalid = null;

  if (dir !== 'NEUTRAL' && res.sl != null) {
    plan = makePlan(live, res.sl, res.targets || []);
    if (!plan) invalid = 'Could not build a valid stop/target plan';
    else if (dir === 'BUY' && !(plan.sl < plan.entry && plan.targets[0] > plan.entry)) invalid = 'Invalid long plan levels';
    else if (dir === 'SELL' && !(plan.sl > plan.entry && plan.targets[0] < plan.entry)) invalid = 'Invalid short plan levels';
    else if (dir === 'BUY' && live <= plan.sl) invalid = 'Price already through the stop — setup expired';
    else if (dir === 'SELL' && live >= plan.sl) invalid = 'Price already through the stop — setup expired';
    else if (dir === 'BUY' && live >= plan.targets[0]) invalid = 'Price already at target 1 — entry missed';
    else if (dir === 'SELL' && live <= plan.targets[0]) invalid = 'Price already at target 1 — entry missed';
  } else if (dir !== 'NEUTRAL') {
    invalid = 'No stop-loss defined for this setup';
  }

  if (invalid) {
    dir = 'NEUTRAL';
    plan = null;
    res.warnings = [...(res.warnings || []), invalid, res.setup].filter(Boolean);
    res.setup = 'Setup expired';
  }

  const checks = res.checks || emptyChecks();
  const items = [
    { key: 'trend', label: 'Trend aligned', ok: checks.trend?.ok ?? false, note: checks.trend?.note || '' },
    { key: 'level', label: 'Key level', ok: checks.level?.ok ?? false, note: checks.level?.note || '' },
    { key: 'momentum', label: 'Momentum', ok: checks.momentum?.ok ?? false, note: checks.momentum?.note || '' },
    { key: 'volume', label: 'Volume spike', ok: checks.volume?.ok ?? null, note: checks.volume?.note || '' },
    { key: 'news', label: 'News clear', ok: null, note: 'news / economic calendar not connected' },
  ];
  const passed = items.filter((x) => x.ok === true).length;
  const evaluated = items.filter((x) => x.ok !== null).length;

  let confidence = 0;
  const warnings = [...new Set((res.warnings || []).filter(Boolean))];
  if (dir !== 'NEUTRAL') {
    confidence = Math.round(clamp(res.strength ?? 60, 40, 96));
    if (passed < Math.min(3, evaluated)) {
      confidence = Math.min(confidence, 74);
      warnings.push(`Confluence ${passed}/${evaluated} — most checks disagree`);
    }
    if (!session.preferred) {
      confidence = Math.min(confidence, 78);
      if (!warnings.some((w) => /preferred/i.test(w))) warnings.push('Outside preferred session hours — reduced conviction');
    }
  }

  const strategy = {
    id: meta.id,
    name: meta.name,
    targetTf: meta.targetTf,
    session,
    checklist: items,
    passed,
    evaluated,
    setup: res.setup || '',
    setups: res.setups || [],
    news: 'not connected',
  };

  return {
    market: marketKey,
    strategy,
    direction: dir,
    state: dir === 'NEUTRAL' ? 'NONE' : res.sigIdx === i ? 'FORMING' : 'CONFIRMED',
    triggerIdx: res.sigIdx ?? null,
    triggerTime: res.sigIdx != null && candles[res.sigIdx] ? candles[res.sigIdx].t : null,
    strength: dir === 'NEUTRAL' ? 0 : confidence,
    confidence,
    reasons: dir === 'NEUTRAL' ? [] : res.reasons || [],
    warnings: warnings.slice(0, 5),
    plan,
    move: res.move || null,
    checks: items,
  };
}
