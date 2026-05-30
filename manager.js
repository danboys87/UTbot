/**
 * Manager — SOP Multi-Timeframe Smart Money
 *
 * TP/SL Logic (sesuai SOP):
 *  SL   : Di bawah swing low / bottom demand zone - 0.5% buffer
 *         → TIDAK boleh dipindah atau averaging down
 *  TP1  : Nearest resistance / swing high → tutup 50% posisi → pindah SL ke BEP
 *  TP2+ : Aktivasi Dynamic Trailing Stop 1.5% callback → biarkan profit berlari
 */

import { getCurrentPrice }  from './bitget.js';
import { config }           from './config.js';
import { log }              from './logger.js';
import {
  getAllPositions,
  getOpenSymbols,
  updatePeakPrice,
  activateTrailing,
} from './state.js';
import { executeSell, executePartialSell } from './executor.js';
import { notifySell }       from './telegram.js';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Hitung effective SL untuk posisi
// Setelah TP1 hit → SL bergeser ke BEP (entryPrice)
// ─────────────────────────────────────────────────────────────────────────────
function getEffectiveSL(position, mgmt) {
  const hasDoneTP1 = position.partialSells?.some(ps => ps.reason === 'tp1_partial');

  if (hasDoneTP1) {
    // SL sudah di BEP setelah TP1
    return position.entryPrice * (1 - 0.001); // BEP - 0.1% buffer kecil
  }

  // Trailing aktif sebelum TP1 → SL geser ke BEP
  if (position.trailingActive) {
    return position.entryPrice * (1 - 0.001); // BEP - 0.1% buffer
  }

  // SL awal: dari slPrice yang di-set saat screening, atau fallback ke config
  if (position.slPrice && position.slPrice > 0) {
    return position.slPrice;
  }

  // Fallback ke config stopLossPct
  const slPct = Math.abs(mgmt.stopLossPct ?? 4);
  return position.entryPrice * (1 - slPct / 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// Estimasi TP1 (nearest resistance)
// Jika tidak ada data resistance → gunakan risk:reward 1:2 dari entry-SL distance
// ─────────────────────────────────────────────────────────────────────────────
function getTP1Price(position, effectiveSL) {
  // Jika ada tp1Price yang disimpan saat approval
  if (position.tp1Price && position.tp1Price > 0) {
    return position.tp1Price;
  }

  // Fallback: RR 1:2 dari distance entry-SL
  const riskPerUnit = position.entryPrice - effectiveSL;
  const minRR = config.management?.minRiskReward ?? 2;
  return position.entryPrice + riskPerUnit * minRR;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluasi satu posisi
// ─────────────────────────────────────────────────────────────────────────────
async function evaluatePosition(symbol, position) {
  const mgmt = config.management;

  const currentPrice = await getCurrentPrice(symbol);
  if (!currentPrice) {
    log('manager_warn', `Tidak bisa ambil harga ${symbol}, skip`);
    return;
  }

  const pnlPct    = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  const holdHours = (Date.now() - new Date(position.openedAt).getTime()) / 3_600_000;
  const hasDoneTP1 = position.partialSells?.some(ps => ps.reason === 'tp1_partial');

  log('manager',
    `${symbol} | price=${currentPrice} entry=${position.entryPrice} ` +
    `PnL=${pnlPct.toFixed(2)}% | hold=${holdHours.toFixed(1)}h | ` +
    `TP1=${hasDoneTP1 ? 'DONE' : 'pending'} | trailing=${position.trailingActive ? 'ON' : 'off'}`
  );

  // ── Effective SL (BEP setelah TP1, original sebelumnya) ──────────────────
  const effectiveSL = getEffectiveSL(position, mgmt);
  const effectiveSLPct = ((effectiveSL - position.entryPrice) / position.entryPrice) * 100;

  // ── 1. Stop Loss ──────────────────────────────────────────────────────────
  if (currentPrice <= effectiveSL) {
    const slLabel = hasDoneTP1 ? 'Break Even' : 'Stop Loss';
    log('manager', `🛑 ${slLabel} hit: ${symbol} | price=${currentPrice} SL=${effectiveSL.toFixed(6)}`);

    const result = await executeSell(symbol, {
      quantity: position.quantity,
      reason:   hasDoneTP1 ? 'break_even_sl' : 'stop_loss',
      position,
    });

    if (result.success) {
      await notifySell({
        symbol,
        entryPrice: position.entryPrice,
        exitPrice:  result.exitPrice,
        pnlPct:     result.pnlPct,
        pnlUsdt:    result.pnlUsdt,
        reason:     hasDoneTP1 ? 'break_even_sl' : 'stop_loss',
      });
    }
    return;
  }

  // ── 2. TP1: Tutup 50% posisi → geser SL ke BEP ───────────────────────────
  if (!hasDoneTP1) {
    const tp1Price = getTP1Price(position, effectiveSL);
    const tp1Pct   = ((tp1Price - position.entryPrice) / position.entryPrice) * 100;

    if (currentPrice >= tp1Price) {
      log('manager', `🎯 TP1 hit: ${symbol} | price=${currentPrice} TP1=${tp1Price.toFixed(6)} | Jual 50%, geser SL ke BEP`);

      const result = await executePartialSell(symbol, {
        sellPct:  50,
        reason:   'tp1_partial',
        position,
      });

      if (result.success) {
        // Simpan info BEP ke position (via recordPartialSell sudah update quantity)
        // Flag BEP akan dideteksi oleh getEffectiveSL → hasDoneTP1 = true
        log('manager', `✅ TP1 done: ${symbol} | SL otomatis bergeser ke BEP ${position.entryPrice}`);

        await notifySell({
          symbol,
          entryPrice: position.entryPrice,
          exitPrice:  result.exitPrice,
          pnlPct:     ((result.exitPrice - position.entryPrice) / position.entryPrice) * 100,
          pnlUsdt:    (result.exitPrice - position.entryPrice) * result.qty,
          reason:     'tp1_partial',
        });

        // Aktifkan trailing untuk sisa 50%
        activateTrailing(symbol);
        log('manager', `🔻 Trailing Stop aktif untuk sisa posisi ${symbol}`);
      }
      return;
    }
  }

  // ── 3. Aktifkan Trailing jika profit >= activateAtProfitPct ─────────────────
  const activateAtPct = mgmt.trailingStop?.activateAtProfitPct ?? 4;
  if (!position.trailingActive && !hasDoneTP1 && pnlPct >= activateAtPct) {
    log('manager', `🔻 Trailing aktif: ${symbol} | PnL=${pnlPct.toFixed(2)}% >= ${activateAtPct}% threshold | SL geser ke BEP`);
    activateTrailing(symbol);
  }

  // ── 4. Dynamic Trailing Stop ──────────────────────────────────────────────
  if (hasDoneTP1 || position.trailingActive) {
    const ts = mgmt.trailingStop;

    // Update peak price
    updatePeakPrice(symbol, currentPrice);

    // Baca posisi terbaru setelah update peak
    const allPos = getAllPositions();
    const pos    = allPos[symbol];
    if (!pos) return;

    if (pos.trailingActive) {
      const trailPct      = ts?.trailPct ?? 1.5; // SOP: 1.5% callback
      const dropFromPeak  = ((pos.peakPrice - currentPrice) / pos.peakPrice) * 100;

      if (dropFromPeak >= trailPct) {
        log('manager',
          `🔻 Trailing Stop: ${symbol} | drop ${dropFromPeak.toFixed(2)}% dari peak ${pos.peakPrice} ` +
          `(callback ${trailPct}%)`
        );

        const result = await executeSell(symbol, {
          quantity: pos.quantity,
          reason:   'trailing_stop',
          position: pos,
        });

        if (result.success) {
          await notifySell({
            symbol,
            entryPrice: pos.entryPrice,
            exitPrice:  result.exitPrice,
            pnlPct:     result.pnlPct,
            pnlUsdt:    result.pnlUsdt,
            reason:     'trailing_stop',
          });
        }
        return;
      }

      log('manager',
        `  Trailing aktif: peak=${pos.peakPrice} | drop=${dropFromPeak.toFixed(2)}% ` +
        `| trigger at ${trailPct}%`
      );
    } else {
      // Aktifkan trailing segera setelah TP1 done
      activateTrailing(symbol);
    }
  }

  // ── 4. Max Hold Time (safety net) ────────────────────────────────────────
  const maxHold = mgmt.maxHoldHours ?? 72;
  if (holdHours >= maxHold) {
    log('manager', `⏰ Max hold: ${symbol} sudah ${holdHours.toFixed(1)} jam`);

    const result = await executeSell(symbol, {
      quantity: position.quantity,
      reason:   'max_hold_time',
      position,
    });

    if (result.success) {
      await notifySell({
        symbol,
        entryPrice: position.entryPrice,
        exitPrice:  result.exitPrice,
        pnlPct:     result.pnlPct,
        pnlUsdt:    result.pnlUsdt,
        reason:     'max_hold_time',
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main management cycle
// ─────────────────────────────────────────────────────────────────────────────
export async function runManagementCycle() {
  const symbols = getOpenSymbols();

  if (symbols.length === 0) {
    log('manager', 'Tidak ada posisi terbuka');
    return;
  }

  log('manager', `Mengevaluasi ${symbols.length} posisi (SOP MTF)...`);
  const positions = getAllPositions();

  for (const symbol of symbols) {
    const position = positions[symbol];
    if (!position) continue;

    try {
      await evaluatePosition(symbol, position);
    } catch (err) {
      log('manager_error', `Error evaluasi ${symbol}: ${err.message}`);
    }

    await sleep(300);
  }

  log('manager', 'Siklus management selesai');
}
