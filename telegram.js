/**
 * Telegram Notifications — v3.2 Gainer+UTBot
 */
import { log } from './logger.js';
import { getAIStatus } from './aiAnalyst.js';
import { config } from './config.js';

const getToken  = () => process.env.TELEGRAM_BOT_TOKEN;
const getChatId = () => process.env.TELEGRAM_CHAT_ID;
const getBase   = () => { const t = getToken(); return t ? `https://api.telegram.org/bot${t}` : null; };

export function isEnabled() { return !!(getToken() && getChatId()); }

async function send(text) {
  if (!isEnabled()) return;
  try {
    await fetch(`${getBase()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: getChatId(), text, parse_mode: 'HTML' }),
    });
  } catch (err) {
    log('telegram_error', `Gagal kirim: ${err.message}`);
  }
}

async function sendLong(text) {
  const LIMIT = 4000;
  if (text.length <= LIMIT) { await send(text); return; }
  const lines  = text.split('\n');
  let   chunk  = '';
  for (const line of lines) {
    if ((chunk + '\n' + line).length > LIMIT) {
      await send(chunk);
      chunk = line;
      await new Promise(r => setTimeout(r, 300));
    } else {
      chunk = chunk ? chunk + '\n' + line : line;
    }
  }
  if (chunk) await send(chunk);
}

// ── Sanitize HTML ─────────────────────────────────────────────────────────────
function sanitize(text) {
  if (!text) return '—';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/‑/g, '-').replace(/–/g, '-').replace(/—/g, '-')
    .replace(/'/g, "'").replace(/"/g, '"').replace(/"/g, '"')
    .trim();
}

function buildConfBar(pct) {
  const f = Math.round((pct / 100) * 10);
  return '█'.repeat(f) + '░'.repeat(10 - f);
}

function stratLabel(strategy) {
  return {
    gainerUTBot:    '🚀📡 Gainer+UTBot',
    utbot:          '📡 UT Bot Alert',
    manual:         '🖐 Manual',
    dailyGainer:    '🚀 Daily Gainer',
  }[strategy] || '📡 UTBot';
}

// ── BUY Notification ─────────────────────────────────────────────────────────
export async function notifyBuy({ symbol, price, quantity, budget, score, signals, slPrice, entryPortion, zones, strategy, change24h }) {
  const portionLabel =
      entryPortion === 1    ? '📌 Entry 1/2 — 55% posisi'
    : entryPortion === 2    ? '📌 Entry 2/2 — 45% posisi'
    : entryPortion === 'all'? '📌 Full Entry — 100% posisi'
    : '';

  const slPct     = slPrice ? ((slPrice - price) / price * 100) : null;
  const slDisplay = slPrice
    ? `${slPrice.toFixed(6)} (${slPct > 0 ? '⚠️ SL di atas entry!' : slPct.toFixed(2) + '%'})`
    : '-';

  const signalLines = Object.entries(signals || {})
    .filter(([, v]) => v?.bullish)
    .map(([, v]) => `• ${v.label}`)
    .join('\n');

  const lines = [
    `🟢 <b>BUY Executed</b> — ${stratLabel(strategy)}`,
    portionLabel,
    ``,
    `Pair  : <b>${symbol}</b>`,
    `Entry : ${price}`,
    `SL    : ${slDisplay}`,
    `TP1   : Resistance terdekat → tutup 50% + BEP`,
    `TP2+  : Trailing Stop 2% callback`,
    signalLines ? `\n${signalLines}` : '',
    ``,
    `📦 Qty: ${quantity} | Budget: ${budget} USDT`,
  ].filter(l => l !== '').join('\n');

  await send(lines);
}

// ── Approval Request ──────────────────────────────────────────────────────────
export async function notifyApprovalRequest({ candidate, timeoutMin }) {
  const c         = candidate;
  const changeStr = c.change24h >= 0 ? `+${c.change24h?.toFixed(2)}` : c.change24h?.toFixed(2);
  const trig      = c.triggered ? `⚡ <b>TRIGGERED</b>` : `⏳ Pre-alert`;

  const signalLines = Object.entries(c.signals || {})
    .filter(([, v]) => v?.bullish)
    .map(([, v]) => `  • ${v.label}`)
    .join('\n');

  const slLine = c.slPrice ? `SL Ref   : ${c.slPrice.toFixed(6)}` : '';

  const lines = [
    `🔔 <b>Kandidat Ditemukan!</b> — ${stratLabel(c.strategy)}`,
    ``,
    `Pair     : <b>${c.symbol}</b>`,
    `Harga    : ${c.lastPrice}`,
    `Change   : ${changeStr}%`,
    `Vol 24h  : $${(c.vol24h / 1e6).toFixed(1)}M`,
    ``,
    trig,
    ``,
    signalLines ? `<b>✅ Sinyal:</b>\n${signalLines}` : '',
    slLine,
    ``,
    `<b>Perintah:</b>`,
    `/approve ${c.symbol}    → Entry 1 (55%)`,
    `/approve2 ${c.symbol}   → Entry 2 (45%)`,
    `/approveall ${c.symbol} → Full position`,
    `/analyze ${c.symbol}    → AI Analyst`,
    `/skip ${c.symbol}       → Lewati`,
    ``,
    `⏰ Expired dalam ${timeoutMin} menit`,
  ].filter(l => l !== null && l !== undefined).join('\n');

  await sendLong(lines);
}

// ── AI Analysis Report (format baru Gainer+UTBot) ────────────────────────────
export function formatAIAnalysis(symbol, analysis) {
  if (!analysis) return `⚠️ AI analisa untuk <b>${symbol}</b> tidak tersedia.`;

  const vEmoji = { BUY_NOW: '🟢', WAIT: '🟡', SKIP: '🔴' }[analysis.verdict] ?? '⚪';
  const bar    = buildConfBar(analysis.confidence);
  const sEmoji = { BULLISH: '🟢', NEUTRAL: '🟡', BEARISH: '🔴' }[analysis.sentiment?.overall] ?? '⚪';
  const tEmoji = (t) => ({ BULLISH: '🟢', NEUTRAL: '🟡', BEARISH: '🔴' }[t] ?? '⚪');

  const lines = [
    `🤖 <b>AI Analyst Report</b> — ${symbol}`,
    ``,
    `${vEmoji} <b>VERDICT: ${analysis.verdict}</b>`,
    `📊 Confidence: ${bar} ${analysis.confidence}%`,
    ``,
    `📝 <b>Summary</b>`,
    sanitize(analysis.summary),
    ``,
    `🚀 <b>Validasi Momentum Gainer</b>`,
    `• Volume    : ${sanitize(analysis.momentum?.volumeRatio)}`,
    `• RSI Status: ${sanitize(analysis.momentum?.rsiStatus)}`,
    `• Karakter  : ${sanitize(analysis.momentum?.pumpOrBreakout)}`,
    ``,
    `📡 <b>UT Bot Signal</b>`,
    `• SL (Trail): ${sanitize(analysis.utbotSignal?.slLevel)}  (risk ${sanitize(analysis.utbotSignal?.riskPct)})`,
    `• Entry     : ${sanitize(analysis.utbotSignal?.entryIdeal)}`,
    `• TP1       : ${sanitize(analysis.utbotSignal?.tp1Level)}`,
    `• R:R       : ${sanitize(analysis.utbotSignal?.rrRatio)}`,
    ``,
    `📈 <b>Trend Alignment</b> ${analysis.trendAlignment?.aligned ? '✅ Searah' : '⚠️ Tidak searah'}`,
    `• 1D: ${tEmoji(analysis.trendAlignment?.daily)} ${analysis.trendAlignment?.daily ?? '-'}`,
    `• 4H: ${tEmoji(analysis.trendAlignment?.h4)} ${analysis.trendAlignment?.h4 ?? '-'}`,
    `• 1H: ${tEmoji(analysis.trendAlignment?.h1)} ${analysis.trendAlignment?.h1 ?? '-'}`,
    `• ${sanitize(analysis.trendAlignment?.note)}`,
    ``,
    `${sEmoji} <b>Sentiment: ${analysis.sentiment?.overall ?? '-'}</b>`,
    `• Katalis+ : ${sanitize(analysis.sentiment?.catalysts)}`,
    `• Risiko   : ${sanitize(analysis.sentiment?.risks)}`,
    ``,
    `🎯 <b>Key Levels</b>`,
    `• Harga    : ${sanitize(analysis.keyLevels?.currentPrice)}`,
    `• Resist 1 : ${sanitize(analysis.keyLevels?.resistance1)}`,
    `• Support 1: ${sanitize(analysis.keyLevels?.support1)}`,
    `• Kritis   : ${sanitize(analysis.keyLevels?.criticalLevel)}`,
    ``,
    `💡 <b>Rekomendasi</b>`,
    sanitize(analysis.recommendation),
  ];

  if (analysis.verdict === 'BUY_NOW') {
    lines.push(``, `<b>→ Aksi:</b>`, `/approve ${symbol}`, `/approve2 ${symbol}`, `/approveall ${symbol}`);
  } else if (analysis.verdict === 'WAIT') {
    lines.push(``, `<i>Jalankan /analyze ${symbol} lagi saat kondisi berubah.</i>`);
  }

  return lines.join('\n');
}

export async function notifyAIAnalysis(symbol, analysis) {
  const msg = formatAIAnalysis(symbol, analysis);
  await sendLong(msg);
}

// ── SELL Notification ─────────────────────────────────────────────────────────
export async function notifySell({ symbol, entryPrice, exitPrice, pnlPct, pnlUsdt, reason }) {
  const emoji = pnlPct >= 0 ? '🟢' : '🔴';
  const sign  = pnlPct >= 0 ? '+' : '';
  const labels = {
    take_profit:   '🎯 Take Profit',
    tp1_partial:   '🎯 TP1 (50% ditutup) → SL ke BEP',
    stop_loss:     '🛑 Stop Loss',
    break_even_sl: '🔁 Break Even SL',
    trailing_stop: '🔻 Trailing Stop',
    max_hold_time: '⏰ Max Hold Time',
    manual_sell:   '🖐 Manual Sell',
  };
  const extra = reason === 'tp1_partial'  ? `\n📌 Sisa 50% jalan | Trailing 2% aktif`
    : reason === 'break_even_sl'          ? `\n✅ Modal dilindungi`
    : reason === 'trailing_stop'          ? `\n📈 Profit diamankan via trailing`
    : '';
  await send(
    `${emoji} <b>SELL</b> ${symbol}\n` +
    `📌 ${labels[reason] || reason}\n` +
    `📈 Entry: ${entryPrice} → Exit: ${exitPrice}\n` +
    `💵 PnL: ${sign}${pnlPct?.toFixed(2)}% (${sign}${pnlUsdt?.toFixed(2)} USDT)` +
    extra
  );
}

// ── Screening Summary ─────────────────────────────────────────────────────────
export async function notifyScreening({ found, total, symbols, strategy }) {
  if (found === 0) {
    await send(`🔍 <b>${strategy} Selesai</b>\n⚠️ Tidak ada kandidat.`);
    return;
  }
  await send(`🔍 <b>${strategy} Selesai</b>\n✅ ${found} kandidat\nKoin: ${symbols.join(', ')}\n\nMengirim approval request...`);
}

export async function notifyError(message) { await send(`⚠️ <b>Error</b>\n${message}`); }

function getAIInfo() {
  try {
    const s = getAIStatus();
    if (!s.enabled) return '⚠ tidak aktif (set API key di .env)';
    return `✅ ${s.provider} / ${s.model}`;
  } catch { return '—'; }
}

export async function notifyStartup(dryRun) {
  await send(
    `🚀 <b>Bot v3.2 — Gainer+UTBot Pipeline</b>\n` +
    `Mode: ${dryRun ? '🧪 DRY RUN' : '💸 LIVE TRADING'}\n` +
    `📡 Pipeline   : Gainer ≥5% → UTBot 1H\n` +
    `🤖 AI Analyst : ${getAIInfo()} (manual via /analyze)\n` +
    `⚙️  Management : setiap 10 menit\n` +
    `Time: ${new Date().toLocaleString('id-ID')}`
  );
}

export async function notifyStats({ openPositions, closedCount, totalPnlUsdt }) {
  const sign = totalPnlUsdt >= 0 ? '+' : '';
  await send(`📊 <b>Status Bot</b>\n📂 Posisi terbuka: ${openPositions}\n✅ Total closed: ${closedCount}\n💰 Total PnL: ${sign}${totalPnlUsdt?.toFixed(2)} USDT`);
}

// ── UT Bot Alert Notification ─────────────────────────────────────────────────
export async function notifyUTBot(signals) {
  if (!signals?.length) return;
  const buySignals = signals.filter(s => s.signal === 'BUY');
  if (!buySignals.length) return;

  const fmt = (s) => {
    const chg   = s.change24h >= 0 ? `+${s.change24h?.toFixed(2)}%` : `${s.change24h?.toFixed(2)}%`;
    const pos   = s.hasPosition ? ' <b>[POSISI OPEN]</b>' : '';
    const vol   = s.vol24h ? ` | Vol $${(s.vol24h/1e6).toFixed(1)}M` : '';
    return [
      `🟢 <b>${s.symbol}</b>${pos} (${chg}${vol})`,
      `   Price : ${s.close}`,
      `   Trail : ${s.trailingStop?.toFixed(6)}`,
      `   ATR   : ${s.atr?.toFixed(6)}`,
    ].join('\n');
  };

  const lines = [
    `📡 <b>Gainer+UTBot — BUY Signal</b>`,
    `Key: ${config?.screening?.utbot?.keyValue ?? 2} | ATR: ${config?.screening?.utbot?.atrPeriod ?? 10}`,
    ``,
    ...buySignals.map(fmt),
    ``,
    `<i>/analyze SYMBOL untuk AI second opinion sebelum approve</i>`,
  ];
  await sendLong(lines.join('\n'));
}

// Legacy compat
export async function notifyApprovalEntry2({ candidate, timeoutMin }) {
  const z = candidate.zones?.[0];
  if (!z) return;
  await send(
    `📦 <b>Approval Entry 2</b>\n\nPair: <b>${candidate.symbol}</b>\nZone: ${z.label}\n\n` +
    `/approve2 ${candidate.symbol} — Entry 2 (45%)\n/skip ${candidate.symbol} — Lewati\n\n⏰ ${timeoutMin} menit`
  );
}
