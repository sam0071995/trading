// Technical indicators. All functions are causal: the value at index i uses
// only data up to and including bar i, so arrays can be precomputed for backtests.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = Number.isFinite(values[i]) ? values[i] : 0;
    sum += v;
    if (i >= period) {
      const old = Number.isFinite(values[i - period]) ? values[i - period] : 0;
      sum -= old;
    }
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let ag = gain / period;
  let al = loss / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const line = values.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const start = line.findIndex((v) => v != null);
  const signal = new Array(values.length).fill(null);
  if (start >= 0) {
    const seg = line.slice(start);
    const segSig = ema(seg, signalPeriod);
    for (let i = 0; i < segSig.length; i++) {
      if (segSig[i] != null) signal[start + i] = segSig[i];
    }
  }
  const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
  return { line, signal, hist };
}

export function trueRange(candles) {
  return candles.map((c, i) =>
    i === 0
      ? c.h - c.l
      : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c)),
  );
}

export function atr(candles, period = 14) {
  const tr = trueRange(candles);
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

// Wilder ADX with +DI / -DI
export function adx(candles, period = 14) {
  const n = candles.length;
  const out = {
    adx: new Array(n).fill(null),
    pdi: new Array(n).fill(null),
    mdi: new Array(n).fill(null),
  };
  if (n < period * 2 + 2) return out;

  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  const tr = trueRange(candles);
  for (let i = 1; i < n; i++) {
    const up = candles[i].h - candles[i - 1].h;
    const down = candles[i - 1].l - candles[i].l;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }

  let sTR = 0;
  let sP = 0;
  let sM = 0;
  for (let i = 1; i <= period; i++) {
    sTR += tr[i];
    sP += plusDM[i];
    sM += minusDM[i];
  }

  const dx = new Array(n).fill(null);
  const put = (i) => {
    const pdi = sTR > 0 ? (100 * sP) / sTR : 0;
    const mdi = sTR > 0 ? (100 * sM) / sTR : 0;
    out.pdi[i] = pdi;
    out.mdi[i] = mdi;
    dx[i] = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
  };
  put(period);
  for (let i = period + 1; i < n; i++) {
    sTR = sTR - sTR / period + tr[i];
    sP = sP - sP / period + plusDM[i];
    sM = sM - sM / period + minusDM[i];
    put(i);
  }

  const seedIdx = period * 2 - 1;
  if (n <= seedIdx) return out;
  let sum = 0;
  for (let i = period; i <= seedIdx; i++) sum += dx[i];
  let a = sum / period;
  out.adx[seedIdx] = a;
  for (let i = seedIdx + 1; i < n; i++) {
    a = (a * (period - 1) + dx[i]) / period;
    out.adx[i] = a;
  }
  return out;
}

export function supertrend(candles, period = 10, mult = 3) {
  const n = candles.length;
  const line = new Array(n).fill(null);
  const dir = new Array(n).fill(null);
  const a = atr(candles, period);
  let upper = null;
  let lower = null;
  let trend = 1;
  for (let i = period; i < n; i++) {
    const aV = a[i];
    if (aV == null) continue;
    const hl2 = (candles[i].h + candles[i].l) / 2;
    const u = hl2 + mult * aV;
    const l = hl2 - mult * aV;
    if (upper == null) {
      upper = u;
      lower = l;
      trend = candles[i].c >= hl2 ? 1 : -1;
    } else {
      const prevClose = candles[i - 1].c;
      upper = u < upper || prevClose > upper ? u : upper;
      lower = l > lower || prevClose < lower ? l : lower;
      if (trend === 1 && candles[i].c < lower) {
        trend = -1;
        upper = u;
      } else if (trend === -1 && candles[i].c > upper) {
        trend = 1;
        lower = l;
      }
    }
    dir[i] = trend;
    line[i] = trend === 1 ? lower : upper;
  }
  return { line, dir };
}

export function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

export function vwapSeries(candles, tzOffsetMinutes = 0) {
  const out = new Array(candles.length).fill(null);
  let day = null;
  let pv = 0;
  let vv = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = new Date((c.t + tzOffsetMinutes * 60) * 1000).toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      pv = 0;
      vv = 0;
    }
    const tp = (c.h + c.l + c.c) / 3;
    const v = c.v > 0 ? c.v : 1;
    pv += tp * v;
    vv += v;
    out[i] = pv / vv;
  }
  return out;
}

// Highest high / lowest low of the N bars *before* index i (excludes current bar)
export function rollingExtremes(candles, lookback = 20) {
  const n = candles.length;
  const hh = new Array(n).fill(null);
  const ll = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const from = Math.max(0, i - lookback);
    if (from >= i) continue;
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = from; k < i; k++) {
      if (candles[k].h > hi) hi = candles[k].h;
      if (candles[k].l < lo) lo = candles[k].l;
    }
    hh[i] = hi;
    ll[i] = lo;
  }
  return { hh, ll };
}

// Fractal pivots for clean support / resistance display
export function pivotLevels(candles, k = 3, lookback = 120) {
  const n = candles.length;
  const from = Math.max(k, n - lookback);
  const highs = [];
  const lows = [];
  for (let i = from; i < n - k; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) isHigh = false;
      if (candles[j].l <= candles[i].l) isLow = false;
    }
    if (isHigh) highs.push(candles[i].h);
    if (isLow) lows.push(candles[i].l);
  }
  return { highs, lows };
}

export function roc(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    const base = values[i - period];
    if (base) out[i] = ((values[i] - base) / base) * 100;
  }
  return out;
}

// Stochastic RSI (3,3,14,14): stochastic of the RSI series, then %K/%D smoothing.
export function stochRsi(values, rsiPeriod = 14, kPeriod = 3, dPeriod = 3) {
  const n = values.length;
  const r = rsi(values, rsiPeriod);
  const raw = new Array(n).fill(null);
  for (let i = rsiPeriod * 2 - 1; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    let ok = true;
    for (let j = i - rsiPeriod + 1; j <= i; j++) {
      const v = r[j];
      if (v == null) {
        ok = false;
        break;
      }
      if (v > hi) hi = v;
      if (v < lo) lo = v;
    }
    if (!ok) continue;
    raw[i] = hi === lo ? 50 : ((r[i] - lo) / (hi - lo)) * 100;
  }
  const smooth = (arr, period) => {
    const out = new Array(n).fill(null);
    const first = arr.findIndex((v) => v != null);
    if (first < 0) return out;
    const seg = arr.slice(first);
    const sm = sma(seg, period);
    for (let t = 0; t < sm.length; t++) if (sm[t] != null) out[first + t] = sm[t];
    return out;
  };
  const k = smooth(raw, kPeriod);
  const d = smooth(k, dPeriod);
  return { k, d, rsi: r };
}

// Day boundaries in a fixed exchange timezone (minutes east of UTC).
function dayKey(tSec, tzOffsetMinutes) {
  return new Date((tSec + tzOffsetMinutes * 60) * 1000).toISOString().slice(0, 10);
}

// Classic daily pivot points from the previous completed day: PP, R1/R2, S1/S2.
export function dailyPivots(candles, tzOffsetMinutes = 330) {
  const n = candles.length;
  const out = {
    pp: new Array(n).fill(null),
    r1: new Array(n).fill(null),
    r2: new Array(n).fill(null),
    s1: new Array(n).fill(null),
    s2: new Array(n).fill(null),
  };
  let key = null;
  let h = -Infinity;
  let l = Infinity;
  let c = null;
  let prevH = null;
  let prevL = null;
  let prevC = null;
  for (let i = 0; i < n; i++) {
    const bar = candles[i];
    const k = dayKey(bar.t, tzOffsetMinutes);
    if (k !== key) {
      if (key != null) {
        prevH = h;
        prevL = l;
        prevC = c;
      }
      key = k;
      h = -Infinity;
      l = Infinity;
      c = null;
    }
    if (bar.h > h) h = bar.h;
    if (bar.l < l) l = bar.l;
    c = bar.c;
    if (prevH != null) {
      const pp = (prevH + prevL + prevC) / 3;
      out.pp[i] = pp;
      out.r1[i] = 2 * pp - prevL;
      out.s1[i] = 2 * pp - prevH;
      out.r2[i] = pp + (prevH - prevL);
      out.s2[i] = pp - (prevH - prevL);
    }
  }
  return out;
}

// Opening range (default first 5 minutes of the 09:15 IST session), causal per bar.
export function openingRanges(candles, tzOffsetMinutes = 330, startMin = 555, windowMin = 5) {
  const n = candles.length;
  const high = new Array(n).fill(null);
  const low = new Array(n).fill(null);
  const size = new Array(n).fill(null);
  const ready = new Array(n).fill(false);
  let key = null;
  let h = -Infinity;
  let l = Infinity;
  let any = false;
  let done = false;
  for (let i = 0; i < n; i++) {
    const bar = candles[i];
    const shifted = new Date((bar.t + tzOffsetMinutes * 60) * 1000);
    const k = shifted.toISOString().slice(0, 10);
    const mins = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
    if (k !== key) {
      key = k;
      h = -Infinity;
      l = Infinity;
      any = false;
      done = false;
    }
    if (!done && mins >= startMin && mins < startMin + windowMin) {
      if (bar.h > h) h = bar.h;
      if (bar.l < l) l = bar.l;
      any = true;
    }
    if (!done && mins >= startMin + windowMin && any) done = true;
    ready[i] = done;
    if (done) {
      high[i] = h;
      low[i] = l;
      size[i] = h - l;
    }
  }
  return { high, low, size, ready };
}

