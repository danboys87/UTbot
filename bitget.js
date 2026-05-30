/**
 * Bitget REST API Client
 * Docs: https://www.bitget.com/api-doc/spot/intro
 */
import crypto from 'crypto';
import axios  from 'axios';
import { log } from './logger.js';

const BASE_URL = 'https://api.bitget.com';

function sign(timestamp, method, requestPath, body, secretKey) {
  const msg = timestamp + method.toUpperCase() + requestPath + (body || '');
  return crypto.createHmac('sha256', secretKey).update(msg).digest('base64');
}

async function request(method, path, params = {}, body = null, auth = true) {
  const timestamp   = Date.now().toString();
  let requestPath   = path;

  if (method === 'GET' && Object.keys(params).length > 0) {
    requestPath = `${path}?${new URLSearchParams(params)}`;
  }

  const bodyStr = body ? JSON.stringify(body) : '';
  const headers = { 'Content-Type': 'application/json', 'locale': 'en-US' };

  if (auth) {
    headers['ACCESS-KEY']        = process.env.BITGET_API_KEY;
    headers['ACCESS-SIGN']       = sign(timestamp, method, requestPath, bodyStr, process.env.BITGET_SECRET_KEY);
    headers['ACCESS-TIMESTAMP']  = timestamp;
    headers['ACCESS-PASSPHRASE'] = process.env.BITGET_PASSPHRASE;
  }

  try {
    const res  = await axios({ method, url: BASE_URL + requestPath, headers, data: body || undefined, timeout: 10000 });
    const data = res.data;
    if (data.code !== '00000' && data.code !== 0) throw new Error(`Bitget API ${data.code}: ${data.msg}`);
    return data.data;
  } catch (err) {
    if (err.response) throw new Error(`Bitget HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`);
    throw err;
  }
}

// ── Public ────────────────────────────────────────────────────────────────────
export async function getAllTickers() {
  return request('GET', '/api/v2/spot/market/tickers', {}, null, false);
}

export async function getTicker(symbol) {
  return request('GET', '/api/v2/spot/market/tickers', { symbol }, null, false);
}

export async function getCandles(symbol, granularity = '1H', limit = 100) {
  return request('GET', '/api/v2/spot/market/candles', { symbol, granularity, limit: String(limit) }, null, false);
}

// ── Auth ──────────────────────────────────────────────────────────────────────
export async function getAccountAssets() {
  return request('GET', '/api/v2/spot/account/assets');
}

export async function getAssetBalance(coin) {
  const assets = await getAccountAssets();
  return Array.isArray(assets) ? (assets.find(a => a.coin === coin) || null) : null;
}

export async function placeOrder({ symbol, side, orderType, size, quoteMode = false }) {
  const body = {
    symbol,
    side,
    orderType,
    force:     'gtc',
    clientOid: `bot_${Date.now()}`,
  };

  if (side === 'buy' && orderType === 'market' && quoteMode) {
    // Market buy dengan USDT amount — Bitget v2 API pakai field 'size' dalam quote currency
    // quoteSize tidak dipakai di API v2, cukup size saja
    body.size = String(size);
  } else {
    body.size = String(size);
  }

  return request('POST', '/api/v2/spot/trade/place-order', {}, body);
}

export async function getOrder(orderId, symbol) {
  return request('GET', '/api/v2/spot/trade/orderInfo', { orderId, symbol });
}

export async function getCurrentPrice(symbol) {
  const tickers = await getTicker(symbol);
  const t = Array.isArray(tickers) ? tickers[0] : tickers;
  return t ? parseFloat(t.lastPr || t.last) : null;
}

export async function testConnection() {
  try {
    const assets = await getAccountAssets();
    return { ok: true, assets: assets?.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
