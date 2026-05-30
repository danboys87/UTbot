/**
 * Technical Indicators
 * RSI, EMA, MACD, Bollinger Bands, Volume
 */

// ── RSI ──────────────────────────────────────────────────────────────────────
export function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0  ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain)  / period;
    avgLoss = (avgLoss * (period - 1) + loss)  / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ── EMA ──────────────────────────────────────────────────────────────────────
export function calcEMA(closes, period) {
  if (closes.length < period) return null;

  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// ── MACD ─────────────────────────────────────────────────────────────────────
export function calcMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (closes.length < slowPeriod + signalPeriod) return null;

  // Build EMA series for signal line
  const k_fast   = 2 / (fastPeriod + 1);
  const k_slow   = 2 / (slowPeriod + 1);
  const k_signal = 2 / (signalPeriod + 1);

  let emaFast = closes.slice(0, fastPeriod).reduce((a, b) => a + b, 0) / fastPeriod;
  let emaSlow = closes.slice(0, slowPeriod).reduce((a, b) => a + b, 0) / slowPeriod;

  const macdLine = [];
  for (let i = slowPeriod; i < closes.length; i++) {
    // Update fast EMA from slowPeriod onwards
    if (i < fastPeriod) {
      emaFast = closes[i];
    } else {
      emaFast = closes[i] * k_fast + emaFast * (1 - k_fast);
    }
    emaSlow = closes[i] * k_slow + emaSlow * (1 - k_slow);
    macdLine.push(emaFast - emaSlow);
  }

  if (macdLine.length < signalPeriod) return null;

  let signal = macdLine.slice(0, signalPeriod).reduce((a, b) => a + b, 0) / signalPeriod;
  for (let i = signalPeriod; i < macdLine.length; i++) {
    signal = macdLine[i] * k_signal + signal * (1 - k_signal);
  }

  const macdValue    = macdLine[macdLine.length - 1];
  const histogram    = macdValue - signal;

  return { macd: macdValue, signal, histogram };
}

// ── Bollinger Bands ───────────────────────────────────────────────────────────
export function calcBollinger(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return null;

  const slice  = closes.slice(-period);
  const mean   = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period;
  const sd     = Math.sqrt(variance);

  const upper  = mean + stdDev * sd;
  const lower  = mean - stdDev * sd;
  const price  = closes[closes.length - 1];
  const pctB   = sd > 0 ? (price - lower) / (upper - lower) : 0.5;

  return { upper, middle: mean, lower, pctB };
}

// ── Volume ────────────────────────────────────────────────────────────────────
export function calcVolumeSurge(volumes, multiplier = 1.5, period = 20) {
  if (volumes.length < period + 1) return null;

  const avgVol   = volumes.slice(-period - 1, -1).reduce((a, b) => a + b, 0) / period;
  const lastVol  = volumes[volumes.length - 1];
  const ratio    = avgVol > 0 ? lastVol / avgVol : 0;

  return { ratio, avgVolume: avgVol, currentVolume: lastVol, surging: ratio >= multiplier };
}

// ── Evaluate All ─────────────────────────────────────────────────────────────
/**
 * Evaluates all configured indicators and returns signals.
 * @param {number[]} closes   - Closing prices (oldest first)
 * @param {number[]} volumes  - Volumes (oldest first)
 * @param {object}   indCfg   - config.screening.indicators
 * @returns {{ signals, matchCount, bullishCount }}
 */
export function evaluateIndicators(closes, volumes, indCfg) {
  const signals = {};
  let matchCount = 0;

  // RSI
  if (indCfg.rsi?.enabled) {
    const rsi = calcRSI(closes, indCfg.rsi.period);
    const bullish = rsi !== null && rsi <= indCfg.rsi.oversoldLevel;
    signals.rsi = { value: rsi, bullish, label: rsi !== null ? `RSI=${rsi.toFixed(1)}` : 'N/A' };
    if (bullish) matchCount++;
  }

  // EMA Cross
  if (indCfg.ema?.enabled) {
    const fast = calcEMA(closes, indCfg.ema.fastPeriod);
    const slow = calcEMA(closes, indCfg.ema.slowPeriod);
    const bullish = fast !== null && slow !== null && fast > slow;
    signals.ema = {
      fast, slow, bullish,
      label: fast && slow ? `EMA${indCfg.ema.fastPeriod}=${fast.toFixed(4)} > EMA${indCfg.ema.slowPeriod}=${slow.toFixed(4)}` : 'N/A',
    };
    if (bullish) matchCount++;
  }

  // Volume Surge
  if (indCfg.volume?.enabled) {
    const vol = calcVolumeSurge(volumes, indCfg.volume.multiplier, indCfg.volume.period);
    const bullish = vol?.surging === true;
    signals.volume = {
      ratio: vol?.ratio, bullish,
      label: vol ? `Vol x${vol.ratio.toFixed(2)} (threshold ${indCfg.volume.multiplier}x)` : 'N/A',
    };
    if (bullish) matchCount++;
  }

  // MACD
  if (indCfg.macd?.enabled) {
    const macd = calcMACD(closes, indCfg.macd.fastPeriod, indCfg.macd.slowPeriod, indCfg.macd.signalPeriod);
    const bullish = macd !== null && macd.macd > macd.signal;
    signals.macd = {
      ...macd, bullish,
      label: macd ? `MACD=${macd.macd.toFixed(6)} Signal=${macd.signal.toFixed(6)}` : 'N/A',
    };
    if (bullish) matchCount++;
  }

  // Bollinger
  if (indCfg.bollinger?.enabled) {
    const bb = calcBollinger(closes, indCfg.bollinger.period, indCfg.bollinger.stdDev);
    const bullish = bb !== null && bb.pctB < 0.2;
    signals.bollinger = {
      ...bb, bullish,
      label: bb ? `%B=${bb.pctB.toFixed(2)} (lower band ${bb.lower.toFixed(4)})` : 'N/A',
    };
    if (bullish) matchCount++;
  }

  return { signals, matchCount };
}

// ── ADX (Average Directional Index) ──────────────────────────────────────────
/**
 * @param {number[]} highs  - oldest first
 * @param {number[]} lows   - oldest first
 * @param {number[]} closes - oldest first
 * @param {number}   period
 * @returns {{ adx, plusDI, minusDI } | null}
 */
export function calcADX(highs, lows, closes, period = 14) {
  if (highs.length < period * 2) return null;

  const trArr = [], plusDMArr = [], minusDMArr = [];

  for (let i = 1; i < highs.length; i++) {
    const highDiff = highs[i] - highs[i - 1];
    const lowDiff  = lows[i - 1] - lows[i];

    const plusDM  = highDiff > lowDiff && highDiff > 0 ? highDiff : 0;
    const minusDM = lowDiff > highDiff && lowDiff  > 0 ? lowDiff  : 0;

    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    );

    trArr.push(tr);
    plusDMArr.push(plusDM);
    minusDMArr.push(minusDM);
  }

  // Smoothed averages (Wilder)
  let atr    = trArr.slice(0, period).reduce((a, b) => a + b, 0);
  let plusDI = plusDMArr.slice(0, period).reduce((a, b) => a + b, 0);
  let minDI  = minusDMArr.slice(0, period).reduce((a, b) => a + b, 0);

  const dxArr = [];

  for (let i = period; i < trArr.length; i++) {
    atr    = atr    - atr    / period + trArr[i];
    plusDI = plusDI - plusDI / period + plusDMArr[i];
    minDI  = minDI  - minDI  / period + minusDMArr[i];

    const pDI = atr > 0 ? (plusDI / atr) * 100 : 0;
    const mDI = atr > 0 ? (minDI  / atr) * 100 : 0;
    const dx  = (pDI + mDI) > 0 ? Math.abs(pDI - mDI) / (pDI + mDI) * 100 : 0;
    dxArr.push({ dx, pDI, mDI });
  }

  if (dxArr.length < period) return null;

  // ADX = smoothed average of DX
  let adx = dxArr.slice(0, period).reduce((s, d) => s + d.dx, 0) / period;
  for (let i = period; i < dxArr.length; i++) {
    adx = (adx * (period - 1) + dxArr[i].dx) / period;
  }

  const last = dxArr[dxArr.length - 1];
  return { adx, plusDI: last.pDI, minusDI: last.mDI };
}

// ── ATR (Average True Range) ──────────────────────────────────────────────────
/**
 * @param {number[]} highs  - oldest first
 * @param {number[]} lows   - oldest first
 * @param {number[]} closes - oldest first
 * @param {number}   period
 * @returns {number[]} array ATR values, null untuk index awal yang belum cukup data
 */
export function calcATR(highs, lows, closes, period = 10) {
  if (highs.length < period + 1) return null;

  const trArr = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i]  - lows[i],
      Math.abs(highs[i]  - closes[i - 1]),
      Math.abs(lows[i]   - closes[i - 1])
    );
    trArr.push(tr);
  }

  // Wilder smoothing
  let atr = trArr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const atrArr = new Array(period).fill(null);
  atrArr.push(atr);

  for (let i = period; i < trArr.length; i++) {
    atr = (atr * (period - 1) + trArr[i]) / period;
    atrArr.push(atr);
  }

  return atrArr;
}

// ── UT Bot Alert ──────────────────────────────────────────────────────────────
/**
 * UT Bot Alert — ATR Trailing Stop + crossover signal
 *
 * Algoritma:
 *  1. nLoss = keyValue × ATR
 *  2. Trailing stop bergerak mengikuti harga:
 *     - Harga naik  : stop = max(stop_prev, close - nLoss)
 *     - Harga turun : stop = min(stop_prev, close + nLoss)
 *  3. BUY  : close crosses ABOVE trailing stop
 *  4. SELL : close crosses BELOW trailing stop
 *
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes    - oldest first
 * @param {number}   keyValue  - ATR multiplier (default 1)
 * @param {number}   atrPeriod - ATR period (default 10)
 * @returns {{ signal, trailingStop, atr, close, prevClose, nLoss } | null}
 */
export function calcUTBot(highs, lows, closes, keyValue = 1, atrPeriod = 10) {
  if (closes.length < atrPeriod + 5) return null;

  const atrArr = calcATR(highs, lows, closes, atrPeriod);
  if (!atrArr) return null;

  const startIdx = atrArr.findIndex(v => v !== null);
  if (startIdx === -1) return null;

  // Hitung trailing stop untuk semua candle
  const stops = new Array(closes.length).fill(null);
  stops[startIdx] = closes[startIdx] - atrArr[startIdx] * keyValue;

  for (let i = startIdx + 1; i < closes.length; i++) {
    const atr      = atrArr[i];
    if (!atr) { stops[i] = stops[i - 1]; continue; }

    const nLoss    = atr * keyValue;
    const close    = closes[i];
    const prevStop = stops[i - 1] ?? (close - nLoss);

    stops[i] = close > prevStop
      ? Math.max(prevStop, close - nLoss)   // trending up — stop naik
      : Math.min(prevStop, close + nLoss);   // trending down — stop turun
  }

  // Deteksi sinyal dari 2 candle closed terakhir
  const lastIdx  = closes.length - 1;
  const prevIdx  = closes.length - 2;
  const close     = closes[lastIdx];
  const prevClose = closes[prevIdx];
  const stop      = stops[lastIdx];
  const prevStop  = stops[prevIdx];
  const atr       = atrArr[lastIdx];

  if (!stop || !prevStop || !atr) return null;

  let signal = null;
  if (prevClose <= prevStop && close > stop) signal = 'BUY';
  if (prevClose >= prevStop && close < stop) signal = 'SELL';

  return {
    signal,
    trailingStop: stop,
    prevStop,
    atr,
    close,
    prevClose,
    nLoss: atr * keyValue,
  };
}
