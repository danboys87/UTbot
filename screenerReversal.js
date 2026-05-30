/**
 * Screener — Metode Reversal Hunter
 *
 * Mencari koin yang sedang dalam tren turun tapi mulai menunjukkan
 * tanda-tanda pembalikan (reversal) ke atas.
 *
 * Kriteria (minimal reversalMinMatch harus terpenuhi):
 *  1. RSI Oversold      — RSI harian < 35 (momentum turun melemah)
 *  2. Hammer / Bullish Engulfing — pola candle reversal
 *  3. Volume Climax     — volume kemarin > 2x rata-rata 5 hari (seller kapitulasi)
 *  4. Harga di Support  — close dekat low 14 hari terakhir (< 10% dari low)
 *  5. EMA Bounce        — harga mendekati atau menyentuh EMA 21
 */

import { getAllTickers, getCandles } from './bitget.js';
import { config }                    from './config.js';
import { log }                       from './logger.js';
import { hasPosition }               from './state.js';
import { calcRSI, calcEMA }          from './indicators.js';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Deteksi Pola Candle Reversal ──────────────────────────────────────────────
function detectCandlePattern(candles) {
  const c1 = candles[candles.length - 2]; // kemarin
  const c2 = candles[candles.length - 3]; // 2 hari lalu

  const open1  = parseFloat(c1[1]);
  const high1  = parseFloat(c1[2]);
  const low1   = parseFloat(c1[3]);
  const close1 = parseFloat(c1[4]);

  const open2  = parseFloat(c2[1]);
  const close2 = parseFloat(c2[4]);

  const totalRange = high1 - low1;
  const body       = Math.abs(close1 - open1);
  const lowerWick  = Math.min(open1, close1) - low1;
  const upperWick  = high1 - Math.max(open1, close1);

  // Hammer — sumbu bawah panjang (≥ 2x body), body kecil, sumbu atas minimal
  const isHammer =
    totalRange > 0 &&
    lowerWick >= body * 2 &&
    upperWick <= body * 0.5 &&
    body > 0;

  // Bullish Engulfing — candle hijau besar menelan candle merah sebelumnya
  const isBullishEngulfing =
    close2 < open2 &&        // c2 bearish
    close1 > open1 &&        // c1 bullish
    open1  < close2 &&       // c1 open di bawah c2 close
    close1 > open2;          // c1 close di atas c2 open

  if (isHammer) return { detected: true, pattern: 'Hammer' };
  if (isBullishEngulfing) return { detected: true, pattern: 'Bullish Engulfing' };
  return { detected: false, pattern: null };
}

// ── Validasi Reversal Setup ───────────────────────────────────────────────────
function validateReversalSetup(candles, sc) {
  if (!candles || candles.length < 22) {
    return { isValid: false, signals: {}, matchCount: 0, reason: 'Data candle kurang (minimal 22)' };
  }

  const reversal   = sc.reversal ?? {};
  const minMatch   = reversal.minMatch ?? 3;
  const signals    = {};
  let   matchCount = 0;

  const closes  = candles.map(c => parseFloat(c[4]));
  const volumes = candles.map(c => parseFloat(c[5]));

  // Data candle kemarin
  const yesterday = candles[candles.length - 2];
  const close     = parseFloat(yesterday[4]);
  const vol       = parseFloat(yesterday[5]);

  // ── 1. RSI Oversold ──────────────────────────────────────────────────────
  const rsiPeriod   = reversal.rsiPeriod ?? 14;
  const rsiLevel    = reversal.rsiOversold ?? 35;
  const rsi         = calcRSI(closes.slice(0, -1), rsiPeriod); // exclude candle hari ini
  const rsiOversold = rsi !== null && rsi <= rsiLevel;
  signals.rsi = {
    bullish: rsiOversold,
    label:   rsi !== null ? `RSI ${rsi.toFixed(1)} ≤ ${rsiLevel}` : 'N/A',
  };
  if (rsiOversold) matchCount++;

  // ── 2. Pola Candle Reversal ───────────────────────────────────────────────
  const pattern = detectCandlePattern(candles);
  signals.candlePattern = {
    bullish: pattern.detected,
    label:   pattern.detected ? pattern.pattern : 'Tidak ada pola reversal',
  };
  if (pattern.detected) matchCount++;

  // ── 3. Volume Climax ─────────────────────────────────────────────────────
  const volMultiplier = reversal.volumeClimax ?? 2.0;
  const prev5vols     = volumes.slice(-7, -2);
  const avgVol        = prev5vols.reduce((s, v) => s + v, 0) / 5;
  const volRatio      = avgVol > 0 ? vol / avgVol : 0;
  const isClimax      = volRatio >= volMultiplier;
  signals.volumeClimax = {
    bullish: isClimax,
    label:   `Vol ${volRatio.toFixed(2)}x avg5 (threshold ${volMultiplier}x)`,
    ratio:   volRatio,
  };
  if (isClimax) matchCount++;

  // ── 4. Harga di Area Support (near 14-day low) ────────────────────────────
  const supportPeriod  = reversal.supportPeriod ?? 14;
  const supportPct     = reversal.supportPct ?? 0.10;
  const recentLows     = closes.slice(-(supportPeriod + 2), -1).map(Number);
  const support14Low   = Math.min(...recentLows);
  const distFromLow    = support14Low > 0 ? (close - support14Low) / support14Low : 1;
  const nearSupport    = distFromLow <= supportPct;
  signals.support = {
    bullish: nearSupport,
    label:   `Harga ${(distFromLow * 100).toFixed(1)}% dari low ${supportPeriod}h (batas ${supportPct * 100}%)`,
  };
  if (nearSupport) matchCount++;

  // ── 5. EMA Bounce (harga dekat EMA 21) ───────────────────────────────────
  const emaPeriod  = reversal.emaPeriod ?? 21;
  const emaPct     = reversal.emaBounceMaxPct ?? 0.03;
  const ema21      = calcEMA(closes.slice(0, -1), emaPeriod);
  const distFromEma = ema21 ? Math.abs(close - ema21) / ema21 : 1;
  const nearEma    = ema21 !== null && distFromEma <= emaPct;
  signals.emaBounce = {
    bullish: nearEma,
    label:   ema21 ? `Harga ${(distFromEma * 100).toFixed(1)}% dari EMA${emaPeriod} (batas ${emaPct * 100}%)` : 'N/A',
  };
  if (nearEma) matchCount++;

  const isValid = matchCount >= minMatch;
  return {
    isValid,
    signals,
    matchCount,
    reason: isValid
      ? `${matchCount}/${Object.keys(signals).length} sinyal reversal terpenuhi`
      : `Hanya ${matchCount}/${Object.keys(signals).length} sinyal (min ${minMatch})`,
  };
}

// ── Main Reversal Screening ───────────────────────────────────────────────────
export async function runReversalScreening(tickers, cfg) {
  const sc         = cfg.screening;
  const reversal   = sc.reversal ?? {};
  const quoteAsset = cfg.trading.quoteAsset || 'USDT';
  const minVolUsdt = sc.minVolume24h ?? 100000;
  const maxBuy     = reversal.topCandidatesLimit ?? 2;
  const checkLimit = reversal.checkLimit ?? 50;

  log('screener', '── Reversal Hunter mulai ──');

  // Filter: USDT, volume cukup, belum punya posisi, tidak di-blacklist
  // Untuk reversal: cari koin yang TURUN (change24h negatif atau kecil)
  const filtered = tickers
    .filter(t => {
      if (!t.symbol.endsWith(quoteAsset))    return false;
      if (cfg.blacklist?.includes(t.symbol)) return false;
      if (hasPosition(t.symbol))             return false;
      const vol = parseFloat(t.usdtVol || t.quoteVolume || 0);
      return vol >= minVolUsdt;
    })
    .map(t => {
      const raw = parseFloat(t.change24h || t.priceChangePercent || 0);
      const change24h = Math.abs(raw) < 1.5 && Math.abs(raw) > 0 ? raw * 100 : raw;
      return {
        symbol:    t.symbol,
        change24h,
        lastPrice: parseFloat(t.lastPr || t.last || 0),
        vol24h:    parseFloat(t.usdtVol || t.quoteVolume || 0),
      };
    })
    // Reversal: fokus ke koin yang sedang turun atau sideways (-20% s/d +2%)
    .filter(t => t.change24h >= (reversal.minChange24h ?? -30) && t.change24h <= (reversal.maxChange24h ?? 2))
    .sort((a, b) => a.change24h - b.change24h); // urut dari yang paling turun

  const toCheck = filtered.slice(0, checkLimit);
  log('screener', `Reversal: ${toCheck.length} koin kandidat (turun/sideways) akan diperiksa`);

  const candidates = [];

  for (let i = 0; i < toCheck.length; i++) {
    const coin = toCheck[i];
    const changeStr = coin.change24h >= 0 ? `+${coin.change24h.toFixed(2)}` : coin.change24h.toFixed(2);
    log('screener', `  [R${i + 1}/${toCheck.length}] ${coin.symbol} (${changeStr}%)`);

    try {
      const rawCandles = await getCandles(coin.symbol, '1day', 30);

      if (!Array.isArray(rawCandles) || rawCandles.length < 22) {
        log('screener', `    ↳ Data candle tidak cukup`);
        await sleep(150);
        continue;
      }

      const candles = rawCandles.slice(0, -1).reverse(); // Bitget oldest-first: buang live dulu baru reverse
      const check   = validateReversalSetup(candles, sc);

      if (check.isValid) {
        log('screener', `    ↳ ✅ REVERSAL LOLOS — ${check.reason}`);
        candidates.push({
          symbol:     coin.symbol,
          lastPrice:  coin.lastPrice,
          change24h:  coin.change24h,
          vol24h:     coin.vol24h,
          score:      check.matchCount * 100 + coin.vol24h / 1e6,
          matchCount: check.matchCount,
          strategy:   'reversal',
          signals:    check.signals,
        });

        if (candidates.length >= maxBuy) {
          log('screener', `  Batas ${maxBuy} kandidat reversal tercapai.`);
          break;
        }
      } else {
        log('screener', `    ↳ ❌ ${check.reason}`);
      }
    } catch (err) {
      log('screener_error', `Reversal error ${coin.symbol}: ${err.message}`);
    }

    await sleep(200);
  }

  log('screener', `Reversal Hunter selesai → ${candidates.length} kandidat`);
  return candidates;
}
