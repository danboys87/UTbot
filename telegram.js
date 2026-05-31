/**
 * Telegram Notifications — v3.1 AI Analyst
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

// ── Kirim pesan panjang dengan auto-split ≤4096 char ─────────────────────────
async function sendLong(text) {
  const LIMIT = 4000;
  if (text.length <= LIMIT) { await send(text); return; }
  // Split per baris supaya tidak putus di tengah tag HTML
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

// ── BUY Notification ─────────────────────────────────────────────────────────
export async function notifyBuy({ symbol, price, quantity, budget, score, signals, slPrice, entryPortion, zones, strategy, change24h }) {
  const stratLabel =
    strategy === 'mtfSmartMoney'   ? '🧠 MTF Smart Money'
  : strategy === 'reversal'        ? '🔄 Reversal Hunter'
  : strategy === 'trendFollowing'  ? '📈 Trend Following'
  : strategy === 'utbot'           ? '📡 UT Bot Alert'
  : strategy === 'manual'          ? '🖐 Manual'
  :                                  '🚀 Daily Gainer';

  const portionLabel =
      entryPortion === 1   ? '📌 Entry 1/2 — 55% posisi (EMA21 zone)'
    : entryPortion === 2   ? '📌 Entry 2/2 — 45% posisi (OB/Demand zone)'
    : entryPortion === 'all'? '📌 Full Entry — 100% posisi'
    : '';

  // SL selalu di bawah entry → persentase negatif
  const slPct     = slPrice ? ((slPrice - price) / price * 100) : null;
  const slDisplay = slPrice
    ? `${slPrice.toFixed(6)} (${slPct > 0 ? '⚠️ SL di atas entry! Cek config' : slPct.toFixed(2) + '%'})`
    : '-';

  const signalLines = [];
  if (signals?.trend1D?.bullish)    signalLines.push(`• ${signals.trend1D.label}`);
  if (signals?.demandZone?.bullish) signalLines.push(`• ${signals.demandZone.label}`);
  if (signals?.trigger1H?.bullish)  signalLines.push(`• ${signals.trigger1H.label}`);
  if (signals?.orderBlocks?.count)  signalLines.push(`• ${signals.orderBlocks.label}`);
  if (signals?.emaStack?.bullish)   signalLines.push(`• ${signals.emaStack.label}`);
  if (signals?.adx?.bullish)        signalLines.push(`• ${signals.adx.label}`);

  const lines = [
    `🟢 <b>BUY Executed</b> — ${stratLabel}`,
    portionLabel,
    ``,
    `Pair    : <b>${symbol}</b>`,
    `Entry   : ${price}`,
    `SL      : ${slDisplay}`,
    `TP1     : Nearest Resistance → tutup 50% + BEP`,
    `TP2+    : Trailing Stop 1.5% callback`,
    ``,
    signalLines.length ? signalLines.join('\n') : '',
    ``,
    `📦 Qty: ${quantity} | Budget: ${budget} USDT`,
  ].filter(l => l !== '').join('\n');

  await send(lines);
}

// ── Approval Request MTF (dengan AI verdict) ──────────────────────────────────
export async function notifyApprovalRequest({ candidate, timeoutMin }) {
  const c          = candidate;
  const stratLabel =
    strategy === 'mtfSmartMoney'   ? '🧠 MTF Smart Money'
  : strategy === 'reversal'        ? '🔄 Reversal Hunter'
  : strategy === 'trendFollowing'  ? '📈 Trend Following'
  : strategy === 'utbot'           ? '📡 UT Bot Alert'
  : strategy === 'manual'          ? '🖐 Manual'
  :                                  '🚀 Daily Gainer';

  const changeStr  = c.change24h >= 0 ? `+${c.change24h.toFixed(2)}` : c.change24h.toFixed(2);
  const trig       = c.triggered ? `⚡ <b>1H TRIGGERED</b>` : `⏳ Pre-alert (belum trigger 1H)`;

  const signalLines = Object.entries(c.signals || {})
    .filter(([, v]) => v?.bullish)
    .map(([, v]) => `  • ${v.label}`)
    .join('\n');

  const zoneLines = (c.zones || [])
    .map((z, i) => `  Zone ${i + 1} (${z.entryPct}%): ${z.label}`)
    .join('\n');

  const slLine = c.slPrice ? `SL Ref   : ${c.slPrice.toFixed(6)}` : '';

  // AI Verdict block
  let aiBlock = '';
  if (c.aiAnalysis) {
    const ai = c.aiAnalysis;
    const vEmoji = { BUY_NOW: '🟢', WAIT: '🟡', SKIP: '🔴' }[ai.verdict] ?? '⚪';
    const bar    = buildConfBar(ai.confidence);
    aiBlock = [
      ``,
      `🤖 <b>AI Analyst:</b>`,
      `${vEmoji} Verdict   : <b>${ai.verdict}</b>`,
      `📊 Confidence: ${bar} ${ai.confidence}%`,
      `📝 ${ai.summary}`,
      ``,
      `• R:R   : ${ai.riskReward?.rrRatio ?? '-'}`,
      `• Entry : ${ai.entryAssessment?.timing ?? '-'} (Grade ${ai.entryAssessment?.quality ?? '-'})`,
      `• Sentimen: ${ai.sentiment?.overall ?? '-'} — ${ai.sentiment?.summary ?? ''}`,
      ``,
      `💡 ${ai.recommendation}`,
    ].join('\n');
  } else if (process.env.ANTHROPIC_API_KEY) {
    aiBlock = `\n🤖 <i>AI analisa sedang diproses...</i>`;
  }

  const lines = [
    `🔔 <b>Kandidat Ditemukan!</b> — ${stratLabel}`,
    ``,
    `Pair     : <b>${c.symbol}</b>`,
    `Harga    : ${c.lastPrice}`,
    `Change   : ${changeStr}%`,
    `Vol 24h  : $${(c.vol24h / 1e6).toFixed(1)}M`,
    ``,
    trig,
    aiBlock,
    ``,
    `<b>📍 Entry Zones:</b>`,
    zoneLines || '  -',
    slLine,
    signalLines ? `\n<b>✅ Sinyal:</b>\n${signalLines}` : '',
    ``,
    `<b>Perintah:</b>`,
    `/approve ${c.symbol}    → Entry 1 (55%)`,
    `/approve2 ${c.symbol}   → Entry 2 (45%)`,
    `/approveall ${c.symbol} → Full position`,
    `/analyze ${c.symbol}    → Detail AI analisa`,
    `/skip ${c.symbol}       → Lewati`,
    ``,
    `⏰ Expired dalam ${timeoutMin} menit`,
  ].filter(l => l !== null && l !== undefined).join('\n');

  await sendLong(lines);
}

// ── Notif AI analysis penuh (on-demand) ──────────────────────────────────────
export async function notifyAIAnalysis(symbol, analysis) {
  const msg = formatAIAnalysis(symbol, analysis);
  await sendLong(msg);
}

// Sanitize teks dari AI — hapus karakter yang bisa break HTML Telegram
function sanitize(text) {
  if (!text) return '—';
  return String(text)
    .replace(/&/g, '&amp;')    // & harus di-escape
    .replace(/</g, '&lt;')     // < yang bukan tag HTML
    .replace(/>/g, '&gt;')     // > yang bukan tag HTML
    .replace(/‑/g, '-')   // non-breaking hyphen
    .replace(/–/g, '-')   // en dash
    .replace(/—/g, '-')   // em dash
    .replace(/’/g, "'")   // right single quotation
    .replace(/“/g, '"')   // left double quotation
    .replace(/”/g, '"')   // right double quotation
    .trim();
}

export function formatAIAnalysis(symbol, analysis) {
  if (!analysis) return `⚠️ AI analisa untuk <b>${symbol}</b> tidak tersedia.`;

  const vEmoji  = { BUY_NOW: '🟢', WAIT: '🟡', SKIP: '🔴' }[analysis.verdict] ?? '⚪';
  const bar     = buildConfBar(analysis.confidence);
  const sEmoji  = { BULLISH: '🟢', NEUTRAL: '🟡', BEARISH: '🔴' }[analysis.sentiment?.overall] ?? '⚪';
  const timing  = {
    IMMEDIATE:       '⚡ Segera',
    WAIT_PULLBACK:   '⏳ Tunggu pullback ke zone',
    WAIT_BREAKOUT:   '📈 Tunggu breakout',
    NOT_RECOMMENDED: '🚫 Tidak disarankan',
  }[analysis.entryAssessment?.timing] ?? (analysis.entryAssessment?.timing ?? '-');

  const lines = [
    `🤖 <b>AI Analyst Report</b> — ${symbol}`,
    ``,
    `${vEmoji} <b>VERDICT: ${analysis.verdict}</b>`,
    `📊 Confidence: ${bar} ${analysis.confidence}%`,
    ``,
    `📝 <b>Summary</b>`,
    sanitize(analysis.summary),
    ``,
    `📈 <b>Multi-Timeframe Narrative</b>`,
    `• 1D : ${sanitize(analysis.narrative?.['1D'])}`,
    `• 4H : ${sanitize(analysis.narrative?.['4H'])}`,
    `• 1H : ${sanitize(analysis.narrative?.['1H'])}`,
    `• ⚡  ${sanitize(analysis.narrative?.convergence)}`,
    ``,
    `📍 <b>Entry Assessment</b> (Grade: ${analysis.entryAssessment?.quality ?? '-'})`,
    `• Timing    : ${timing}`,
    `• Best Entry: ${sanitize(analysis.entryAssessment?.bestEntry)}`,
    `• Zone 1 30%: ${sanitize(analysis.entryAssessment?.zone1)}`,
    `• Zone 2 70%: ${sanitize(analysis.entryAssessment?.zone2)}`,
    ``,
    `⚖️ <b>Risk / Reward</b>`,
    `• SL       : ${sanitize(analysis.riskReward?.slLevel)} (risk ${sanitize(analysis.riskReward?.riskPct)})`,
    `• TP1      : ${sanitize(analysis.riskReward?.tp1Level)}`,
    `• TP2 est  : ${sanitize(analysis.riskReward?.tp2EstRange)}`,
    `• R:R      : ${sanitize(analysis.riskReward?.rrRatio)} — ${sanitize(analysis.riskReward?.assessment)}`,
    ``,
    `${sEmoji} <b>Market Sentiment</b>`,
    `• Overall  : ${analysis.sentiment?.overall ?? '-'}`,
    `• Situasi  : ${sanitize(analysis.sentiment?.summary)}`,
    `• Katalis+ : ${sanitize(analysis.sentiment?.catalysts)}`,
    `• Risiko   : ${sanitize(analysis.sentiment?.risks)}`,
    ``,
    `🎯 <b>Key Levels</b>`,
    `• Support  : ${sanitize(analysis.keyLevels?.strongSupport)}`,
    `• Resist   : ${sanitize(analysis.keyLevels?.strongResistance)}`,
    `• Kritis   : ${sanitize(analysis.keyLevels?.criticalLevel)}`,
    ``,
    `💡 <b>Rekomendasi</b>`,
    sanitize(analysis.recommendation),
  ];

  if (analysis.verdict === 'BUY_NOW') {
    lines.push(``, `<b>→ Aksi:</b>`, `/approve ${symbol}`, `/approve2 ${symbol}`, `/approveall ${symbol}`);
  } else if (analysis.verdict === 'WAIT') {
    lines.push(``, `<i>Jalankan /analyze ${symbol} lagi saat harga mendekati zone.</i>`);
  }

  return lines.join('\n');
}

function buildConfBar(pct) {
  const f = Math.round((pct / 100) * 10);
  return '█'.repeat(f) + '░'.repeat(10 - f);
}

// ── SELL Notification ─────────────────────────────────────────────────────────
export async function notifySell({ symbol, entryPrice, exitPrice, pnlPct, pnlUsdt, reason }) {
  const emoji = pnlPct >= 0 ? '🟢' : '🔴';
  const sign  = pnlPct >= 0 ? '+' : '';
  const labels = {
    take_profit:   '🎯 Take Profit',
    tp1_partial:   '🎯 TP1 (50% ditutup) → SL ke BEP',
    stop_loss:     '🛑 Stop Loss',
    break_even_sl: '🔁 Break Even SL (modal aman)',
    trailing_stop: '🔻 Trailing Stop',
    max_hold_time: '⏰ Max Hold Time',
    manual_sell:   '🖐 Manual Sell',
  };
  const extra = reason === 'tp1_partial'  ? `\n📌 Sisa 50% jalan | Trailing 1.5% aktif`
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
    await send(`🔍 <b>${strategy} Selesai</b>\n⚠️ Tidak ada kandidat dari ${total} koin.`);
    return;
  }
  await send(`🔍 <b>${strategy} Selesai</b>\n✅ ${found} kandidat dari ${total} koin\nKoin: ${symbols.join(', ')}\n\nMengirim approval request...`);
}

export async function notifyError(message) { await send(`⚠️ <b>Error</b>\n${message}`); }


function getAIInfo() {
  try {
    const s = getAIStatus();
    if (!s.enabled) return '⚠ tidak aktif (set GEMINI_API_KEY atau ANTHROPIC_API_KEY)';
    return `✅ ${s.provider} / ${s.model}`;
  } catch { return '—'; }
}

export async function notifyStartup(dryRun) {
  await send(
    `🚀 <b>Bot v3.1 — MTF Smart Money + AI Analyst</b>\n` +
    `Mode: ${dryRun ? '🧪 DRY RUN' : '💸 LIVE TRADING'}\n` +
    `📅 MTF Screening : 07:00 WIB\n` +
    `🤖 AI Analyst    : ${getAIInfo()}\n` +
    `⚙️  Management    : setiap 10 menit\n` +
    `Time: ${new Date().toLocaleString('id-ID')}`
  );
}

export async function notifyStats({ openPositions, closedCount, totalPnlUsdt }) {
  const sign = totalPnlUsdt >= 0 ? '+' : '';
  await send(`📊 <b>Status Bot</b>\n📂 Posisi terbuka: ${openPositions}\n✅ Total closed: ${closedCount}\n💰 Total PnL: ${sign}${totalPnlUsdt?.toFixed(2)} USDT`);
}


// ── Pre-Alert Notification (1H belum trigger) ─────────────────────────────
export async function notifyPreAlert(candidates) {
  if (!candidates?.length) return;
  const lines = [
    `⏳ <b>Pre-Alert — Pantau Koin Ini</b>`,
    ``,
    `Lolos 1D + 4H tapi 1H belum konfirmasi.`,
    `Set alert TradingView, approve saat harga mendekati zone.`,
    ``,
  ];
  for (const c of candidates) {
    const chg  = c.change24h >= 0 ? `+${c.change24h?.toFixed(2)}%` : `${c.change24h?.toFixed(2)}%`;
    const z1   = c.entryZone1;
    const z2   = c.entryZone2;
    lines.push(`📌 <b>${c.symbol}</b> (${chg}) | Vol $${(c.vol24h/1e6).toFixed(1)}M`);
    lines.push(`   Price skrg  : ${c.lastPrice}`);
    if (z1) lines.push(`   EMA21 zone : ${z1.priceBottom?.toFixed(4)} – ${z1.priceTop?.toFixed(4)}`);
    if (z2) lines.push(`   Demand zone: ${z2.priceBottom?.toFixed(4)} – ${z2.priceTop?.toFixed(4)}`);
    if (c.slPrice) lines.push(`   SL ref     : ${c.slPrice?.toFixed(4)}`);
    lines.push(`   /analyze ${c.symbol} — minta AI analisa manual`);
    lines.push(``);
  }
  await sendLong(lines.join('\n'));
}

// ── UT Bot Alert Notification ─────────────────────────────────────────────────
export async function notifyUTBot(signals) {
  if (!signals?.length) return;

  const buySignals  = signals.filter(s => s.signal === 'BUY');
  const sellSignals = signals.filter(s => s.signal === 'SELL');

  const fmt = (s) => {
    const chg   = s.change24h >= 0 ? `+${s.change24h?.toFixed(2)}%` : `${s.change24h?.toFixed(2)}%`;
    const pos   = s.hasPosition ? ' <b>[POSISI OPEN]</b>' : '';
    const vol   = s.vol24h ? ` | Vol $${(s.vol24h/1e6).toFixed(1)}M` : '';
    const emoji = s.signal === 'BUY' ? '🟢' : '🔴';
    return [
      `${emoji} <b>${s.symbol}</b>${pos} (${chg}${vol})`,
      `   Price : ${s.close}`,
      `   Trail : ${s.trailingStop?.toFixed(6)}`,
      `   ATR   : ${s.atr?.toFixed(6)}`,
      s.signal === 'BUY'
        ? `   /buy ${s.symbol} — beli manual`
        : `   /sell ${s.symbol} — jual posisi`,
    ].join('\n');
  };

  if (buySignals.length > 0) {
    const lines = [
      `📡 <b>UT Bot Alert — BUY Signal (1H)</b>`,
      `Key: ${config?.screening?.utbot?.keyValue ?? 1} | ATR: ${config?.screening?.utbot?.atrPeriod ?? 10}`,
      ``,
      ...buySignals.map(fmt),
      ``,
      `<i>Filter 1D aktif — sinyal sudah dikonfirmasi trend harian</i>`,
    ];
    await sendLong(lines.join('\n'));
  }

  // SELL signal disembunyikan — management cycle yang handle exit
  // Uncomment blok di bawah kalau mau notif SELL dimunculkan lagi:
  /*
  if (sellSignals.length > 0) {
    const lines = [
      `📡 <b>UT Bot Alert — SELL Signal (1H)</b>`,
      `Key: ${config?.screening?.utbot?.keyValue ?? 1} | ATR: ${config?.screening?.utbot?.atrPeriod ?? 10}`,
      ``,
      ...sellSignals.map(fmt),
    ];
    await sendLong(lines.join('\n'));
  }
  */
}

// Legacy compat
export async function notifyApprovalEntry2({ candidate, timeoutMin }) {
  const z = candidate.entryZone2;
  if (!z) return;
  await send(
    `📦 <b>Harga Mendekati Demand Zone!</b>\n\nPair: <b>${candidate.symbol}</b>\nZone: ${z.label}\n\n` +
    `/approve2 ${candidate.symbol} — Entry 2 (70%)\n/skip ${candidate.symbol} — Lewati\n\n⏰ ${timeoutMin} menit`
  );
}
