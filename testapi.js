// testapi.js — Test koneksi Bitget API
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('dotenv').config();

import { testConnection } from './bitget.js';

console.log('');
console.log('=== Bitget API Connection Test ===');
console.log('');
console.log('API Key  :', process.env.BITGET_API_KEY?.slice(0, 10) + '...');
console.log('Secret   :', process.env.BITGET_SECRET_KEY?.slice(0, 5) + '...');
console.log('Passphrase:', process.env.BITGET_PASSPHRASE?.slice(0, 3) + '...');
console.log('');
console.log('Testing connection...');
console.log('');

const result = await testConnection();

if (result.ok) {
  console.log('✅ Koneksi BERHASIL!');
  console.log('   Aset ditemukan:', result.assets);
} else {
  console.log('❌ Koneksi GAGAL!');
  console.log('   Error:', result.error);
  console.log('');
  console.log('Kemungkinan penyebab:');
  console.log('  1. API Key salah atau sudah dihapus di Bitget');
  console.log('  2. Secret Key tidak sesuai dengan API Key');
  console.log('  3. Passphrase salah');
  console.log('  4. IP Whitelist aktif — nonaktifkan di Bitget API Management');
}
console.log('');
