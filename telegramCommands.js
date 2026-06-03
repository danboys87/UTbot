/**
 * Telegram Command Handler v3.2 — Gainer+UTBot Pipeline
 *
 * Perubahan v3.2:
 *   - Hapus /trend dan /reversal
 *   - /gainer   — tampilkan list koin gainer ≥10%
 *   - /pipeline — jalankan Gainer ≥10% → UTBot pipeline
 *   - /utbot    — UT Bot Alert standalone (semua koin)
 *   - /mtf      — MTF Smart Money screener
 */

import { log }                 from './logger.js';
import { getCurrentPrice }     from './bitget.js';
import { getStats, getAllPositions, getOpenSymbols, hasPosition } from './state.js';
import { executeSell, executeBuy } from './executor.js';
import { notifyBuy, notifyAIAnalysis } from './telegram.js';
import { analyzeOnDemand, getAIStatus } from './aiAnalyst.js';
import { config }              from './config.js';

const getToken  = () => process.env.TELEGRAM_BOT_TOKEN;
const getChatId = () => process.env.TELEGRAM_CHAT_ID;
const getBase   = () => { const t = getToken(); return t ? `https://api.telegram.org/bot${t}` : null; };

let _offset = 0, _polling = false, _pollTimer = null;

async function reply(chatId, text) {
  if (!getBase()) return;
  const LIMIT = 4000;
  const chunks = [];
  if (text.length <= LIMIT) {
    chunks.push(text);
  } else {
    const lines = text.split('\n');
    let chunk = '';
    for (const line of lines) {
      if ((chunk + '\n' + line).length > LIMIT) { chunks.push(chunk); chunk = line; }
      else { chunk = chunk ? chunk + '\n' + line : line; }
    }
    if (chunk) chunks.push(chunk);
  }
  for (const chunk of chunks) {
    try {
      await fetch(`${getBase()}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'HTML' }),
      });
      if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
    } catch (err) { log('telegram_error', `Reply error: ${err.message}`); }
  }
}

async function getUpdates() {
  if (!getBase()) return [];
  try {
    const res  = await fetch(`${getBase()}/getUpdates?offset=${_offset}&timeout=10&allowed_updates=["message"]`);
    const data = await res.json();
    return data.ok ? data.result : [];
  } catch { return []; }
}

// ── Status text ───────────────────────────────────────────────────────────────
async function buildStatusText(callbacks) {
  const stats     = getStats();
  const positions = getAllPositions();
  const pending   = callbacks.getPendingQueue();
  const isDryRun  = process.env.DRY_RUN === 'true';
  const _aiSt = (() => { try { return getAIStatus(); } catch { return {enabled:false}; } })();

  let text = `📊 <b>Status Bot v3.2</b>\n`;
  text += `Mode     : ${isDryRun ? '🧪 DRY RUN' : '💸 LIVE'}\n`;
  text += `AI Analyst: ${_aiSt.enabled ? `🤖 ${_aiSt.provider}/${_aiSt.model}` : '⚠️ set GEMINI_API_KEY di .env'}\n`;
  text += `Open Pos : ${stats.openPositions}/${config.trading.maxOpenPositions}\n`;
  text += `Closed   : ${stats.closedCount}\n`;
  text += `Total PnL: ${stats.totalPnlUsdt >= 0 ? '+' : ''}${stats.totalPnlUsdt?.toFixed(2)} USDT\n`;

  if (pending.length > 0) {
    text += `\n<b>⏳ Menunggu Approval (${pending.length}):</b>\n`;
    for (const p of pending) {
      const trig   = p.candidate.triggered ? '⚡' : '⏳';
      const ai     = p.candidate.aiAnalysis?.verdict;
      const strat  = p.candidate.strategy === 'gainerUTBot' ? '[🚀📡]'
                   : p.candidate.strategy === 'utbot'       ? '[📡]'
                   :                                          '[🧠]';
      const aiTag  = ai ? ` 🤖 ${ai}` : '';
      text += `  ${trig} ${strat} <b>${p.symbol}</b>${aiTag} — sisa ${p.minsLeft}m\n`;
    }
  }

  if (stats.openPositions > 0) {
    text += `\n<b>Posisi Terbuka:</b>\n`;
    for (const [symbol, pos] of Object.entries(positions)) {
      const hasBEP = pos.partialSells?.some(ps => ps.reason === 'tp1_partial');
      const mgmt   = config.management;
      try {
        const cur   = await getCurrentPrice(symbol);
        const pnl   = cur ? ((cur - pos.entryPrice) / pos.entryPrice * 100) : null;
        const usdt  = cur ? ((cur - pos.entryPrice) * pos.quantity) : null;
        const sign  = pnl >= 0 ? '+' : '';
        const emoji = pnl >= 0 ? '🟢' : '🔴';
        const flags = [hasBEP ? 'BEP✅' : '', pos.trailingActive ? '🔻TRAIL' : ''].filter(Boolean).join(' ');
        const effectiveSL = (hasBEP || pos.trailingActive)
          ? pos.entryPrice * (1 - 0.001)
          : (pos.slPrice ?? pos.entryPrice * (1 - Math.abs(mgmt.stopLossPct ?? 4) / 100));
        const tp1 = pos.tp1Price ?? pos.entryPrice + (pos.entryPrice - effectiveSL) * (mgmt.minRiskReward ?? 2);
        text += `${emoji} <b>${symbol}</b>${flags ? ' ' + flags : ''}\n`;
        text += `   Entry : ${pos.entryPrice} | Now: ${cur ?? '—'}\n`;
        text += `   SL    : ${effectiveSL.toFixed(6)}\n`;
        text += `   TP1   : ${hasBEP ? '✅ done' : tp1.toFixed(6)}\n`;
        if (pnl !== null) text += `   PnL   : ${sign}${pnl.toFixed(2)}% (${sign}${usdt.toFixed(2)} USDT)\n`;
      } catch { text += `⚪ ${symbol} | Entry: ${pos.entryPrice}\n`; }
    }
  }
  return text;
}

// ── Command handler ───────────────────────────────────────────────────────────
async function handleCommand(chatId, text, callbacks) {
  if (String(chatId) !== String(getChatId())) { await reply(chatId, '⛔ Tidak diizinkan.'); return; }

  const parts = text.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();
  const arg   = parts[1]?.toUpperCase();

  log('telegram', `Cmd: ${cmd}${arg ? ' ' + arg : ''}`);

  switch (cmd) {

    case '/status': {
      await reply(chatId, '⏳ Mengambil data...');
      await reply(chatId, await buildStatusText(callbacks));
      break;
    }

    // ── Screener ─────────────────────────────────────────────────────────────
    case '/mtf': {
      await reply(chatId, '🧠 MTF Smart Money Screening dimulai...\n🤖 AI analisa akan berjalan otomatis.');
      callbacks.doMTFScreening()
        .then(c => { if (!c?.length) reply(chatId, '⚠️ Tidak ada kandidat MTF.'); })
        .catch(e => reply(chatId, `⚠️ Error: ${e.message}`));
      break;
    }

    case '/gainer': {
      await reply(chatId, '🚀 Mengambil daftar Gainer ≥10%...');
      callbacks.doGainerScreening?.()
        .then(gainers => {
          if (!gainers?.length) {
            reply(chatId, '⚠️ Tidak ada koin gainer ≥10% saat ini.');
            return;
          }
          let msg = `🚀 <b>Gainer ≥10% (${gainers.length} koin)</b>\n\n`;
          gainers.slice(0, 20).forEach((g, i) => {
            msg += `${i+1}. <b>${g.symbol}</b> +${g.change24h.toFixed(2)}% | $${(g.vol24h/1e6).toFixed(1)}M\n`;
          });
          if (gainers.length > 20) msg += `\n<i>...dan ${gainers.length - 20} lainnya</i>`;
          msg += `\n\nGunakan /pipeline untuk cari BUY signal UTBot dari list ini.`;
          reply(chatId, msg);
        })
        .catch(e => reply(chatId, `⚠️ Error: ${e.message}`));
      break;
    }

    case '/utbot': {
      await reply(chatId, '📡 UT Bot Alert screening dimulai (1H, filter EMA21 1H)...');
      callbacks.doUTBotScreener?.()
        .then(signals => {
          const buySignals = signals?.filter(s => s.signal === 'BUY') ?? [];
          if (buySignals.length === 0) {
            reply(chatId, '📡 UT Bot: tidak ada sinyal BUY saat ini.\n\n<i>Coba lagi di candle berikutnya.</i>');
          }
        })
        .catch(e => reply(chatId, `⚠️ Error: ${e.message}`));
      break;
    }

    case '/pipeline': {
      await reply(chatId,
        '🚀📡 <b>Gainer ≥10% → UT Bot Pipeline</b>\n\n' +
        'Step 1: Cari koin naik ≥10% dalam 24h...\n' +
        'Step 2: Scan UTBot BUY signal (filter EMA21 1H)...\n\n' +
        '<i>Estimasi: 1-3 menit</i>'
      );
      callbacks.doGainerUTBotScreening?.()
        .then(c => {
          if (!c?.length) reply(chatId, '⚠️ Tidak ada kandidat dari pipeline Gainer+UTBot.');
        })
        .catch(e => reply(chatId, `⚠️ Error: ${e.message}`));
      break;
    }

    case '/screen': {
      await reply(chatId, '🔍 Menjalankan MTF + Gainer+UTBot pipeline...');
      callbacks.doScreening?.()
        .then(c => { if (!c?.length) reply(chatId, '⚠️ Tidak ada kandidat.'); })
        .catch(e => reply(chatId, `⚠️ Error: ${e.message}`));
      break;
    }

    // ── AI Analyst on-demand ─────────────────────────────────────────────────
    case '/analyze': {
      if (!arg) { await reply(chatId, '❓ Format: /analyze SYMBOL\nContoh: /analyze BTCUSDT'); break; }
      const aiSt = (() => { try { return getAIStatus(); } catch { return {enabled:false}; } })();
      if (!aiSt.enabled) {
        await reply(chatId, '⚠️ AI Analyst belum aktif.\n\nTambahkan ke .env:\n• GEMINI_API_KEY\n• ANTHROPIC_API_KEY\n• OPENROUTER_API_KEY');
        break;
      }
      await reply(chatId,
        `🤖 <b>AI Analyst</b> — ${arg}\n\n` +
        `⏳ Mengambil data market 1D + 4H + 1H...\n` +
        `📊 Menjalankan analisa multi-timeframe...\n\n` +
        `<i>Estimasi: 30-60 detik</i>`
      );
      try {
        const analysis = await analyzeOnDemand(arg);
        if (!analysis) {
          await reply(chatId, `⚠️ AI analisa untuk <b>${arg}</b> tidak tersedia.\nCek log bot untuk detail error.`);
          break;
        }
        const { formatAIAnalysis } = await import('./telegram.js');
        const msg = formatAIAnalysis(arg, analysis);
        const safeReply = async (t) => {
          const base = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
          try {
            const res  = await fetch(`${base}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: t, parse_mode: 'HTML' }) });
            const data = await res.json();
            if (!data.ok) {
              const plain = t.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
              await fetch(`${base}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: plain }) });
            }
          } catch (err) { log('telegram_error', `safeReply: ${err.message}`); }
        };
        const LIMIT = 3500;
        if (msg.length <= LIMIT) {
          await safeReply(msg);
        } else {
          const lines = msg.split('\n');
          let chunk = '';
          for (const line of lines) {
            if ((chunk + '\n' + line).length > LIMIT) { await safeReply(chunk); chunk = line; await new Promise(r => setTimeout(r, 400)); }
            else { chunk = chunk ? chunk + '\n' + line : line; }
          }
          if (chunk) await safeReply(chunk);
        }
      } catch (err) {
        await reply(chatId, `❌ Analisa gagal: ${err.message}`);
      }
      break;
    }

    // ── Approval ─────────────────────────────────────────────────────────────
    case '/approve': {
      if (!arg) { await reply(chatId, '❓ Format: /approve SYMBOL'); break; }
      const q1    = callbacks.getPendingQueue();
      const item1 = q1.find(p => p.symbol === arg);
      if (item1?.candidate?.aiAnalysis?.verdict === 'SKIP' && !item1._aiWarnShown) {
        await reply(chatId, `⚠️ AI Analyst merekomendasikan <b>SKIP</b> untuk ${arg}.\n\nAlasan: ${item1.candidate.aiAnalysis.summary}\n\nKetik /approve ${arg} lagi untuk override.`);
        item1._aiWarnShown = true;
        break;
      }
      await reply(chatId, `⏳ Approve Entry 1 (${config.trading.splitEntry?.portion1Pct ?? 55}%) — ${arg}...`);
      const res = await callbacks.approveCandidate(arg);
      await reply(chatId, res.ok ? `✅ <b>${arg}</b> Entry 1 dieksekusi!` : `❌ ${res.reason}`);
      break;
    }

    case '/approve2': {
      if (!arg) { await reply(chatId, '❓ Format: /approve2 SYMBOL'); break; }
      await reply(chatId, `⏳ Approve Entry 2 (${config.trading.splitEntry?.portion2Pct ?? 45}%) — ${arg}...`);
      try {
        const res = await callbacks.approveEntry2(arg);
        await reply(chatId, res.ok ? `✅ <b>${arg}</b> Entry 2 dieksekusi!` : `❌ ${res.reason}`);
      } catch (err) { await reply(chatId, `❌ Error: ${err.message}`); }
      break;
    }

    case '/approveall': {
      if (!arg) { await reply(chatId, '❓ Format: /approveall SYMBOL'); break; }
      await reply(chatId, `⏳ Full position (100%) — ${arg}...`);
      try {
        const res = await callbacks.approveAll(arg);
        await reply(chatId, res.ok ? `✅ <b>${arg}</b> Full position dieksekusi!` : `❌ ${res.reason}`);
      } catch (err) { await reply(chatId, `❌ Error: ${err.message}`); }
      break;
    }

    case '/skip': {
      if (!arg) { await reply(chatId, '❓ Format: /skip SYMBOL'); break; }
      const res = callbacks.skipCandidate(arg);
      await reply(chatId, res.ok ? `⏭️ <b>${arg}</b> diskip.` : `❌ ${res.reason}`);
      break;
    }

    case '/pending': {
      const pending = callbacks.getPendingQueue();
      if (!pending.length) { await reply(chatId, '📭 Tidak ada kandidat pending.'); break; }
      let msg = `⏳ <b>Menunggu Approval (${pending.length}):</b>\n\n`;
      for (const p of pending) {
        const trig  = p.candidate.triggered ? '⚡ <b>TRIGGERED</b>' : '⏳ pre-alert';
        const ai    = p.candidate.aiAnalysis;
        const aiStr = ai ? `\n   🤖 AI: <b>${ai.verdict}</b> (${ai.confidence}%) — ${ai.summary?.slice(0, 80)}...` : '';
        const stratIcon = p.candidate.strategy === 'gainerUTBot' ? '🚀📡' : p.candidate.strategy === 'utbot' ? '📡' : '🧠';
        const chg   = p.candidate.change24h >= 0 ? `+${p.candidate.change24h?.toFixed(2)}` : p.candidate.change24h?.toFixed(2);

        msg += `${stratIcon} <b>${p.symbol}</b> (${chg}%) [${trig}]${aiStr}\n`;
        msg += `   Sisa: ${p.minsLeft} menit\n`;
        if (p.candidate.slPrice) msg += `   SL: ${p.candidate.slPrice.toFixed(6)}\n`;
        msg += `   /approve ${p.symbol} | /approve2 ${p.symbol} | /approveall ${p.symbol}\n`;
        msg += `   /analyze ${p.symbol} | /skip ${p.symbol}\n\n`;
      }
      await reply(chatId, msg);
      break;
    }

    // ── Buy / Sell manual ────────────────────────────────────────────────────
    case '/buy': {
      if (!arg) { await reply(chatId, '❓ Format: /buy SYMBOL'); break; }
      if (getOpenSymbols().length >= config.trading.maxOpenPositions) {
        await reply(chatId, `❌ Slot penuh (${getOpenSymbols().length}/${config.trading.maxOpenPositions}).`); break;
      }
      if (hasPosition(arg)) { await reply(chatId, `❌ Sudah punya posisi <b>${arg}</b>.`); break; }
      await reply(chatId, `⏳ Membeli <b>${arg}</b>...`);
      try {
        const result = await executeBuy({ symbol: arg, score: 0, signals: {}, strategy: 'manual' });
        if (result.success) {
          await notifyBuy({ symbol: arg, price: result.entryPrice, quantity: result.quantity, budget: config.trading.budgetPerTrade, score: 0, signals: {}, strategy: 'manual' });
          await reply(chatId, `✅ BUY ${arg} @ ${result.entryPrice} | qty=${result.quantity}`);
        } else { await reply(chatId, `❌ Gagal: ${result.error}`); }
      } catch (err) { await reply(chatId, `❌ Error: ${err.message}`); }
      break;
    }

    case '/sell': {
      if (!arg) { await reply(chatId, '❓ Format: /sell SYMBOL'); break; }
      const pos = getAllPositions()[arg];
      if (!pos) { await reply(chatId, `❌ Tidak ada posisi <b>${arg}</b>.`); break; }
      await reply(chatId, `🔄 Menjual <b>${arg}</b>...`);
      try {
        const result = await executeSell(arg, { quantity: pos.quantity, reason: 'manual_sell', position: pos });
        if (result.success) {
          const sign = result.pnlPct >= 0 ? '+' : '';
          await reply(chatId, `${result.pnlPct >= 0 ? '🟢' : '🔴'} SELL ${arg}\nEntry: ${pos.entryPrice} → Exit: ${result.exitPrice}\nPnL: ${sign}${result.pnlPct?.toFixed(2)}% (${sign}${result.pnlUsdt?.toFixed(2)} USDT)`);
        } else { await reply(chatId, `❌ Gagal: ${result.error}`); }
      } catch (err) { await reply(chatId, `❌ Error: ${err.message}`); }
      break;
    }

    case '/manage': {
      await reply(chatId, '⚙️ Management cycle...');
      callbacks.doManagement().then(() => reply(chatId, '✅ Selesai.'));
      break;
    }

    case '/stats': {
      const s    = getStats();
      const sign = s.totalPnlUsdt >= 0 ? '+' : '';
      await reply(chatId, `📊 <b>Statistik</b>\n📂 Terbuka: ${s.openPositions}\n✅ Closed: ${s.closedCount}\n💰 PnL: ${sign}${s.totalPnlUsdt?.toFixed(2)} USDT`);
      break;
    }

    case '/stop': {
      await reply(chatId, '🛑 Bot dihentikan.');
      callbacks.stopBot();
      break;
    }

    case '/help':
    default: {
      await reply(chatId,
        `🤖 <b>Bot v3.2 — MTF + Gainer UTBot Pipeline</b>\n\n` +
        `<b>📡 Screening:</b>\n` +
        `/mtf             — MTF Smart Money (1D+4H+1H)\n` +
        `/gainer          — Tampilkan koin naik ≥10% hari ini\n` +
        `/pipeline        — Gainer ≥10% → UTBot BUY signal (utama)\n` +
        `/utbot           — UTBot standalone (semua koin)\n` +
        `/screen          — Jalankan MTF + Pipeline sekaligus\n\n` +
        `<b>🤖 AI Analyst:</b>\n` +
        `/analyze SYMBOL  — Analisa AI lengkap on-demand\n\n` +
        `<b>✅ Approval Split Entry:</b>\n` +
        `/pending               — Kandidat pending\n` +
        `/approve SYMBOL        — Entry 1 (55%)\n` +
        `/approve2 SYMBOL       — Entry 2 (45%)\n` +
        `/approveall SYMBOL     — Full position (100%)\n` +
        `/skip SYMBOL           — Lewati\n\n` +
        `<b>💰 Trading Manual:</b>\n` +
        `/buy SYMBOL      — Beli manual\n` +
        `/sell SYMBOL     — Jual posisi\n\n` +
        `<b>📊 Monitor:</b>\n` +
        `/status          — Posisi + PnL\n` +
        `/manage          — Cek TP/SL\n` +
        `/stats           — Total PnL\n` +
        `/stop            — Hentikan bot`
      );
      break;
    }
  }
}

// ── Polling ───────────────────────────────────────────────────────────────────
export function startTelegramPolling(callbacks) {
  if (!getToken() || !getChatId()) { log('telegram', 'Telegram tidak dikonfigurasi'); return; }
  if (_polling) return;
  _polling = true;
  log('telegram', '✅ Telegram polling aktif (v3.2 Gainer+UTBot)');

  async function poll() {
    if (!_polling) return;
    const updates = await getUpdates();
    for (const update of updates) {
      _offset = update.update_id + 1;
      const msg = update.message;
      if (!msg?.text?.startsWith('/')) continue;
      try { await handleCommand(msg.chat.id, msg.text, callbacks); }
      catch (err) { log('telegram_error', `Handle error: ${err.message}`); }
    }
    if (_polling) _pollTimer = setTimeout(poll, 1000);
  }
  poll();
}

export function stopTelegramPolling() {
  _polling = false;
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
  log('telegram', 'Polling dihentikan');
}
