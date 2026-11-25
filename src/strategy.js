// Analysis entry point.
//
// Indicator context is precomputed once per candle series, then the market's
// playbook in strategies.js decides the signal, plan and confluence checklist.
// The same functions are used live and in the backtester.

import {
  adx,
  atr,
  bollinger,
  dailyPivots,
  ema,
  macd,
  openingRanges,
  rollingExtremes,
  rsi,
  sma,
  stochRsi,
  supertrend,
  vwapSeries,
} from './indicators.js';
import { evaluate } from './strategies.js';

const INTRADAY = new Set(['1m', '5m', '15m', '1h', '4h']);

export function priceDecimals(price) {
  const a = Math.abs(price);
  if (!Number.isFinite(a) || a === 0) return 2;
  if (a >= 1000) return 2;
  if (a >= 10) return 3;
  if (a >= 1) return 4;
  if (a >= 0.1) return 5;
  if (a >= 0.01) return 6;
  return 7;
}

const round = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const pct = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

export function computeContext(candles, opts = {}) {
  const closes = candles.map((c) => c.c);
  const vols = candles.map((c) => c.v || 0);
  const tf = opts.tf || '5m';
  const tz = opts.tzOffsetMinutes || 0;
  const ex = rollingExtremes(candles, 20);
  const bb = bollinger(closes, 20, 2);
  const bbw = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (bb.mid[i]) bbw[i] = (bb.upper[i] - bb.lower[i]) / bb.mid[i];
  }

  return {
    closes,
    vols,
    e5: ema(closes, 5),
    e9: ema(closes, 9),
    e13: ema(closes, 13),
    e20: ema(closes, 20),
    e21: ema(closes, 21),
    e50: ema(closes, 50),
    e200: closes.length >= 210 ? ema(closes, 200) : null,
    rsi: rsi(closes, 14),
    stoch: stochRsi(closes, 14, 3, 3),
    macd: macd(closes, 12, 26, 9),
    atr: atr(candles, 14),
    adx: adx(candles, 14),
    st: supertrend(candles, 10, 3),
    bb,
    bbw,
    vwap: INTRADAY.has(tf) ? vwapSeries(candles, tz) : null,
    volSma: sma(vols, 20),
    hh: ex.hh,
    ll: ex.ll,
    piv: dailyPivots(candles, 330),
    or: openingRanges(candles, 330),
    tf,
  };
}

function trendLabel(ctx, i, price) {
  const e20 = ctx.e20[i];
  const e50 = ctx.e50[i];
  if (e20 != null && e50 != null) {
    if (price > e20 && e20 > e50) return 'UP';
    if (price < e20 && e20 < e50) return 'DOWN';
    return 'SIDE';
  }
  if (e50 != null) return price > e50 ? 'UP' : 'DOWN';
  return 'SIDE';
}

export function analyze(candles, opts = {}) {
  const tf = opts.tf || '5m';
  const n = candles.length;
  if (n < 70) return { ok: false, reason: `Not enough data (${n} bars, need 70+)` };

  const ctx = computeContext(candles, opts);
  const i = n - 1;
  const last = candles[i];
  const livePrice = Number.isFinite(opts.livePrice) && opts.livePrice > 0 ? opts.livePrice : last.c;
  let ev = evaluate(candles, ctx, i, { ...opts, tf, livePrice });

  // Anchor the plan to the trigger bar's close so entry/SL/targets are a fixed
  // trade, not a live-price recalc that drifts every tick.
  if (ev.direction !== 'NEUTRAL' && ev.triggerIdx != null && candles[ev.triggerIdx]) {
    const trigClose = candles[ev.triggerIdx].c;
    const anchored = evaluate(candles, ctx, i, { ...opts, tf, livePrice: trigClose });
    if (anchored.direction === ev.direction && anchored.plan) ev = anchored;
  }

  const dir = ev.direction;
  const plan = ev.plan;
  const dec = priceDecimals(livePrice);
  const confidence = ev.confidence;
  const grade = confidence >= 80 ? 'A' : confidence >= 68 ? 'B' : confidence >= 56 ? 'C' : 'D';

  const prevClose = Number.isFinite(opts.prevClose) && opts.prevClose > 0 ? opts.prevClose : candles[Math.max(0, i - 1)].c;
  const chgPct = Number.isFinite(opts.changePct) ? opts.changePct : ((livePrice - prevClose) / prevClose) * 100;

  const r2 = (v) => round(v, dec);
  const atrV = ctx.atr[i] ?? null;
  const stochK = ctx.stoch.k[i];
  const vb = ctx.volSma[i];
  const volRatio = vb && vb > 0 ? (ctx.vols[i] || 0) / vb : null;

  return {
    ok: true,
    symbol: opts.symbol || '',
    tf,
    time: last.t,
    price: round(livePrice, dec),
    changePct: pct(chgPct),
    direction: dir,
    signal: dir,
    state: ev.state,
    confidence,
    grade,
    score: dir === 'BUY' ? confidence : dir === 'SELL' ? -confidence : 0,
    strength: ev.strength,
    entry: plan ? r2(plan.entry) : null,
    stopLoss: plan ? r2(plan.sl) : null,
    targets: plan ? plan.targets.map(r2) : [],
    riskPct: plan ? pct(plan.riskPct) : null,
    rr: plan ? pct(plan.rr, 2) : null,
    atr: atrV != null ? r2(atrV) : null,
    atrPct: atrV != null ? pct((atrV / livePrice) * 100) : null,
    reasons: ev.reasons,
    warnings: ev.warnings,
    move: ev.move,
    strategy: ev.strategy,
    session: ev.strategy.session,
    indicators: {
      rsi: pct(ctx.rsi[i], 1),
      stochRsi: stochK != null ? pct(stochK, 1) : null,
      stochD: ctx.stoch.d[i] != null ? pct(ctx.stoch.d[i], 1) : null,
      adx: pct(ctx.adx.adx[i], 1),
      pdi: pct(ctx.adx.pdi[i], 1),
      mdi: pct(ctx.adx.mdi[i], 1),
      macdHist: ctx.macd.hist[i] != null ? Number(ctx.macd.hist[i].toPrecision(4)) : null,
      ema9: ctx.e9[i] != null ? r2(ctx.e9[i]) : null,
      ema21: ctx.e21[i] != null ? r2(ctx.e21[i]) : null,
      ema50: ctx.e50[i] != null ? r2(ctx.e50[i]) : null,
      ema200: ctx.e200 && ctx.e200[i] != null ? r2(ctx.e200[i]) : null,
      vwap: ctx.vwap && ctx.vwap[i] != null ? r2(ctx.vwap[i]) : null,
      supertrend: ctx.st.line[i] != null ? r2(ctx.st.line[i]) : null,
      supertrendDir: ctx.st.dir[i],
      bbUpper: ctx.bb.upper[i] != null ? r2(ctx.bb.upper[i]) : null,
      bbLower: ctx.bb.lower[i] != null ? r2(ctx.bb.lower[i]) : null,
      bbWidthPct: ctx.bbw[i] != null ? pct(ctx.bbw[i] * 100, 2) : null,
      pivotPP: ctx.piv.pp[i] != null ? r2(ctx.piv.pp[i]) : null,
      pivotS1: ctx.piv.s1[i] != null ? r2(ctx.piv.s1[i]) : null,
      pivotR1: ctx.piv.r1[i] != null ? r2(ctx.piv.r1[i]) : null,
      orHigh: ctx.or.high[i] != null ? r2(ctx.or.high[i]) : null,
      orLow: ctx.or.low[i] != null ? r2(ctx.or.low[i]) : null,
      orReady: !!ctx.or.ready[i],
      support: ctx.ll[i] != null ? r2(ctx.ll[i]) : null,
      resistance: ctx.hh[i] != null ? r2(ctx.hh[i]) : null,
      volRatio: volRatio != null ? pct(volRatio, 2) : null,
      trend: trendLabel(ctx, i, livePrice),
    },
    decimals: dec,
    bars: n,
  };
}

export { INTRADAY };
