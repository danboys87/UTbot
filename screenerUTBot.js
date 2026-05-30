/**
 * Screener — UT Bot Alert (1H)
 *
 * Algoritma:
 *  1. Hitung ATR periode N (default 10) pada candle 1H
 *  2. Bangun ATR Trailing Stop dengan multiplier keyValue (default 2)
 *  3. Deteksi BUY signal: close cross ke atas trailing stop
 *  4. Deteksi SELL signal: close cross ke bawah trailing stop
 *  5. Filter tambahan: hanya BUY kalau 1D trend bullish (price > EMA21 1D)
 *  6. Kirim notif Telegram → masuk Approval Queue (Opsi B)
 *
 * Setting di user-config.json:
 *  "utbot": {
 *    "enabled": true,
 *    "keyValue": 2,
 *    "atrPeriod": 10,
 *    "timeframe": "1h",
 *    "checkIntervalMin": 60,
 *    "minVolume24h": 2000000,
 *    "filter1D": true,
 *    "maxSignalsPerRun": 5
 *  }
 */

import { getCandles, getAllTickers } from './bitget.js';
import { calcUTBot, calcEMA }       from './indicators.js';
import { config }                   from './config.js';
import { log }                      from './logger.js';
import { hasPosition }              from './state.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Track sinyal yang sudah dikirim agar tidak spam notif berulang
const _sentSignals = new Map();

function signalKey(symbol, signal, timestamp) {
  return `${symbol}_${signal}_${timestamp}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cek 1D trend — price > EMA21 1D
// ─────────────────────────────────────────────────────────────────────────────
async function is1DBullish(symbol) {
  try {
    const raw1D = await getCandles(symbol, '1day', 62);
    if (!Array.isArray(raw1D) || raw1D.length < 25) return true;

    const now         = Date.now();
    const periodMs    = 86400000;
    const periodStart = now - (now % periodMs);
    const closed      = raw1D
      .filter(c => parseInt(c[0]) < periodStart)
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));

    if (closed.length < 22) return true;
    const closes  = closed.map(c => parseFloat(c[4]));
    const ema21   = calcEMA(closes, 21);
    const lastClose = closes[closes.length - 1];
    return ema21 ? lastClose > ema21 : true;
  } catch {
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan satu symbol — return result + data untuk approval queue
// ─────────────────────────────────────────────────────────────────────────────
async function scanSymbol(symbol, cfg) {
  const { keyValue, atrPeriod, filter1D } = cfg;

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

    // Cek duplikat sinyal
    const key = signalKey(symbol, result.signal, lastTs);
    if (_sentSignals.has(key)) return null;

    // Filter 1D bullish untuk BUY signal
    if (result.signal === 'BUY' && filter1D) {
      const bullish = await is1DBullish(symbol);
      if (!bullish) {
        log('utbot', `  ${symbol} BUY signal tapi 1D bearish → difilter`);
        return null;
      }
    }

    // Tandai sudah dikirim
    _sentSignals.set(key, Date.now());

    // Bersihkan cache lama (lebih dari 24 jam)
    const cutoff = Date.now() - 86400000;
    for (const [k, ts] of _sentSignals.entries()) {
      if (ts < cutoff) _sentSignals.delete(k);
    }

    // ── Hitung SL & zone entry untuk approval queue ───────────────────────
    // SL: di bawah trailing stop saat ini dengan buffer 0.3%
    const slBuffer = config.management?.slBuffer ?? 0.005;
    const slPrice  = result.trailingStop * (1 - slBuffer);

    // Ambil low 20 candle terakhir sebagai referensi support
    const low20 = Math.min(...lows.slice(-20));

    // Zone entry: sekitar harga close sekarang (UT Bot entry di breakout trailing stop)
    const entryZone = {
      type:        'UTBot',
      entryPct:    100,
      priceTop:    result.close * 1.005,
      priceBottom: result.trailingStop,
      label:       `UT Bot zone ${result.trailingStop.toFixed(6)} - ${(result.close * 1.005).toFixed(6)}`,
    };

    return {
      symbol,
      signal:       result.signal,
      close:        result.close,
      trailingStop: result.trailingStop,
      atr:          result.atr,
      nLoss:        result.nLoss,
      candleTs:     lastTs,

      // Data tambahan untuk approval queue
      lastPrice:    result.close,
      slPrice,
      zones:        [entryZone],
      strategy:     'utbot',
      triggered:    true,   // UTBot signal = langsung triggered
      signals: {
        utbotSignal: {
          bullish: result.signal === 'BUY',
          label:   `UT Bot BUY — close ${result.close} cross above trailing stop ${result.trailingStop.toFixed(6)}`,
        },
        atrTrailing: {
          bullish: true,
          label:   `ATR=${result.atr.toFixed(6)} | nLoss=${result.nLoss.toFixed(6)} | keyValue=${keyValue}`,
        },
        trend1D: {
          bullish: true,
          label:   `1D trend bullish (price > EMA21 1D)`,
        },
        support: {
          bullish: true,
          label:   `Low20 1H = ${low20.toFixed(6)} | SL ref = ${result.trailingStop.toFixed(6)}`,
        },
      },
      matchCount: 3,
      score: 50,   // base score untuk UTBot
    };

  } catch (err) {
    log('utbot_error', `Scan ${symbol}: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main run
// ─────────────────────────────────────────────────────────────────────────────
export async function runUTBotScreener(tickers) {
  const utCfg = config.screening?.utbot ?? {};
  if (!utCfg.enabled) {
    log('utbot', 'UT Bot screener tidak aktif (set utbot.enabled: true di config)');
    return [];
  }

  const keyValue     = utCfg.keyValue     ?? 2;
  const atrPeriod    = utCfg.atrPeriod    ?? 10;
  const filter1D     = utCfg.filter1D     ?? true;
  const minVol       = utCfg.minVolume24h ?? config.screening?.minVolume24h ?? 2000000;
  const maxSignals   = utCfg.maxSignalsPerRun ?? 5;
  const quoteAsset   = config.trading.quoteAsset || 'USDT';
  const whitelist    = config.whitelist ?? [];

  log('utbot', `══ UT Bot Alert Screener (1H | key=${keyValue} atr=${atrPeriod}) ══`);

  const filtered = (tickers || [])
    .filter(t => {
      if (!t.symbol.endsWith(quoteAsset))    return false;
      if (config.blacklist?.includes(t.symbol)) return false;
      if (parseFloat(t.usdtVol || t.quoteVolume || 0) < minVol) return false;
      if (whitelist.length > 0 && !whitelist.includes(t.symbol)) return false;
      return true;
    })
    .sort((a, b) => parseFloat(b.usdtVol || 0) - parseFloat(a.usdtVol || 0));

  log('utbot', `Scanning ${filtered.length} koin...`);

  const signals = [];

  for (let i = 0; i < filtered.length; i++) {
    const coin = filtered[i];

    const result = await scanSymbol(coin.symbol, { keyValue, atrPeriod, filter1D });

    if (result) {
      const hasPos = hasPosition(result.symbol);
      result.hasPosition = hasPos;
      result.vol24h      = parseFloat(coin.usdtVol || coin.quoteVolume || 0);
      result.change24h   = parseFloat(coin.change24h || 0);

      log('utbot', `  🔔 ${result.signal} signal: ${result.symbol} @ ${result.close} | TS=${result.trailingStop.toFixed(6)} | ATR=${result.atr.toFixed(6)}${hasPos ? ' [SUDAH POSISI]' : ''}`);
      signals.push(result);

      if (signals.length >= maxSignals) {
        log('utbot', `  Max ${maxSignals} sinyal tercapai, berhenti`);
        break;
      }
    }

    if (i % 10 === 9) await sleep(500);
    else await sleep(150);
  }

  log('utbot', `UT Bot selesai → ${signals.length} sinyal (${signals.filter(s=>s.signal==='BUY').length} BUY, ${signals.filter(s=>s.signal==='SELL').length} SELL)`);
  return signals;
}
