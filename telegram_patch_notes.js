// ─────────────────────────────────────────────────────────────────────────────
// PATCH: Di telegram.js, fungsi notifyApprovalRequest()
// Tambahkan 'utbot' ke stratLabel mapping (baris awal fungsi)
// ─────────────────────────────────────────────────────────────────────────────

// GANTI baris ini di notifyApprovalRequest():
//   const stratLabel = c.strategy === 'mtfSmartMoney' ? '🧠 MTF Smart Money'
//     : c.strategy === 'reversal' ? '🔄 Reversal Hunter'
//     : c.strategy === 'trendFollowing' ? '📈 Trend Following' : '🚀 Daily Gainer';
//
// DENGAN:
//   const stratLabel = c.strategy === 'mtfSmartMoney'   ? '🧠 MTF Smart Money'
//     : c.strategy === 'reversal'       ? '🔄 Reversal Hunter'
//     : c.strategy === 'trendFollowing' ? '📈 Trend Following'
//     : c.strategy === 'utbot'          ? '📡 UT Bot Alert'
//     : '🚀 Daily Gainer';
//
// ─────────────────────────────────────────────────────────────────────────────
// PATCH: Di telegram.js, fungsi notifyBuy()
// Tambahkan 'utbot' ke stratLabel mapping (baris awal fungsi)
// ─────────────────────────────────────────────────────────────────────────────

// GANTI baris ini di notifyBuy():
//   const stratLabel =
//       strategy === 'mtfSmartMoney' ? '🧠 MTF Smart Money'
//     : strategy === 'reversal'      ? '🔄 Reversal Hunter'
//     : strategy === 'trendFollowing'? '📈 Trend Following'
//     : strategy === 'manual'        ? '🖐 Manual'
//     :                                '🚀 Daily Gainer';
//
// DENGAN:
//   const stratLabel =
//       strategy === 'mtfSmartMoney'   ? '🧠 MTF Smart Money'
//     : strategy === 'reversal'        ? '🔄 Reversal Hunter'
//     : strategy === 'trendFollowing'  ? '📈 Trend Following'
//     : strategy === 'utbot'           ? '📡 UT Bot Alert'
//     : strategy === 'manual'          ? '🖐 Manual'
//     :                                  '🚀 Daily Gainer';
//
// ─────────────────────────────────────────────────────────────────────────────
// PATCH: Di dashboard.html, fungsi stratLabel() dan stratFullLabel()
// Tambahkan entry 'utbot'
// ─────────────────────────────────────────────────────────────────────────────

// GANTI di stratLabel():
//   return {mtfSmartMoney:'MTF',trendFollowing:'TREND',reversal:'REV',dailyGainer:'GAINER',manual:'MANUAL'}[s] || s || '—';
// DENGAN:
//   return {mtfSmartMoney:'MTF',trendFollowing:'TREND',reversal:'REV',dailyGainer:'GAINER',utbot:'UTBOT',manual:'MANUAL'}[s] || s || '—';

// GANTI di stratFullLabel():
//   return {mtfSmartMoney:'🧠 MTF Smart Money',trendFollowing:'📈 Trend Following',reversal:'🔄 Reversal Hunter',dailyGainer:'🚀 Daily Gainer',manual:'🖐 Manual'}[s] || s || '—';
// DENGAN:
//   return {mtfSmartMoney:'🧠 MTF Smart Money',trendFollowing:'📈 Trend Following',reversal:'🔄 Reversal Hunter',dailyGainer:'🚀 Daily Gainer',utbot:'📡 UT Bot Alert',manual:'🖐 Manual'}[s] || s || '—';
