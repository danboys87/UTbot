/**
 * Screener — Daily Gainer ≥10%
 * Mencari koin spot Bitget yang naik minimal 10% dalam 24 jam.
 *
 * Kriteria:
 *  1. Perubahan harga 24h >= minGainPct (default 10%)
 *  2. Volume 24h >= minVolume24h
 *  3. Belum punya posisi terbuka
 *  4. Tidak di-blacklist
 *
 * Output: array kandidat yang akan di-pipe ke UTBot screener.
 */

import { getAllTickers } from './bitget.js';
import { config }        from './config.js';
import { log }           from './logger.js';
import { hasPosition }   from './state.js';

export async function runGainerScreening() {
  const sc         = config.screening;
  const gainer     = sc.gainer ?? {};
  const quoteAsset = config.trading.quoteAsset || 'USDT';
  const minGainPct = gainer.minGainPct   ?? 10;
  const minVolUsdt = gainer.minVolume24h ?? sc.minVolume24h ?? 2_000_000;
  const maxGainPct = gainer.maxGainPct   ?? 200; // filter pump ekstrem
  const limit      = gainer.checkLimit   ?? 300;

  log('screener', `══ Daily Gainer Screening (≥${minGainPct}%) ══`);

  let tickers;
  try {
    tickers = await getAllTickers();
  } catch (err) {
    log('screener_error', `Gagal ambil ticker: ${err.message}`);
    return [];
  }

  const gainers = tickers
    .filter(t => {
      if (!t.symbol.endsWith(quoteAsset))         return false;
      if (config.blacklist?.includes(t.symbol))   return false;
      if (hasPosition(t.symbol))                  return false;
      if (parseFloat(t.usdtVol || t.quoteVolume || 0) < minVolUsdt) return false;
      return true;
    })
    .map(t => {
      const raw = parseFloat(t.change24h || 0);
      // Bitget kadang kirim desimal (0.15 = 15%), kadang langsung (15)
      const change24h = Math.abs(raw) < 1.5 && Math.abs(raw) > 0 ? raw * 100 : raw;
      return {
        symbol:    t.symbol,
        change24h,
        lastPrice: parseFloat(t.lastPr || t.last || 0),
        vol24h:    parseFloat(t.usdtVol || t.quoteVolume || 0),
      };
    })
    .filter(t => t.change24h >= minGainPct && t.change24h <= maxGainPct)
    .sort((a, b) => b.change24h - a.change24h)
    .slice(0, limit);

  log('screener', `Gainer ≥${minGainPct}%: ${gainers.length} koin ditemukan`);
  gainers.forEach((g, i) =>
    log('screener', `  [G${i+1}] ${g.symbol} +${g.change24h.toFixed(2)}% | Vol $${(g.vol24h/1e6).toFixed(1)}M`)
  );

  return gainers;
}
