/**
 * AI Analyst — Multi-Provider
 *
 * Provider yang didukung (set di .env):
 *   AI_PROVIDER=openrouter   → OpenRouter (akses 200+ model, ada free tier)
 *   AI_PROVIDER=gemini       → Google Gemini (free tier)
 *   AI_PROVIDER=claude       → Anthropic Claude
 *
 * Konfigurasi .env:
 *   # OpenRouter
 *   AI_PROVIDER=openrouter
 *   OPENROUTER_API_KEY=sk-or-...      → daftar di openrouter.ai (free)
 *   OPENROUTER_MODEL=google/gemini-2.0-flash-exp:free   → model gratis
 *   # OPENROUTER_MODEL=meta-llama/llama-3.3-70b-instruct:free
 *   # OPENROUTER_MODEL=deepseek/deepseek-chat-v3-0324:free
 *   # OPENROUTER_MODEL=mistralai/mistral-7b-instruct:free
 *
 *   # Gemini langsung
 *   AI_PROVIDER=gemini
 *   GEMINI_API_KEY=AIza...
 *   GEMINI_MODEL=gemini-2.0-flash
 *
 *   # Claude langsung
 *   AI_PROVIDER=claude
 *   ANTHROPIC_API_KEY=sk-ant-...
 *
 * Model OpenRouter gratis (update: openrouter.ai/models?q=free):
 *   google/gemini-2.0-flash-exp:free  — Gemini 2.0 Flash (recommended)
 *   google/gemini-2.5-pro-exp-03-25:free — Gemini 2.5 Pro
 *   deepseek/deepseek-chat-v3-0324:free  — DeepSeek V3
 *   meta-llama/llama-3.3-70b-instruct:free — Llama 3.3 70B
 *   mistralai/mistral-7b-instruct:free    — Mistral 7B
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
// OpenRouter caller — OpenAI-compatible API
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
      // Rate limit
      if (res.status === 429) {
        if (_retry >= 2) {
          log('ai_analyst_warn', `OpenRouter rate limit — skip setelah ${_retry + 1}x retry`);
          return null;
        }
        const wait = (_retry + 1) * 15;
        log('ai_analyst_warn', `OpenRouter rate limit, retry dalam ${wait}s... [${_retry + 1}/2]`);
        await sleep(wait * 1000);
        return callOpenRouter({ systemPrompt, userPrompt, maxTokens, _retry: _retry + 1 });
      }
      throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data    = await res.json();
    const content = data?.choices?.[0]?.message?.content;

    // Cek error dari OpenRouter (model tidak tersedia dll)
    if (data?.error) throw new Error(data.error.message || JSON.stringify(data.error));

    return content?.trim() || null;

  } catch (err) {
    log('ai_analyst_error', `OpenRouter error: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini caller
// ─────────────────────────────────────────────────────────────────────────────
async function callGemini({ systemPrompt, userPrompt, maxTokens = 2000, _retry = 0 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { log('ai_analyst', '⚠ GEMINI_API_KEY tidak ada'); return null; }

  // Model fallback chain saat rate limit
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
        if (_retry >= 2) {
          log('ai_analyst_warn', `Gemini rate limit — skip setelah ${_retry + 1}x retry`);
          log('ai_analyst_warn', `Coba ganti ke OpenRouter: AI_PROVIDER=openrouter di .env`);
          return null;
        }
        const wait = (_retry + 1) * 15;
        log('ai_analyst_warn', `Gemini rate limit (${model}), coba model lain dalam ${wait}s... [${_retry + 1}/2]`);
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
// Claude caller
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
// Unified caller — pilih provider, fallback otomatis
// ─────────────────────────────────────────────────────────────────────────────
async function callAI(opts) {
  const provider = getProvider();
  log('ai_analyst', `  Provider: ${provider} | Model: ${getModelName()}`);

  // Caller utama
  const callers = {
    openrouter: callOpenRouter,
    gemini:     callGemini,
    claude:     callClaude,
  };

  let result = await (callers[provider] || callOpenRouter)(opts);

  // Fallback chain jika utama gagal
  if (!result) {
    const fallbacks = ['openrouter', 'gemini', 'claude'].filter(p => p !== provider);
    for (const fb of fallbacks) {
      const hasKey = {
        openrouter: !!process.env.OPENROUTER_API_KEY,
        gemini:     !!process.env.GEMINI_API_KEY,
        claude:     !!process.env.ANTHROPIC_API_KEY,
      }[fb];

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
    // Fetch candles + live price secara paralel
    // Limit 1D = 62 (konsisten dengan screenerMTF), 4H/1H cukup 100
    const [raw1D, raw4H, raw1H, liveTicker] = await Promise.all([
      getCandles(symbol, '1day', 62),
      getCandles(symbol, '4h',  100),
      getCandles(symbol, '1h',  100),
      getCurrentPrice(symbol).catch(() => null),
    ]);

    /**
     * Parse candle array dari Bitget.
     * Bitget format: [timestamp, open, high, low, close, volume, ...]
     *
     * MASALAH: Bitget tidak selalu menyertakan candle live di posisi yang sama
     * tergantung granularity dan limit. Dengan limit besar (200) untuk 1day,
     * candle live kadang tidak ada → slice(0,-1) malah buang candle valid.
     *
     * FIX: Deteksi candle live berdasarkan timestamp.
     * Candle live = timestamp-nya di dalam periode candle yang sedang berjalan
     * (yaitu: now - (now % periodMs) < timestamp <= now)
     */
    const PERIOD_MS = { '1day': 86400000, '4h': 14400000, '1h': 3600000 };

    const parse = (raw, livePrice, granularity = '1day') => {
      if (!Array.isArray(raw) || raw.length < 3) return null;

      const now       = Date.now();
      const periodMs  = PERIOD_MS[granularity] ?? 86400000;
      // Awal periode candle yang sedang berjalan
      const periodStart = now - (now % periodMs);

      // Filter: buang candle yang timestamp-nya >= periodStart (candle live/belum close)
      // Kemudian sort ascending (oldest first) untuk konsistensi kalkulasi indikator
      const closedCandles = raw
        .filter(c => parseInt(c[0]) < periodStart)
        .sort((a, b) => parseInt(a[0]) - parseInt(b[0]));

      // Validasi: minimal 22 candle untuk indikator dasar
      if (closedCandles.length < 22) return null;

      // Index TERAKHIR = candle terbaru yang sudah close (newest closed)
      const lastClosed = closedCandles[closedCandles.length - 1];
      const prevClosed = closedCandles[closedCandles.length - 2];

      // Gunakan harga live dari ticker jika tersedia, fallback ke close candle terbaru
      const currentPrice = livePrice ?? parseFloat(lastClosed[4]);

      const closes = closedCandles.map(c => parseFloat(c[4]));
      const highs  = closedCandles.map(c => parseFloat(c[2]));
      const lows   = closedCandles.map(c => parseFloat(c[3]));
      const vols   = closedCandles.map(c => parseFloat(c[5]));

      const lastClose = parseFloat(lastClosed[4]);
      const prevClose = parseFloat(prevClosed?.[4] ?? lastClosed[4]);

      // Change% = dari close terakhir yang valid ke harga live saat ini
      const changePct = ((currentPrice - lastClose) / lastClose * 100).toFixed(2);

      return {
        currentPrice,                   // harga live dari ticker
        lastClosedPrice: lastClose,      // close candle terakhir yang sudah selesai
        open:   parseFloat(lastClosed[1]),
        high:   parseFloat(lastClosed[2]),
        low:    parseFloat(lastClosed[3]),
        close:  lastClose,
        volume: parseFloat(lastClosed[5]),
        prevClose,
        change: changePct,

        // Indikator dihitung dari closed candles saja (tidak bias candle live)
        ema9:   calcEMA(closes, 9),
        ema21:  calcEMA(closes, 21),
        ema50:  calcEMA(closes, 50),
        rsi14:  calcRSI(closes, 14),
        macd:   calcMACD(closes),
        bb:     calcBollinger(closes),
        adx:    calcADX(highs, lows, closes, 14),

        // Key levels dari closed candles
        high20: Math.max(...highs.slice(-20)),
        low20:  Math.min(...lows.slice(-20)),
        high5:  Math.max(...highs.slice(-5)),
        low5:   Math.min(...lows.slice(-5)),

        // Volume
        avgVol10: vols.slice(-11, -1).reduce((s, v) => s + v, 0) / 10,
        lastVol:  parseFloat(lastClosed[5]),

        // Meta
        candleCount: closedCandles.length,

        // Validasi sanity: log warning jika EMA21 terlalu jauh dari harga live
        _ema21SanityOk: true, // akan di-set ulang di bawah
      };
    };

    const d1  = parse(raw1D, liveTicker, '1day');
    const d4  = parse(raw4H, liveTicker, '4h');
    const d1h = parse(raw1H, liveTicker, '1h');

    // ── Sanity check: EMA21 tidak boleh terlalu jauh dari harga live ──────────
    // Jika EMA21 > 2x harga atau < 0.3x harga → data candle kemungkinan terbalik
    const sanityCheck = (label, d) => {
      if (!d || !d.ema21 || !d.currentPrice) return;
      const ratio = d.ema21 / d.currentPrice;
      if (ratio > 2 || ratio < 0.3) {
        log('ai_analyst_warn', `  ⚠ SANITY FAIL [${label}]: EMA21=${d.ema21?.toFixed(4)} vs price=${d.currentPrice} (ratio=${ratio.toFixed(2)}) — data candle mungkin terbalik!`);
      } else {
        log('ai_analyst', `  ✅ Sanity OK [${label}]: EMA21=${d.ema21?.toFixed(4)} vs price=${d.currentPrice} (ratio=${ratio.toFixed(2)})`);
      }
    };
    sanityCheck('1D', d1);
    sanityCheck('4H', d4);
    sanityCheck('1H', d1h);

    // Validasi konsistensi: currentPrice semua TF harus sama (live ticker)
    if (d1 && d4 && d1h) {
      log('ai_analyst', `  Data check: live=${liveTicker?.toFixed(4)} | 1D_close=${d1.lastClosedPrice?.toFixed(4)} | 4H_close=${d4.lastClosedPrice?.toFixed(4)} | 1H_close=${d1h.lastClosedPrice?.toFixed(4)}`);
      log('ai_analyst', `  EMA check : 1D_ema21=${d1.ema21?.toFixed(4)} | 4H_ema21=${d4.ema21?.toFixed(4)} | 1H_ema21=${d1h.ema21?.toFixed(4)}`);
      log('ai_analyst', `  Candles   : 1D=${d1.candleCount} | 4H=${d4.candleCount} | 1H=${d1h.candleCount}`);
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
function formatMarketData(symbol, md, candidate) {
  const fmt = (tf, d) => {
    if (!d) return `[${tf}]: Data tidak tersedia`;
    return [
      `[${tf}]`,
      `  Price (live)  : ${d.currentPrice} | Change from last close: ${d.change}%`,
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

  const signals = candidate?.signals
    ? '\nSCREENER SIGNALS:\n' + Object.entries(candidate.signals)
        .map(([k, v]) => `  ${k}: ${v.bullish ? '✅' : '❌'} ${v.label}`).join('\n')
    : '';

  const zones = candidate?.zones
    ? '\nENTRY ZONES:\n' + candidate.zones
        .map(z => `  ${z.entryPct}% (${z.type}): ${z.priceBottom?.toFixed(6)} - ${z.priceTop?.toFixed(6)}`).join('\n')
    : '';

  const slInfo = candidate?.slPrice ? `\nSL REFERENCE: ${candidate.slPrice.toFixed(6)}` : '';

  return [`SYMBOL: ${symbol}`, fmt('1D', md['1D']), fmt('4H', md['4H']), fmt('1H', md['1H']), signals, zones, slInfo].filter(Boolean).join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Sentiment analysis
// ─────────────────────────────────────────────────────────────────────────────
async function getSentimentAnalysis(symbol) {
  const coinName = symbol.replace('USDT', '');

  // Gemini: coba Google Search Grounding
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

  // Fallback: prompt biasa ke provider aktif
  const result = await callAI({
    maxTokens:    500,
    systemPrompt: `Kamu analis sentimen crypto. Jawab Bahasa Indonesia, max 150 kata. Fokus: tren umum, sentimen komunitas, risiko utama ${coinName}.`,
    userPrompt:   `Analisa sentimen market terkini untuk ${coinName} (${symbol}). Sebutkan faktor bullish dan bearish yang relevan saat ini.`,
  });

  return result || `Data sentimen ${coinName} tidak tersedia saat ini.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Technical analysis → verdict JSON
// ─────────────────────────────────────────────────────────────────────────────
async function getTechnicalAnalysis(symbol, marketDataStr, sentimentSummary) {
  const systemPrompt = `Kamu adalah AI Trading Analyst senior spesialis crypto swing trading dengan pendekatan Smart Money Concept (SMC) dan Multi-Timeframe Analysis (MTF).

SOP TRADING:
1. 1D: Bullish jika price > EMA21 1D + ada BoS/ChoCh bullish pada struktur harian
2. 4H: Cari Unmitigated Order Block / Demand Zone sebagai area entry potensial
3. 1H: Konfirmasi trigger via Pinbar, Bullish Engulfing, atau ChoCh
4. Entry Zone 1 (30%): di sekitar EMA21 1D — GUNAKAN NILAI EMA21 1D dari data [1D] yang diberikan
5. Entry Zone 2 (70%): di Order Block / Demand Zone 4H terkuat di bawah harga saat ini
6. SL: Di bawah swing low / bottom demand zone - 0.5% buffer (TIDAK boleh digeser)
7. TP1: Nearest resistance → tutup 50% → geser SL ke BEP
8. TP2+: Trailing stop 1.5% callback
9. Minimum R:R = 1:2

ATURAN VERDICT — WAJIB DIIKUTI:
- BUY_NOW : 1D bullish (price > EMA21 1D) + ada zone entry jelas + 1H sudah konfirmasi (pinbar/engulfing/ChoCh) + R:R >= 1:2
- WAIT    : 1D bullish (price > EMA21 1D) + struktur bagus TAPI salah satu belum terpenuhi: 1H belum konfirmasi, ATAU harga belum di zone entry, ATAU R:R belum ideal. Gunakan WAIT jika setup menarik dan layak dipantau.
- SKIP    : 1D bearish (price < EMA21 1D) ATAU struktur rusak ATAU R:R < 1:1.5 ATAU tidak ada potensi setup sama sekali

PENTING — ZONA ENTRY:
- Zone 1 EMA21 WAJIB mengacu pada nilai EMA21 dari timeframe [1D], bukan 4H atau 1H
- Contoh: jika EMA21 1D = 0.3855, maka zone 1 = sekitar 0.383-0.389
- Zone 2 OB/Demand mengacu pada swing low / structure 4H di bawah harga saat ini
- Jika tidak ada OB yang jelas, gunakan swing low 4H atau low20 sebagai zone 2

ATURAN REKOMENDASI — WAJIB:
- Selalu tulis angka spesifik dari data, JANGAN tulis "tidak berlaku" atau "N/A"
- SL selalu berikan angka konkret berdasarkan swing low atau low20 dari data
- TP1 selalu berikan angka konkret berdasarkan high20 atau resistance terdekat

ATURAN PERHITUNGAN R:R — WAJIB:
- R:R HARUS dihitung dari zona ENTRY, bukan dari harga live saat ini
- Risk  = harga entry - SL
- Reward = TP1 - harga entry
- R:R = Reward / Risk
- riskPct = (Risk / harga entry) * 100
- Contoh: entry 0.386, SL 0.372, TP1 0.453 → Risk=0.014, Reward=0.067, R:R=1:4.8, riskPct=3.6%

KEMBALIKAN JSON VALID SAJA, tanpa teks lain, tanpa markdown:
{
  "verdict": "BUY_NOW" | "WAIT" | "SKIP",
  "confidence": <0-100>,
  "summary": "<harga live saat ini> — <1-2 kalimat ringkasan kondisi keseluruhan. Contoh: 'Price $84.09 — 1D bearish, price di bawah EMA21 $86.71, tidak ada konfirmasi bullish di 1H.'>",
  "entryAssessment": {
    "bestEntry": "<zona harga spesifik yang ideal untuk entry>",
    "timing": "IMMEDIATE" | "WAIT_PULLBACK" | "WAIT_BREAKOUT" | "NOT_RECOMMENDED",
    "zone1": "<zona EMA21 1D spesifik — contoh: 0.383-0.389 (EMA21 1D)>",
    "zone2": "<zona OB/swing low 4H spesifik — contoh: 0.350-0.360 (swing low 4H)>",
    "quality": "A+" | "A" | "B" | "C" | "D"
  },
  "riskReward": {
    "slLevel": "<harga SL konkret — wajib ada angkanya>",
    "tp1Level": "<harga TP1 konkret — wajib ada angkanya>",
    "tp2EstRange": "<estimasi range TP2>",
    "rrRatio": "<R:R dihitung dari ENTRY ke SL dan ENTRY ke TP1 — contoh: entry 0.386, SL 0.372, TP1 0.453 → 1:4.8>",
    "riskPct": "<(entry - SL) / entry * 100 — contoh: 3.6%>",
    "assessment": "<layak / belum layak dan alasannya>"
  },
  "sentiment": {
    "overall": "BULLISH" | "NEUTRAL" | "BEARISH",
    "summary": "<ringkasan sentimen>",
    "catalysts": "<faktor positif spesifik>",
    "risks": "<faktor risiko spesifik>"
  },
  "keyLevels": {
    "currentPrice": "<harga live saat ini>",
    "strongSupport": "<level support terkuat — gunakan low20 4H>",
    "strongResistance": "<level resistance terkuat — gunakan high20 4H>",
    "criticalLevel": "<level kritis penentu arah — biasanya EMA21 1D>"
  }
}`;

  // Batasi panjang prompt agar tidak melebihi context limit model gratis
  const maxSentimentLen = 300;
  const trimmedSentiment = sentimentSummary.length > maxSentimentLen
    ? sentimentSummary.slice(0, maxSentimentLen) + '...'
    : sentimentSummary;

  const userPrompt = `Analisa trading setup untuk ${symbol}:

=== DATA TEKNIKAL ===
${marketDataStr}

=== SENTIMEN MARKET ===
${trimmedSentiment}

INSTRUKSI:
1. Tentukan verdict sesuai aturan WAIT vs SKIP: jika 1D bullish (price > EMA21 1D) tapi 1H belum konfirmasi → WAIT, bukan SKIP
2. Zona entry dan SL/TP WAJIB berisi angka konkret dari data di atas, meskipun verdict WAIT atau SKIP
3. Untuk SL gunakan low20 atau swing low dari data sebagai referensi
4. Untuk TP1 gunakan high20 atau resistance terdekat dari data sebagai referensi
5. Jangan tulis "tidak berlaku", "N/A", atau "—" untuk field angka — selalu isi dengan estimasi berdasarkan data
6. R:R WAJIB dihitung dari harga ENTRY (bukan harga live): Risk = entry - SL, Reward = TP1 - entry, R:R = Reward/Risk

Kembalikan JSON valid sesuai format.`;

  const raw = await callAI({ systemPrompt, userPrompt, maxTokens: 2000 });
  if (!raw) {
    log('ai_analyst_error', 'Model mengembalikan response kosong');
    return null;
  }

  // Coba parse JSON — beberapa model kadang bungkus dengan markdown atau teks
  const attempts = [
    // 1. Langsung parse
    () => JSON.parse(raw.trim()),
    // 2. Hapus markdown fence
    () => JSON.parse(raw.replace(/```json|```/g, '').trim()),
    // 3. Ekstrak objek JSON dari dalam teks
    () => { const m = raw.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; },
    // 4. Cari dari baris pertama yang dimulai {
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

  // Semua attempt gagal — log raw untuk debug
  log('ai_analyst_error', `Parse JSON gagal. Raw response (200 char): ${raw.slice(0, 200)}`);

  // Fallback: coba ulang dengan prompt yang lebih strict
  log('ai_analyst', '  Retry dengan prompt strict...');
  const strictPrompt = `Berikan HANYA JSON valid untuk analisa ${symbol}, tanpa teks lain:
${userPrompt.slice(0, 500)}`;
  const raw2 = await callAI({ systemPrompt, userPrompt: strictPrompt, maxTokens: 1500 });
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
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
export async function analyzeCandidate(candidate) {
  const { symbol } = candidate;
  if (!isAIEnabled()) { log('ai_analyst', '⚠ AI tidak aktif — set API key di .env'); return null; }

  log('ai_analyst', `🤖 AI analisa [${getProvider()}] → ${symbol}`);
  try {
    const marketData    = await buildMarketData(symbol);
    if (!marketData) return null;
    const marketDataStr = formatMarketData(symbol, marketData, candidate);
    const sentiment     = await getSentimentAnalysis(symbol);
    const analysis      = await getTechnicalAnalysis(symbol, marketDataStr, sentiment);
    if (analysis) log('ai_analyst', `✅ ${symbol} → ${analysis.verdict} (${analysis.confidence}%)`);
    return analysis;
  } catch (err) {
    log('ai_analyst_error', `analyzeCandidate ${symbol}: ${err.message}`);
    return null;
  }
}

export async function analyzeOnDemand(symbol) {
  if (!isAIEnabled()) {
    log('ai_analyst', `⚠ AI tidak aktif — provider: ${getProvider()}, key ada: ${isAIEnabled()}`);
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

    const marketDataStr = formatMarketData(symbol, marketData, null);

    log('ai_analyst', `  Step 2: Fetch sentiment...`);
    const sentiment = await getSentimentAnalysis(symbol);
    log('ai_analyst', `  ✅ Sentiment OK (${sentiment.length} chars)`);

    log('ai_analyst', `  Step 3: Technical analysis...`);
    const analysis = await getTechnicalAnalysis(symbol, marketDataStr, sentiment);

    if (!analysis) {
      log('ai_analyst_error', `  ❌ Analisa gagal — lihat log di atas untuk detail`);
      return null;
    }

    log('ai_analyst', `  ✅ Selesai: ${analysis.verdict} (${analysis.confidence}%)`);
    return analysis;

  } catch (err) {
    log('ai_analyst_error', `analyzeOnDemand ${symbol}: ${err.message}`);
    return null;
  }
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
