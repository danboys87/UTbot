/**
 * Bitget Spot Trading Bot v3.2 — MTF Smart Money + Gainer UTBot Pipeline
 * Entry point utama
 *
 * Screener aktif:
 *  1. MTF Smart Money (cron 07:30 / 13:00 / 19:00 WIB)
 *  2. Gainer ≥10% → UT Bot Alert pipeline (cron per jam atau manual)
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
import { runMTFScreening }              from './screenerMTF.js';
import { runGainerScreening }           from './screenerGainer.js';
import { runUTBotScreener }             from './screenerUTBot.js';
import { runGainerUTBotPipeline }       from './screenerGainerUTBot.js';
import { runManagementCycle }           from './manager.js';
import { executeBuy }                   from './executor.js';
import { getStats, getOpenSymbols, getAllPositions, initState } from './state.js';
import {
  notifyStartup, notifyBuy, notifySell,
  notifyScreening, notifyApprovalRequest,
  notifyPreAlert, notifyStats, notifyError, notifyUTBot, isEnabled,
} from './telegram.js';
import { startTelegramPolling, stopTelegramPolling } from './telegramCommands.js';
import { startApiServer } from './apiServer.js';
import {
  addToQueue, setCallbacks, getPendingQueue,
  approveCandidate, skipCandidate,
} from './approvalQueue.js';

const isDryRun = process.env.DRY_RUN === 'true';
const args     = process.argv.slice(2);

let _screenBusy = false;
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
// MTF SCREENING
// ─────────────────────────────────────────────────────────────────────────────
export async function doMTFScreening() {
  if (_screenBusy) { log('cron', 'Screening masih berjalan, skip'); return []; }
  _screenBusy = true;
  try {
    const open = getOpenSymbols().length;
    const max  = config.trading.maxOpenPositions;
    if (open >= max) { log('screener', `Skip MTF: posisi penuh (${open}/${max})`); return []; }

    log('screener', '🧠 Menjalankan MTF Smart Money Screening...');
    const tickers    = await getAllTickers();
    const candidates = await runMTFScreening(tickers, config);

    await notifyScreening({ found: candidates.length, total: config.screening?.mtf?.checkLimit ?? 100, symbols: candidates.map(c => c.symbol), strategy: 'MTF Smart Money' });

    if (!candidates.length) return [];

    const triggered = candidates.filter(c => c.triggered);
    const preAlert  = candidates.filter(c => !c.triggered);

    if (triggered.length > 0) {
      log('screener', `✅ ${triggered.length} kandidat triggered → approval queue`);
      await sendApprovalRequests(triggered);
    }
    if (preAlert.length > 0) {
      log('screener', `⏳ ${preAlert.length} kandidat pre-alert → notif pantau`);
      await notifyPreAlert(preAlert);
    }
    return candidates;
  } catch (err) {
    log('cron_error', `MTF screening error: ${err.message}`);
    await notifyError(`MTF screening error: ${err.message}`);
    return [];
  } finally {
    _screenBusy = false;
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

    log('screener', '🚀📡 Menjalankan Gainer ≥10% → UT Bot Pipeline...');
    const candidates = await runGainerUTBotPipeline();

    if (!candidates.length) {
      await notifyScreening({ found: 0, total: 0, symbols: [], strategy: 'Gainer ≥10% + UT Bot' });
      return [];
    }

    await notifyScreening({
      found:    candidates.length,
      total:    0,
      symbols:  candidates.map(c => c.symbol),
      strategy: 'Gainer ≥10% + UT Bot',
    });

    const eligible   = candidates.filter(c => !c.hasPosition).slice(0, slotLeft);
    const hasPosList = candidates.filter(c => c.hasPosition);

    if (hasPosList.length > 0) {
      log('screener', `  Skip ${hasPosList.length} koin (sudah punya posisi): ${hasPosList.map(c => c.symbol).join(', ')}`);
    }

    if (eligible.length > 0) {
      log('screener', `  ${eligible.length} kandidat → approval queue`);
      await notifyUTBot(eligible); // kirim ringkasan UTBot dulu
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
  if (_screenBusy) { log('cron', 'Screening masih berjalan, skip'); return []; }
  _screenBusy = true;
  try {
    const gainers = await runGainerScreening();
    await notifyScreening({ found: gainers.length, total: 0, symbols: gainers.map(g => g.symbol), strategy: 'Gainer ≥10% (list)' });
    return gainers;
  } catch (err) {
    log('cron_error', `Gainer error: ${err.message}`);
    return [];
  } finally {
    _screenBusy = false;
  }
}

export async function doScreening() {
  log('screener', '🔍 Menjalankan MTF + Gainer+UTBot...');
  const r1 = await doMTFScreening();
  await sleep(1000);
  const r2 = await doGainerUTBotScreening();
  return [...r1, ...r2];
}

// ─────────────────────────────────────────────────────────────────────────────
// PRE-ALERT RECHECK
// ─────────────────────────────────────────────────────────────────────────────
export async function doPreAlertRecheck() {
  if (_screenBusy) { log('cron', 'Screening masih berjalan, skip pre-alert recheck'); return; }
  const pending   = getPendingQueue();
  const preAlerts = pending.filter(p => !p.candidate.triggered);
  if (!preAlerts.length) { log('cron', '⏳ Pre-alert recheck: tidak ada kandidat'); return; }

  log('cron', `⏳ Pre-alert recheck: ${preAlerts.length} kandidat → ${preAlerts.map(p => p.symbol).join(', ')}`);
  _screenBusy = true;
  try {
    const tickers         = await getAllTickers();
    const preAlertSymbols = preAlerts.map(p => p.symbol);
    const filteredTickers = tickers.filter(t => preAlertSymbols.includes(t.symbol));
    if (!filteredTickers.length) return;

    const candidates   = await runMTFScreening(filteredTickers, config);
    const nowTriggered = candidates.filter(c => c.triggered);
    if (nowTriggered.length > 0) {
      log('cron', `✅ ${nowTriggered.length} pre-alert sekarang TRIGGERED`);
      await sendApprovalRequests(nowTriggered);
    }
  } catch (err) {
    log('cron_error', `Pre-alert recheck error: ${err.message}`);
  } finally {
    _screenBusy = false;
  }
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

  const manageMin   = config.schedule?.managementIntervalMin    ?? 10;
  const preAlertMin = config.schedule?.preAlertRecheckMin       ?? 60;
  const utbotMin    = config.screening?.utbot?.checkIntervalMin ?? 60;
  const mtfCron     = config.schedule?.mtfCron  || '30 0 * * *';
  const mtfCron2    = config.schedule?.mtfCron2 || '0 6 * * *';
  const mtfCron3    = config.schedule?.mtfCron3 || '0 12 * * *';

  const cronManage   = intervalToCron(manageMin);
  const cronPreAlert = intervalToCron(preAlertMin);
  const cronUtbot    = intervalToCron(utbotMin);

  log('cron', `Cron aktif:`);
  log('cron', `  MTF Pagi    : ${mtfCron}  → 07:30 WIB`);
  log('cron', `  MTF Siang   : ${mtfCron2} → 13:00 WIB`);
  log('cron', `  MTF Sore    : ${mtfCron3} → 19:00 WIB`);
  log('cron', `  Gainer+UTBot: ${cronUtbot}     → setiap ${utbotMin} menit`);
  log('cron', `  Pre-alert   : ${cronPreAlert}  → setiap ${preAlertMin} menit`);
  log('cron', `  Management  : ${cronManage}    → setiap ${manageMin} menit`);

  const mtfTask1 = cron.schedule(mtfCron,  () => { log('cron', '🌅 MTF pagi'); doMTFScreening(); },   { timezone: 'UTC' });
  const mtfTask2 = cron.schedule(mtfCron2, () => { log('cron', '☀️  MTF siang'); doMTFScreening(); }, { timezone: 'UTC' });
  const mtfTask3 = cron.schedule(mtfCron3, () => { log('cron', '🌆 MTF sore');  doMTFScreening(); }, { timezone: 'UTC' });

  const manageTask = cron.schedule(cronManage, doManagement);

  const preAlertTask = cron.schedule(cronPreAlert, () => {
    log('cron', `🔄 Pre-alert recheck`);
    doPreAlertRecheck();
  });

  const utbotTask = cron.schedule(cronUtbot, () => {
    log('cron', `🚀📡 Gainer+UTBot pipeline (setiap ${utbotMin} menit)`);
    doGainerUTBotScreening();
  });

  _cronTasks = [mtfTask1, mtfTask2, mtfTask3, manageTask, preAlertTask, utbotTask];
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
      const strat     = p.candidate.strategy === 'gainerUTBot' ? '[Gainer+UTBot]'
                      : p.candidate.strategy === 'utbot'       ? '[UTBot]'
                      :                                          '[MTF]';
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
  console.log('\n📖 Perintah: status | mtf | gainer | utbot | pipeline | screen | manage | stats | stop | help\n');
  rl.prompt();

  rl.on('line', async (line) => {
    const cmd = line.trim().toLowerCase();
    if (!cmd) { rl.prompt(); return; }
    switch (cmd) {
      case 'status':   await showStatus(); break;
      case 'mtf':      await doMTFScreening(); break;
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
          '  mtf      — jalankan MTF Smart Money screener',
          '  gainer   — tampilkan koin gainer ≥10%',
          '  utbot    — UT Bot Alert screener standalone',
          '  pipeline — Gainer ≥10% → UTBot (pipeline utama)',
          '  screen   — MTF + Pipeline sekaligus',
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
  console.log('║  Bitget Spot Bot v3.2 — MTF + Gainer UTBot       ║');
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

  const cfg         = config;
  const pct1        = cfg.trading.splitEntry?.portion1Pct ?? 55;
  const pct2        = cfg.trading.splitEntry?.portion2Pct ?? 45;
  const manageMin   = cfg.schedule?.managementIntervalMin ?? 10;
  const preAlertMin = cfg.schedule?.preAlertRecheckMin    ?? 60;
  const utbotMin    = cfg.screening?.utbot?.checkIntervalMin ?? 60;

  log('startup', `Config:`);
  log('startup', `  Budget/trade : ${cfg.trading.budgetPerTrade} USDT (E1 ${pct1}%: ${(cfg.trading.budgetPerTrade * pct1 / 100).toFixed(0)}, E2 ${pct2}%: ${(cfg.trading.budgetPerTrade * pct2 / 100).toFixed(0)})`);
  log('startup', `  Max posisi   : ${cfg.trading.maxOpenPositions}`);
  log('startup', `  Min gainer   : ${cfg.screening?.gainer?.minGainPct ?? 10}%`);
  log('startup', `Jadwal:`);
  log('startup', `  MTF          : 07:30 / 13:00 / 19:00 WIB`);
  log('startup', `  Gainer+UTBot : setiap ${utbotMin} menit`);
  log('startup', `  Management   : setiap ${manageMin} menit`);

  await notifyStartup(isDryRun, config);

  if (args.includes('--screen-only'))   { await doMTFScreening(); process.exit(0); }
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
    doScreening:        doMTFScreening,
    doMTFScreening,
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
    doMTFScreening,
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
