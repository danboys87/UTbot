/**
 * AI Analyst — Powered by Claude API
 *
 * Dua mode:
 *  1. analyzeCandidate(candidate, marketData) — dipanggil otomatis setelah screening
 *  2. analyzeOnDemand(symbol, marketData)     — dipanggil via /analyze SYMBOL
 *
 * Output terstruktur:
 *  - verdict      : BUY_NOW | WAIT | SKIP
 *  - confidence   : 0-100
 *  - narrative    : multi-timeframe story
 *  - entryAssessment : zona entry terbaik + timing
 *  - riskReward   : kalkulasi R:R, SL, TP
 *  - sentiment    : ringkasan sentimen market (dari web search)
 *  - recommendation: kalimat akhir untuk user
 */

import { getCandles } from './bitget.js';
import { calcEMA, calcRSI, calcMACD, calcBollinger, calcADX } from './indicators.js';
import { log } from './logger.js';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL         = 'claude-sonnet-4-20250514';

// ─────────────────────────────────────────────────────────────────────────────
// Helper: panggil Claude API
// ─────────────────────────────────────────────────────────────────────────────
async function callClaude({ systemPrompt, userPrompt, useWebSearch = false, maxTokens = 1500 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    log('ai_analyst', 'ANTHROPIC_API_KEY tidak dikonfigurasi, skip AI analisa');
    return null;
  }

  const body = {
    model:      MODEL,
    max_tokens: maxTokens,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userPrompt }],
  };

  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }

  try {
    const res  = await fetch(ANTHROPIC_API, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Claude API ${res.status}: ${err}`);
    }

    const data = await res.json();

    // Gabungkan semua text block dari response (termasuk setelah tool use)
    const fullText = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    return fullText || null;

  } catch (err) {
    log('ai_analyst_error', `Claude API error: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: kumpulkan market data dari candle
// ─────────────────────────────────────────────────────────────────────────────
async function buildMarketData(symbol) {
  try {
    const [raw1D, raw4H, raw1H] = await Promise.all([
      getCandles(symbol, '1day', 60),
      getCandles(symbol, '4h',   100),
      getCandles(symbol, '1H',   50),
    ]);

    const parse = (raw) => {
      if (!Array.isArray(raw) || raw.length === 0) return null;
      const candles = raw.slice().reverse();
      const closes  = candles.map(c => parseFloat(c[4]));
      const highs   = candles.map(c => parseFloat(c[2]));
      const lows    = candles.map(c => parseFloat(c[3]));
      const vols    = candles.map(c => parseFloat(c[5]));

      const last   = candles[candles.length - 1];
      const prev   = candles[candles.length - 2];

      return {
        currentPrice: parseFloat(last[4]),
        open:    parseFloat(last[1]),
        high:    parseFloat(last[2]),
        low:     parseFloat(last[3]),
        close:   parseFloat(last[4]),
        volume:  parseFloat(last[5]),
        prevClose: parseFloat(prev?.[4] ?? last[4]),
        change:  ((parseFloat(last[4]) - parseFloat(prev?.[4] ?? last[4])) / parseFloat(prev?.[4] ?? last[4]) * 100).toFixed(2),

        // Indicators
        ema21:   calcEMA(closes, 21),
        ema9:    calcEMA(closes, 9),
        ema50:   calcEMA(closes, 50),
        rsi14:   calcRSI(closes, 14),
        macd:    calcMACD(closes),
        bb:      calcBollinger(closes),
        adx:     calcADX(highs, lows, closes, 14),

        // Swing levels
        high20:  Math.max(...highs.slice(-20)),
        low20:   Math.min(...lows.slice(-20)),
        high5:   Math.max(...highs.slice(-5)),
        low5:    Math.min(...lows.slice(-5)),

        // Volume
        avgVol10: vols.slice(-11, -1).reduce((s, v) => s + v, 0) / 10,
        lastVol:  parseFloat(last[5]),
      };
    };

    return {
      '1D': parse(raw1D),
      '4H': parse(raw4H),
      '1H': parse(raw1H),
    };
  } catch (err) {
    log('ai_analyst_error', `Build market data error ${symbol}: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: format market data ke string ringkas untuk prompt
// ─────────────────────────────────────────────────────────────────────────────
function formatMarketDataForPrompt(symbol, md, candidate) {
  const fmt = (tf, d) => {
    if (!d) return `${tf}: Data tidak tersedia`;
    return [
      `[${tf}]`,
      `  Price : ${d.currentPrice} | Change: ${d.change}%`,
      `  EMA9  : ${d.ema9?.toFixed(6) ?? 'N/A'} | EMA21: ${d.ema21?.toFixed(6) ?? 'N/A'} | EMA50: ${d.ema50?.toFixed(6) ?? 'N/A'}`,
      `  RSI14 : ${d.rsi14?.toFixed(1) ?? 'N/A'}`,
      `  MACD  : ${d.macd ? `line=${d.macd.macd.toFixed(6)} signal=${d.macd.signal.toFixed(6)} hist=${d.macd.histogram.toFixed(6)}` : 'N/A'}`,
      `  BB    : ${d.bb ? `upper=${d.bb.upper.toFixed(6)} mid=${d.bb.middle.toFixed(6)} lower=${d.bb.lower.toFixed(6)} %B=${d.bb.pctB.toFixed(2)}` : 'N/A'}`,
      `  ADX   : ${d.adx ? `adx=${d.adx.adx.toFixed(1)} +DI=${d.adx.plusDI.toFixed(1)} -DI=${d.adx.minusDI.toFixed(1)}` : 'N/A'}`,
      `  H/L 20: ${d.high20?.toFixed(6)} / ${d.low20?.toFixed(6)}`,
      `  H/L 5 : ${d.high5?.toFixed(6)} / ${d.low5?.toFixed(6)}`,
      `  Vol   : ${d.lastVol?.toFixed(0)} (avg10: ${d.avgVol10?.toFixed(0)}) ratio=${d.avgVol10 > 0 ? (d.lastVol / d.avgVol10).toFixed(2) : 'N/A'}x`,
    ].join('\n');
  };

  // Screener signals jika dari MTF
  const signals = candidate?.signals
    ? '\nSCREENER SIGNALS:\n' + Object.entries(candidate.signals)
        .map(([k, v]) => `  ${k}: ${v.bullish ? '✅' : '❌'} ${v.label}`)
        .join('\n')
    : '';

  // Entry zones jika tersedia
  const zones = candidate?.zones
    ? '\nDETECTED ENTRY ZONES:\n' + candidate.zones
        .map(z => `  Zone ${z.entryPct}% (${z.type}): ${z.priceBottom?.toFixed(6)} - ${z.priceTop?.toFixed(6)}`)
        .join('\n')
    : '';

  const slInfo = candidate?.slPrice
    ? `\nSL REFERENCE: ${candidate.slPrice.toFixed(6)}`
    : '';

  return [
    `SYMBOL: ${symbol}`,
    fmt('1D', md['1D']),
    fmt('4H', md['4H']),
    fmt('1H', md['1H']),
    signals,
    zones,
    slInfo,
  ].filter(Boolean).join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Ambil sentimen market via web search
// ─────────────────────────────────────────────────────────────────────────────
async function getSentimentAnalysis(symbol) {
  const coinName = symbol.replace('USDT', '');

  const sentimentRaw = await callClaude({
    useWebSearch: true,
    maxTokens:    800,
    systemPrompt: `You are a crypto market sentiment analyst. Search for recent news and sentiment about the given cryptocurrency. 
Be concise and factual. Focus on:
1. Recent major news (last 7 days)
2. Overall market sentiment (bullish/bearish/neutral)
3. Any major catalysts or risks
4. Social/community sentiment

Respond in Indonesian language. Keep it under 200 words. Be direct and honest.`,

    userPrompt: `Cari dan analisa sentimen market terkini untuk ${coinName} (${symbol}). 
Fokus pada berita 7 hari terakhir, sentimen komunitas, dan faktor fundamental yang relevan saat ini.`,
  });

  return sentimentRaw || `Tidak dapat mengambil data sentimen untuk ${coinName} saat ini.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Analisa teknikal + gabungkan dengan sentimen → verdict final
// ─────────────────────────────────────────────────────────────────────────────
async function getTechnicalAnalysis(symbol, marketDataStr, sentimentSummary, candidate) {
  const systemPrompt = `Kamu adalah AI Trading Analyst senior yang spesialis di crypto swing trading dengan pendekatan Smart Money Concept (SMC) dan Multi-Timeframe Analysis (MTF).

PERANMU:
- Analisa data teknikal dari 3 timeframe (1D, 4H, 1H)
- Evaluasi setup berdasarkan SOP trading profesional
- Gabungkan analisa teknikal dengan sentimen market
- Berikan rekomendasi tegas dengan reasoning yang jelas

SOP YANG DIGUNAKAN:
1. 1D: Bullish jika price > EMA21 + ada BoS/ChoCh bullish
2. 4H: Entry di Unmitigated Order Block / Demand Zone atau EMA21
3. 1H: Konfirmasi via Pinbar, Bullish Engulfing, atau ChoCh
4. Entry: Split 30% di EMA21, 70% di core demand zone
5. SL: Di bawah demand zone terbawah - 0.5% buffer (TIDAK boleh digeser)
6. TP1: Nearest resistance → tutup 50% → geser SL ke BEP
7. TP2+: Trailing stop 1.5% callback

FORMAT RESPONSE — wajib ikuti format JSON ini persis:
{
  "verdict": "BUY_NOW" | "WAIT" | "SKIP",
  "confidence": <angka 0-100>,
  "summary": "<1-2 kalimat ringkasan situasi>",
  "narrative": {
    "1D": "<analisa trend harian>",
    "4H": "<analisa zona entry dan struktur>",
    "1H": "<kondisi trigger dan momentum>",
    "convergence": "<apakah 3 TF align? kesimpulan>"
  },
  "entryAssessment": {
    "bestEntry": "<harga entry terbaik atau zona>",
    "timing": "IMMEDIATE" | "WAIT_PULLBACK" | "WAIT_BREAKOUT" | "NOT_RECOMMENDED",
    "zone1": "<assessment zona EMA21 entry 30%>",
    "zone2": "<assessment OB/demand zone entry 70%>",
    "quality": "A+" | "A" | "B" | "C" | "D"
  },
  "riskReward": {
    "slLevel": "<harga SL yang disarankan>",
    "tp1Level": "<harga TP1 target>",
    "tp2EstRange": "<estimasi range TP2>",
    "rrRatio": "<misal 1:2.5>",
    "riskPct": "<% risiko dari entry ke SL>",
    "assessment": "<layak atau tidak berdasarkan minimum RR 1:2>"
  },
  "sentiment": {
    "overall": "BULLISH" | "NEUTRAL" | "BEARISH",
    "summary": "<ringkasan sentimen>",
    "catalysts": "<faktor positif>",
    "risks": "<faktor risiko>"
  },
  "keyLevels": {
    "strongSupport": "<level support terkuat>",
    "strongResistance": "<level resistance terkuat>",
    "criticalLevel": "<level yang harus diperhatikan>"
  },
  "recommendation": "<kalimat rekomendasi final 2-3 kalimat, dalam Bahasa Indonesia, tegas dan actionable>"
}

PENTING: Response harus berupa JSON valid saja, tanpa teks di luar JSON.`;

  const userPrompt = `Analisa trading setup untuk ${symbol}:

=== DATA TEKNIKAL ===
${marketDataStr}

=== SENTIMEN MARKET (dari web search) ===
${sentimentSummary}

Berikan analisa lengkap sesuai format yang diminta. Jika setup tidak memenuhi SOP minimum (RR < 1:2, SL terlalu jauh, tidak ada konfirmasi), tetap berikan verdict SKIP atau WAIT dengan alasan jelas.`;

  const raw = await callClaude({
    systemPrompt,
    userPrompt,
    useWebSearch: false,
    maxTokens:    2000,
  });

  if (!raw) return null;

  // Parse JSON dari response
  try {
    // Bersihkan jika ada markdown fence
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    log('ai_analyst_error', `Gagal parse JSON dari Claude: ${err.message}`);
    log('ai_analyst_error', `Raw response: ${raw.slice(0, 200)}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN: analyzeCandidate — otomatis setelah screening
// ─────────────────────────────────────────────────────────────────────────────
export async function analyzeCandidate(candidate) {
  const { symbol } = candidate;
  log('ai_analyst', `🤖 Memulai AI analisa untuk ${symbol}...`);

  try {
    // Fetch market data fresh (lebih lengkap dari data screening)
    const marketData = await buildMarketData(symbol);
    if (!marketData) {
      log('ai_analyst_error', `Tidak bisa build market data untuk ${symbol}`);
      return null;
    }

    const marketDataStr = formatMarketDataForPrompt(symbol, marketData, candidate);

    // Step 1: Sentimen via web search (paralel tidak bisa karena Anthropic rate limit)
    log('ai_analyst', `  → Mengambil sentimen market ${symbol}...`);
    const sentiment = await getSentimentAnalysis(symbol);

    // Step 2: Analisa teknikal + gabung sentimen
    log('ai_analyst', `  → Menjalankan analisa teknikal ${symbol}...`);
    const analysis = await getTechnicalAnalysis(symbol, marketDataStr, sentiment, candidate);

    if (!analysis) {
      log('ai_analyst_error', `Analisa AI gagal untuk ${symbol}`);
      return null;
    }

    log('ai_analyst', `✅ Analisa selesai: ${symbol} → ${analysis.verdict} (confidence: ${analysis.confidence}%)`);
    return analysis;

  } catch (err) {
    log('ai_analyst_error', `analyzeCandidate error ${symbol}: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN: analyzeOnDemand — dipanggil via /analyze SYMBOL
// ─────────────────────────────────────────────────────────────────────────────
export async function analyzeOnDemand(symbol) {
  log('ai_analyst', `🤖 On-demand AI analisa: ${symbol}`);

  try {
    const marketData = await buildMarketData(symbol);
    if (!marketData) return null;

    const marketDataStr = formatMarketDataForPrompt(symbol, marketData, null);

    log('ai_analyst', `  → Sentimen...`);
    const sentiment = await getSentimentAnalysis(symbol);

    log('ai_analyst', `  → Analisa teknikal...`);
    const analysis = await getTechnicalAnalysis(symbol, marketDataStr, sentiment, null);

    return analysis;
  } catch (err) {
    log('ai_analyst_error', `analyzeOnDemand error ${symbol}: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Format analysis result ke Telegram message
// ─────────────────────────────────────────────────────────────────────────────
export function formatAnalysisForTelegram(symbol, analysis) {
  if (!analysis) {
    return `⚠️ AI analisa untuk <b>${symbol}</b> tidak tersedia saat ini.`;
  }

  const verdictEmoji = {
    BUY_NOW: '🟢',
    WAIT:    '🟡',
    SKIP:    '🔴',
  }[analysis.verdict] ?? '⚪';

  const confidenceBar = buildConfidenceBar(analysis.confidence);

  const timingLabel = {
    IMMEDIATE:        '⚡ Segera',
    WAIT_PULLBACK:    '⏳ Tunggu pullback ke zone',
    WAIT_BREAKOUT:    '📈 Tunggu breakout konfirmasi',
    NOT_RECOMMENDED:  '🚫 Tidak disarankan',
  }[analysis.entryAssessment?.timing] ?? analysis.entryAssessment?.timing;

  const sentimentEmoji = {
    BULLISH:  '🟢',
    NEUTRAL:  '🟡',
    BEARISH:  '🔴',
  }[analysis.sentiment?.overall] ?? '⚪';

  const lines = [
    `🤖 <b>AI Analyst Report — ${symbol}</b>`,
    ``,
    `${verdictEmoji} <b>VERDICT: ${analysis.verdict}</b>`,
    `📊 Confidence: ${confidenceBar} ${analysis.confidence}%`,
    ``,
    `📝 <b>Summary</b>`,
    analysis.summary,
    ``,
    `📈 <b>Multi-Timeframe Narrative</b>`,
    `• 1D: ${analysis.narrative?.['1D'] ?? '-'}`,
    `• 4H: ${analysis.narrative?.['4H'] ?? '-'}`,
    `• 1H: ${analysis.narrative?.['1H'] ?? '-'}`,
    `• ⚡ ${analysis.narrative?.convergence ?? '-'}`,
    ``,
    `📍 <b>Entry Assessment</b> (Grade: ${analysis.entryAssessment?.quality ?? '-'})`,
    `• Timing : ${timingLabel}`,
    `• Best Entry: ${analysis.entryAssessment?.bestEntry ?? '-'}`,
    `• Zone 1 (30%): ${analysis.entryAssessment?.zone1 ?? '-'}`,
    `• Zone 2 (70%): ${analysis.entryAssessment?.zone2 ?? '-'}`,
    ``,
    `⚖️ <b>Risk/Reward</b>`,
    `• SL      : ${analysis.riskReward?.slLevel ?? '-'} (risk ${analysis.riskReward?.riskPct ?? '-'})`,
    `• TP1     : ${analysis.riskReward?.tp1Level ?? '-'}`,
    `• TP2 est : ${analysis.riskReward?.tp2EstRange ?? '-'}`,
    `• R:R     : ${analysis.riskReward?.rrRatio ?? '-'} — ${analysis.riskReward?.assessment ?? '-'}`,
    ``,
    `${sentimentEmoji} <b>Market Sentiment</b>`,
    `• Overall   : ${analysis.sentiment?.overall ?? '-'}`,
    `• Situasi   : ${analysis.sentiment?.summary ?? '-'}`,
    `• Katalis + : ${analysis.sentiment?.catalysts ?? '-'}`,
    `• Risiko    : ${analysis.sentiment?.risks ?? '-'}`,
    ``,
    `🎯 <b>Key Levels</b>`,
    `• Support kuat  : ${analysis.keyLevels?.strongSupport ?? '-'}`,
    `• Resistance    : ${analysis.keyLevels?.strongResistance ?? '-'}`,
    `• Level kritis  : ${analysis.keyLevels?.criticalLevel ?? '-'}`,
    ``,
    `💡 <b>Rekomendasi</b>`,
    analysis.recommendation,
  ];

  // Tambahkan perintah approve jika verdict BUY_NOW
  if (analysis.verdict === 'BUY_NOW') {
    lines.push(``);
    lines.push(`<b>→ Aksi:</b>`);
    lines.push(`/approve ${symbol}    — Entry 1 (30%)`);
    lines.push(`/approve2 ${symbol}   — Entry 2 (70%)`);
    lines.push(`/approveall ${symbol} — Full position`);
  } else if (analysis.verdict === 'WAIT') {
    lines.push(``);
    lines.push(`<i>Set alert di TradingView pada level yang disebutkan, lalu /analyze ${symbol} lagi saat harga mendekati zone.</i>`);
  }

  return lines.join('\n');
}

// Helper: build confidence bar visual
function buildConfidenceBar(pct) {
  const filled = Math.round((pct / 100) * 10);
  const empty  = 10 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}
