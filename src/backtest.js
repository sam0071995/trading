// Backtester: replays the live strategy engine bar-by-bar over history.
//
// A CONFIRMED signal (evaluator sees the trigger on an earlier bar) enters at
// the next bar's open. Half the position is booked at target 1 and the stop
// moves to break-even; the rest runs to target 2, an opposite confirmed
// signal, or a 40-bar time stop.

import { computeContext } from './strategy.js';
import { evaluate, isSmcSymbol } from './strategies.js';

export function backtest(candles, opts = {}) {
  const tf = opts.tf || '15m';
  const n = candles.length;
  if (!candles || n < 100) return { ok: false, reason: `Not enough history (${n} bars, need 100+)` };

  // The SMC book runs to target 3 after booking half at target 1, matching the live book.
  const runT3 = tf === '5m' && isSmcSymbol(opts.symbol);

  const ctx = computeContext(candles, opts);
  const start = 70;
  const MAX_HOLD = 40;

  const evals = new Array(n).fill(null);
  for (let i = start; i < n; i++) {
    evals[i] = evaluate(candles, ctx, i, { ...opts, tf, nowSec: candles[i].t });
  }

  const trades = [];
  let pos = null;
  let pending = null;

  const rAt = (px) =>
    pos.dir === 'BUY' ? (px - pos.entry) / pos.dist : (pos.entry - px) / pos.dist;

  const closePos = (bar, price, reason, extra = 0, weight = 1) => {
    const finalR = extra + weight * rAt(price);
    trades.push({
      dir: pos.dir,
      entry: Number(pos.entry.toPrecision(8)),
      exit: Number(price.toPrecision(8)),
      r: Number(finalR.toFixed(3)),
      reason,
      bars: pos.bars,
      entryTime: pos.entryTime,
      exitTime: bar.t,
    });
    pos = null;
  };

  for (let i = start; i < n - 1; i++) {
    const bar = candles[i];

    if (pending) {
      const ev = evals[i];
      const dirOk = !ev || ev.direction === pending.dir || ev.direction === 'NEUTRAL';
      const long = pending.dir === 'BUY';
      const entry = bar.o;
      const dist = long ? entry - pending.sl : pending.sl - entry;
      const t1Ok = long ? entry < pending.targets[0] : entry > pending.targets[0];
      if (dirOk && dist > 0 && t1Ok) {
        pos = {
          dir: pending.dir,
          entry,
          sl: pending.sl,
          tp1: pending.targets[0],
          tp2: pending.targets[1],
          run: (runT3 ? pending.targets[2] : null) ?? pending.targets[1],
          dist,
          bars: 0,
          entryTime: bar.t,
          tp1Done: false,
          tp2Done: false,
          bookedR: 0,
        };
      }
      pending = null;
    }

    if (pos) {
      const long = pos.dir === 'BUY';
      const hitSL = long ? bar.l <= pos.sl : bar.h >= pos.sl;
      const hitT1 = long ? bar.h >= pos.tp1 : bar.l <= pos.tp1;
      const hitRun = long ? bar.h >= pos.run : bar.l <= pos.run;
      const r1 = Math.abs(pos.tp1 - pos.entry) / pos.dist;

      if (!pos.tp1Done) {
        if (hitSL && hitT1) {
          // Conservative: when one bar spans both levels assume the stop filled first
          closePos(bar, pos.sl, 'SL');
        } else if (hitSL) {
          closePos(bar, pos.sl, 'SL');
        } else if (hitT1) {
          pos.tp1Done = true;
          pos.bookedR = 0.5 * r1;
          pos.sl = pos.entry;
          pos.bars += 1;
        } else {
          pos.bars += 1;
          const ev = evals[i];
          const flip = ev && ev.state === 'CONFIRMED' && ev.direction !== 'NEUTRAL' && ev.direction !== pos.dir;
          if (flip) closePos(bar, bar.c, 'FLIP');
          else if (pos.bars >= MAX_HOLD) closePos(bar, bar.c, 'TIME');
        }
      }

      if (pos && pos.tp1Done) {
        if (runT3) {
          // SMC runner: stop trails to target 1 once target 2 is touched, then rides to target 3
          const stop = pos.tp2Done ? pos.tp1 : pos.entry;
          const hitTrail = long ? bar.l <= stop : bar.h >= stop;
          const hitTP2 = long ? bar.h >= pos.tp2 : bar.l <= pos.tp2;
          if (hitTrail) {
            closePos(bar, stop, pos.tp2Done ? 'TP1 + TP2 TRAIL' : 'TP1 + BE', pos.bookedR, 0.5);
          } else if (!pos.tp2Done && hitTP2) {
            pos.tp2Done = true;
            pos.sl = pos.tp1;
            pos.bars += 1;
          } else if (pos.tp2Done && hitRun) {
            closePos(bar, pos.run, 'TP1 + TP3', pos.bookedR, 0.5);
          } else {
            const ev = evals[i];
            const flip = ev && ev.state === 'CONFIRMED' && ev.direction !== 'NEUTRAL' && ev.direction !== pos.dir;
            if (flip) closePos(bar, bar.c, 'TP1 + FLIP', pos.bookedR, 0.5);
            else if (pos.bars >= MAX_HOLD) closePos(bar, bar.c, 'TP1 + TIME', pos.bookedR, 0.5);
          }
        } else {
          const hitBE = long ? bar.l <= pos.entry : bar.h >= pos.entry;
          if (hitBE) {
            closePos(bar, pos.sl, 'TP1 + BE', pos.bookedR, 0.5);
          } else if (hitRun) {
            closePos(bar, pos.run, 'TP1 + TP2', pos.bookedR, 0.5);
          } else {
            const ev = evals[i];
            const flip = ev && ev.state === 'CONFIRMED' && ev.direction !== 'NEUTRAL' && ev.direction !== pos.dir;
            if (flip) closePos(bar, bar.c, 'TP1 + FLIP', pos.bookedR, 0.5);
            else if (pos.bars >= MAX_HOLD) closePos(bar, bar.c, 'TP1 + TIME', pos.bookedR, 0.5);
          }
        }
      }
    }

    if (!pos && !pending) {
      const ev = evals[i];
      if (ev && ev.state === 'CONFIRMED' && ev.direction !== 'NEUTRAL' && ev.plan) {
        pending = { dir: ev.direction, sl: ev.plan.sl, targets: ev.plan.targets };
      }
    }
  }

  if (pos) {
    const last = candles[n - 1];
    if (pos.tp1Done) closePos(last, last.c, 'TP1 + OPEN', pos.bookedR, 0.5);
    else closePos(last, last.c, 'OPEN');
  }

  if (!trades.length) return { ok: true, trades: 0, note: 'No confirmed signals in this window' };

  const wins = trades.filter((t) => t.r > 0);
  const losses = trades.filter((t) => t.r <= 0);
  const grossWin = wins.reduce((s, t) => s + t.r, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.r, 0));
  const totalR = trades.reduce((s, t) => s + t.r, 0);

  let cum = 0;
  let peak = 0;
  let maxDD = 0;
  const curve = [];
  trades.forEach((t, idx) => {
    cum += t.r;
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
    curve.push({ i: idx + 1, r: Number(cum.toFixed(2)) });
  });

  const byReason = {};
  for (const t of trades) byReason[t.reason] = (byReason[t.reason] || 0) + 1;

  const from = candles[start];
  const to = candles[n - 1];
  const buyHoldPct = from && from.c ? ((to.c - from.c) / from.c) * 100 : 0;

  return {
    ok: true,
    tf,
    bars: n - start,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: Number(((wins.length / trades.length) * 100).toFixed(1)),
    totalR: Number(totalR.toFixed(2)),
    avgR: Number((totalR / trades.length).toFixed(2)),
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : grossWin > 0 ? 99 : 0,
    maxDrawdownR: Number(maxDD.toFixed(2)),
    avgBars: Number((trades.reduce((s, t) => s + t.bars, 0) / trades.length).toFixed(1)),
    buyHoldPct: Number(buyHoldPct.toFixed(2)),
    byReason,
    curve,
    sample: trades.length >= 25 ? 'good' : trades.length >= 10 ? 'low' : 'very low',
  };
}
