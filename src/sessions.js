// IST session windows for the strategy playbook.
//
// India : 09:15-11:30, 13:30-15:00
// Forex : London 13:30-16:00, New York 18:30-21:00
// Crypto: 13:00-17:00, 18:30-23:00 (preferred hours; 24/7 otherwise)
// Gold  : London metals 12:30-15:00, NY metals 18:00-21:00

const IST_OFFSET_MIN = 330;

const pad = (n) => String(n).padStart(2, '0');
const hm = (mins) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

export const WINDOWS = {
  india: [
    { from: 555, to: 690, name: 'India morning ORB', window: '09:15–11:30 IST' },
    { from: 810, to: 900, name: 'India afternoon ORB', window: '13:30–15:00 IST' },
  ],
  forex: [
    { from: 810, to: 960, name: 'London open', window: '13:30–16:00 IST' },
    { from: 1110, to: 1260, name: 'New York open', window: '18:30–21:00 IST' },
  ],
  crypto: [
    { from: 780, to: 1020, name: 'Asia/Europe hours', window: '13:00–17:00 IST' },
    { from: 1110, to: 1380, name: 'US market hours', window: '18:30–23:00 IST' },
  ],
  commodities: [
    { from: 750, to: 900, name: 'London metals', window: '12:30–15:00 IST' },
    { from: 1080, to: 1260, name: 'NY metals', window: '18:00–21:00 IST' },
  ],
};

export function istParts(tsSec) {
  const d = new Date((tsSec + IST_OFFSET_MIN * 60) * 1000);
  const day = d.getUTCDay();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return { day, mins, hm: hm(mins), date: d.toISOString().slice(0, 10) };
}

// Whether an open position may keep running. India has two signal windows but
// the venue trades through lunch, so positions are flattened only at 15:00 IST.
export function tradeHoursOpen(market, tsSec = Math.floor(Date.now() / 1000)) {
  const p = istParts(tsSec);
  if (market === 'india') return p.day >= 1 && p.day <= 5 && p.mins >= 555 && p.mins < 900;
  return true;
}

export function sessionInfo(market, tsSec, tf) {
  const p = istParts(tsSec);
  const base = { ist: p.hm, day: p.day };

  if (tf === '4h' || tf === '1d') {
    return { ...base, active: true, preferred: true, mode: 'swing', label: 'Swing mode', window: 'session filter off for 4h/1d', next: null };
  }
  const list = WINDOWS[market];
  if (!list) {
    return { ...base, active: true, preferred: true, mode: '24h', label: '24/7', window: 'no session filter', next: null };
  }

  const weekend = p.day === 0 || p.day === 6;
  if (market === 'crypto' && p.day === 6 && p.mins >= 120 && p.mins < 600) {
    return { ...base, active: false, preferred: false, mode: 'intraday', label: 'Weekend low-volume block', window: 'Sat 02:00–10:00 IST', next: 'Resumes 10:00 IST' };
  }
  if (market !== 'crypto' && weekend) {
    return { ...base, active: false, preferred: false, mode: 'intraday', label: 'Weekend — market closed', window: 'Mon–Fri only', next: 'Next open Monday' };
  }

  const current = list.find((w) => p.mins >= w.from && p.mins < w.to);
  if (current) {
    return { ...base, active: true, preferred: true, mode: 'intraday', label: current.name, window: current.window, next: null };
  }

  const upcoming = list.find((w) => w.from > p.mins);
  const next = upcoming
    ? `Next: ${upcoming.name} ${hm(upcoming.from)} IST`
    : `Next: ${list[0].name} ${hm(list[0].from)} IST (tomorrow)`;

  if (market === 'crypto') {
    return { ...base, active: true, preferred: false, mode: 'intraday', label: 'Outside preferred crypto hours', window: '13:00–17:00 / 18:30–23:00 IST', next };
  }
  // FX and futures trade nearly round the clock Mon–Fri; the listed windows are
  // the preferred (highest-liquidity) ones, not a hard gate.
  if (market === 'forex' || market === 'commodities') {
    return {
      ...base,
      active: true,
      preferred: false,
      mode: 'intraday',
      label: 'Extended ' + (market === 'forex' ? 'FX' : 'metals') + ' hours',
      window: list.map((w) => w.window).join(' / ') + ' preferred',
      next,
    };
  }
  return {
    ...base,
    active: false,
    preferred: false,
    mode: 'intraday',
    label: 'Outside ' + (market === 'commodities' ? 'metals' : market) + ' hours',
    window: list.map((w) => w.window).join(' / '),
    next,
  };
}
