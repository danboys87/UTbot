/**
 * Pipeline: Daily Gainer ≥10% → UT Bot Alert (1H)
 *
 * Alur:
 *  1. Ambil semua koin yang naik ≥10% dalam 24h (dari runGainerScreening)
 *  2. Dari koin-koin tersebut, cari yang punya BUY signal UT Bot di 1H
 *     dengan konfirmasi close > EMA21 1H
 *  3. Hasilnya: kandidat kuat — sudah momentum (gainer) + entry timing bagus (UTBot)
 */

import { runGainerScreening } from './screenerGainer.js';
import { runUTBotScreener }   from './screenerUTBot.js';
import { log }                from './logger.js';

export async function runGainerUTBotPipeline() {
  log('screener', '══ Gainer ≥10% → UT Bot Pipeline dimulai ══');

  // Step 1: Ambil gainer ≥10%
  const gainers = await runGainerScreening();

  if (!gainers.length) {
    log('screener', 'Pipeline: tidak ada gainer ≥10%, pipeline berhenti.');
    return [];
  }

  log('screener', `Pipeline: ${gainers.length} gainer → scan UT Bot signal...`);

  // Step 2: Jalankan UTBot hanya pada koin-koin gainer
  const signals = await runUTBotScreener(gainers, {
    fromGainer:  true,
    maxSignals:  10, // lebih longgar karena sudah pre-filter gainer
  });

  if (!signals.length) {
    log('screener', 'Pipeline: tidak ada BUY signal UTBot dari gainer list.');
    return [];
  }

  // Enrich dengan info gainer
  const enriched = signals.map(sig => {
    const gainerData = gainers.find(g => g.symbol === sig.symbol);
    return {
      ...sig,
      change24h: gainerData?.change24h ?? sig.change24h,
      vol24h:    gainerData?.vol24h    ?? sig.vol24h,
      // Tambah label gainer ke signals
      signals: {
        ...sig.signals,
        gainerFilter: {
          bullish: true,
          label:   `Gainer 24h: +${(gainerData?.change24h ?? sig.change24h).toFixed(2)}%`,
        },
      },
      matchCount: (sig.matchCount ?? 0) + 1,
      score:      (sig.score ?? 0) + (gainerData?.change24h ?? 0) * 2,
      strategy:   'gainerUTBot',
    };
  });

  // Sort: sinyal terkuat (score tinggi) dulu
  enriched.sort((a, b) => b.score - a.score);

  log('screener', `Pipeline selesai: ${enriched.length} kandidat final`);
  enriched.forEach((c, i) =>
    log('screener', `  [${i+1}] ${c.symbol} | +${c.change24h.toFixed(2)}% | TS=${c.trailingStop?.toFixed(6)}`)
  );

  return enriched;
}
