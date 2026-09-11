/**
 * The symbol mapping table (INV-120).
 *
 * The core knows one name per instrument — `EURUSD`, `XAUUSD`, `BTCUSD`. Every
 * provider calls the same thing something else, and this table is the only
 * place those dialects exist. An adapter translates on the way in and never
 * lets a provider's name past this file.
 *
 * Entries are `canonical → provider symbol`. An instrument a provider does not
 * carry is simply absent, and the gateway does not subscribe it there.
 */

/** @type {Record<string, Record<string, string>>} */
export const MAPPING = {
  binance: {
    BTCUSD: "BTCUSDT",
  },
  twelvedata: {
    EURUSD: "EUR/USD",
    GBPUSD: "GBP/USD",
    AUDUSD: "AUD/USD",
    XAUUSD: "XAU/USD",
    BTCUSD: "BTC/USD",
  },
  finnhub: {
    EURUSD: "OANDA:EUR_USD",
    GBPUSD: "OANDA:GBP_USD",
    AUDUSD: "OANDA:AUD_USD",
    XAUUSD: "OANDA:XAU_USD",
    BTCUSD: "BINANCE:BTCUSDT",
  },
  mt5: {
    EURUSD: "EURUSD",
    GBPUSD: "GBPUSD",
    AUDUSD: "AUDUSD",
    XAUUSD: "XAUUSD",
    BTCUSD: "BTCUSD",
  },
  "sim-lp": {
    EURUSD: "EURUSD",
    GBPUSD: "GBPUSD",
    AUDUSD: "AUDUSD",
    XAUUSD: "XAUUSD",
    BTCUSD: "BTCUSD",
  },
};

/**
 * The provider's name for a canonical symbol, if it carries it.
 * @param {string} source
 * @param {string} canonical
 */
export function toProvider(source, canonical) {
  return MAPPING[source]?.[canonical];
}

/**
 * The canonical symbol for a provider's name, if it is one we map.
 * @param {string} source
 * @param {string} providerSymbol
 */
export function toCanonical(source, providerSymbol) {
  const table = MAPPING[source];
  if (!table) return undefined;
  for (const [canonical, theirs] of Object.entries(table)) {
    if (theirs === providerSymbol) return canonical;
  }
  return undefined;
}

/**
 * The canonical symbols a provider carries, restricted to `wanted`.
 * @param {string} source
 * @param {string[]} wanted
 */
export function carried(source, wanted) {
  return wanted.filter((symbol) => toProvider(source, symbol) !== undefined);
}
