/**
 * Bitget Spot Trading Bot v3.2 — Gainer UTBot Pipeline
 * Entry point utama
 *
 * Screener aktif:
 *  1. Gainer ≥5% → UT Bot Alert pipeline (cron per jam atau manual)
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const dotenv  = require('dotenv');
dotenv.config();

import cron     from 'node-cron';
import readline from 'readline';
import { log }                from './logger.js';
import { config }             from './config.js';
import { testConnection, getCurrentPrice, getAllTickers } from './bitget.js';
import { runGainerScreening }           from './screenerGainer.js';
import { runUTBotScreener }             from './screenerUTBot.js';
import { runGainerUTBotPipeline }       from './screenerGainerUTBot.js';
import { runManagementCycle }           from './manager.js';
import { executeBuy }                   from './executor.js';
import { getStats, getOpenSymbols, getAllPositions, initState } from './state.js';
import {
  notifyStartup, notifyBuy, notifySell,
  notifyScreening, notifyApprovalRequest,
  notifyStats, notifyError, notifyUTBot, isEnabled,
} from './telegram.js';
import { startTelegramPolling, stopTelegramPolling } from './telegramCommands.js';
import { startApiServer } from './apiServer.js';
import {
  addToQueue, setCallbacks, getPendingQueue,
  approveCandidate, skipCandidate,
} from './approvalQueue.js';

const isDryRun = process.env.DRY_RUN === 'true';
const args     = process.argv.slice(2);

let _utbotBusy  = false;
let _manageBusy = false;
let _cronTasks  = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function intervalToCron(minutes) {
  if (minutes <= 0) minutes = 60;
  if (minutes < 60) return `*/${minutes} * * * *`;
  if (minutes === 60) return `0 * * * *`;
  const hours = Math.floor(minutes / 60);
  return `0 */${hours} * * *`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SPLIT ENTRY HELPERS
// ─────────────────────────────────────────────────────────────────────────────
async function executeBuyEntry1(candidate) {
  const maxPos = config.trading.maxOpenPositions;
  const open   = getOpenSymbols().length;
  if (open >= maxPos) {
    await notifyError(`⚠️ Slot penuh (${open}/${maxPos}). <b>${candidate.symbol}</b> tidak bisa dibeli.\n\nTunggu posisi lain closing.`);
    return;
  }
  const pct1    = (config.trading.splitEntry?.portion1Pct ?? 55) / 100;
  const budget1 = config.trading.budgetPerTrade * pct1;
  const result  = await executeBuy({ ...candidate, budget: budget1, entryPortion: 1 });
  if (result.success) {
    await notifyBuy({ symbol: candidate.symbol, price: result.entryPrice, quantity: result.quantity, budget: budget1, score: candidate.score, signals: candidate.signals, slPrice: candidate.slPrice, entryPortion: 1, zones: candidate.zones, strategy: candidate.strategy, change24h: candidate.change24h });
  } else {
    await notifyError(`Buy Entry1 ${candidate.symbol} gagal: ${result.error}`);
  }
}

async function executeBuyEntry2(candidate) {
  const pct2    = (config.trading.splitEntry?.portion2Pct ?? 45) / 100;
  const budget2 = config.trading.budgetPerTrade * pct2;
  const result  = await executeBuy({ ...candidate, budget: budget2, entryPortion: 2 });
  if (result.success) {
    await notifyBuy({ symbol: candidate.symbol, price: result.entryPrice, quantity: result.quantity, budget: budget2, score: candidate.score, signals: candidate.signals, slPrice: candidate.slPrice, entryPortion: 2, zones: candidate.zones, strategy: candidate.strategy, change24h: candidate.change24h });
  } else {
    await notifyError(`Buy Entry2 ${candidate.symbol} gagal: ${result.error}`);
  }
}

async function executeBuyAll(candidate) {
  const maxPos = config.trading.maxOpenPositions;
  const open   = getOpenSymbols().length;
  if (open >= maxPos) { await notifyError(`Slot penuh (${open}/${maxPos}). ${candidate.symbol} dilewati.`); return; }
  const result = await executeBuy({ ...candidate, entryPortion: 'all' });
  if (result.success) {
    await notifyBuy({ symbol: candidate.symbol, price: result.entryPrice, quantity: result.quantity, budget: config.trading.budgetPerTrade, score: candidate.score, signals: candidate.signals, slPrice: candidate.slPrice, entryPortion: 'all', zones: candidate.zones, strategy: candidate.strategy, change24h: candidate.change24h });
  } else {
    await notifyError(`Buy ALL ${candidate.symbol} gagal: ${result.error}`);
  }
}

setCallbacks({
  onApprove: executeBuyEntry1,
  onExpire:  (symbol) => notifyError(`⏰ Konfirmasi ${symbol} expired, dilewati.`),
});

export { executeBuyEntry2, executeBuyAll };

async function sendApprovalRequests(candidates) {
  const timeoutMin = config.trading.approvalTimeoutMin ?? 60;
  for (const candidate of candidates) {
    const added = addToQueue(candidate, timeoutMin);
    if (added) await notifyApprovalRequest({ candidate, timeoutMin });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GAINER + UTBOT PIPELINE
// ─────────────────────────────────────────────────────────────────────────────
export async function doGainerUTBotScreening() {
  if (_utbotBusy) { log('cron', 'Gainer/UTBot masih berjalan, skip'); return []; }
  _utbotBusy = true;
  try {
    const open     = getOpenSymbols().length;
    const max      = config.trading.maxOpenPositions;
    const slotLeft = max - open;

    if (slotLeft <= 0) {
      log('screener', `Skip Gainer+UTBot: posisi penuh (${open}/${max})`);
      await notifyError(`📡 Gainer+UTBot: slot posisi penuh (${open}/${max})`);
      return [];
    }

    log('screener', '🚀📡 Menjalankan Gainer ≥5% → UT Bot Pipeline...');
    const candidates = await runGainerUTBotPipeline();

    if (!candidates.length) {
      await notifyScreening({ found: 0, total: 0, symbols: [], strategy: 'Gainer ≥5% + UT Bot' });
      return [];
    }

    await notifyScreening({
      found:    candidates.length,
      total:    0,
      symbols:  candidates.map(c => c.symbol),
      strategy: 'Gainer ≥5% + UT Bot',
    });

    const eligible   = candidates.filter(c => !c.hasPosition).slice(0, slotLeft);
    const hasPosList = candidates.filter(c => c.hasPosition);

    if (hasPosList.length > 0) {
      log('screener', `  Skip ${hasPosList.length} koin (sudah punya posisi): ${hasPosList.map(c => c.symbol).join(', ')}`);
    }

    if (eligible.length > 0) {
      log('screener', `  ${eligible.length} kandidat → approval queue`);
      await notifyUTBot(eligible);
      await sendApprovalRequests(eligible);
    }

    return candidates;
  } catch (err) {
    log('cron_error', `Gainer+UTBot error: ${err.message}`);
    await notifyError(`Gainer+UTBot error: ${err.message}`);
    return [];
  } finally {
    _utbotBusy = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UTBOT STANDALONE (untuk command /utbot manual)
// ─────────────────────────────────────────────────────────────────────────────
export async function doUTBotScreener() {
  if (_utbotBusy) { log('cron', 'UTBot masih berjalan, skip'); return []; }
  _utbotBusy = true;
  try {
    const tickers = await getAllTickers();
    const signals = await runUTBotScreener(tickers);

    const eligible = signals.filter(s => !s.hasPosition);
    const skipped  = signals.filter(s => s.hasPosition);

    if (skipped.length > 0) log('utbot', `  Skip ${skipped.length} (posisi open): ${skipped.map(s => s.symbol).join(', ')}`);

    if (eligible.length > 0) {
      const openCount  = getOpenSymbols().length;
      const maxPos     = config.trading.maxOpenPositions;
      const slotLeft   = maxPos - openCount;
      if (slotLeft <= 0) {
        await notifyError(`📡 UT Bot: ${eligible.length} BUY signal tapi slot penuh (${openCount}/${maxPos})`);
      } else {
        const toQueue    = eligible.slice(0, slotLeft);
        const timeoutMin = config.trading.approvalTimeoutMin ?? 60;
        await notifyUTBot(signals);
        for (const s of toQueue) {
          const added = addToQueue(s, timeoutMin);
          if (added) await notifyApprovalRequest({ candidate: s, timeoutMin });
        }
      }
    } else if (signals.length > 0) {
      await notifyUTBot(signals);
    } else {
      log('utbot', '  Tidak ada sinyal UTBot saat ini');
    }
    return signals;
  } catch (err) {
    log('cron_error', `UTBot error: ${err.message}`);
    return [];
  } finally {
    _utbotBusy = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GAINER ONLY (untuk command /gainer manual — tampilkan list saja)
// ─────────────────────────────────────────────────────────────────────────────
export async function doGainerScreening() {
  if (_utbotBusy) { log('cron', 'Screening masih berjalan, skip'); return []; }
  _utbotBusy = true;
  try {
    const gainers = await runGainerScreening();
    await notifyScreening({ found: gainers.length, total: 0, symbols: gainers.map(g => g.symbol), strategy: 'Gainer ≥5% (list)' });
    return gainers;
  } catch (err) {
    log('cron_error', `Gainer error: ${err.message}`);
    return [];
  } finally {
    _utbotBusy = false;
  }
}

export async function doScreening() {
  log('screener', '🔍 Menjalankan Gainer+UTBot...');
  return await doGainerUTBotScreening();
}

// ─────────────────────────────────────────────────────────────────────────────
// MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
export async function doManagement() {
  if (_manageBusy) { log('cron', 'Management masih berjalan, skip'); return; }
  _manageBusy = true;
  try {
    await runManagementCycle();
  } catch (err) {
    log('cron_error', `Management error: ${err.message}`);
    await notifyError(`Management error: ${err.message}`);
  } finally {
    _manageBusy = false;
  }
}

export { approveCandidate, skipCandidate, getPendingQueue };

// ─────────────────────────────────────────────────────────────────────────────
// CRON
// ─────────────────────────────────────────────────────────────────────────────
function startCron() {
  stopCron();

  const manageMin = config.schedule?.managementIntervalMin    ?? 5;
  const utbotMin  = config.screening?.utbot?.checkIntervalMin ?? 60;

  const cronManage = intervalToCron(manageMin);
  const cronUtbot  = intervalToCron(utbotMin);

  log('cron', `Cron aktif:`);
  log('cron', `  Gainer+UTBot: ${cronUtbot} → setiap ${utbotMin} menit`);
  log('cron', `  Management  : ${cronManage} → setiap ${manageMin} menit`);

  const manageTask = cron.schedule(cronManage, doManagement);

  const utbotTask = cron.schedule(cronUtbot, () => {
    log('cron', `🚀📡 Gainer+UTBot pipeline (setiap ${utbotMin} menit)`);
    doGainerUTBotScreening();
  });

  _cronTasks = [manageTask, utbotTask];
}

function stopCron() {
  _cronTasks.forEach(t => t.stop());
  _cronTasks = [];
  stopTelegramPolling();
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS DISPLAY
// ─────────────────────────────────────────────────────────────────────────────
async function showStatus() {
  const stats     = getStats();
  const positions = getAllPositions();
  const pending   = getPendingQueue();

  console.log('\n══════════════════════════════════════');
  console.log('  📊 STATUS BOT v3.2');
  console.log('══════════════════════════════════════');
  console.log(`  Mode     : ${isDryRun ? '🧪 DRY RUN' : '💸 LIVE'}`);
  console.log(`  Open Pos : ${stats.openPositions}/${config.trading.maxOpenPositions}`);
  console.log(`  Closed   : ${stats.closedCount}`);
  console.log(`  Total PnL: ${stats.totalPnlUsdt >= 0 ? '+' : ''}${stats.totalPnlUsdt?.toFixed(2)} USDT`);

  if (pending.length > 0) {
    console.log(`\n  ⏳ Menunggu Approval (${pending.length}):`);
    for (const p of pending) {
      const triggered = p.candidate.triggered ? '⚡ TRIGGERED' : '⏳ pre-alert';
      const strat     = p.candidate.strategy === 'gainerUTBot' ? '[Gainer+UTBot]' : '[UTBot]';
      console.log(`    ${strat} ${p.symbol} — sisa ${p.minsLeft} menit [${triggered}]`);
    }
  }

  if (stats.openPositions > 0) {
    console.log('\n  Posisi Terbuka:');
    for (const [symbol, pos] of Object.entries(positions)) {
      const currentPrice = await getCurrentPrice(symbol).catch(() => null);
      const hasDoneTP1   = pos.partialSells?.some(ps => ps.reason === 'tp1_partial');
      if (currentPrice) {
        const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        const sign   = pnlPct >= 0 ? '+' : '';
        const flags  = [hasDoneTP1 ? 'BEP' : '', pos.trailingActive ? 'TRAIL' : ''].filter(Boolean).join('|');
        console.log(`    ${symbol.padEnd(12)} entry=${pos.entryPrice} now=${currentPrice} PnL=${sign}${pnlPct.toFixed(2)}% [${flags || 'active'}]`);
      } else {
        console.log(`    ${symbol.padEnd(12)} entry=${pos.entryPrice}`);
      }
    }
  }
  console.log('══════════════════════════════════════\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// REPL
// ─────────────────────────────────────────────────────────────────────────────
function startREPL() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '\n[bitget-bot v3.2] > ' });
  console.log('\n📖 Perintah: status | gainer | utbot | pipeline | screen | manage | stats | stop | help\n');
  rl.prompt();

  rl.on('line', async (line) => {
    const cmd = line.trim().toLowerCase();
    if (!cmd) { rl.prompt(); return; }
    switch (cmd) {
      case 'status':   await showStatus(); break;
      case 'gainer':   await doGainerScreening(); break;
      case 'utbot':    await doUTBotScreener(); break;
      case 'pipeline': await doGainerUTBotScreening(); break;
      case 'screen':   await doScreening(); break;
      case 'manage':   await doManagement(); break;
      case 'stats':    await notifyStats(getStats()); console.log('📊 Stats dikirim ke Telegram'); break;
      case 'stop':     console.log('🛑 Menghentikan bot...'); stopCron(); process.exit(0); break;
      case 'help':
        console.log([
          '',
          '  status   — posisi terbuka & PnL',
          '  gainer   — tampilkan koin gainer ≥5%',
          '  utbot    — UT Bot Alert screener standalone',
          '  pipeline — Gainer ≥5% → UTBot (pipeline utama)',
          '  screen   — jalankan pipeline sekarang',
          '  manage   — cek TP/SL semua posisi',
          '  stats    — kirim ringkasan ke Telegram',
          '  stop     — hentikan bot',
          '',
        ].join('\n')); break;
      default: console.log(`❓ Perintah tidak dikenal: "${cmd}". Ketik "help".`);
    }
    rl.prompt();
  });

  rl.on('close', () => process.exit(0));
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Bitget Spot Bot v3.2 — Gainer UTBot Pipeline    ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Mode: ${isDryRun ? '🧪 DRY RUN' : '💸 LIVE TRADING'}`);
  console.log('');

  if (!isDryRun) {
    log('startup', 'Mengecek koneksi Bitget API...');
    const conn = await testConnection();
    if (!conn.ok) { log('startup_error', `Koneksi API gagal: ${conn.error}`); process.exit(1); }
    log('startup', `✅ Koneksi OK | ${conn.assets} aset ditemukan`);
  } else {
    log('startup', '🧪 DRY RUN mode - API connection skipped');
  }

  const cfg       = config;
  const pct1      = cfg.trading.splitEntry?.portion1Pct ?? 55;
  const pct2      = cfg.trading.splitEntry?.portion2Pct ?? 45;
  const manageMin = cfg.schedule?.managementIntervalMin ?? 5;
  const utbotMin  = cfg.screening?.utbot?.checkIntervalMin ?? 60;

  log('startup', `Config:`);
  log('startup', `  Budget/trade : ${cfg.trading.budgetPerTrade} USDT (E1 ${pct1}%: ${(cfg.trading.budgetPerTrade * pct1 / 100).toFixed(0)}, E2 ${pct2}%: ${(cfg.trading.budgetPerTrade * pct2 / 100).toFixed(0)})`);
  log('startup', `  Max posisi   : ${cfg.trading.maxOpenPositions}`);
  log('startup', `  Min gainer   : ${cfg.screening?.gainer?.minGainPct ?? 5}%`);
  log('startup', `Jadwal:`);
  log('startup', `  Gainer+UTBot : setiap ${utbotMin} menit`);
  log('startup', `  Management   : setiap ${manageMin} menit`);

  await notifyStartup(isDryRun, config);

  if (args.includes('--manage-only'))   { await doManagement(); process.exit(0); }
  if (args.includes('--pipeline-only')) { await doGainerUTBotScreening(); process.exit(0); }
  if (args.includes('--utbot-only'))    { await doUTBotScreener(); process.exit(0); }

  await initState();

  log('startup', 'Menjalankan management cycle pertama...');
  await doManagement();

  startCron();

  const approveEntry2Fn = (symbol) => {
    const q    = getPendingQueue();
    const item = q.find(p => p.symbol === symbol);
    if (!item) return { ok: false, reason: `${symbol} tidak ada di queue` };
    return executeBuyEntry2(item.candidate).then(() => ({ ok: true }));
  };

  const approveAllFn = (symbol) => {
    const q    = getPendingQueue();
    const item = q.find(p => p.symbol === symbol);
    if (!item) return { ok: false, reason: `${symbol} tidak ada di queue` };
    return executeBuyAll(item.candidate).then(() => ({ ok: true }));
  };

  startTelegramPolling({
    doScreening:            doScreening,
    doGainerScreening,
    doUTBotScreener,
    doGainerUTBotScreening,
    doManagement,
    approveCandidate,
    approveEntry2:  approveEntry2Fn,
    approveAll:     approveAllFn,
    skipCandidate,
    getPendingQueue,
    getAllPositions,
    getCurrentPrice,
    stopBot: () => { stopCron(); process.exit(0); },
  });

  startApiServer({
    doGainerScreening,
    doUTBotScreener,
    doGainerUTBotScreening,
    doScreening,
    doManagement,
    approveCandidate,
    approveEntry2:  approveEntry2Fn,
    approveAll:     approveAllFn,
    skipCandidate,
    getPendingQueue,
    getAllPositions,
    getCurrentPrice,
    executeBuyManual: async (symbol, opts = {}) => {
      const { executeBuy } = await import('./executor.js');
      const { split, slPrice, tp1Price, budget } = opts;
      const baseBudget  = budget || config.trading.budgetPerTrade;
      const p1 = (config.trading.splitEntry?.portion1Pct ?? 55) / 100;
      const p2 = (config.trading.splitEntry?.portion2Pct ?? 45) / 100;
      const finalBudget = split === 'entry1' ? baseBudget * p1 : split === 'entry2' ? baseBudget * p2 : baseBudget;
      return executeBuy({ symbol, score: 0, signals: {}, strategy: 'manual', budget: finalBudget, entryPortion: split === 'entry1' ? 1 : split === 'entry2' ? 2 : 'all', slPrice: slPrice || null, tp1Price: tp1Price || null });
    },
    executeSellManual: async (symbol, opts = {}) => {
      const { executeSell, executePartialSell } = await import('./executor.js');
      const pos = getAllPositions()[symbol];
      if (!pos) return { ok: false, error: 'Posisi tidak ditemukan' };
      const sellPct = opts.sellPct ?? 100;
      if (sellPct < 100) return executePartialSell(symbol, { sellPct, reason: 'manual_partial', position: pos });
      return executeSell(symbol, { quantity: pos.quantity, reason: 'manual_sell', position: pos });
    },
  });

  if (process.stdin.isTTY) {
    startREPL();
  } else {
    log('startup', 'Non-TTY mode - berjalan sebagai daemon');
  }
}

main().catch(err => { log('fatal', err.message); process.exit(1); });
