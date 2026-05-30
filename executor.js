/**
 * Executor
 * Eksekusi order beli/jual ke Bitget Spot API.
 */
import { placeOrder, getOrder, getAssetBalance, getCurrentPrice } from './bitget.js';
import { config }    from './config.js';
import { log }       from './logger.js';
import { logTrade }  from './logger.js';
import { openPosition, closePosition as closePos, recordPartialSell } from './state.js';

const isDryRun = process.env.DRY_RUN === 'true';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Helper: hitung quantity dari budget ───────────────────────────────────────
// Tentukan jumlah desimal qty berdasarkan harga
// Bitget error checkBDScale terjadi jika desimal qty melebihi batas per simbol
function getQtyDecimals(price) {
  if (price >= 10000) return 6;  // BTC, ETH: qty kecil, bisa banyak desimal
  if (price >= 100)   return 4;
  if (price >= 1)     return 2;
  return 2;                      // koin murah: qty besar, Bitget max 2 desimal
}

async function calcQuantity(symbol, budget) {
  const price = await getCurrentPrice(symbol);
  if (!price || price <= 0) throw new Error(`Harga tidak valid untuk ${symbol}`);

  const decimals   = getQtyDecimals(price);
  const multiplier = Math.pow(10, decimals);
  const qty        = Math.floor((budget / price) * multiplier) / multiplier;
  return { price, qty };
}

// ── Beli ──────────────────────────────────────────────────────────────────────
export async function executeBuy(candidate) {
  const { symbol, score, signals } = candidate;
  const budget = config.trading.budgetPerTrade;

  try {
    log('executor', `Mencoba beli ${symbol} | budget=${budget} USDT`);

    const { price: currentPrice, qty } = await calcQuantity(symbol, budget);

    if (qty <= 0) {
      log('executor_error', `Quantity tidak valid untuk ${symbol}`);
      return { success: false, error: 'Quantity <= 0' };
    }

    if (isDryRun) {
      log('executor', `[DRY RUN] BUY ${symbol} qty=${qty} @ ${currentPrice}`);
      openPosition({
        symbol,
        entryPrice: currentPrice,
        quantity:   qty,
        orderId:    `dryrun_${Date.now()}`,
        budget,
        score,
        signals,
      });
      logTrade({ side: 'buy', symbol, qty, price: currentPrice, reason: 'dry-run' });
      return { success: true, entryPrice: currentPrice, quantity: qty, orderId: 'dry-run' };
    }

    // Cek saldo USDT
    const usdtBalance = await getAssetBalance('USDT');
    const available   = parseFloat(usdtBalance?.available || 0);
    const needed      = budget + config.trading.gasReserve;

    if (available < needed) {
      log('executor_error', `Saldo USDT tidak cukup: ${available} < ${needed}`);
      return { success: false, error: 'Saldo tidak cukup' };
    }

    // Pasang order market buy
    // Bitget market buy: gunakan 'size' dalam USDT (quoteAmt) bukan token qty
    const order = await placeOrder({
      symbol,
      side:      'buy',
      orderType: 'market',
      size:      budget,
      quoteMode: true,  // flag untuk executor tahu ini USDT amount
    });

    const orderId = order?.orderId;
    if (!orderId) throw new Error('Tidak ada orderId dari API');

    // Tunggu sebentar lalu ambil harga fill
    await sleep(1500);
    const orderDetail = await getOrder(orderId, symbol).catch(() => null);
    const fillPrice   = orderDetail ? parseFloat(orderDetail.priceAvg || orderDetail.fillPrice || currentPrice) : currentPrice;
    const fillQty     = orderDetail ? parseFloat(orderDetail.baseVolume || orderDetail.fillSize || qty) : qty;

    openPosition({
      symbol,
      entryPrice: fillPrice,
      quantity:   fillQty,
      orderId,
      budget,
      score,
      signals,
    });

    logTrade({ side: 'buy', symbol, qty: fillQty, price: fillPrice, reason: 'screening' });
    log('executor', `✅ BUY ${symbol} | qty=${fillQty} @ ${fillPrice} | orderId=${orderId}`);

    return { success: true, entryPrice: fillPrice, quantity: fillQty, orderId };

  } catch (err) {
    log('executor_error', `Beli ${symbol} gagal: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ── Jual ──────────────────────────────────────────────────────────────────────
export async function executeSell(symbol, { quantity, reason, position }) {
  try {
    log('executor', `Mencoba jual ${symbol} | qty=${quantity} | reason=${reason}`);

    const currentPrice = await getCurrentPrice(symbol);
    if (!currentPrice) throw new Error(`Tidak bisa ambil harga ${symbol}`);

    if (isDryRun) {
      log('executor', `[DRY RUN] SELL ${symbol} qty=${quantity} @ ${currentPrice}`);
      const closed = closePos(symbol, { exitPrice: currentPrice, reason });
      if (closed) {
        logTrade({ side: 'sell', symbol, qty: quantity, price: currentPrice, reason });
      }
      return {
        success: true,
        exitPrice: currentPrice,
        pnlPct:   closed?.pnlPct,
        pnlUsdt:  closed?.pnlUsdt,
      };
    }

    // Cek saldo token
    const baseAsset = symbol.replace('USDT', '');
    const tokenBal  = await getAssetBalance(baseAsset);
    const available = parseFloat(tokenBal?.available || 0);

    // Round qty ke 2 desimal (standar aman Bitget untuk koin murah)
    // Hindari error checkBDScale akibat terlalu banyak desimal
    const rawQty  = Math.min(quantity, available);
    const sellQty = Math.floor(rawQty * 100) / 100;

    if (sellQty <= 0) {
      log('executor_error', `Saldo ${baseAsset} tidak cukup: ${available}`);
      return { success: false, error: 'Saldo token tidak cukup' };
    }

    const order = await placeOrder({
      symbol,
      side:      'sell',
      orderType: 'market',
      size:      sellQty,
    });

    const orderId = order?.orderId;
    await sleep(1500);
    const orderDetail = await getOrder(orderId, symbol).catch(() => null);
    const fillPrice   = orderDetail ? parseFloat(orderDetail.priceAvg || orderDetail.fillPrice || currentPrice) : currentPrice;

    const closed = closePos(symbol, { exitPrice: fillPrice, reason });
    logTrade({ side: 'sell', symbol, qty: sellQty, price: fillPrice, reason });

    log('executor', `✅ SELL ${symbol} | qty=${sellQty} @ ${fillPrice} | reason=${reason}`);

    return {
      success:   true,
      exitPrice: fillPrice,
      pnlPct:    closed?.pnlPct,
      pnlUsdt:   closed?.pnlUsdt,
    };

  } catch (err) {
    log('executor_error', `Jual ${symbol} gagal: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ── Partial Sell ──────────────────────────────────────────────────────────────
export async function executePartialSell(symbol, { sellPct, reason, position }) {
  try {
    const sellQty = Math.floor(position.quantity * (sellPct / 100) * 10000) / 10000;
    if (sellQty <= 0) return { success: false, error: 'Partial qty terlalu kecil' };

    const currentPrice = await getCurrentPrice(symbol);
    if (!currentPrice) throw new Error('Harga tidak valid');

    log('executor', `Partial sell ${symbol}: ${sellPct}% (${sellQty}) @ ${currentPrice} | reason=${reason}`);

    if (isDryRun) {
      recordPartialSell(symbol, { sellQty, price: currentPrice, reason });
      logTrade({ side: 'sell', symbol, qty: sellQty, price: currentPrice, reason: `partial-${reason}` });
      return { success: true, exitPrice: currentPrice, qty: sellQty };
    }

    const baseAsset = symbol.replace('USDT', '');
    const tokenBal  = await getAssetBalance(baseAsset);
    const available = parseFloat(tokenBal?.available || 0);

    // Round ke 2 desimal agar tidak kena error checkBDScale dari Bitget
    const rawActual = Math.min(sellQty, available);
    const actualQty = Math.floor(rawActual * 100) / 100;

    if (actualQty <= 0) return { success: false, error: 'Saldo tidak cukup untuk partial' };

    const order = await placeOrder({
      symbol,
      side:      'sell',
      orderType: 'market',
      size:      actualQty,
    });

    await sleep(1500);
    const orderDetail = await getOrder(order?.orderId, symbol).catch(() => null);
    const fillPrice   = orderDetail ? parseFloat(orderDetail.priceAvg || currentPrice) : currentPrice;

    recordPartialSell(symbol, { sellQty: actualQty, price: fillPrice, reason });
    logTrade({ side: 'sell', symbol, qty: actualQty, price: fillPrice, reason: `partial-${reason}` });

    return { success: true, exitPrice: fillPrice, qty: actualQty };

  } catch (err) {
    log('executor_error', `Partial sell ${symbol} gagal: ${err.message}`);
    return { success: false, error: err.message };
  }
}
