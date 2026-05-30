/**
 * State Management
 * Tracks open & closed positions.
 * Persist ke local file + sync ke JSONBin.io (cloud) jika dikonfigurasi.
 */
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log }                        from './logger.js';
import { loadFromCloud, saveToCloud } from './stateSync.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));

// Railway pakai /tmp, lokal pakai root directory
const STATE_FILE = process.env.RAILWAY_ENVIRONMENT
  ? '/tmp/state.json'
  : path.join(__dirname, 'state.json');

// ── Load / Save lokal ─────────────────────────────────────────────────────────
function loadLocal() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (err) {
    log('state_error', `Gagal baca state lokal: ${err.message}`);
  }
  return { positions: {}, closed: [], totalPnlUsdt: 0 };
}

function saveLocal(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log('state_error', `Gagal simpan state lokal: ${err.message}`);
  }
}

// ── Save: lokal + cloud ───────────────────────────────────────────────────────
function saveState(state) {
  saveLocal(state);
  saveToCloud(state).catch(() => {}); // non-blocking
}

// ── Init state (load cloud dulu, fallback ke lokal) ───────────────────────────
let _state = loadLocal();

export async function initState() {
  const cloud = await loadFromCloud();
  // Hanya pakai cloud state jika berhasil dimuat (bukan null)
  // Kondisi sebelumnya `>= 0` selalu true, termasuk saat cloud kosong
  if (cloud && typeof cloud.positions === 'object') {
    _state = cloud;
    saveLocal(_state); // sync ke lokal
    log('state', `☁️  State dari cloud: ${Object.keys(_state.positions).length} posisi terbuka`);
  } else {
    log('state', `💾 State dari lokal: ${Object.keys(_state.positions).length} posisi terbuka`);
  }
}

// ── Position CRUD ─────────────────────────────────────────────────────────────
export function openPosition({ symbol, entryPrice, quantity, orderId, budget, score, signals }) {
  _state.positions[symbol] = {
    symbol,
    entryPrice,
    quantity,
    orderId,
    budget,
    score,
    signals,
    openedAt:       new Date().toISOString(),
    peakPrice:      entryPrice,
    trailingActive: false,
    partialSells:   [],
  };
  saveState(_state);
  log('state', `📂 Posisi dibuka: ${symbol} @ ${entryPrice} qty=${quantity}`);
}

export function updatePeakPrice(symbol, currentPrice) {
  const pos = _state.positions[symbol];
  if (!pos) return;
  if (currentPrice > pos.peakPrice) {
    pos.peakPrice = currentPrice;
    saveState(_state);
  }
}

export function activateTrailing(symbol) {
  const pos = _state.positions[symbol];
  if (pos && !pos.trailingActive) {
    pos.trailingActive = true;
    saveState(_state);
    log('state', `🔻 Trailing stop aktif: ${symbol}`);
  }
}

export function recordPartialSell(symbol, { sellQty, price, reason }) {
  const pos = _state.positions[symbol];
  if (!pos) return;
  pos.partialSells.push({ sellQty, price, reason, at: new Date().toISOString() });
  pos.quantity -= sellQty;
  saveState(_state);
}

export function closePosition(symbol, { exitPrice, reason }) {
  const pos = _state.positions[symbol];
  if (!pos) return null;

  const pnlUsdt = (exitPrice - pos.entryPrice) * pos.quantity;
  const pnlPct  = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;

  const closed = {
    ...pos,
    exitPrice,
    closedAt: new Date().toISOString(),
    reason,
    pnlUsdt,
    pnlPct,
  };

  _state.closed.push(closed);
  _state.totalPnlUsdt = (_state.totalPnlUsdt || 0) + pnlUsdt;
  delete _state.positions[symbol];
  saveState(_state);

  log('state', `📁 Posisi ditutup: ${symbol} @ ${exitPrice} | PnL=${pnlPct.toFixed(2)}% (${pnlUsdt >= 0 ? '+' : ''}${pnlUsdt.toFixed(2)} USDT)`);
  return closed;
}

// ── Getters ───────────────────────────────────────────────────────────────────
export function getPosition(symbol)  { return _state.positions[symbol] || null; }
export function getAllPositions()     { return _state.positions; }
export function getOpenSymbols()     { return Object.keys(_state.positions); }
export function hasPosition(symbol)  { return !!_state.positions[symbol]; }

export function getStats() {
  return {
    openPositions: Object.keys(_state.positions).length,
    closedCount:   _state.closed.length,
    totalPnlUsdt:  _state.totalPnlUsdt || 0,
  };
}

export function reload() {
  _state = loadLocal();
}
