/**
 * Screener — UT Bot Alert (1H)
 *
 * Algoritma:
 *  1. Hitung ATR periode N (default 10) pada candle 1H
 *  2. Bangun ATR Trailing Stop dengan multiplier keyValue (default 2)
 *  3. Deteksi BUY signal: close cross ke atas trailing stop
 *  4. Filter: harga close > EMA21 pada timeframe 1H
 *  5. Filter: bukan tokenized stock (prefix 'r' — rAAPL, rTSLA, dst)
 */

import { getCandles, getAllTickers } from './bitget.js';
import { calcUTBot, calcEMA }        from './indicators.js';
import { config }                    from './config.js';
import { log }                       from './logger.js';
import { hasPosition }               from './state.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isTokenizedStock(symbol) {
  // Bitget tokenized stocks pakai prefix 'r' diikuti huruf kapital
  // contoh: rAAPLUSDT, rTSLAUSDT, rNVDAUSDT, rQQQUSDT, rSPYUSDT
  return /^r[A-Z]/.test(symbol);
}

const _sentSignals = new Map();

function signalKey(symbol, signal, timestamp) {
  return `${symbol}_${signal}_${timestamp}`;
}

async function is1HBullish(symbol) {
  try {
    const raw1H = await getCandles(symbol, '1h', 60);
    if (!Array.isArray(raw1H) || raw1H.length < 25) return true;

    const now         = Date.now();
    const periodMs    = 3600000;
    const periodStart = now - (now % periodMs);
    const closed      = raw1H
      .filter(c => parseInt(c[0]) < periodStart)
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));

    if (closed.length < 22) return true;

    const closes    = closed.map(c => parseFloat(c[4]));
    const ema21     = calcEMA(closes, 21);
    const lastClose = closes[closes.length - 1];

    const bullish = ema21 ? lastClose > ema21 : true;
    log('utbot', `  [1H EMA21] ${symbol}: close=${lastClose?.toFixed(6)} EMA21=${ema21?.toFixed(6)} → ${bullish ? '✅ BULLISH' : '❌ BEARISH'}`);
    return bullish;
  } catch {
    return true;
  }
}

async function scanSymbol(symbol, cfg) {
  const { keyValue, atrPeriod, filter1H_EMA21 } = cfg;

  try {
    const raw1H = await getCandles(symbol, '1h', Math.max(atrPeriod * 3 + 20, 60));
    if (!Array.isArray(raw1H) || raw1H.length < atrPeriod + 10) return null;

    const now         = Date.now();
    const periodMs    = 3600000;
    const periodStart = now - (now % periodMs);
    const closed      = raw1H
      .filter(c => parseInt(c[0]) < periodStart)
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));

    if (closed.length < atrPeriod + 5) return null;

    const highs  = closed.map(c => parseFloat(c[2]));
    const lows   = closed.map(c => parseFloat(c[3]));
    const closes = closed.map(c => parseFloat(c[4]));
    const lastTs = parseInt(closed[closed.length - 1][0]);

    const result = calcUTBot(highs, lows, closes, keyValue, atrPeriod);
    if (!result || !result.signal) return null;
    if (result.signal !== 'BUY') return null;

    const key = signalKey(symbol, result.signal, lastTs);
    if (_sentSignals.has(key)) return null;

    if (filter1H_EMA21 !== false) {
      const bullish1H = await is1HBullish(symbol);
      if (!bullish1H) {
        log('utbot', `  ${symbol} BUY signal tapi 1H bearish (close < EMA21 1H) → difilter`);
        return null;
      }
    }

    _sentSignals.set(key, Date.now());

    const cutoff = Date.now() - 86400000;
    for (const [k, ts] of _sentSignals.entries()) {
      if (ts < cutoff) _sentSignals.delete(k);
    }

    const slBuffer = config.management?.slBuffer ?? 0.005;
    const slPrice  = result.trailingStop * (1 - slBuffer);
    const low20    = Math.min(...lows.slice(-20));

    const entryZone = {
      type:        'UTBot',
      entryPct:    100,
      priceTop:    result.close * 1.005,
      priceBottom: result.trailingStop,
      label:       `UT Bot zone ${result.trailingStop.toFixed(6)} - ${(result.close * 1.005).toFixed(6)}`,
    };

    const ema21_1H = calcEMA(closes, 21);

    return {
      symbol,
      signal:       result.signal,
      close:        result.close,
      trailingStop: result.trailingStop,
      atr:          result.atr,
      nLoss:        result.nLoss,
      candleTs:     lastTs,

      lastPrice:    result.close,
      slPrice,
      zones:        [entryZone],
      strategy:     'utbot',
      triggered:    true,
      signals: {
        utbotSignal: {
          bullish: true,
          label:   `UT Bot BUY — close ${result.close} cross above trailing stop ${result.trailingStop.toFixed(6)}`,
        },
        atrTrailing: {
          bullish: true,
          label:   `ATR=${result.atr.toFixed(6)} | nLoss=${result.nLoss.toFixed(6)} | keyValue=${keyValue}`,
        },
        ema21_1H: {
          bullish: true,
          label:   ema21_1H ? `Close ${result.close.toFixed(6)} > EMA21 1H ${ema21_1H.toFixed(6)} ✅` : 'EMA21 1H: data kurang',
        },
        support: {
          bullish: true,
          label:   `Low20 1H = ${low20.toFixed(6)} | SL ref = ${result.trailingStop.toFixed(6)}`,
        },
      },
      ema21_1H,
      matchCount: 3,
      score: 50,
    };

  } catch (err) {
    log('utbot_error', `Scan ${symbol}: ${err.message}`);
    return null;
  }
}

export async function runUTBotScreener(tickersOrSymbols, opts = {}) {
  const utCfg = config.screening?.utbot ?? {};

  const keyValue       = utCfg.keyValue       ?? 2;
  const atrPeriod      = utCfg.atrPeriod      ?? 10;
  const filter1H_EMA21 = utCfg.filter1H_EMA21 !== false;
  const minVol         = utCfg.minVolume24h   ?? config.screening?.minVolume24h ?? 5_000_000;
  const maxSignals     = opts.maxSignals       ?? utCfg.maxSignalsPerRun ?? 5;
  const quoteAsset     = config.trading.quoteAsset || 'USDT';
  const whitelist      = config.whitelist ?? [];
  const fromGainer     = opts.fromGainer ?? false;

  log('utbot', `══ UT Bot Alert Screener (1H | key=${keyValue} atr=${atrPeriod} | EMA21-1H filter: ${filter1H_EMA21 ? 'ON' : 'OFF'}) ══`);

  let filtered;

  if (fromGainer && Array.isArray(tickersOrSymbols)) {
    // Input dari gainer pipeline — sudah pasti bukan tokenized stock
    // karena screenerGainer.js sudah filter duluan
    filtered = tickersOrSymbols.filter(t => !hasPosition(t.symbol));
    log('utbot', `Dari gainer pipeline: ${filtered.length} koin (sudah crypto spot murni)`);
  } else {
    // Standalone mode: filter dari semua tickers
    const tickers = Array.isArray(tickersOrSymbols) ? tickersOrSymbols : [];
    filtered = tickers
      .filter(t => {
        if (!t.symbol.endsWith(quoteAsset))                        return false;
        if (isTokenizedStock(t.symbol))                            return false; // filter saham tokenized
        if (config.blacklist?.includes(t.symbol))                  return false;
        if (parseFloat(t.usdtVol || t.quoteVolume || 0) < minVol) return false;
        if (whitelist.length > 0 && !whitelist.includes(t.symbol)) return false;
        return true;
      })
      .sort((a, b) => parseFloat(b.usdtVol || 0) - parseFloat(a.usdtVol || 0));
  }

  log('utbot', `Scanning ${filtered.length} koin untuk BUY signal (crypto spot murni)...`);

  const signals = [];

  for (let i = 0; i < filtered.length; i++) {
    const coin = filtered[i];

    const result = await scanSymbol(coin.symbol, { keyValue, atrPeriod, filter1H_EMA21 });

    if (result) {
      const hasPos = hasPosition(result.symbol);
      result.hasPosition = hasPos;
      result.vol24h      = coin.vol24h    ?? parseFloat(coin.usdtVol || coin.quoteVolume || 0);
      result.change24h   = coin.change24h ?? parseFloat(coin.change24h || 0);

      log('utbot', `  🔔 BUY: ${result.symbol} @ ${result.close} | TS=${result.trailingStop.toFixed(6)} | ATR=${result.atr.toFixed(6)}${hasPos ? ' [POSISI OPEN]' : ''}`);
      signals.push(result);

      if (signals.length >= maxSignals) {
        log('utbot', `  Max ${maxSignals} sinyal tercapai, berhenti`);
        break;
      }
    }

    if (i % 10 === 9) await sleep(500);
    else await sleep(150);
  }

  log('utbot', `UT Bot selesai → ${signals.length} BUY signal`);
  return signals;
}
