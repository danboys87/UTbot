/**
 * API Server — Dashboard REST Endpoints
 * Dijalankan bersamaan dengan bot (port terpisah, default 3000)
 */

import http   from 'http';
import fs     from 'fs';
import path   from 'path';
import { fileURLToPath } from 'url';
import { log }           from './logger.js';
import { getCurrentPrice } from './bitget.js';
import {
  getStats, getAllPositions, getOpenSymbols,
  hasPosition,
} from './state.js';
import { config, saveConfig } from './config.js';
import { analyzeOnDemand, getAIStatus, isAIEnabled } from './aiAnalyst.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PORT       = parseInt(process.env.DASHBOARD_PORT || '3000');
const API_SECRET = process.env.DASHBOARD_SECRET || '';

let _callbacks = {};
export function setApiCallbacks(cb) { _callbacks = cb; }

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type,X-Secret',
  });
  res.end(JSON.stringify(data));
}

function err(res, msg, status = 400) {
  json(res, { ok: false, error: msg }, status);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e6) reject(new Error('Body too large')); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function checkAuth(req) {
  if (!API_SECRET) return true;
  return req.headers['x-secret'] === API_SECRET;
}

function tailLog(lines = 100) {
  try {
    const today   = new Date().toISOString().slice(0, 10);
    const logFile = path.join(__dirname, 'logs', `bot-${today}.log`);
    if (!fs.existsSync(logFile)) return [];
    const content = fs.readFileSync(logFile, 'utf8');
    return content.trim().split('\n').slice(-lines);
  } catch { return []; }
}

function getClosedTrades() {
  try {
    const dir = path.join(__dirname, 'logs');
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter(f => f.startsWith('trades-') && f.endsWith('.jsonl')).sort().reverse();
    const trades = [];
    for (const f of files.slice(0, 7)) {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean);
      for (const l of lines) {
        try { trades.push(JSON.parse(l)); } catch {}
      }
    }
    return trades.sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 200);
  } catch { return []; }
}

async function handle(req, res) {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const route  = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-Secret' });
    res.end(); return;
  }

  if (method === 'POST' && !checkAuth(req)) {
    err(res, 'Unauthorized', 401); return;
  }

  // ── GET /api/status ────────────────────────────────────────────────────────
  if (route === '/api/status' && method === 'GET') {
    const stats     = getStats();
    const positions = getAllPositions();
    const pending   = _callbacks.getPendingQueue?.() ?? [];

    const enriched = {};
    for (const [sym, pos] of Object.entries(positions)) {
      const price = await getCurrentPrice(sym).catch(() => null);
      const pnlPct  = price ? ((price - pos.entryPrice) / pos.entryPrice * 100) : null;
      const pnlUsdt = price ? ((price - pos.entryPrice) * pos.quantity) : null;
      const hasBEP  = pos.partialSells?.some(ps => ps.reason === 'tp1_partial');
      enriched[sym] = { ...pos, currentPrice: price, pnlPct, pnlUsdt, hasBEP };
    }

    json(res, {
      ok: true,
      stats,
      positions: enriched,
      pending: pending.map(p => ({
        symbol:      p.symbol,
        minsLeft:    p.minsLeft,
        triggered:   p.candidate.triggered,
        strategy:    p.candidate.strategy,
        lastPrice:   p.candidate.lastPrice,
        change24h:   p.candidate.change24h,
        vol24h:      p.candidate.vol24h,
        slPrice:     p.candidate.slPrice,
        zones:       p.candidate.zones,
        signals:     p.candidate.signals,
        aiVerdict:   p.candidate.aiAnalysis?.verdict,
        aiConfidence:p.candidate.aiAnalysis?.confidence,
        aiSummary:   p.candidate.aiAnalysis?.summary,
        aiAnalysis:  p.candidate.aiAnalysis,
      })),
      config: {
        budgetPerTrade:    config.trading.budgetPerTrade,
        maxOpenPositions:  config.trading.maxOpenPositions,
        takeProfitPct:     config.management.takeProfitPct,
        stopLossPct:       config.management.stopLossPct,
        trailPct:          config.management.trailingStop.trailPct,
        isDryRun:          process.env.DRY_RUN === 'true',
        aiEnabled:         !!(process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY),
        aiStatus:          (() => { try { return getAIStatus(); } catch { return null; } })(),
      },
      serverTime: new Date().toISOString(),
    });
    return;
  }

  // ── GET /api/history ───────────────────────────────────────────────────────
  if (route === '/api/history' && method === 'GET') {
    json(res, { ok: true, trades: getClosedTrades() });
    return;
  }

  // ── GET /api/logs ──────────────────────────────────────────────────────────
  if (route === '/api/logs' && method === 'GET') {
    const n = parseInt(url.searchParams.get('n') || '150');
    json(res, { ok: true, logs: tailLog(n) });
    return;
  }

  // ── GET /api/price/:symbol ─────────────────────────────────────────────────
  if (route.startsWith('/api/price/') && method === 'GET') {
    const symbol = route.split('/').pop().toUpperCase();
    const price  = await getCurrentPrice(symbol).catch(() => null);
    json(res, { ok: true, symbol, price });
    return;
  }

  // ── GET /api/config ────────────────────────────────────────────────────────
  if (route === '/api/config' && method === 'GET') {
    json(res, { ok: true, config });
    return;
  }

  // ── POST /api/config ───────────────────────────────────────────────────────
  if (route === '/api/config' && method === 'POST') {
    const body = await readBody(req);
    try {
      saveConfig(body);
      json(res, { ok: true, message: 'Config tersimpan', config });
    } catch (e) { err(res, e.message); }
    return;
  }

  // ── POST /api/approve ──────────────────────────────────────────────────────
  if (route === '/api/approve' && method === 'POST') {
    const { symbol, type = 'entry1' } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    try {
      let result;
      if (type === 'entry2')   result = await _callbacks.approveEntry2?.(symbol);
      else if (type === 'all') result = await _callbacks.approveAll?.(symbol);
      else                     result = await _callbacks.approveCandidate?.(symbol);
      json(res, result ?? { ok: false, error: 'Callback tidak tersedia' });
    } catch (e) { err(res, e.message); }
    return;
  }

  // ── POST /api/skip ─────────────────────────────────────────────────────────
  if (route === '/api/skip' && method === 'POST') {
    const { symbol } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    const result = _callbacks.skipCandidate?.(symbol) ?? { ok: false };
    json(res, result);
    return;
  }

  // ── POST /api/buy ──────────────────────────────────────────────────────────
  if (route === '/api/buy' && method === 'POST') {
    const { symbol } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    if (!_callbacks.executeBuyManual) { err(res, 'Buy callback tidak tersedia'); return; }
    try {
      const result = await _callbacks.executeBuyManual(symbol);
      json(res, result);
    } catch (e) { err(res, e.message); }
    return;
  }

  // ── POST /api/sell ─────────────────────────────────────────────────────────
  if (route === '/api/sell' && method === 'POST') {
    const { symbol } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    if (!_callbacks.executeSellManual) { err(res, 'Sell callback tidak tersedia'); return; }
    try {
      const result = await _callbacks.executeSellManual(symbol);
      json(res, result);
    } catch (e) { err(res, e.message); }
    return;
  }

  // ── POST /api/screen ───────────────────────────────────────────────────────
  if (route === '/api/screen' && method === 'POST') {
    const { type = 'pipeline' } = await readBody(req);
    json(res, { ok: true, message: `Screening ${type} dimulai di background` });
    if (type === 'utbot') _callbacks.doUTBotScreener?.().catch(() => {});
    else                  _callbacks.doGainerUTBotScreening?.().catch(() => {});
    return;
  }

  // ── POST /api/analyze ──────────────────────────────────────────────────────
  if (route === '/api/analyze' && method === 'POST') {
    const { symbol } = await readBody(req);
    if (!symbol) { err(res, 'symbol required'); return; }
    if (!isAIEnabled()) { err(res, `AI tidak aktif. Set GEMINI_API_KEY atau ANTHROPIC_API_KEY di .env, lalu restart bot.`); return; }
    try {
      const analysis = await analyzeOnDemand(symbol.toUpperCase());
      json(res, { ok: true, symbol, analysis });
    } catch (e) { err(res, e.message); }
    return;
  }

  // ── POST /api/manage ───────────────────────────────────────────────────────
  if (route === '/api/manage' && method === 'POST') {
    json(res, { ok: true, message: 'Management cycle dimulai' });
    _callbacks.doManagement?.().catch(() => {});
    return;
  }

  // ── POST /webhook/tradingview ──────────────────────────────────────────────
  if (route === '/webhook/tradingview' && method === 'POST') {
    const webhookSecret = process.env.WEBHOOK_SECRET || '';
    if (webhookSecret) {
      const headerSecret = req.headers['x-webhook-secret'];
      const querySecret  = new URL(req.url, `http://localhost`).searchParams.get('secret');
      if (headerSecret !== webhookSecret && querySecret !== webhookSecret) {
        err(res, 'Unauthorized', 401);
        log('webhook', `⛔ Webhook ditolak — secret tidak valid`);
        return;
      }
    }

    const body = await readBody(req);
    const { ticker, action, price, time, strategy } = body;

    if (!ticker || !action) {
      err(res, 'ticker dan action wajib ada');
      return;
    }

    const symbol    = ticker.toUpperCase().includes('USDT') ? ticker.toUpperCase() : `${ticker.toUpperCase()}USDT`;
    const actionUp  = action.toUpperCase();

    log('webhook', `📡 TradingView signal: ${actionUp} ${symbol} @ ${price} | strategy=${strategy || '-'}`);

    if (actionUp === 'BUY') {
      const openPos = getOpenSymbols();
      const maxPos  = config.trading.maxOpenPositions;

      if (openPos.includes(symbol)) {
        const msg = `⚠️ Sudah ada posisi ${symbol}, skip BUY signal`;
        log('webhook', msg);
        json(res, { ok: false, reason: msg });
        _callbacks.notifyWebhook?.({ symbol, action: 'BUY', price, strategy, skipped: true, reason: 'already_open' });
        return;
      }

      if (openPos.length >= maxPos) {
        const msg = `⚠️ Slot penuh (${openPos.length}/${maxPos}), skip BUY ${symbol}`;
        log('webhook', msg);
        json(res, { ok: false, reason: msg });
        _callbacks.notifyWebhook?.({ symbol, action: 'BUY', price, strategy, skipped: true, reason: 'slot_full' });
        return;
      }

      json(res, { ok: true, message: `BUY ${symbol} dieksekusi` });
      _callbacks.executeWebhookBuy?.({ symbol, price, strategy }).catch(e => {
        log('webhook_error', `BUY ${symbol} gagal: ${e.message}`);
      });
      return;
    }

    if (actionUp === 'SELL') {
      const positions = getAllPositions();
      if (!positions[symbol]) {
        const msg = `⚠️ Tidak ada posisi ${symbol}, skip SELL signal`;
        log('webhook', msg);
        json(res, { ok: false, reason: msg });
        _callbacks.notifyWebhook?.({ symbol, action: 'SELL', price, strategy, skipped: true, reason: 'no_position' });
        return;
      }

      json(res, { ok: true, message: `SELL ${symbol} dieksekusi` });
      _callbacks.executeWebhookSell?.({ symbol, price, strategy }).catch(e => {
        log('webhook_error', `SELL ${symbol} gagal: ${e.message}`);
      });
      return;
    }

    err(res, `action tidak dikenal: ${action}. Gunakan BUY atau SELL`);
    return;
  }

  json(res, { ok: false, error: 'Route tidak ditemukan' }, 404);
}

export function startApiServer(callbacks) {
  setApiCallbacks(callbacks);
  const server = http.createServer(async (req, res) => {
    try { await handle(req, res); }
    catch (e) { err(res, e.message, 500); }
  });
  server.listen(PORT, () => {
    log('api_server', `✅ Dashboard API berjalan di http://localhost:${PORT}`);
    log('api_server', `   Buka dashboard.html di browser dan set API URL ke http://localhost:${PORT}`);
  });
  return server;
}
