// Live market data with caching, request de-duplication and multi-source fallback.
//
//   Crypto      : Binance -> Bybit -> OKX -> Yahoo (BTC-USD)
//   Forex/India : Yahoo Finance chart API
//   Commodities : Yahoo Finance chart API (futures)
//
// No API keys required. Set CACHE_TTL_SCALE=2 to be gentler on the providers.

import { aliasFor, detectMarket, yahooSymbol } from './markets.js';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

const SCALE = Number(process.env.CACHE_TTL_SCALE || 1);

export const TF_SEC = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };

const TTL = {
  '1m': 18000,
  '5m': 40000,
  '15m': 80000,
  '1h': 180000,
  '4h': 300000,
  '1d': 600000,
};

export const ttlFor = (tf) => (TTL[tf] || 60000) * SCALE;

const cache = new Map();
const inflight = new Map();
const preferredSource = new Map();
const hostCooldown = new Map();

export function peekCache(symbol, tf) {
  return cache.get(`${symbol}|${tf}`) || null;
}

export function cacheAge(symbol, tf) {
  const e = cache.get(`${symbol}|${tf}`);
  return e ? Date.now() - e.at : Infinity;
}

async function jget(url, timeout = 12000) {
  const host = new URL(url).host;
  const until = hostCooldown.get(host) || 0;
  if (Date.now() < until) throw new Error(`${host} cooling down`);
  let res;
  try {
    res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    hostCooldown.set(host, Date.now() + 20000);
    throw new Error(`${host}: ${err.message}`);
  }
  if (!res.ok) {
    if (res.status === 429 || res.status === 403 || res.status === 451) {
      hostCooldown.set(host, Date.now() + 60000);
    }
    throw new Error(`${host} HTTP ${res.status}`);
  }
  return res.json();
}

/* ------------------------------------------------------------------ */
/* Crypto symbol helpers                                               */
/* ------------------------------------------------------------------ */

export function parseCryptoSymbol(symbol) {
  const m0 = /^(BTC|ETH|SOL|XRP|BNB|DOGE|ADA|LINK|AVAX|LTC|XAUT|PAXG)USD$/.exec(symbol);
  if (m0) return { base: m0[1], quote: 'USD', yahoo: `${m0[1]}-USD` };
  const m1 = /^([A-Z0-9]{2,12})(USDT|USDC|BUSD)$/.exec(symbol);
  if (m1) return { base: m1[1], quote: m1[2], yahoo: `${m1[1]}-${m1[2] === 'USDT' || m1[2] === 'USDC' || m1[2] === 'BUSD' ? 'USD' : m1[2]}` };
  const m2 = /^([A-Z0-9]{2,10})-(USD|USDT)$/.exec(symbol);
  if (m2) return { base: m2[1], quote: m2[2], yahoo: `${m2[1]}-USD` };
  return null;
}

/* ------------------------------------------------------------------ */
/* Yahoo Finance                                                       */
/* ------------------------------------------------------------------ */

const YAHOO_IV = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '60m', '4h': '60m', '1d': '1d' };
const YAHOO_RANGE = { '1m': '5d', '5m': '1mo', '15m': '1mo', '1h': '6mo', '4h': '6mo', '1d': '2y' };

function aggregate(candles, seconds) {
  const out = [];
  let cur = null;
  for (const c of candles) {
    const bucket = Math.floor(c.t / seconds) * seconds;
    if (!cur || cur.t !== bucket) {
      cur = { t: bucket, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
      out.push(cur);
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
      cur.v += c.v;
    }
  }
  return out;
}

async function fetchYahoo(symbol, tf) {
  const src = yahooSymbol(symbol);
  const alias = aliasFor(symbol);
  const iv = YAHOO_IV[tf] || '15m';
  const range = YAHOO_RANGE[tf] || '1mo';
  const qs = `?interval=${iv}&range=${range}&includePrePost=false&events=div%2Csplit`;
  const path = `/v8/finance/chart/${encodeURIComponent(src)}${qs}`;
  let j;
  let lastErr;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      j = await jget(`https://${host}${path}`);
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!j) throw lastErr || new Error('Yahoo unavailable');

  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(j?.chart?.error?.description || 'yahoo: no data');
  const q = result.indicators?.quote?.[0] || {};
  const ts = result.timestamp || [];
  const candles = [];
  const seen = new Set();
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    if (seen.has(ts[i])) continue;
    seen.add(ts[i]);
    candles.push({ t: ts[i], o, h, l, c, v: Number(q.volume?.[i]) || 0 });
  }
  if (candles.length < 30) throw new Error(`yahoo: only ${candles.length} bars`);
  const cs = tf === '4h' ? aggregate(candles, 14400) : candles;

  const m = result.meta || {};
  const lastClose = cs[cs.length - 1].c;
  const price = Number.isFinite(m.regularMarketPrice) ? m.regularMarketPrice : lastClose;
  const prevClose = Number.isFinite(m.previousClose)
    ? m.previousClose
    : Number.isFinite(m.chartPreviousClose)
      ? m.chartPreviousClose
      : null;

  return {
    candles: cs,
    source: 'yahoo',
    meta: {
      price,
      prevClose,
      changePct: Number.isFinite(m.regularMarketChangePercent)
        ? m.regularMarketChangePercent
        : prevClose
          ? ((price - prevClose) / prevClose) * 100
          : null,
      dayHigh: m.regularMarketDayHigh ?? null,
      dayLow: m.regularMarketDayLow ?? null,
      currency: m.currency || '',
      exchange: m.exchangeName || '',
      name: alias?.name || m.shortName || m.longName || null,
      priceHint: m.priceHint ?? null,
      marketTime: m.regularMarketTime ?? null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Crypto exchanges                                                    */
/* ------------------------------------------------------------------ */

function binanceSymbol(p) {
  const quote = p.quote === 'USD' ? 'USDT' : p.quote;
  return `${p.base}${quote}`;
}

async function fetchBinance(symbol, tf) {
  const p = parseCryptoSymbol(symbol);
  if (!p) throw new Error('not a crypto pair');
  const sym = binanceSymbol(p);
  // The 5m SMC book (BTC/ETH) wants a deeper sample for its backtest panel.
  const pages = (p.base === 'BTC' || p.base === 'ETH') && tf === '5m' ? 6 : 1;
  const baseUrl = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${tf}&limit=1000`;
  let arr = await jget(baseUrl);
  for (let n = 1; n < pages && Array.isArray(arr) && arr.length; n++) {
    const prev = await jget(`${baseUrl}&endTime=${arr[0][0] - 1}`);
    if (!Array.isArray(prev) || !prev.length) break;
    arr = prev.concat(arr);
  }
  if (!Array.isArray(arr) || arr.length < 30) throw new Error('binance: bad payload');
  const candles = arr.map((k) => ({
    t: Math.floor(k[0] / 1000),
    o: +k[1],
    h: +k[2],
    l: +k[3],
    c: +k[4],
    v: +k[5],
  }));
  const last = candles[candles.length - 1];
  return {
    candles,
    source: 'binance',
    meta: { price: last.c, prevClose: null, changePct: null, currency: 'USDT', exchange: 'BINANCE', name: null },
  };
}

const BYBIT_IV = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };

async function fetchBybit(symbol, tf) {
  const p = parseCryptoSymbol(symbol);
  if (!p) throw new Error('not a crypto pair');
  const sym = `${p.base}${p.quote === 'USD' ? 'USDT' : p.quote}`;
  const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=${BYBIT_IV[tf]}&limit=1000`;
  const j = await jget(url);
  const list = j?.result?.list;
  if (!Array.isArray(list) || list.length < 30) throw new Error('bybit: bad payload');
  const candles = list
    .map((k) => ({ t: Math.floor(+k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))
    .reverse();
  const last = candles[candles.length - 1];
  return {
    candles,
    source: 'bybit',
    meta: { price: last.c, prevClose: null, changePct: null, currency: 'USDT', exchange: 'BYBIT', name: null },
  };
}

const OKX_BAR = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };

async function fetchOkx(symbol, tf) {
  const p = parseCryptoSymbol(symbol);
  if (!p) throw new Error('not a crypto pair');
  const quote = p.quote === 'USD' ? 'USDT' : p.quote;
  const inst = `${p.base}-${quote}`;
  const url = `https://www.okx.com/api/v5/market/candles?instId=${inst}&bar=${OKX_BAR[tf]}&limit=300`;
  const j = await jget(url);
  const data = j?.data;
  if (!Array.isArray(data) || data.length < 30) throw new Error('okx: bad payload');
  const candles = data
    .map((k) => ({ t: Math.floor(+k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }))
    .reverse();
  const last = candles[candles.length - 1];
  return {
    candles,
    source: 'okx',
    meta: { price: last.c, prevClose: null, changePct: null, currency: 'USDT', exchange: 'OKX', name: null },
  };
}

function crypto24hChange(candles, tf) {
  const last = candles[candles.length - 1];
  const sec = TF_SEC[tf] || 3600;
  const target = last.t - 86400;
  let ref = null;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].t <= target) {
      ref = candles[i];
      break;
    }
  }
  if (!ref) ref = candles[Math.max(0, candles.length - 1 - Math.round(86400 / sec))];
  if (!ref || !ref.c) return null;
  return ((last.c - ref.c) / ref.c) * 100;
}

async function fetchCrypto(symbol, tf) {
  const order = ['binance', 'bybit', 'okx', 'yahoo'];
  const pref = preferredSource.get(symbol);
  if (pref) {
    order.sort((a, b) => (a === pref ? -1 : b === pref ? 1 : 0));
  }
  const p = parseCryptoSymbol(symbol);
  let lastErr;
  for (const src of order) {
    try {
      let data;
      if (src === 'binance') data = await fetchBinance(symbol, tf);
      else if (src === 'bybit') data = await fetchBybit(symbol, tf);
      else if (src === 'okx') data = await fetchOkx(symbol, tf);
      else data = await fetchYahoo(p ? p.yahoo : symbol, tf);
      preferredSource.set(symbol, src);
      if (data.meta.changePct == null) {
        const chg = crypto24hChange(data.candles, tf);
        data.meta.changePct = chg;
        if (data.meta.prevClose == null && chg != null) {
          const last = data.candles[data.candles.length - 1].c;
          data.meta.prevClose = last / (1 + chg / 100);
        }
      }
      return data;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('no crypto source available');
}

/* ------------------------------------------------------------------ */
/* Main entry point                                                    */
/* ------------------------------------------------------------------ */

async function fetchCandles(symbol, tf) {
  if (detectMarket(symbol) === 'crypto' && parseCryptoSymbol(symbol)) {
    return fetchCrypto(symbol, tf);
  }
  return fetchYahoo(symbol, tf);
}

export async function getCandles(symbol, tf, opts = {}) {
  const key = `${symbol}|${tf}`;
  const maxAge = Number.isFinite(opts.maxAge) ? opts.maxAge : ttlFor(tf);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < maxAge) return hit;
  if (inflight.has(key)) return inflight.get(key);

  const job = fetchCandles(symbol, tf)
    .then((data) => {
      const entry = { ...data, symbol, tf, at: Date.now(), stale: false, error: null };
      cache.set(key, entry);
      if (cache.size > 400) {
        let oldestKey = null;
        let oldestAt = Infinity;
        for (const [k, v] of cache) {
          if (v.at < oldestAt) {
            oldestAt = v.at;
            oldestKey = k;
          }
        }
        if (oldestKey && oldestKey !== key) cache.delete(oldestKey);
      }
      return entry;
    })
    .catch((err) => {
      if (hit) {
        const stale = { ...hit, stale: true, error: err.message };
        cache.set(key, stale);
        return stale;
      }
      throw err;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job;
}

/* ------------------------------------------------------------------ */
/* Fast crypto ticker (single request for all pairs)                   */
/* ------------------------------------------------------------------ */

let tickerState = { at: 0, map: new Map(), source: null, error: null };
let tickerInflight = null;

export function peekTickers() {
  return tickerState;
}

export async function refreshTickers(symbols, maxAge = 6000) {
  if (!symbols.length) return tickerState;
  if (Date.now() - tickerState.at < maxAge) return tickerState;
  if (tickerInflight) return tickerInflight;

  const pairs = symbols.map(parseCryptoSymbol).filter(Boolean);
  const binanceSyms = pairs.map((p) => binanceSymbol(p));

  tickerInflight = (async () => {
    const map = new Map();
    let source = null;
    try {
      const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(binanceSyms))}`;
      const arr = await jget(url, 9000);
      if (Array.isArray(arr)) {
        for (const t of arr) {
          map.set(t.symbol, {
            price: +t.lastPrice,
            chgPct: +t.priceChangePercent,
            high: +t.highPrice,
            low: +t.lowPrice,
            quoteVol: +t.quoteVolume,
          });
        }
        if (map.size) source = 'binance';
      }
    } catch {
      /* fall through to Bybit */
    }
    if (!map.size) {
      try {
        const j = await jget('https://api.bybit.com/v5/market/tickers?category=spot', 12000);
        const list = j?.result?.list || [];
        for (const t of list) {
          const chg = t.prevPrice24h ? ((+t.lastPrice - +t.prevPrice24h) / +t.prevPrice24h) * 100 : null;
          map.set(t.symbol, { price: +t.lastPrice, chgPct: chg, high: +t.highPrice24h, low: +t.lowPrice24h, quoteVol: +t.turnover24h });
        }
        if (map.size) source = 'bybit';
      } catch (err) {
        tickerState = { at: Date.now(), map: new Map(), source: null, error: err.message };
        return tickerState;
      }
    }
    tickerState = { at: Date.now(), map, source, error: null };
    return tickerState;
  })().finally(() => {
    tickerInflight = null;
  });

  return tickerInflight;
}

export function tickerFor(symbol) {
  const p = parseCryptoSymbol(symbol);
  if (!p) return null;
  const key = binanceSymbol(p);
  return tickerState.map.get(key) || null;
}
