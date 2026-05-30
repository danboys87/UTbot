// ─────────────────────────────────────────────────────────────────────────────
// PATCH: Ganti fungsi doUTBotScreener() yang lama di index.js
// dengan versi baru ini (Opsi B — masuk approval queue)
// ─────────────────────────────────────────────────────────────────────────────

export async function doUTBotScreener() {
  if (_screenBusy) { log('cron', 'Screening masih berjalan, skip UTBot'); return []; }
  _screenBusy = true;
  try {
    const tickers = await getAllTickers();
    const signals = await runUTBotScreener(tickers);

    // Pisahkan BUY dan SELL
    const buySignals  = signals.filter(s => s.signal === 'BUY');
    const sellSignals = signals.filter(s => s.signal === 'SELL');

    // ── BUY signal → approval queue ──────────────────────────────────────
    if (buySignals.length > 0) {
      const eligible = buySignals.filter(s => !s.hasPosition);
      const skipped  = buySignals.filter(s => s.hasPosition);

      if (skipped.length > 0) {
        log('utbot', `  Skip ${skipped.length} BUY (sudah punya posisi): ${skipped.map(s=>s.symbol).join(', ')}`);
      }

      if (eligible.length > 0) {
        // Cek slot posisi
        const openCount = getOpenSymbols().length;
        const maxPos    = config.trading.maxOpenPositions;
        const slotLeft  = maxPos - openCount;

        if (slotLeft <= 0) {
          log('utbot', `  Slot penuh (${openCount}/${maxPos}), UTBot BUY tidak masuk queue`);
          await notifyError(`📡 UT Bot: ${eligible.length} BUY signal tapi slot posisi penuh (${openCount}/${maxPos})`);
        } else {
          const toQueue = eligible.slice(0, slotLeft);
          log('utbot', `  ${toQueue.length} BUY signal → approval queue`);

          // Kirim notif UTBot ringkas dulu
          await notifyUTBot(signals);

          // Masukkan ke approval queue
          const timeoutMin = config.trading.approvalTimeoutMin ?? 60;
          for (const s of toQueue) {
            const added = addToQueue(s, timeoutMin);
            if (added) {
              await notifyApprovalRequest({ candidate: s, timeoutMin });
            }
          }
        }
      }
    }

    // ── SELL signal → hanya notif, eksekusi via manager ──────────────────
    // Manager yang handle exit — UTBot SELL hanya sebagai info tambahan
    if (sellSignals.length > 0) {
      log('utbot', `  ${sellSignals.length} SELL signal (info saja, manager yang handle exit)`);
      await notifyUTBot(sellSignals);
    }

    return signals;
  } catch (err) {
    log('cron_error', `UTBot screener error: ${err.message}`);
    return [];
  } finally {
    _screenBusy = false;
  }
}
