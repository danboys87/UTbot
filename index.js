/**
 * Bitget Spot Trading Bot v3.0 — MTF Smart Money
 * Entry point utama
 *
 * Perubahan dari v2.0:
 *  - Screener utama: runMTFScreening (1D + 4H + 1H + Order Block)
 *  - Approval: 3 perintah → /approve (entry1 30%), /approve2 (entry2 70%), /approveall
 *  - Manager: TP1 50% + BEP, lalu trailing 1.5%
 *  - Screener lama (gainer, reversal, trend) tetap tersedia sebagai fallback
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
import { runMTFScreening }          from './screenerMTF.js';
import { runDailyGainerScreening }  from './screener.js';
import { runReversalScreening }     from './screenerReversal.js';
import { runTrendScreening }        from './screenerTrend.js';
import { runUTBotScreener }         from './screenerUTBot.js';
import { runManagementCycle }       from './manager.js';
import { executeBuy }               from './executor.js';
import { getStats, getOpenSymbols, getAllPositions, initState } from './state.js';
import {
  notifyStartup, notifyBuy, notifySell,
  notifyScreening, notifyApprovalRequest, notifyApprovalEntry2,
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
let _manageBusy = false;
let _cronTasks  = [];

// ─────────────────────────────────────────────────────────────────────────────
// SPLIT ENTRY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Beli Entry 1 saja (30% @ EMA21 zone)
 */
async function executeBuyEntry1(candidate) {
  const maxPos = config.trading.maxOpenPositions;
  const open   = getOpenSymbols().length;

  if (open >= maxPos) {
    log('executor', `Slot penuh (${open}/${maxPos}), ${candidate.symbol} tidak jadi dibeli`);
    await notifyError(`⚠️ Slot penuh (${open}/${maxPos}). <b>${candidate.symbol}</b> tidak bisa dibeli sekarang.\n\nTunggu posisi lain closing, lalu /approve ${candidate.symbol} lagi.`);
    return;
  }

  const pct1    = (config.trading.splitEntry?.portion1Pct ?? 55) / 100;
  const budget1 = config.trading.budgetPerTrade * pct1;
  const cand1   = { ...candidate, budget: budget1, entryPortion: 1 };

  log('executor', `→ Eksekusi Buy Entry 1 (${Math.round(pct1*100)}%): ${candidate.symbol} | budget=${budget1.toFixed(0)} USDT`);
  const result = await executeBuy(cand1);

  if (result.success) {
    await notifyBuy({
      symbol:       candidate.symbol,
      price:        result.entryPrice,
      quantity:     result.quantity,
      budget:       budget1,
      score:        candidate.score,
      signals:      candidate.signals,
      slPrice:      candidate.slPrice,
      entryPortion: 1,
      zones:        candidate.zones,
      strategy:     candidate.strategy,
      change24h:    candidate.change24h,
    });
  } else {
    await notifyError(`Buy Entry1 ${candidate.symbol} gagal: ${result.error}`);
  }
}

/**
 * Beli Entry 2 saja (70% @ OB/Demand zone)
 */
async function executeBuyEntry2(candidate) {
  const pct2    = (config.trading.splitEntry?.portion2Pct ?? 45) / 100;
  const budget2 = config.trading.budgetPerTrade * pct2;
  const cand2   = { ...candidate, budget: budget2, entryPortion: 2 };

  log('executor', `→ Eksekusi Buy Entry 2 (${Math.round(pct2*100)}%): ${candidate.symbol} | budget=${budget2.toFixed(0)} USDT`);
  const result = await executeBuy(cand2);

  if (result.success) {
    await notifyBuy({
      symbol:       candidate.symbol,
      price:        result.entryPrice,
      quantity:     result.quantity,
      budget:       budget2,
      score:        candidate.score,
      signals:      candidate.signals,
      slPrice:      candidate.slPrice,
      entryPortion: 2,
      zones:        candidate.zones,
      strategy:     candidate.strategy,
      change24h:    candidate.change24h,
    });
  } else {
    await notifyError(`Buy Entry2 ${candidate.symbol} gagal: ${result.error}`);
  }
}

/**
 * Beli kedua entry sekaligus (100% budget)
 */
async function executeBuyAll(candidate) {
  const maxPos = config.trading.maxOpenPositions;
  const open   = getOpenSymbols().length;

  if (open >= maxPos) {
    await notifyError(`Slot penuh (${open}/${maxPos}). ${candidate.symbol} dilewati.`);
    return;
  }

  log('executor', `→ Eksekusi Buy ALL: ${candidate.symbol} | budget=${config.trading.budgetPerTrade} USDT`);
  const result = await executeBuy({ ...candidate, entryPortion: 'all' });

  if (result.success) {
    await notifyBuy({
      symbol:       candidate.symbol,
      price:        result.entryPrice,
      quantity:     result.quantity,
      budget:       config.trading.budgetPerTrade,
      score:        candidate.score,
      signals:      candidate.signals,
      slPrice:      candidate.slPrice,
      entryPortion: 'all',
      zones:        candidate.zones,
      strategy:     candidate.strategy,
      change24h:    candidate.change24h,
    });
  } else {
    await notifyError(`Buy ALL ${candidate.symbol} gagal: ${result.error}`);
  }
}

// Set approval callbacks
// /approve → entry1, /approve2 → entry2, /approveall → keduanya
// Untuk kompatibilitas approvalQueue, default /approve = entry1
setCallbacks({
  onApprove: executeBuyEntry1,
  onExpire:  (symbol) => notifyError(`⏰ Konfirmasi ${symbol} expired, dilewati.`),
});

// Expose entry2 & all untuk telegramCommands
export { executeBuyEntry2, executeBuyAll };

// ─────────────────────────────────────────────────────────────────────────────
// APPROVAL HELPER
// ─────────────────────────────────────────────────────────────────────────────
async function sendApprovalRequests(candidates) {
  const timeoutMin = config.trading.approvalTimeoutMin ?? 60;
  for (const candidate of candidates) {
    const added = addToQueue(candidate, timeoutMin);
    if (added) {
      await notifyApprovalRequest({ candidate, timeoutMin });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MTF SCREENING (screener utama)
// ─────────────────────────────────────────────────────────────────────────────
export async function doMTFScreening() {
  if (_screenBusy) { log('cron', 'Screening masih berjalan, skip'); return []; }
  _screenBusy = true;

  try {
    const open = getOpenSymbols().length;
    const max  = config.trading.maxOpenPositions;

    if (open >= max) {
      log('screener', `Skip MTF screening: posisi penuh (${open}/${max})`);
      return [];
    }

    log('screener', '🧠 Menjalankan MTF Smart Money Screening...');
    const tickers    = await getAllTickers();
    const candidates = await runMTFScreening(tickers, config);

    await notifyScreening({
      found:    candidates.length,
      total:    config.screening?.mtf?.checkLimit ?? 100,
      symbols:  candidates.map(c => c.symbol),
      strategy: 'MTF Smart Money',
    });

    if (candidates.length === 0) return [];

    // Pisahkan triggered (3/3 TF) dan pre-alert (1-2/3 TF)
    const triggered = candidates.filter(c => c.triggered);
    const preAlert  = candidates.filter(c => !c.triggered);

    // Triggered → masuk approval queue dengan notif lengkap + AI verdict
    if (triggered.length > 0) {
      log('screener', `✅ ${triggered.length} kandidat triggered → approval queue`);
      await sendApprovalRequests(triggered);
    }

    // Pre-alert → notif ringkas saja, tidak masuk approval queue
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
// SCREENER LAMA (fallback, tetap tersedia via Telegram)
// ─────────────────────────────────────────────────────────────────────────────
export async function doGainerScreening() {
  if (_screenBusy) { log('cron', 'Screening masih berjalan, skip'); return []; }
  _screenBusy = true;
  try {
    const candidates = await runDailyGainerScreening();
    await notifyScreening({ found: candidates.length, total: 50, symbols: candidates.map(c => c.symbol), strategy: 'Daily Gainer' });
    if (candidates.length > 0) await sendApprovalRequests(candidates);
    return candidates;
  } catch (err) {
    log('cron_error', `Gainer error: ${err.message}`);
    return [];
  } finally {
    _screenBusy = false;
  }
}

export async function doReversalScreening() {
  if (_screenBusy) { log('cron', 'Screening masih berjalan, skip'); return []; }
  _screenBusy = true;
  try {
    const tickers    = await getAllTickers();
    const candidates = await runReversalScreening(tickers, config);
    await notifyScreening({ found: candidates.length, total: 50, symbols: candidates.map(c => c.symbol), strategy: 'Reversal Hunter' });
    if (candidates.length > 0) await sendApprovalRequests(candidates);
    return candidates;
  } catch (err) {
    log('cron_error', `Reversal error: ${err.message}`);
    return [];
  } finally {
    _screenBusy = false;
  }
}

export async function doTrendScreening() {
  if (_screenBusy) { log('cron', 'Screening masih berjalan, skip'); return []; }
  _screenBusy = true;
  try {
    const tickers    = await getAllTickers();
    const candidates = await runTrendScreening(tickers, config);
    await notifyScreening({ found: candidates.length, total: 50, symbols: candidates.map(c => c.symbol), strategy: 'Trend Following' });
    if (candidates.length > 0) await sendApprovalRequests(candidates);
    return candidates;
  } catch (err) {
    log('cron_error', `Trend error: ${err.message}`);
    return [];
  } finally {
    _screenBusy = false;
  }
}

export async function doScreening() {
  log('screener', '🔍 Menjalankan MTF + semua screener...');
  const r1 = await doMTFScreening();
  await sleep(500);
  return r1;
}

// ─────────────────────────────────────────────────────────────────────────────
// MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
export async function doPreAlertRecheck() {
  if (_screenBusy) { log('cron', 'Screening masih berjalan, skip pre-alert recheck'); return; }

  const pending   = getPendingQueue();
  const preAlerts = pending.filter(p => !p.candidate.triggered);

  if (preAlerts.length === 0) {
    log('cron', '⏳ Pre-alert recheck: tidak ada kandidat pre-alert di queue');
    return;
  }

  log('cron', `⏳ Pre-alert recheck: ${preAlerts.length} kandidat → ${preAlerts.map(p => p.symbol).join(', ')}`);
  _screenBusy = true;

  try {
    const tickers         = await getAllTickers();
    const preAlertSymbols = preAlerts.map(p => p.symbol);
    const filteredTickers = tickers.filter(t => preAlertSymbols.includes(t.symbol));
    if (!filteredTickers.length) return;

    const candidates  = await runMTFScreening(filteredTickers, config);
    const nowTriggered = candidates.filter(c => c.triggered);
    const stillPre     = candidates.filter(c => !c.triggered);

    if (nowTriggered.length > 0) {
      log('cron', `✅ ${nowTriggered.length} pre-alert sekarang TRIGGERED: ${nowTriggered.map(c => c.symbol).join(', ')}`);
      await sendApprovalRequests(nowTriggered);
    }
    if (stillPre.length > 0) {
      log('cron', `⏳ ${stillPre.length} masih pre-alert: ${stillPre.map(c => c.symbol).join(', ')}`);
    }
    const disappeared = preAlertSymbols.filter(s => !candidates.find(c => c.symbol === s));
    if (disappeared.length > 0) {
      log('cron', `❌ ${disappeared.length} tidak lolos recheck: ${disappeared.join(', ')}`);
    }
  } catch (err) {
    log('cron_error', `Pre-alert recheck error: ${err.message}`);
  } finally {
    _screenBusy = false;
  }
}

export async function doUTBotScreener() {
  if (_screenBusy) { log('cron', 'Screening masih berjalan, skip UTBot'); return []; }
  _screenBusy = true;
  try {
    const tickers = await getAllTickers();
    const signals = await runUTBotScreener(tickers);
    if (signals.length > 0) await notifyUTBot(signals);
    return signals;
  } catch (err) {
    log('cron_error', `UTBot screener error: ${err.message}`);
    return [];
  } finally {
    _screenBusy = false;
  }
}

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
  const mtfCron     = config.schedule?.mtfCron  || '30 0 * * *';  // 07:30 WIB
  const mtfCron2    = config.schedule?.mtfCron2 || '0 6 * * *';   // 13:00 WIB
  const mtfCron3    = config.schedule?.mtfCron3 || '0 12 * * *';  // 19:00 WIB

  // Wrapper screening dengan label waktu
  const doMTFMorning = async () => {
    log('cron', '🌅 Screening pagi (07:30 WIB) — setelah daily close');
    return doMTFScreening();
  };
  const doMTFNoon = async () => {
    log('cron', '☀️  Screening siang (13:00 WIB) — cek pre-alert trigger');
    return doMTFScreening();
  };
  const doMTFEvening = async () => {
    log('cron', '🌆 Screening sore (19:00 WIB) — update kondisi');
    return doMTFScreening();
  };

  const mtfTask1     = cron.schedule(mtfCron,  doMTFMorning,  { timezone: 'UTC' });
  const mtfTask2     = cron.schedule(mtfCron2, doMTFNoon,     { timezone: 'UTC' });
  const mtfTask3     = cron.schedule(mtfCron3, doMTFEvening,  { timezone: 'UTC' });
  const manageTask   = cron.schedule(`*/${manageMin} * * * *`, doManagement);
  const preAlertTask = cron.schedule(`*/${preAlertMin} * * * *`, async () => {
    log('cron', `🔄 Pre-alert recheck (setiap ${preAlertMin} menit)`);
    await doPreAlertRecheck();
  });
  const utbotTask    = cron.schedule(`*/${utbotMin} * * * *`, async () => {
    const utEnabled = config.screening?.utbot?.enabled ?? false;
    if (!utEnabled) return;
    log('cron', `📡 UT Bot Alert screening (setiap ${utbotMin} menit)`);
    await doUTBotScreener();
  });

  _cronTasks = [mtfTask1, mtfTask2, mtfTask3, manageTask, preAlertTask, utbotTask];
  log('cron', `Cron aktif:`);
  log('cron', `  🌅 MTF Pagi    → 07:30 WIB (setelah daily close)`);
  log('cron', `  ☀️  MTF Siang   → 13:00 WIB`);
  log('cron', `  🌆 MTF Sore    → 19:00 WIB`);
  log('cron', `  🔄 Pre-alert   → setiap ${preAlertMin} menit`);
  log('cron', `  📡 UT Bot      → setiap ${utbotMin} menit ${config.screening?.utbot?.enabled ? '✅' : '(disabled)'}`);
  log('cron', `  ⚙️  Management  → setiap ${manageMin} menit`);
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
  console.log('  📊 STATUS BOT v3.0 MTF');
  console.log('══════════════════════════════════════');
  console.log(`  Mode     : ${isDryRun ? '🧪 DRY RUN' : '💸 LIVE'}`);
  console.log(`  Open Pos : ${stats.openPositions}/${config.trading.maxOpenPositions}`);
  console.log(`  Closed   : ${stats.closedCount}`);
  console.log(`  Total PnL: ${stats.totalPnlUsdt >= 0 ? '+' : ''}${stats.totalPnlUsdt?.toFixed(2)} USDT`);

  if (pending.length > 0) {
    console.log(`\n  ⏳ Menunggu Approval (${pending.length}):`);
    for (const p of pending) {
      const triggered = p.candidate.triggered ? '⚡ TRIGGERED' : '⏳ pre-alert';
      console.log(`    ${p.symbol} — sisa ${p.minsLeft} menit [${triggered}]`);
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
  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    prompt: '\n[bitget-bot v3] > ',
  });

  console.log('\n📖 Perintah: status | mtf | screen | gainer | trend | reversal | manage | stats | stop | help\n');
  rl.prompt();

  rl.on('line', async (line) => {
    const cmd = line.trim().toLowerCase();
    if (!cmd) { rl.prompt(); return; }

    switch (cmd) {
      case 'status':   await showStatus(); break;
      case 'mtf':      await doMTFScreening(); break;
      case 'screen':   await doScreening(); break;
      case 'gainer':   await doGainerScreening(); break;
      case 'trend':    await doTrendScreening(); break;
      case 'reversal': await doReversalScreening(); break;
      case 'manage':   await doManagement(); break;
      case 'stats':    await notifyStats(getStats()); console.log('📊 Stats dikirim ke Telegram'); break;
      case 'stop':
        console.log('🛑 Menghentikan bot...');
        stopCron(); process.exit(0); break;
      case 'help':
        console.log([
          '',
          '  status   — posisi terbuka & PnL',
          '  mtf      — jalankan MTF Smart Money screener',
          '  screen   — jalankan semua screener',
          '  gainer   — daily gainer screener (legacy)',
          '  reversal — reversal screener (legacy)',
          '  trend    — trend screener (legacy)',
          '  manage   — cek TP/SL semua posisi',
          '  stats    — kirim ringkasan ke Telegram',
          '  stop     — hentikan bot',
          '',
        ].join('\n')); break;
      default:
        console.log(`❓ Perintah tidak dikenal: "${cmd}". Ketik "help".`);
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
  console.log('╔════════════════════════════════════════════╗');
  console.log('║   Bitget Spot Bot v3.0 — MTF Smart Money  ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`  Mode: ${isDryRun ? '🧪 DRY RUN' : '💸 LIVE TRADING'}`);
  console.log('');

  if (!isDryRun) {
    log('startup', 'Mengecek koneksi Bitget API...');
    const conn = await testConnection();
    if (!conn.ok) {
      log('startup_error', `Koneksi API gagal: ${conn.error}`);
      process.exit(1);
    }
    log('startup', `✅ Koneksi OK | ${conn.assets} aset ditemukan`);
  } else {
    log('startup', '🧪 DRY RUN mode - API connection skipped');
  }

  const cfg  = config;
  const pct1 = cfg.trading.splitEntry?.portion1Pct ?? 55;
  const pct2 = cfg.trading.splitEntry?.portion2Pct ?? 45;
  log('startup', `Config:`);
  log('startup', `  Budget/trade : ${cfg.trading.budgetPerTrade} USDT (Entry1 ${pct1}%: ${(cfg.trading.budgetPerTrade * pct1 / 100).toFixed(0)}, Entry2 ${pct2}%: ${(cfg.trading.budgetPerTrade * pct2 / 100).toFixed(0)})`);
  log('startup', `  Max posisi   : ${cfg.trading.maxOpenPositions}`);
  log('startup', `  Min volume   : $${((cfg.screening?.mtf?.minVolume24h ?? 2e6) / 1e6).toFixed(0)}M`);
  log('startup', `  Whitelist    : ${(cfg.whitelist?.length ?? 0)} koin`);
  log('startup', `  SL buffer    : ${(cfg.management.slBuffer * 100).toFixed(1)}% bawah demand zone`);
  log('startup', `  TP1          : tutup 50% → geser SL ke BEP`);
  log('startup', `  Trailing     : aktif >= ${cfg.management.trailingStop.activateAtProfitPct ?? 4}% profit | callback ${cfg.management.trailingStop.trailPct}%`);

  await notifyStartup(isDryRun, config);

  if (args.includes('--screen-only')) {
    await doMTFScreening(); process.exit(0);
  }
  if (args.includes('--manage-only')) {
    await doManagement(); process.exit(0);
  }

  await initState();

  log('startup', 'Menjalankan management cycle pertama...');
  await doManagement();

  startCron();

  startTelegramPolling({
    doScreening:        doMTFScreening,
    doMTFScreening,
    doTrendScreening,
    doReversalScreening,
    doGainerScreening,
    doUTBotScreener,
    doManagement,
    approveCandidate,
    approveEntry2:      (symbol) => {
      const q = getPendingQueue();
      const item = q.find(p => p.symbol === symbol);
      if (!item) return { ok: false, reason: `${symbol} tidak ada di queue` };
      return executeBuyEntry2(item.candidate).then(() => ({ ok: true }));
    },
    approveAll:         (symbol) => {
      const q = getPendingQueue();
      const item = q.find(p => p.symbol === symbol);
      if (!item) return { ok: false, reason: `${symbol} tidak ada di queue` };
      return executeBuyAll(item.candidate).then(() => ({ ok: true }));
    },
    skipCandidate,
    getPendingQueue,
    getAllPositions,
    getCurrentPrice,
    stopBot:            () => { stopCron(); process.exit(0); },
  });

  // ── Dashboard API Server ───────────────────────────────────────────────────
  startApiServer({
    doMTFScreening,
    doTrendScreening,
    doReversalScreening,
    doGainerScreening,
    doUTBotScreener,
    doScreening,
    doManagement,
    approveCandidate,
    approveEntry2: (symbol) => {
      const q    = getPendingQueue();
      const item = q.find(p => p.symbol === symbol);
      if (!item) return Promise.resolve({ ok: false, reason: `${symbol} tidak ada di queue` });
      return executeBuyEntry2(item.candidate).then(() => ({ ok: true }));
    },
    approveAll: (symbol) => {
      const q    = getPendingQueue();
      const item = q.find(p => p.symbol === symbol);
      if (!item) return Promise.resolve({ ok: false, reason: `${symbol} tidak ada di queue` });
      return executeBuyAll(item.candidate).then(() => ({ ok: true }));
    },
    skipCandidate,
    getPendingQueue,
    getAllPositions,
    getCurrentPrice,
    executeBuyManual: async (symbol, opts = {}) => {
      const { executeBuy } = await import('./executor.js');
      const { split, slPrice, tp1Price, budget } = opts;

      // Tentukan budget berdasarkan split
      const baseBudget = budget || config.trading.budgetPerTrade;
      const p1 = (config.trading.splitEntry?.portion1Pct ?? 55) / 100;
      const p2 = (config.trading.splitEntry?.portion2Pct ?? 45) / 100;
      const finalBudget = split === 'entry1' ? baseBudget * p1
                        : split === 'entry2' ? baseBudget * p2
                        : baseBudget;

      const candidate = {
        symbol,
        score:        0,
        signals:      {},
        strategy:     'manual',
        budget:       finalBudget,
        entryPortion: split === 'entry1' ? 1 : split === 'entry2' ? 2 : 'all',
        // Simpan SL dan TP1 custom ke candidate agar disimpan ke state
        slPrice:      slPrice  || null,
        tp1Price:     tp1Price || null,
      };

      const result = await executeBuy(candidate);

      // Jika berhasil dan ada SL/TP1 custom, update posisi di state
      if (result.success && (slPrice || tp1Price)) {
        const { getPosition } = await import('./state.js');
        // slPrice dan tp1Price sudah tersimpan via openPosition di state
        log('executor', `📍 Manual SL: ${slPrice || 'config'} | TP1: ${tp1Price || 'auto R:R'}`);
      }

      return result;
    },
    executeSellManual: async (symbol, opts = {}) => {
      const { executeSell, executePartialSell } = await import('./executor.js');
      const pos = getAllPositions()[symbol];
      if (!pos) return { ok: false, error: 'Posisi tidak ditemukan' };

      const sellPct = opts.sellPct ?? 100;

      // Partial sell
      if (sellPct < 100) {
        return executePartialSell(symbol, {
          sellPct,
          reason:   'manual_partial',
          position: pos,
        });
      }

      return executeSell(symbol, { quantity: pos.quantity, reason: 'manual_sell', position: pos });
    },
  });

  if (process.stdin.isTTY) {
    startREPL();
  } else {
    log('startup', 'Non-TTY mode - berjalan sebagai daemon');
  }
}

main().catch(err => {
  log('fatal', err.message);
  process.exit(1);
});

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
