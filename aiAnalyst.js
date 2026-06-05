/**
 * AI Analyst — Multi-Provider
 * Digunakan untuk analisa manual via /analyze SYMBOL dari Telegram.
 *
 * Provider yang didukung (set di .env):
 *   AI_PROVIDER=openrouter
 *   AI_PROVIDER=gemini
 *   AI_PROVIDER=claude
 */

import { getCandles, getCurrentPrice } from './bitget.js';
import { calcEMA, calcRSI, calcMACD, calcBollinger, calcADX } from './indicators.js';
import { log } from './logger.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────
// Provider helpers
// ─────────────────────────────────────────────────────────────────────────────
function getProvider() {
  return (process.env.AI_PROVIDER || 'openrouter').toLowerCase();
}

export function isAIEnabled() {
  const p = getProvider();
  if (p === 'openrouter') return !!process.env.OPENROUTER_API_KEY;
  if (p === 'gemini')     return !!process.env.GEMINI_API_KEY;
  if (p === 'claude')     return !!process.env.ANTHROPIC_API_KEY;
  return false;
}

function getModelName() {
  const p = getProvider();
  if (p === 'openrouter') return process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free';
  if (p === 'gemini')     return process.env.GEMINI_MODEL     || 'gemini-2.0-flash';
  if (p === 'claude')     return 'claude-sonnet-4-20250514';
  return '—';
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenRouter
// ─────────────────────────────────────────────────────────────────────────────
async function callOpenRouter({ systemPrompt, userPrompt, maxTokens = 2000, _retry = 0 }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) { log('ai_analyst', '⚠ OPENROUTER_API_KEY tidak ada'); return null; }
  const model = getModelName();
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer':  'https://github.com/bitget-bot',
        'X-Title':       'Bitget Trading Bot',
      },
      body: JSON.stringify({
        model,
        max_tokens:  maxTokens,
        temperature: 0.3,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429) {
        if (_retry >= 2) { log('ai_analyst_warn', `OpenRouter rate limit — skip`); return null; }
        const wait = (_retry + 1) * 15;
        log('ai_analyst_warn', `OpenRouter rate limit, retry dalam ${wait}s...`);
        await sleep(wait * 1000);
        return callOpenRouter({ systemPrompt, userPrompt, maxTokens, _retry: _retry + 1 });
      }
      throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data    = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (data?.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return content?.trim() || null;
  } catch (err) {
    log('ai_analyst_error', `OpenRouter error: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini
// ─────────────────────────────────────────────────────────────────────────────
async function callGemini({ systemPrompt, userPrompt, maxTokens = 2000, _retry = 0 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { log('ai_analyst', '⚠ GEMINI_API_KEY tidak ada'); return null; }
  const MODEL_CHAIN = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
  const envModel    = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const model       = _retry === 0 ? envModel : MODEL_CHAIN[Math.min(_retry, MODEL_CHAIN.length - 1)];
  const url         = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429) {
        if (_retry >= 2) { log('ai_analyst_warn', `Gemini rate limit — skip`); return null; }
        const wait = (_retry + 1) * 15;
        log('ai_analyst_warn', `Gemini rate limit, retry dalam ${wait}s...`);
        await sleep(wait * 1000);
        return callGemini({ systemPrompt, userPrompt, maxTokens, _retry: _retry + 1 });
      }
      throw new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text && _retry > 0) log('ai_analyst', `  ✅ Berhasil dengan ${model}`);
    return text?.trim() || null;
  } catch (err) {
    log('ai_analyst_error', `Gemini error: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude
// ─────────────────────────────────────────────────────────────────────────────
async function callClaude({ systemPrompt, userPrompt, maxTokens = 2000 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { log('ai_analyst', '⚠ ANTHROPIC_API_KEY tidak ada'); return null; }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}`);
    const data = await res.json();
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || null;
  } catch (err) {
    log('ai_analyst_error', `Claude error: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified caller dengan fallback
// ─────────────────────────────────────────────────────────────────────────────
async function callAI(opts) {
  const provider = getProvider();
  log('ai_analyst', `  Provider: ${provider} | Model: ${getModelName()}`);
  const callers = { openrouter: callOpenRouter, gemini: callGemini, claude: callClaude };
  let result = await (callers[provider] || callOpenRouter)(opts);
  if (!result) {
    const fallbacks = ['openrouter', 'gemini', 'claude'].filter(p => p !== provider);
    for (const fb of fallbacks) {
      const hasKey = { openrouter: !!process.env.OPENROUTER_API_KEY, gemini: !!process.env.GEMINI_API_KEY, claude: !!process.env.ANTHROPIC_API_KEY }[fb];
      if (hasKey) {
        log('ai_analyst', `  ${provider} gagal → fallback ke ${fb}...`);
        result = await callers[fb](opts);
        if (result) break;
      }
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build market data dari candles
// ─────────────────────────────────────────────────────────────────────────────
async function buildMarketData(symbol) {
  try {
    const [raw1D, raw4H, raw1H, liveTicker] = await Promise.all([
      getCandles(symbol, '1day', 62),
      getCandles(symbol, '4h',  100),
      getCandles(symbol, '1h',  100),
      getCurrentPrice(symbol).catch(() => null),
    ]);

    const PERIOD_MS = { '1day': 86400000, '4h': 14400000, '1h': 3600000 };

    const parse = (raw, livePrice, granularity = '1day') => {
      if (!Array.isArray(raw) || raw.length < 3) return null;
      const now         = Date.now();
      const periodMs    = PERIOD_MS[granularity] ?? 86400000;
      const periodStart = now - (now % periodMs);
      const closedCandles = raw
        .filter(c => parseInt(c[0]) < periodStart)
        .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
      if (closedCandles.length < 22) return null;

      const lastClosed = closedCandles[closedCandles.length - 1];
      const prevClosed = closedCandles[closedCandles.length - 2];
      const currentPrice = livePrice ?? parseFloat(lastClosed[4]);
      const closes = closedCandles.map(c => parseFloat(c[4]));
      const highs  = closedCandles.map(c => parseFloat(c[2]));
      const lows   = closedCandles.map(c => parseFloat(c[3]));
      const vols   = closedCandles.map(c => parseFloat(c[5]));
      const lastClose = parseFloat(lastClosed[4]);
      const prevClose = parseFloat(prevClosed?.[4] ?? lastClosed[4]);
      const changePct = ((currentPrice - lastClose) / lastClose * 100).toFixed(2);

      return {
        currentPrice,
        lastClosedPrice: lastClose,
        open:   parseFloat(lastClosed[1]),
        high:   parseFloat(lastClosed[2]),
        low:    parseFloat(lastClosed[3]),
        close:  lastClose,
        volume: parseFloat(lastClosed[5]),
        prevClose,
        change: changePct,
        ema9:   calcEMA(closes, 9),
        ema21:  calcEMA(closes, 21),
        ema50:  calcEMA(closes, 50),
        rsi14:  calcRSI(closes, 14),
        macd:   calcMACD(closes),
        bb:     calcBollinger(closes),
        adx:    calcADX(highs, lows, closes, 14),
        high20: Math.max(...highs.slice(-20)),
        low20:  Math.min(...lows.slice(-20)),
        high5:  Math.max(...highs.slice(-5)),
        low5:   Math.min(...lows.slice(-5)),
        avgVol10: vols.slice(-11, -1).reduce((s, v) => s + v, 0) / 10,
        lastVol:  parseFloat(lastClosed[5]),
        candleCount: closedCandles.length,
      };
    };

    const d1  = parse(raw1D, liveTicker, '1day');
    const d4  = parse(raw4H, liveTicker, '4h');
    const d1h = parse(raw1H, liveTicker, '1h');

    if (d1 && d4 && d1h) {
      log('ai_analyst', `  Data: live=${liveTicker?.toFixed(4)} | 1D_ema21=${d1.ema21?.toFixed(4)} | 4H_ema21=${d4.ema21?.toFixed(4)} | 1H_ema21=${d1h.ema21?.toFixed(4)}`);
    }

    return { '1D': d1, '4H': d4, '1H': d1h };
  } catch (err) {
    log('ai_analyst_error', `Build market data ${symbol}: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Format market data untuk prompt
// ─────────────────────────────────────────────────────────────────────────────
function formatMarketData(symbol, md) {
  const fmt = (tf, d) => {
    if (!d) return `[${tf}]: Data tidak tersedia`;
    return [
      `[${tf}]`,
      `  Price (live)  : ${d.currentPrice} | Change dari last close: ${d.change}%`,
      `  Last Closed   : ${d.lastClosedPrice?.toFixed(6) ?? 'N/A'} | Candles: ${d.candleCount}`,
      `  EMA9   : ${d.ema9?.toFixed(6) ?? 'N/A'} | EMA21: ${d.ema21?.toFixed(6) ?? 'N/A'} | EMA50: ${d.ema50?.toFixed(6) ?? 'N/A'}`,
      `  RSI14  : ${d.rsi14?.toFixed(1) ?? 'N/A'}`,
      `  MACD   : ${d.macd ? `line=${d.macd.macd.toFixed(6)} signal=${d.macd.signal.toFixed(6)} hist=${d.macd.histogram.toFixed(6)}` : 'N/A'}`,
      `  BB     : ${d.bb ? `upper=${d.bb.upper.toFixed(6)} mid=${d.bb.middle.toFixed(6)} lower=${d.bb.lower.toFixed(6)} %B=${d.bb.pctB.toFixed(2)}` : 'N/A'}`,
      `  ADX    : ${d.adx ? `adx=${d.adx.adx.toFixed(1)} +DI=${d.adx.plusDI.toFixed(1)} -DI=${d.adx.minusDI.toFixed(1)}` : 'N/A'}`,
      `  H/L 20 : ${d.high20?.toFixed(6)} / ${d.low20?.toFixed(6)}`,
      `  H/L 5  : ${d.high5?.toFixed(6)} / ${d.low5?.toFixed(6)}`,
      `  Vol    : ${d.lastVol?.toFixed(0)} (avg10: ${d.avgVol10?.toFixed(0)}) ratio=${d.avgVol10 > 0 ? (d.lastVol / d.avgVol10).toFixed(2) : 'N/A'}x`,
    ].join('\n');
  };

  return [`SYMBOL: ${symbol}`, fmt('1D', md['1D']), fmt('4H', md['4H']), fmt('1H', md['1H'])].join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Sentiment analysis
// ─────────────────────────────────────────────────────────────────────────────
async function getSentimentAnalysis(symbol) {
  const coinName = symbol.replace('USDT', '');

  // Gemini: coba Google Search Grounding untuk berita terkini
  if (getProvider() === 'gemini' && process.env.GEMINI_API_KEY) {
    const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: 'Analis sentimen crypto. Jawab Bahasa Indonesia, max 200 kata, faktual.' }] },
          contents: [{ role: 'user', parts: [{ text: `Cari sentimen market terkini ${coinName} (${symbol}): berita 7 hari terakhir, katalis positif/negatif, risiko utama.` }] }],
          tools: [{ googleSearch: {} }],
          generationConfig: { maxOutputTokens: 500, temperature: 0.2 },
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) { log('ai_analyst', '  Sentimen via Google Search Grounding ✅'); return text.trim(); }
      }
    } catch {}
  }

  const result = await callAI({
    maxTokens:    400,
    systemPrompt: `Kamu analis sentimen crypto. Jawab Bahasa Indonesia, max 150 kata. Fokus: tren umum, sentimen komunitas, risiko utama ${coinName}.`,
    userPrompt:   `Analisa sentimen market terkini untuk ${coinName} (${symbol}). Sebutkan faktor bullish dan bearish yang relevan saat ini.`,
  });

  return result || `Data sentimen ${coinName} tidak tersedia saat ini.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Technical analysis — prompt disesuaikan pipeline Gainer + UTBot
// ─────────────────────────────────────────────────────────────────────────────
async function getTechnicalAnalysis(symbol, marketDataStr, sentimentSummary) {

  const systemPrompt = `Kamu adalah AI Trading Analyst senior spesialis crypto spot trading.

KONTEKS STRATEGI:
Bot ini menggunakan pipeline Gainer + UT Bot Alert:
1. Gainer Filter: koin yang naik 5-20% dalam 24 jam dengan volume ≥$5M
2. UT Bot Signal (1H): ATR Trailing Stop crossover — close baru saja menembus ke atas trailing stop
3. Filter EMA21 1H: close > EMA21 1H sebagai konfirmasi trend jangka pendek

TUGASMU — evaluasi apakah setup ini LAYAK di-trade sekarang:

A. VALIDASI MOMENTUM GAINER
   - Apakah kenaikan 5-20% didukung volume yang sehat (vol ratio > 1.5x avg)?
   - Apakah RSI sudah overbought (>75) atau masih ada ruang?
   - Apakah ini breakout genuine atau sekadar pump tanpa struktur?

B. VALIDASI UT BOT SIGNAL
   - Level trailing stop UTBot = area SL kandidat
   - Apakah jarak entry ke SL (trailing stop) masuk akal vs potensi upside?
   - Apakah EMA stack 1H/4H mendukung arah naik?

C. KONDISI TREND BESAR (1D)
   - Apakah trend harian mendukung (price > EMA21 1D)?
   - Apakah ini searah trend atau counter-trend?
   - Kalau counter-trend: lebih berisiko, confidence harus lebih rendah

D. LEVEL KRITIS
   - Resistance terdekat di atas (target realistis TP1)
   - Support kuat di bawah (konfirmasi area SL)
   - R:R minimal 1:2 dari entry ke SL vs entry ke TP1

ATURAN VERDICT:
- BUY_NOW : Volume sehat + RSI tidak overbought + trend 1D bullish + R:R ≥ 1:2 + UTBot signal valid
- WAIT    : Setup menarik tapi salah satu belum terpenuhi (misal RSI tinggi, tunggu pullback, atau volume kurang meyakinkan)
- SKIP    : RSI sudah sangat overbought (>80) ATAU volume tidak mendukung ATAU trend 1D bearish ATAU R:R < 1:1.5

KEMBALIKAN JSON VALID SAJA, tanpa teks lain:
{
  "verdict": "BUY_NOW" | "WAIT" | "SKIP",
  "confidence": <0-100>,
  "summary": "<harga live — 1-2 kalimat kondisi keseluruhan>",
  "momentum": {
    "gainerValid": true | false,
    "volumeRatio": "<vol kemarin vs avg10 — contoh: 2.3x>",
    "rsiStatus": "<contoh: RSI 1H=62 — ruang masih ada>",
    "pumpOrBreakout": "<genuine breakout / pump tanpa struktur / belum jelas>"
  },
  "utbotSignal": {
    "slLevel": "<trailing stop level — ini SL kandidat>",
    "entryIdeal": "<area entry ideal berdasarkan harga sekarang>",
    "tp1Level": "<resistance terdekat berdasarkan high20 atau struktur 4H>",
    "rrRatio": "<R:R dihitung dari entry ke SL dan entry ke TP1>",
    "riskPct": "<(entry - SL) / entry * 100>"
  },
  "trendAlignment": {
    "daily": "BULLISH" | "NEUTRAL" | "BEARISH",
    "h4": "BULLISH" | "NEUTRAL" | "BEARISH",
    "h1": "BULLISH" | "NEUTRAL" | "BEARISH",
    "aligned": true | false,
    "note": "<penjelasan singkat apakah 3 TF searah atau tidak>"
  },
  "sentiment": {
    "overall": "BULLISH" | "NEUTRAL" | "BEARISH",
    "catalysts": "<faktor positif>",
    "risks": "<faktor risiko / potensi reversal>"
  },
  "keyLevels": {
    "currentPrice": "<harga live>",
    "resistance1": "<resistance terdekat di atas>",
    "support1": "<support kuat di bawah>",
    "criticalLevel": "<level penentu — biasanya EMA21 1D atau swing low>"
  },
  "recommendation": "<paragraf rekomendasi konkret: entry di mana, SL di mana, TP1 di mana, dan kondisi apa yang membatalkan setup>"
}`;

  const maxSentimentLen = 300;
  const trimmedSentiment = sentimentSummary.length > maxSentimentLen
    ? sentimentSummary.slice(0, maxSentimentLen) + '...'
    : sentimentSummary;

  const userPrompt = `Analisa trading setup Gainer+UTBot untuk ${symbol}:

=== DATA TEKNIKAL ===
${marketDataStr}

=== SENTIMEN MARKET ===
${trimmedSentiment}

INSTRUKSI:
1. Fokus pada validasi momentum gainer dan UTBot signal — bukan analisa MTF SMC
2. SL diasumsikan di level trailing stop UTBot (terlihat dari data 1H low terbaru / low5)
3. TP1 berdasarkan resistance terdekat — pakai high20 4H atau high5 1H sebagai referensi
4. R:R WAJIB dihitung dari harga ENTRY (bukan harga live jika berbeda)
5. Semua field angka WAJIB diisi dengan nilai konkret dari data
6. Verdict WAIT jika setup menarik tapi butuh konfirmasi lebih, bukan langsung SKIP

Kembalikan JSON valid sesuai format.`;

  const raw = await callAI({ systemPrompt, userPrompt, maxTokens: 2000 });
  if (!raw) {
    log('ai_analyst_error', 'Model mengembalikan response kosong');
    return null;
  }

  // Parse JSON dengan beberapa fallback
  const attempts = [
    () => JSON.parse(raw.trim()),
    () => JSON.parse(raw.replace(/```json|```/g, '').trim()),
    () => { const m = raw.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; },
    () => {
      const lines = raw.split('\n');
      const start = lines.findIndex(l => l.trim().startsWith('{'));
      if (start === -1) return null;
      return JSON.parse(lines.slice(start).join('\n').replace(/```/g, '').trim());
    },
  ];

  for (let i = 0; i < attempts.length; i++) {
    try {
      const result = attempts[i]();
      if (result && result.verdict) {
        if (i > 0) log('ai_analyst', `  JSON parsed dengan method ${i + 1}`);
        return result;
      }
    } catch {}
  }

  log('ai_analyst_error', `Parse JSON gagal. Raw (200 char): ${raw.slice(0, 200)}`);

  // Retry dengan prompt strict
  log('ai_analyst', '  Retry dengan prompt strict...');
  const raw2 = await callAI({
    systemPrompt,
    userPrompt: `Berikan HANYA JSON valid untuk analisa ${symbol}. ${userPrompt.slice(0, 400)}`,
    maxTokens: 1500,
  });
  if (raw2) {
    try {
      const m = raw2.match(/\{[\s\S]*\}/);
      const result = m ? JSON.parse(m[0]) : null;
      if (result?.verdict) { log('ai_analyst', '  ✅ Retry berhasil'); return result; }
    } catch {}
  }

  log('ai_analyst_error', 'Semua parse attempt gagal');
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// On-demand analysis (dipanggil via /analyze dari Telegram)
// ─────────────────────────────────────────────────────────────────────────────
export async function analyzeOnDemand(symbol) {
  if (!isAIEnabled()) {
    log('ai_analyst', `⚠ AI tidak aktif — provider: ${getProvider()}`);
    return null;
  }

  log('ai_analyst', `🤖 On-demand: ${symbol} [${getProvider()}/${getModelName()}]`);
  try {
    log('ai_analyst', `  Step 1: Fetch market data...`);
    const marketData = await buildMarketData(symbol);
    if (!marketData) {
      log('ai_analyst_error', `  ❌ Market data gagal untuk ${symbol}`);
      return null;
    }
    log('ai_analyst', `  ✅ Market data OK`);

    const marketDataStr = formatMarketData(symbol, marketData);

    log('ai_analyst', `  Step 2: Fetch sentiment...`);
    const sentiment = await getSentimentAnalysis(symbol);
    log('ai_analyst', `  ✅ Sentiment OK`);

    log('ai_analyst', `  Step 3: Technical analysis...`);
    const analysis = await getTechnicalAnalysis(symbol, marketDataStr, sentiment);

    if (!analysis) {
      log('ai_analyst_error', `  ❌ Analisa gagal`);
      return null;
    }

    log('ai_analyst', `  ✅ Selesai: ${analysis.verdict} (${analysis.confidence}%)`);
    return analysis;

  } catch (err) {
    log('ai_analyst_error', `analyzeOnDemand ${symbol}: ${err.message}`);
    return null;
  }
}

// Tidak dipakai lagi (MTF dihapus) — tapi tetap export agar tidak break import lain
export async function analyzeCandidate(candidate) {
  return analyzeOnDemand(candidate.symbol);
}

export function getAIStatus() {
  return {
    enabled:  isAIEnabled(),
    provider: getProvider(),
    model:    getModelName(),
    keySet: {
      openrouter: !!process.env.OPENROUTER_API_KEY,
      gemini:     !!process.env.GEMINI_API_KEY,
      claude:     !!process.env.ANTHROPIC_API_KEY,
    },
  };
}
