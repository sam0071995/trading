# Trading Terminal — live multi-market signals

A local, real-time market study terminal. It pulls live candles and prices from the internet,
runs a multi-indicator strategy on every symbol, and shows **BUY / SELL / NO-TRADE** with
**entry, stop-loss and three targets** (plus risk %, R-multiples, confidence and a backtest of
the same rules on that symbol's history).

Markets covered: **India (NSE indices + stocks)**, **XAUUSD (gold)**, **XAUTUSD (Tether Gold)**,
**BTCUSD**, **ETHUSD**.

> Educational technical analysis. Not financial advice. No order execution — signals only.

---

## Run it

Requirements: Node.js 20+ (no `npm install` needed, zero dependencies).

```bat
cd D:\TRADING
node server.js
```

or double-click `start.bat`.

Open <http://127.0.0.1:4321>.

| Env var            | Default     | Use                                  |
| ------------------ | ----------- | ------------------------------------ |
| `PORT`             | `4321`      | HTTP port                            |
| `HOST`             | `127.0.0.1` | Set `0.0.0.0` to view from phone/LAN |
| `CACHE_TTL_SCALE`  | `1`         | `2` = refresh providers half as often |

---

## Host it online (free)

The repo ships a `render.yaml` blueprint, so [Render](https://render.com) can host it free:

1. Render → **New → Blueprint** → connect this GitHub repo.
2. Apply — it reads `render.yaml` (Node runtime, free plan, **Singapore** region, `HOST=0.0.0.0`).
3. Open the `https://<service>.onrender.com` URL it gives you.

Why Singapore: Binance/Bybit/OKX block US IPs, so a US region would lose the crypto feeds.

Free-tier behaviour to expect:

- The instance **sleeps after ~15 minutes without visitors**; first open takes ~30–60 s and the SSE
  stream reconnects by itself.
- The disk is **ephemeral**: `data/signals.json`, `trades.json` and `watchlist.json` are recreated on
  every restart/redeploy, so the report's history starts fresh (the old local history is not pushed).
  Custom symbols added with **+** are lost the same way.
- Shared cloud IPs are rate-limited by Yahoo more often than a home connection; the last good data is
  kept and marked `STALE`, and the crypto feeds fall back through Binance → Bybit → OKX.

GitHub Pages cannot host this app — it needs a long-running Node process, not static files.

---

## What you see

- **Ticker strip** — NIFTY, SENSEX, BANK NIFTY, XAUUSD, XAUTUSD, BTCUSD, ETHUSD with live change.
- **Market pulse** — buy/sell counts, breadth, top movers, IST session status for India
  (09:15–11:30, 13:30–15:00), gold (12:30–15:00, 18:00–21:00) and crypto (24/7, weekend block).
- **Watchlist scanner** — every symbol, trade state (BUY/SELL open, EXIT with result, or flat),
  sorted or filtered by market.
- **Signal panel** — the active strategy and session, direction + grade, the **locked** entry,
  stop-loss and T1/T2/T3 with R multiples (TP1 says how much to book), live R vs the plan, risk %,
  ATR, the reasons behind the trigger, the **market checks** (trend, key level, momentum,
  volume, news) and the **strategy scan** (every setup's state and score) with passed/evaluated counts.
- **Chart** — candles, EMA 9/21/50, SuperTrend, optional VWAP, volume, your entry/SL/targets,
  the opening range (ORH/ORL) and daily pivot PP drawn on the price.
  Mouse wheel zooms, hover shows OHLCV. Click legend items to toggle overlays.
- **Indicators** — RSI, Stochastic RSI, ADX/DI, MACD histogram, SuperTrend state, EMA trend, VWAP,
  volume ratio, daily PP, opening range, support/resistance, checks passed, confidence.
- **Signal feed** — trade entries (`ENTRY`) and exits (`EXIT` with the reason and R result) for the
  selected timeframe, persisted to `data/signals.json`. Optional sound + toast alerts (🔔 button).
- **Backtest** — the same engine replayed over the symbol's history: trades, win rate, total/avg R,
  profit factor, max drawdown, exit breakdown, equity curve, vs buy & hold.
- **Reports** (top-right link, `/reports.html`) — a separate performance page built from the signal
  log, with a **date picker** (and Today / 7D / 30D / All presets). It shows overall and per-market
  (India, XAUUSD, XAUTUSD, BTCUSD, ETHUSD) results: signals, closed trades, **target-hit vs stop-loss counts**,
  win rate, total/avg R, profit factor, max drawdown, best/worst trade, plus a **day-by-day table**
  (signals, target, SL, other, win %, day R, cumulative R) with an equity line, a **profit & loss
  table** by market and by symbol (closed trades, target hits, SL hits, other exits, profit R,
  loss R, net R), and a dedicated **Loss
  report** tab listing every losing exit with entry, stop, exit price and R. Dates are IST.

Timeframes: `1m 5m 15m 1h 4h 1d`.

Add any symbol with the **+** button: `NIFTY.NS`, `BTCUSD`, `ETHUSD`, `XAUTUSD`, `XAUUSD`, `AAPL`…
Crypto pairs (`BTCUSD`, `XAUTUSD`, `BTC-USD`) and Yahoo tickers both work.

---

## One signal, one trade

The terminal does not re-score a position on every tick. When a setup confirms on a closed bar, the
plan is opened once and **frozen**: entry, stop-loss and T1/T2/T3 are anchored to the trigger bar's
close. The row in the watchlist and the panel then show the same `BUY`/`SELL` with a live R value —
it does not flip because the last tick moved.

A trade stays open until one of these happens, and only then is an `EXIT` event emitted:

| Exit | Emitted as |
| --- | --- |
| Price hits the stop (or break-even after T1) | `EXIT — STOP LOSS` / `BREAKEVEN` |
| Price hits the trailed stop after T2 (BTC/ETH 5m book) | `EXIT — TRAIL STOP` |
| Price reaches the runner target (T2, T3 on BTC/ETH 5m) | `EXIT — TARGET HIT` |
| A confirmed signal fires in the opposite direction | `EXIT — REVERSAL` |
| The market's session closes | `EXIT — SESSION CLOSE` |

After T1 is touched the stop moves to the entry (break-even) and 50% is treated as booked. On the
BTC/ETH 5m book, once T2 is touched the stop trails to T1 and the rest runs to T3.

Closing a trade is not the end of the symbol — the terminal immediately keeps scanning. As soon as a
**fresh** setup confirms on a later bar, the next plan is opened, even in the same direction:

- Exit bar itself — no re-entry, so a stop-out or target fill never reopens on the same snapshot.
- Same direction — allowed once the new trigger bar is later than the exit bar **and** at least 2 bars
  have passed (1 bar on 4h/1d). A stop-out therefore re-signals only on a genuinely new setup, not the
  stale one it just traded.
- Opposite direction — a confirmed reversal closes the trade (`EXIT — REVERSAL`) and opens the new
  side in the same update.

The watchlist row and panel switch from `EXIT` back to a live `BUY`/`SELL` with a new frozen plan,
and the signal feed shows the `EXIT` immediately followed by the next `ENTRY`.

---

## Data sources (no API keys)

| Market      | Primary                | Fallback chain                            |
| ----------- | ---------------------- | ----------------------------------------- |
| BTCUSD / ETHUSD / XAUTUSD | Binance REST | Bybit → OKX → Yahoo (`BTC-USD`, `ETH-USD`, `XAUT-USD`) |
| India       | Yahoo Finance (NSE)    | `^NSEI`, `^BSESN`, `^NSEBANK`, `*.NS`     |
| XAUUSD      | Yahoo Finance futures  | `GC=F` (gold contract)                    |

Yahoo has no spot XAU/USD quote, so trading-desk names are aliased to the matching futures
contract: `XAUUSD`→`GC=F`. The chart keeps the name you searched for.

Crypto also gets a fast 24h ticker batch (price + % change every ~6s) from Binance, falling back to Bybit.

Caching is deliberate so free endpoints are not hammered: 18s (1m), 40s (5m), 80s (15m),
3m (1h), 5m (4h), 10m (1d). The scanner refreshes a rotating slice of symbols every 4s and streams
updates over Server-Sent Events, so the page stays live without polling from the browser.

If a provider fails, the last good data is kept and marked `STALE`; the symbol recovers automatically.

### Notes on data

- Yahoo intraday history is limited (1m ≈ 5 days, 5m/15m ≈ 1 month, 1h ≈ 6 months); 4h candles are
  aggregated from 1h. Backtest sample sizes therefore vary by timeframe.
- Index feeds return no volume → volume rules are simply disabled for them.
- Free feeds can lag by seconds and are not exchange-grade tick data.

---

## The strategy

Every market follows its own playbook. **BTCUSD and ETHUSD on 5m run the Smart Money engine**
below; other crypto, gold and custom stocks run the **adaptive engine**: on every closed bar it
scores a family of independent setups, then shows the strongest one that clears 64/96. Every
market uses the setups that survive its own backtest, rather than one rigid pattern. Signals are
causal: the evaluator only reads bars up to the one it is scoring, so the live panel and the
backtest use identical logic.

| Market | Setups scored | Trigger | Stop | Targets |
| --- | --- | --- | --- | --- |
| **India** (NIFTY/SENSEX/Bank NIFTY + NSE stocks) | Opening Range Breakout + EMA filter | 5m close outside the 09:15–09:20 range, on the right side of VWAP, SuperTrend aligned, EMA 9/21 cross or slope, volume ≥ 1.8× (or range expansion when the feed has no volume) | Below VWAP / OR candle low (−0.15 ATR), clamped | 1.5× / 2× / 2.5× OR size |
| India secondary | 09:20 momentum candle | 1m/5m opening candle with > 60% body, traded with the close direction | Opposite end of the candle | 2R / 3R / 4R |
| **BTCUSD / ETHUSD (5m)** | SMC: liquidity sweep → MSS → displacement → FVG → retrace confirmation | 1H + 15m EMA 50/200 trend aligned, sweep of a confirmed swing, MSS close, displacement ≥ 1.2× ATR on volume, FVG retested | Behind the sweep ∓ 0.2 ATR (rejected above 4 ATR) | 1R / 2R / 3R, break-even after 1R, stop trails to 1R after 2R |
| **XAUTUSD** | Trend pullback, range breakout, squeeze, RSI divergence, US-open momentum | Close outside the 20-bar range, band break after a ≤ 32% squeeze, divergence with a stoch turn, or the 18:30 IST candle ≥ 0.3% | Swing ∓ 0.2–0.35 ATR, clamped | Next level, then 2R–4R |
| **Gold (XAUUSD)** | Range breakout + trend pullback + Asian-range break | 20-bar close-through, EMA 20 pullback, or a 23:30–07:30 IST range break at the NY metals session | Level ∓ 0.3 ATR / range mid, clamped | Next pivot, then 2R–3R |
| **4h / 1d** (all markets) | Swing continuation | EMA 9 > 21 > 50 + SuperTrend, 20-bar structure break | Structure ∓ 0.25 ATR, clamped 0.8–3 ATR | 1.5R / 2.5R / 4R |

### BTCUSD / ETHUSD — Smart Money engine (5m)

The 5m entry chart uses 15m and 1H data as confirmation (both fetched and cached alongside it):

- **1H trend** and **15m** close above/below EMA 200 with EMA 50 on the same side → long/short bias.
  Both frames must agree, and volume must be ≥ 1.2× its 20-bar average.
- **Liquidity sweep** of a confirmed swing low/high that closes back on the right side.
- **Market structure shift**: close through the prior swing high/low within 6 bars of the sweep.
- **Displacement** candle ≥ 1.2× ATR (volume confirms the entry bar).
- **Fair value gap** formed by the displacement, price retraces into it, then a 5m confirmation
  close back out of the gap → signal at that close (up to 3 bars old).
- Filters: ATR ≥ 0.6× its 50-bar average (blocks dead tape), stop distance ≤ 4 ATR.
- **VWAP side** is scored, not a hard gate: an FVG retrace entry usually fills before price has
  reclaimed VWAP again, so a wrong-side entry is taken with reduced confidence instead of blocked.
- Backtest replays the same 5m bars against time-aligned, fully-closed 15m/1H bars, so no
  future information leaks into the signal.

Daily guards on the BTC/ETH 5m book: maximum 5 entries per IST day and a pause after 3 consecutive
losing exits (resumes next day). Exits: half is booked at T1 (1R) and the stop moves to break-even;
once T2 (2R) is touched the stop trails up to T1, and the remainder rides to T3 (3R), an opposite
confirmed signal or the session close. No averaging down, no martingale. The site is signal-only: the
0.5% risk per trade / 2% daily loss caps from the spec apply to your own position sizing, since no
broker balance is connected.

Every setup is weighted by the trend state (EMA 20/50 stack, ADX, SuperTrend) and the ATR
regime — rotation (recent ATR < 0.85× its 50-bar average), trend, or impulse. Mean-reversion
setups get a bonus in rotation; breakouts are penalised there. The panel's **Strategy scan** list
shows each setup's live state (`FIRED` / `READY` / `NEAR` / `WAITING` / `OFF`) and its score, so
you can see what the engine is watching even when there is no trade.

Gold trades nearly around the clock Mon–Fri, so the London/NY windows are *preferred*
(higher-liquidity) hours rather than a hard gate; outside them signals are still produced with
confidence capped at 78. Crypto runs 24/7 with the same cap outside its preferred windows.
India signals only fire inside the two ORB windows (09:15–11:30, 13:30–15:00 IST), but an open
position is held through the lunch break and flattened at the 15:00 IST close.

### Market checks (shown in the panel)

Before any signal is shown, checks are scored: **trend aligned**, **price at a key level**
(pivot, VWAP, OR, zone), **momentum confirms**, **volume spike**, **news clear** (news is not
connected, so it is shown as `–`). Checks that cannot be evaluated (e.g. no volume on an index
feed) are also shown as `–` and excluded from the denominator. No R:R row — the plan's R:R is
displayed in the plan itself and never blocks a setup that met the strategy. 4+ passing checks
means a strong setup; below that the confidence is capped at 74 and a warning is attached.

Not connected yet: economic-calendar/news, PCR, FII/DII flows, BTC dominance, funding rate,
spread and DXY/yield filters. They are listed as explicit warnings instead of being faked.

### Backtest rules

Entry at the next bar's open after a **confirmed** signal. 50% is booked at target 1 and the stop
moves to break-even; the runner exits at target 2, an opposite confirmed signal, or a 40-bar time
stop. On the BTC/ETH 5m book the runner instead goes to target 3, and once target 2 is touched the
stop trails to target 1. If a bar spans the stop and T1, the stop is assumed first (conservative).
Fees/slippage are not modelled — treat results as a sanity check on the rules, not a promise.

---

## Project layout

```
D:\TRADING
├─ server.js            HTTP server, SSE stream, scan/analyze/backtest/report APIs, signal log
├─ start.bat            Windows launcher
├─ src/
│  ├─ markets.js        watchlists (India 13, BTCUSD, ETHUSD, XAUTUSD, XAUUSD), symbol → market detection
│  ├─ providers.js      data fetching, fallbacks, caching, tickers
│  ├─ indicators.js     EMA, RSI, MACD, ATR, ADX, SuperTrend, Bollinger, VWAP, Stoch RSI, pivots, opening range
│  ├─ sessions.js       IST session windows and per-market gating
│  ├─ strategies.js     the playbook engine (one evaluator per market) + confluence checklist
│  ├─ strategy.js       indicator context + live analyze() adapter
│  ├─ tradebook.js      one frozen trade per symbol/timeframe, exits on SL/T1/T2/reversal/session
│  └─ backtest.js       bar-by-bar replay of the same evaluator
├─ public/              index.html, reports.html, styles.css, app.js, reports.js, favicon
└─ data/                signals.json, trades.json, watchlist.json (created at runtime)
```

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config` | markets, timeframes, symbol list |
| `GET /api/scan?tf=15m` | summary rows for every symbol + pulse |
| `GET /api/analyze?symbol=^NSEI&tf=15m` | full analysis + candles + overlays + backtest |
| `GET /api/backtest?symbol=BTCUSD&tf=1h` | strategy stats on history |
| `GET /api/report?from=2026-11-18&to=2026-11-24` | performance report: overall, per market, daily, losses (IST dates) |
| `GET /api/stream?tf=15m` | SSE: `snapshot` every ~4s, `signal` on new signals |
| `GET /api/watch/add?symbol=AAPL` | add a symbol to the watchlist |
| `GET /api/watch/remove?symbol=AAPL` | remove it again |

The report is built from the signal log (`data/signals.json`, last 12,000 entry/exit events), so it
needs no separate database. Entry/exit events carry the exit reason (`TARGET HIT`, `STOP LOSS`,
`BREAKEVEN`, `TRAIL STOP`, `REVERSAL`, `SESSION CLOSE`) and the R result; wins/losses are counted by
R sign, and target/SL counts by exit reason. Gold and crypto history recorded under the old provider
symbols (`GC=F`, `BTCUSDT`, `ETHUSDT`) is folded into the XAUUSD/BTCUSD/ETHUSD report.

---

## Disclaimer

This is a technical study tool. Signals can be wrong, data can be delayed or missing, and
crypto/gold/equity trading carries substantial risk. Nothing here is investment advice.
