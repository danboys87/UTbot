/**
 * Symbol Filter — Crypto Spot Only
 *
 * Memfilter tokenized stocks (saham AS yang ditokenisasi) dari daftar ticker.
 * Bitget punya field 'areaSymbol' di endpoint /api/v2/spot/public/symbols:
 *   - "no"  → crypto spot murni (BTCUSDT, ETHUSDT, dst)
 *   - "yes" → tokenized / area-restricted asset (saham, RWA, dst)
 *
 * Cache di-refresh setiap 6 jam agar selalu up-to-date saat Bitget listing baru.
 */

import { log } from './logger.js';

const SYMBOLS_URL    = 'https://api.bitget.com/api/v2/spot/public/symbols';
const CACHE_TTL_MS   = 6 * 60 * 60 * 1000; // 6 jam

let _cryptoSymbols   = new Set(); // set of symbol string yang confirmed crypto
let _lastFetch       = 0;
let _fetchPromise    = null;       // prevent concurrent fetches

// ─────────────────────────────────────────────────────────────────────────────
// Fetch & cache
// ─────────────────────────────────────────────────────────────────────────────
async function fetchAndCache() {
  try {
    const res  = await fetch(SYMBOLS_URL);
    const data = await res.json();

    if (data.code !== '00000' || !Array.isArray(data.data)) {
      throw new Error(`API error: ${data.msg}`);
    }

    const cryptoSet = new Set();
    let totalRwa    = 0;

    for (const s of data.data) {
      if (s.areaSymbol === 'no') {
        cryptoSet.add(s.symbol);
      } else {
        totalRwa++;
      }
    }

    _cryptoSymbols = cryptoSet;
    _lastFetch     = Date.now();

    log('symbol_filter', `✅ Symbol cache updated: ${cryptoSet.size} crypto spot, ${totalRwa} non-crypto (tokenized/RWA) difilter`);
    return true;

  } catch (err) {
    log('symbol_filter', `⚠ Gagal fetch symbols: ${err.message} — pakai cache lama (${_cryptoSymbols.size} entries)`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pastikan cache tersedia dan fresh
// ─────────────────────────────────────────────────────────────────────────────
async function ensureCache() {
  const stale = Date.now() - _lastFetch > CACHE_TTL_MS;

  if (_cryptoSymbols.size > 0 && !stale) return; // cache masih valid

  // Prevent concurrent fetches
  if (_fetchPromise) {
    await _fetchPromise;
    return;
  }

  _fetchPromise = fetchAndCache().finally(() => { _fetchPromise = null; });
  await _fetchPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cek apakah symbol adalah crypto spot murni.
 * Kalau cache kosong (belum pernah fetch), fallback ke true agar tidak block screener.
 */
export function isCryptoSpot(symbol) {
  if (_cryptoSymbols.size === 0) return true; // fallback jika cache belum siap
  return _cryptoSymbols.has(symbol);
}

/**
 * Pre-load cache. Panggil sekali saat startup bot.
 */
export async function initSymbolFilter() {
  log('symbol_filter', 'Memuat daftar symbol crypto spot dari Bitget...');
  await fetchAndCache();
}

/**
 * Filter array tickers, hanya kembalikan crypto spot murni.
 * Otomatis refresh cache jika sudah stale.
 */
export async function filterCryptoOnly(tickers) {
  await ensureCache();

  if (_cryptoSymbols.size === 0) {
    // Cache gagal total — kembalikan semua dengan warning
    log('symbol_filter', '⚠ Cache kosong, tidak bisa filter — semua ticker dikembalikan');
    return tickers;
  }

  const before  = tickers.length;
  const filtered = tickers.filter(t => _cryptoSymbols.has(t.symbol));
  const removed  = before - filtered.length;

  if (removed > 0) {
    log('symbol_filter', `Filter: ${before} → ${filtered.length} ticker (${removed} non-crypto dibuang)`);
  }

  return filtered;
}
