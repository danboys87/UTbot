/**
 * Screener — Daily Gainer Setup
 * Dijalankan jam 07:30 WIB setelah candle daily close.
 *
 * Kriteria (semua 4 harus terpenuhi):
 *  1. Candle kemarin HIJAU (bullish)
 *  2. Sumbu atas kecil (≤ upperWickMaxPct)
 *  3. Close kemarin > High dua hari lalu (breakout)
 *  4. Volume kemarin > rata-rata 5 hari sebelumnya
 */

import { getAllTickers, getCandles } from './bitget.js';
import { config }                    from './config.js';
import { log }                       from './logger.js';
import { hasPosition }               from './state.js';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function validateDailySetup(candles, sc) {
  if (!candles || candles.length < 7) {
    return { isValid: false, reason: 'Data candle kurang (minimal 7 hari)' };
  }

  const yesterday  = candles[candles.length - 2];
  const twoDaysAgo = candles[candles.length - 3];

  const open     = parseFloat(yesterday[1]);
  const high     = parseFloat(yesterday[2]);
  const low      = parseFloat(yesterday[3]);
  const close    = parseFloat(yesterday[4]);
  const vol      = parseFloat(yesterday[5]);
  const prevHigh = parseFloat(twoDaysAgo[2]);

  if (close <= open)
    return { isValid: false, reason: 'Bukan candle hijau (bearish/doji)' };

  const totalRange      = high - low;
  const upperWick       = high - close;
  const upperWickMaxPct = sc.upperWickMaxPct ?? 0.25;
  if (totalRange > 0 && (upperWick / totalRange) > upperWickMaxPct)
    return { isValid: false, reason: `Sumbu atas ${(upperWick / totalRange * 100).toFixed(1)}% > batas ${upperWickMaxPct * 100}%` };

  if (close <= prevHigh)
    return { isValid: false, reason: `Close (${close}) tidak menembus prevHigh (${prevHigh})` };

  const prev5  = candles.slice(candles.length - 7, candles.length - 2);
  const avgVol = prev5.reduce((s, c) => s + parseFloat(c[5]), 0) / 5;
  if (vol <= avgVol)
    return { isValid: false, reason: `Volume (${vol.toFixed(0)}) ≤ avg5 (${avgVol.toFixed(0)})` };

  return {
    isValid: true,
    reason:  'Semua 4 kriteria terpenuhi',
    detail:  { open, high, low, close, vol, prevHigh, avgVol },
  };
}

export async function runDailyGainerScreening() {
  const cfg        = config;
  const sc         = cfg.screening;
  const quoteAsset = cfg.trading.quoteAsset || 'USDT';

  log('screener', '══ Daily Gainer Screening mulai ══');

  let tickers;
  try {
    tickers = await getAllTickers();
  } catch (err) {
    log('screener_error', `Gagal ambil ticker: ${err.message}`);
    return [];
  }

  const minVolUsdt = sc.minVolume24h ?? 100000;
  const checkLimit = Math.min(sc.gainersCheckLimit ?? 50, 200);
  const maxBuy     = sc.topCandidatesLimit ?? 2;

  const ranked = tickers
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
    .filter(t =>
      t.change24h >= (sc.minPriceChangeThreshold ?? 2) &&
      t.change24h <= (sc.maxPriceChangeThreshold ?? 50)
    )
    .sort((a, b) => b.change24h - a.change24h);

  const toCheck    = ranked.slice(0, checkLimit);
  const candidates = [];

  log('screener', `Memeriksa ${toCheck.length} top gainer...`);

  for (let i = 0; i < toCheck.length; i++) {
    const coin = toCheck[i];
    log('screener', `  [G${i + 1}/${toCheck.length}] ${coin.symbol} (+${coin.change24h.toFixed(2)}%)`);

    try {
      const rawCandles = await getCandles(coin.symbol, '1day', 30);
      if (!Array.isArray(rawCandles) || rawCandles.length < 7) {
        await sleep(150); continue;
      }

      const candles = rawCandles.slice(0, -1).reverse(); // Bitget oldest-first: buang live dulu baru reverse
      const check   = validateDailySetup(candles, sc);

      if (check.isValid) {
        log('screener', `    ↳ ✅ LOLOS — ${check.reason}`);
        const d = check.detail;
        candidates.push({
          symbol:     coin.symbol,
          lastPrice:  coin.lastPrice,
          change24h:  coin.change24h,
          vol24h:     coin.vol24h,
          score:      coin.change24h + (coin.vol24h / 1e6) * 0.1,
          matchCount: 4,
          strategy:   'dailyGainer',
          signals: {
            bullishCandle:  { bullish: true, label: `Candle hijau (O:${d.open} C:${d.close})` },
            smallUpperWick: { bullish: true, label: 'Sumbu atas kecil' },
            breakoutClose:  { bullish: true, label: `Close ${d.close} > prevHigh ${d.prevHigh}` },
            volumeSurge:    { bullish: true, label: `Vol ${d.vol?.toFixed(0)} > avg5 ${d.avgVol?.toFixed(0)}` },
          },
        });
        if (candidates.length >= maxBuy) break;
      } else {
        log('screener', `    ↳ ❌ ${check.reason}`);
      }
    } catch (err) {
      log('screener_error', `${coin.symbol}: ${err.message}`);
    }

    await sleep(250);
  }

  log('screener', `Daily Gainer selesai → ${candidates.length} kandidat`);
  return candidates;
}
