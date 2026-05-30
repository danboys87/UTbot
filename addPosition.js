/**
 * Script input manual posisi terbuka
 * Pakai saat bot restart/redeploy dan posisi hilang dari state
 *
 * Cara pakai:
 *   node addPosition.js SYMBOL ENTRY_PRICE QUANTITY
 *
 * Contoh:
 *   node addPosition.js KAIAUSDT 0.1850 108.5
 *   node addPosition.js HYPEUSDT 42.71 0.46
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('dotenv').config();

import { openPosition, initState } from './state.js';

const args     = process.argv.slice(2);
const symbol   = args[0]?.toUpperCase();
const entry    = parseFloat(args[1]);
const quantity = parseFloat(args[2]);

if (!symbol || isNaN(entry) || isNaN(quantity)) {
  console.log('');
  console.log('❌ Format salah!');
  console.log('');
  console.log('Cara pakai:');
  console.log('  node addPosition.js SYMBOL ENTRY_PRICE QUANTITY');
  console.log('');
  console.log('Contoh:');
  console.log('  node addPosition.js KAIAUSDT 0.1850 108.5');
  console.log('  node addPosition.js HYPEUSDT 42.71 0.46');
  console.log('');
  process.exit(1);
}

console.log('');
console.log(`📂 Menambahkan posisi manual:`);
console.log(`   Symbol     : ${symbol}`);
console.log(`   Entry Price: ${entry}`);
console.log(`   Quantity   : ${quantity}`);
console.log(`   Budget est : ${(entry * quantity).toFixed(2)} USDT`);
console.log('');

// Load state dari cloud dulu agar posisi tidak tertimpa
await initState();

openPosition({
  symbol,
  entryPrice: entry,
  quantity,
  orderId:    'manual_input',
  budget:     entry * quantity,
  score:      0,
  signals:    {},
});

console.log(`✅ Posisi ${symbol} berhasil ditambahkan ke state!`);
console.log('');
