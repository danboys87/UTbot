/**
 * State Sync — JSONBin.io
 * Menyimpan dan memuat state bot ke/dari JSONBin.io
 * agar state tidak hilang saat restart/redeploy.
 *
 * Setup:
 * 1. Daftar di https://jsonbin.io
 * 2. Buat bin kosong: {"positions":{},"closed":[],"totalPnlUsdt":0}
 * 3. Copy BIN_ID dan API_KEY ke Railway Variables:
 *    JSONBIN_BIN_ID  = xxxxxxxxxxxxxxxx
 *    JSONBIN_API_KEY = $2b$10$xxxxxxxxxxxxxxxx
 */

import { log } from './logger.js';

const BIN_ID  = process.env.JSONBIN_BIN_ID;
const API_KEY = process.env.JSONBIN_API_KEY;
const BASE    = 'https://api.jsonbin.io/v3/b';

const MAX_CLOSED_RECORDS = 50; // batas riwayat trade tersimpan

function isConfigured() {
  return !!(BIN_ID && API_KEY);
}

// ── Load state dari JSONBin ───────────────────────────────────────────────────
export async function loadFromCloud() {
  if (!isConfigured()) return null;

  try {
    const res  = await fetch(`${BASE}/${BIN_ID}/latest`, {
      headers: { 'X-Master-Key': API_KEY },
    });
    const data = await res.json();
    if (data?.record) {
      log('state', '☁️  State dimuat dari JSONBin');
      return data.record;
    }
  } catch (err) {
    log('state_error', `Gagal load dari JSONBin: ${err.message}`);
  }
  return null;
}

// ── Simpan state ke JSONBin ───────────────────────────────────────────────────
export async function saveToCloud(state) {
  if (!isConfigured()) return;

  try {
    // Batasi riwayat closed agar tidak melebihi 10KB
    const trimmed = { ...state };
    if (trimmed.closed && trimmed.closed.length > MAX_CLOSED_RECORDS) {
      trimmed.closed = trimmed.closed.slice(-MAX_CLOSED_RECORDS);
    }

    await fetch(`${BASE}/${BIN_ID}`, {
      method:  'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': API_KEY,
      },
      body: JSON.stringify(trimmed),
    });
  } catch (err) {
    log('state_error', `Gagal simpan ke JSONBin: ${err.message}`);
  }
}
