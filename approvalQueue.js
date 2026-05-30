/**
 * Approval Queue
 * Menyimpan kandidat yang menunggu konfirmasi manual via Telegram.
 * 
 * Alur:
 *  1. Screening nemu kandidat → masuk queue
 *  2. Bot kirim notif ke Telegram dengan instruksi /approve atau /skip
 *  3. User reply → bot eksekusi buy, kandidat TETAP di queue jika masih ada sisa entry
 *  4. Kandidat dihapus jika: kedua entry done, /approveall, /skip, atau expired
 */

import { log } from './logger.js';

// Map: symbol → { candidate, expiresAt, notified, entry1Done, entry2Done }
const _queue = new Map();

// Callbacks yang di-set oleh index.js
let _onApprove  = null;
let _onApprove2 = null;
let _onExpire   = null;

export function setCallbacks({ onApprove, onApprove2, onExpire }) {
  _onApprove  = onApprove;
  _onApprove2 = onApprove2;
  _onExpire   = onExpire;
}

// Tambah kandidat ke queue
export function addToQueue(candidate, timeoutMin = 30) {
  const symbol    = candidate.symbol;
  const expiresAt = Date.now() + timeoutMin * 60 * 1000;

  if (_queue.has(symbol)) {
    log('approval', `${symbol} sudah ada di queue, skip`);
    return false;
  }

  _queue.set(symbol, {
    candidate,
    expiresAt,
    notified:   true,
    entry1Done: false,
    entry2Done: false,
  });
  log('approval', `${symbol} masuk queue, expired dalam ${timeoutMin} menit`);

  // Auto-expire
  setTimeout(() => {
    if (_queue.has(symbol)) {
      log('approval', `⏰ ${symbol} expired tanpa konfirmasi`);
      _queue.delete(symbol);
      if (_onExpire) _onExpire(symbol);
    }
  }, timeoutMin * 60 * 1000);

  return true;
}

// Approve Entry 1 — kandidat TETAP di queue jika entry2 belum done
export async function approveCandidate(symbol) {
  const item = _queue.get(symbol);
  if (!item) return { ok: false, reason: `${symbol} tidak ada di queue atau sudah expired` };

  if (item.entry1Done) return { ok: false, reason: `Entry 1 ${symbol} sudah pernah dieksekusi` };

  log('approval', `✅ ${symbol} Entry 1 diapprove`);
  item.entry1Done = true;

  if (_onApprove) await _onApprove(item.candidate);

  // Hapus dari queue hanya jika entry2 juga sudah done
  if (item.entry2Done) {
    _queue.delete(symbol);
    log('approval', `${symbol} kedua entry selesai → hapus dari queue`);
    return { ok: true, done: true };
  }

  log('approval', `${symbol} Entry 1 done — Entry 2 masih tersedia di queue`);
  return { ok: true, done: false, remaining: 'entry2' };
}

// Approve Entry 2 — kandidat TETAP di queue jika entry1 belum done
export async function approveEntry2(symbol) {
  const item = _queue.get(symbol);
  if (!item) return { ok: false, reason: `${symbol} tidak ada di queue atau sudah expired` };

  if (item.entry2Done) return { ok: false, reason: `Entry 2 ${symbol} sudah pernah dieksekusi` };

  log('approval', `✅ ${symbol} Entry 2 diapprove`);
  item.entry2Done = true;

  if (_onApprove2) await _onApprove2(item.candidate);

  // Hapus dari queue hanya jika entry1 juga sudah done
  if (item.entry1Done) {
    _queue.delete(symbol);
    log('approval', `${symbol} kedua entry selesai → hapus dari queue`);
    return { ok: true, done: true };
  }

  log('approval', `${symbol} Entry 2 done — Entry 1 masih tersedia di queue`);
  return { ok: true, done: false, remaining: 'entry1' };
}

// Approve ALL — eksekusi full, hapus dari queue
export async function approveAll(symbol, onApproveAll) {
  const item = _queue.get(symbol);
  if (!item) return { ok: false, reason: `${symbol} tidak ada di queue atau sudah expired` };

  _queue.delete(symbol);
  log('approval', `✅ ${symbol} Full position diapprove → hapus dari queue`);

  if (onApproveAll) await onApproveAll(item.candidate);

  return { ok: true, done: true };
}

// Skip kandidat — hapus dari queue
export function skipCandidate(symbol) {
  const item = _queue.get(symbol);
  if (!item) return { ok: false, reason: `${symbol} tidak ada di queue atau sudah expired` };

  _queue.delete(symbol);
  log('approval', `⏭️  ${symbol} diskip`);
  return { ok: true };
}

// Lihat semua yang masih pending
export function getPendingQueue() {
  const now = Date.now();
  const result = [];
  for (const [symbol, item] of _queue.entries()) {
    const minsLeft = Math.max(0, Math.round((item.expiresAt - now) / 60000));
    result.push({
      symbol,
      candidate:  item.candidate,
      minsLeft,
      entry1Done: item.entry1Done,
      entry2Done: item.entry2Done,
    });
  }
  return result;
}

export function clearQueue() {
  _queue.clear();
}
