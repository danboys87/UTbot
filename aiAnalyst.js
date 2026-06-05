/**
 * AI Analyst — Multi-Provider
 * Digunakan untuk analisa manual via /analyze SYMBOL dari Telegram.
 *
 * Provider yang didukung (set di .env):
 * AI_PROVIDER=openrouter
 * AI_PROVIDER=gemini
 * AI_PROVIDER=claude
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
      `  MACD   : ${d.macd ? `line=${d.macd.macd.toFixed(6
