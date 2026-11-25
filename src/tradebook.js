// One fixed trade per symbol/timeframe.
//
// A plan is opened once on a confirmed closed bar and frozen. It stays open
// until the stop/target is reached, the session closes, or a confirmed
// opposite signal fires. Every close is emitted as an EXIT event.

import { istParts, tradeHoursOpen } from './sessions.js';

const books = new Map();
const lastPrice = new Map();

export const rAt = (b, px) => {
  const dist = Math.abs(b.entry - b.sl);
  if (!(dist > 0)) return 0;
  return (b.dir === 'BUY' ? px - b.entry : b.entry - px) / dist;
};

export function bookView(b, price) {
  if (!b || b.status === 'FLAT') return { status: 'FLAT' };
  const pnl = b.status === 'OPEN' ? rAt(b, price) : b.exit?.r ?? 0;
  return {
    status: b.status,
    id: b.id,
    dir: b.dir,
    entry: b.entry,
    sl: b.sl,
    stop: b.status === 'OPEN' ? (b.tp2Hit ? b.tp1 : b.be ? b.entry : b.sl) : b.sl,
    be: !!b.be,
    tp2Hit: !!b.tp2Hit,
    targets: b.targets,
    tp1Hit: !!b.tp1Hit,
    riskPct: b.riskPct,
    rr: b.rr,
    confidence: b.confidence,
    grade: b.grade,
    openedAt: b.openedAt || null,
    ageMs: b.openedAt ? Math.max(0, Date.now() - b.openedAt) : 0,
    triggerTime: b.triggerTime || null,
    pnlR: Number(pnl.toFixed(2)),
    strategy: b.strategy || null,
    setup: b.setup || '',
    exit: b.exit || null,
  };
}

let seq = 0;

const TF_SEC = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
const gapBars = (tf) => ((TF_SEC[tf] || 300) >= 14400 ? 1 : 2);

export function updateBook(info, tf, a, price, emit) {
  const key = `${info.symbol}|${tf}`;
  let b = books.get(key) || { status: 'FLAT' };
  const now = Date.now();
  const sessionActive = a.strategy?.session?.active !== false;
  const hoursOpen = tradeHoursOpen(info.market);
  const smcBook = a.strategy?.id === 'crypto-smc';
  const dayKey = istParts(Number.isFinite(a.time) ? a.time : Math.floor(now / 1000)).date;
  if (b.day !== dayKey) {
    b.day = dayKey;
    b.dayTrades = 0;
    b.lossStreak = 0;
  }
  lastPrice.set(key, price);

  if (b.status === 'OPEN') {
    const long = b.dir === 'BUY';
    if (!b.tp1Hit && (long ? price >= b.tp1 : price <= b.tp1)) {
      b.tp1Hit = true;
      b.be = true;
    }
    const tp2 = b.runToT3 ? b.targets?.[1] : null;
    if (b.tp1Hit && !b.tp2Hit && tp2 != null && (long ? price >= tp2 : price <= tp2)) b.tp2Hit = true;
    const stop = b.tp2Hit ? b.tp1 : b.be ? b.entry : b.sl;
    const hitStop = long ? price <= stop : price >= stop;
    const runner = b.runToT3 && b.targets?.[2] != null ? b.targets[2] : b.tp2;
    const hitRunner = long ? price >= runner : price <= runner;

    const closeTrade = (reason, px) => {
      const r1 = Math.abs(b.tp1 - b.entry) / Math.abs(b.entry - b.sl);
      const raw = b.tp1Hit ? 0.5 * r1 + 0.5 * rAt(b, px) : rAt(b, px);
      b.status = 'CLOSED';
      b.exit = { price: Number(px.toPrecision(10)), reason, at: now, r: Number(raw.toFixed(2)) };
      b.closedAt = now;
      b.closedBarT = Number.isFinite(a.time) ? a.time : null;
      b.lastDir = b.dir;
      b.pnlR = b.exit.r;
      if (smcBook) {
        if (b.exit.r < 0) b.lossStreak = (b.lossStreak || 0) + 1;
        else if (b.exit.r > 0) b.lossStreak = 0;
      }
      emit(tf, 'EXIT', b, info, b.exit.price, { exitReason: reason, pnlR: b.exit.r });
    };

    if (hitStop) closeTrade(b.tp2Hit ? 'TRAIL STOP' : b.tp1Hit ? 'BREAKEVEN' : 'STOP LOSS', stop);
    else if (hitRunner) {
      if (!b.tp1Hit) {
        b.tp1Hit = true;
        b.be = true;
      }
      closeTrade('TARGET HIT', runner);
    } else if (!hoursOpen) closeTrade('SESSION CLOSE', price);
    else if (a.direction !== 'NEUTRAL' && a.direction !== b.dir && a.state === 'CONFIRMED') closeTrade('REVERSAL', price);
  }

  if (b.status !== 'OPEN') {
    const entry = a.entry ?? a.plan?.entry;
    const sl = a.stopLoss ?? a.plan?.sl;
    const targets = a.targets?.length ? a.targets : a.plan?.targets || [];
    const sameDir = b.lastDir != null && a.direction === b.lastDir;
    const barSec = TF_SEC[tf] || 300;
    const barsSince = b.closedBarT != null && Number.isFinite(a.time) ? Math.round((a.time - b.closedBarT) / barSec) : null;
    const fresh = b.closedBarT == null || !Number.isFinite(a.triggerTime) || a.triggerTime > b.closedBarT;
    const requalified = !sameDir || (fresh && (barsSince == null || barsSince >= gapBars(tf)));
    const riskBlocked = smcBook && ((b.lossStreak || 0) >= 3 || (b.dayTrades || 0) >= 5);
    const canOpen =
      sessionActive &&
      !riskBlocked &&
      a.direction !== 'NEUTRAL' &&
      a.state === 'CONFIRMED' &&
      requalified &&
      entry != null &&
      sl != null &&
      targets.length >= 2;
    if (canOpen) {
      const long = a.direction === 'BUY';
      const beyond = long ? price <= sl || price >= targets[0] : price >= sl || price <= targets[0];
      if (!beyond) {
        b = {
          id: `${key}|${++seq}`,
          symbol: info.symbol,
          tf,
          status: 'OPEN',
          dir: a.direction,
          entry,
          sl,
          be: false,
          targets,
          tp1: targets[0],
          tp2: targets[1],
          runToT3: smcBook,
          day: dayKey,
          dayTrades: (b.dayTrades || 0) + 1,
          lossStreak: b.lossStreak || 0,
          riskPct: a.riskPct ?? a.plan?.riskPct ?? null,
          rr: a.rr ?? a.plan?.rr ?? null,
          confidence: a.confidence,
          grade: a.grade,
          strategy: { id: a.strategy?.id, name: a.strategy?.name },
          setup: a.strategy?.setup || '',
          checklist: a.strategy?.checklist || [],
          passed: a.strategy?.passed,
          evaluated: a.strategy?.evaluated,
          reasons: a.reasons || [],
          openedAt: now,
          triggerTime: a.triggerTime,
          tp1Hit: false,
          tp2Hit: false,
          pnlR: 0,
        };
        emit(tf, 'ENTRY', b, info, price);
      }
    }
  }

  books.set(key, b);
  return b;
}

export function getBook(symbol, tf) {
  return books.get(`${symbol}|${tf}`) || { status: 'FLAT' };
}

export function snapshotBooks() {
  return [...books.entries()].filter(([, b]) => b.status === 'OPEN' || b.status === 'CLOSED').map(([key, b]) => ({ key, b }));
}

export function restoreBooks(list) {
  if (!Array.isArray(list)) return 0;
  const now = Date.now();
  let n = 0;
  for (const row of list) {
    if (!row || typeof row.key !== 'string' || !row.b || !row.b.status) continue;
    const b = row.b;
    if (b.status === 'CLOSED' && b.closedAt && now - b.closedAt > 3 * 86400000) continue;
    delete b.blockDir;
    books.set(row.key, b);
    n++;
  }
  return n;
}
