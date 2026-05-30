/**
 * Screener — Trend Following
 * Dijalankan jam 08:00 WIB setelah Daily Gainer.
 *
 * Mencari koin yang sedang dalam tren naik yang kuat dan terkonfirmasi
 * di timeframe harian — bukan menebak reversal, tapi ikuti tren yang sudah jalan.
 *
 * Kriteria (minimal trendMinMatch harus terpenuhi dari 6):
 *  1. EMA Stack    — EMA9 > EMA21 > EMA50 (tren naik tersusun rapi)
 *  2. Harga > EMA21— harga di atas EMA21 (konfirmasi tren bullish)
 *  3. Higher Low   — low kemarin > low 5 hari lalu (struktur naik terjaga)
 *  4. ADX > 25     — tren cukup kuat, bukan sideways
 *  5. RSI 45-70    — momentum bullish tapi belum overbought
 *  6. Volume naik  — volume 3 hari terakhir lebih tinggi dari avg 10 hari
 */

import { getAllTickers, getCandles } from './bitget.js';
import { config }                    from './config.js';
import { log }                       from './logger.js';
import { hasPosition }               from './state.js';
import { calcEMA, calcRSI, calcADX } from './indicators.js';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Validasi Trend Following Setup ────────────────────────────────────────────
function validateTrendSetup(candles, sc) {
  const trend    = sc.trend ?? {};
  const minMatch = trend.minMatch ?? 4;

  if (!candles || candles.length < 55) {
    return { isValid: false, signals: {}, matchCount: 0, reason: 'Data candle kurang (min 55)' };
  }

  const closes  = candles.map(c => parseFloat(c[4]));
  const highs   = candles.map(c => parseFloat(c[2]));
  const lows    = candles.map(c => parseFloat(c[3]));
  const volumes = candles.map(c => parseFloat(c[5]));

  // Gunakan data sampai candle kemarin (exclude candle hari ini yg belum close)
  const closesYest  = closes.slice(0, -1);
  const highsYest   = highs.slice(0, -1);
  const lowsYest    = lows.slice(0, -1);
  const volumesYest = volumes.slice(0, -1);

  const close    = closesYest[closesYest.length - 1];
  const signals  = {};
  let   matchCount = 0;

  // ── 1. EMA Stack: EMA9 > EMA21 > EMA50 ──────────────────────────────────
  const ema9  = calcEMA(closesYest, 9);
  const ema21 = calcEMA(closesYest, 21);
  const ema50 = calcEMA(closesYest, 50);
  const emaStack = ema9 !== null && ema21 !== null && ema50 !== null
    && ema9 > ema21 && ema21 > ema50;
  signals.emaStack = {
    bullish: emaStack,
    label:   ema9 && ema21 && ema50
      ? `EMA9(${ema9.toFixed(4)}) > EMA21(${ema21.toFixed(4)}) > EMA50(${ema50.toFixed(4)})`
      : 'N/A',
  };
  if (emaStack) matchCount++;

  // ── 2. Harga > EMA21 ──────────────────────────────────────────────────────
  const aboveEma21 = ema21 !== null && close > ema21;
  const distEma21  = ema21 ? ((close - ema21) / ema21 * 100) : 0;
  signals.aboveEma21 = {
    bullish: aboveEma21,
    label:   ema21 ? `Close ${close} > EMA21 ${ema21.toFixed(4)} (+${distEma21.toFixed(2)}%)` : 'N/A',
  };
  if (aboveEma21) matchCount++;

  // ── 3. Higher Low — low kemarin > low 5 hari lalu ─────────────────────────
  const higherLowPeriod = trend.higherLowPeriod ?? 5;
  const currentLow      = lowsYest[lowsYest.length - 1];
  const prevLow         = Math.min(...lowsYest.slice(-higherLowPeriod - 1, -1));
  const isHigherLow     = currentLow > prevLow;
  signals.higherLow = {
    bullish: isHigherLow,
    label:   `Low kemarin ${currentLow.toFixed(6)} > low ${higherLowPeriod}h lalu ${prevLow.toFixed(6)}`,
  };
  if (isHigherLow) matchCount++;

  // ── 4. ADX > 25 (tren kuat) ───────────────────────────────────────────────
  const adxPeriod  = trend.adxPeriod ?? 14;
  const adxMin     = trend.adxMin ?? 25;
  const adxResult  = calcADX(highsYest, lowsYest, closesYest, adxPeriod);
  const strongTrend = adxResult !== null && adxResult.adx >= adxMin && adxResult.plusDI > adxResult.minusDI;
  signals.adx = {
    bullish: strongTrend,
    label:   adxResult
      ? `ADX ${adxResult.adx.toFixed(1)} (min ${adxMin}) | +DI ${adxResult.plusDI.toFixed(1)} > -DI ${adxResult.minusDI.toFixed(1)}`
      : 'N/A',
  };
  if (strongTrend) matchCount++;

  // ── 5. RSI 45-70 (momentum bullish, belum overbought) ─────────────────────
  const rsiMin = trend.rsiMin ?? 45;
  const rsiMax = trend.rsiMax ?? 70;
  const rsi    = calcRSI(closesYest, 14);
  const rsiOk  = rsi !== null && rsi >= rsiMin && rsi <= rsiMax;
  signals.rsi = {
    bullish: rsiOk,
    label:   rsi !== null ? `RSI ${rsi.toFixed(1)} (range ${rsiMin}-${rsiMax})` : 'N/A',
  };
  if (rsiOk) matchCount++;

  // ── 6. Volume naik — avg 3 hari > avg 10 hari ────────────────────────────
  const volRecent = volumesYest.slice(-3).reduce((s, v) => s + v, 0) / 3;
  const volAvg10  = volumesYest.slice(-11, -1).reduce((s, v) => s + v, 0) / 10;
  const volRising = volAvg10 > 0 && volRecent > volAvg10;
  signals.volumeRising = {
    bullish: volRising,
    label:   `Vol avg3 ${volRecent.toFixed(0)} > avg10 ${volAvg10.toFixed(0)}`,
    ratio:   volAvg10 > 0 ? volRecent / volAvg10 : 0,
  };
  if (volRising) matchCount++;

  const isValid = matchCount >= minMatch;
  return {
    isValid,
    signals,
    matchCount,
    totalSignals: 6,
    reason: isValid
      ? `${matchCount}/6 sinyal trend terpenuhi`
      : `Hanya ${matchCount}/6 sinyal (min ${minMatch})`,
  };
}

// ── Main Trend Following Screening ───────────────────────────────────────────
export async function runTrendScreening(tickers, cfg) {
  const sc         = cfg.screening;
  const trend      = sc.trend ?? {};
  const quoteAsset = cfg.trading.quoteAsset || 'USDT';
  const minVolUsdt = sc.minVolume24h ?? 100000;
  const maxBuy     = trend.topCandidatesLimit ?? 2;
  const checkLimit = trend.checkLimit ?? 50;

  log('screener', '── Trend Following Screening mulai ──');

  // Filter: USDT, volume cukup, belum posisi, tidak blacklist
  // Trend Following: cari koin yang sudah naik (change24h positif, tapi tidak pump ekstrem)
  const filtered = tickers
    .filter(t => {
      if (!t.symbol.endsWith(quoteAsset))    return false;
      if (cfg.blacklist?.includes(t.symbol)) return false;
      if (hasPosition(t.symbol))             return false;
      return parseFloat(t.usdtVol || t.quoteVolume || 0) >= minVolUsdt;
    })
    .map(t => {
      const raw = parseFloat(t.change24h || 0);
      const change24h = Math.abs(raw) < 1.5 && Math.abs(raw) > 0 ? raw * 100 : raw;
      return {
        symbol:    t.symbol,
        change24h,
        lastPrice: parseFloat(t.lastPr || t.last || 0),
        vol24h:    parseFloat(t.usdtVol || t.quoteVolume || 0),
      };
    })
    // Trend Following: koin yang naik moderat (1% - 15%), bukan pump ekstrem
    .filter(t =>
      t.change24h >= (trend.minChange24h ?? 1) &&
      t.change24h <= (trend.maxChange24h ?? 15)
    )
    // Urutkan berdasarkan volume (koin liquid lebih diprioritaskan)
    .sort((a, b) => b.vol24h - a.vol24h);

  const toCheck    = filtered.slice(0, checkLimit);
  const candidates = [];

  log('screener', `Trend: ${toCheck.length} koin akan diperiksa (naik 1-15%)...`);

  for (let i = 0; i < toCheck.length; i++) {
    const coin = toCheck[i];
    const changeStr = coin.change24h >= 0 ? `+${coin.change24h.toFixed(2)}` : coin.change24h.toFixed(2);
    log('screener', `  [T${i + 1}/${toCheck.length}] ${coin.symbol} (${changeStr}%)`);

    try {
      const rawCandles = await getCandles(coin.symbol, '1day', 60);

      if (!Array.isArray(rawCandles) || rawCandles.length < 55) {
        log('screener', `    ↳ Data candle tidak cukup (${rawCandles?.length ?? 0})`);
        await sleep(150);
        continue;
      }

      const candles = rawCandles.slice(0, -1).reverse(); // Bitget oldest-first: buang live dulu baru reverse
      const check   = validateTrendSetup(candles, sc);

      if (check.isValid) {
        log('screener', `    ↳ ✅ TREND LOLOS — ${check.reason}`);
        candidates.push({
          symbol:     coin.symbol,
          lastPrice:  coin.lastPrice,
          change24h:  coin.change24h,
          vol24h:     coin.vol24h,
          score:      check.matchCount * 100 + (coin.vol24h / 1e6),
          matchCount: check.matchCount,
          strategy:   'trendFollowing',
          signals:    check.signals,
        });

        if (candidates.length >= maxBuy) {
          log('screener', `  Batas ${maxBuy} kandidat trend tercapai.`);
          break;
        }
      } else {
        log('screener', `    ↳ ❌ ${check.reason}`);
      }
    } catch (err) {
      log('screener_error', `Trend error ${coin.symbol}: ${err.message}`);
    }

    await sleep(200);
  }

  log('screener', `Trend Following selesai → ${candidates.length} kandidat`);
  return candidates;
}
