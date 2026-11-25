// Default watchlists. `s` = provider symbol, `n` = display name.
// Symbol conventions:
//   crypto      -> BTCUSD (Binance/Bybit/OKX) with Yahoo BTC-USD fallback
//   forex       -> EURUSD=X (Yahoo) — only for symbols added manually
//   india       -> ^NSEI / RELIANCE.NS (Yahoo)
//   commodities -> XAUUSD -> GC=F (Yahoo futures)

export const TFS = ['1m', '5m', '15m', '1h', '4h', '1d'];

// Common spot / trading-desk names. Yahoo has no XAU/USD quote, so these
// resolve to the matching futures contract (tracking error is small).
export const ALIASES = {
  XAUUSD: { yahoo: 'GC=F', name: 'Gold Spot (XAU/USD)' },
  'XAUUSD=X': { yahoo: 'GC=F', name: 'Gold Spot (XAU/USD)' },
  XAGUSD: { yahoo: 'SI=F', name: 'Silver Spot (XAG/USD)' },
  'XAGUSD=X': { yahoo: 'SI=F', name: 'Silver Spot (XAG/USD)' },
  XPTUSD: { yahoo: 'PL=F', name: 'Platinum Spot (XPT/USD)' },
  XPDUSD: { yahoo: 'PA=F', name: 'Palladium Spot (XPD/USD)' },
  WTI: { yahoo: 'CL=F', name: 'Crude Oil WTI' },
  USOIL: { yahoo: 'CL=F', name: 'Crude Oil WTI' },
  BRENT: { yahoo: 'BZ=F', name: 'Brent Crude' },
  UKOIL: { yahoo: 'BZ=F', name: 'Brent Crude' },
  NATGAS: { yahoo: 'NG=F', name: 'Natural Gas' },
  COPPER: { yahoo: 'HG=F', name: 'Copper' },
};

export const aliasFor = (symbol) => ALIASES[symbol] || null;
export const yahooSymbol = (symbol) => ALIASES[symbol]?.yahoo || symbol;

export const MARKETS = [
  {
    id: 'india',
    label: 'India',
    hours: 'Mon-Fri 09:15 - 15:30 IST',
    tzOffset: 330,
    symbols: [
      ['^NSEI', 'NIFTY 50'],
      ['^BSESN', 'SENSEX'],
      ['^NSEBANK', 'BANK NIFTY'],
      ['RELIANCE.NS', 'Reliance'],
      ['TCS.NS', 'TCS'],
      ['HDFCBANK.NS', 'HDFC Bank'],
      ['INFY.NS', 'Infosys'],
      ['ICICIBANK.NS', 'ICICI Bank'],
      ['SBIN.NS', 'State Bank of India'],
      ['BHARTIARTL.NS', 'Bharti Airtel'],
      ['ITC.NS', 'ITC'],
      ['LT.NS', 'Larsen & Toubro'],
      ['ADANIENT.NS', 'Adani Enterprises'],
    ],
  },
  {
    id: 'crypto',
    label: 'Crypto',
    hours: '24/7',
    tzOffset: 0,
    symbols: [
      ['BTCUSD', 'Bitcoin (BTCUSD)'],
      ['ETHUSD', 'Ethereum (ETHUSD)'],
      ['XAUTUSD', 'Tether Gold (XAUT/USD)'],
    ],
  },
  {
    id: 'commodities',
    label: 'Gold',
    hours: 'Mon-Fri (near 24h)',
    tzOffset: 0,
    symbols: [['XAUUSD', 'Gold Spot (XAU/USD)']],
  },
];

export function detectMarket(symbol) {
  if (ALIASES[symbol]) return 'commodities';
  if (/^(BTC|ETH|SOL|XRP|BNB|DOGE|ADA|LINK|AVAX|LTC|XAUT|PAXG)USD$/.test(symbol)) return 'crypto';
  if (/^[A-Z0-9]{2,12}(USDT|USDC|BUSD)$/.test(symbol)) return 'crypto';
  if (/^[A-Z0-9]{2,10}-USD$/.test(symbol)) return 'crypto';
  if (symbol.endsWith('=F')) return 'commodities';
  if (symbol.endsWith('=X')) return 'forex';
  if (symbol.startsWith('^') || symbol.endsWith('.NS') || symbol.endsWith('.BO')) return 'india';
  if (/^[A-Z]{6}$/.test(symbol) && /^(USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|INR|CNH|SGD|HKD)/.test(symbol)) {
    return 'forex';
  }
  return 'other';
}

export function marketLabel(id) {
  const m = MARKETS.find((x) => x.id === id);
  return m ? m.label : 'Custom';
}
