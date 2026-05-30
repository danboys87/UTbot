/**
 * Screener — Multi-Timeframe (MTF) Smart Money Concept
 * v3.1 — dengan AI Analyst auto-trigger
 *
 * Flow:
 *  Step 1 (1D): Bullish jika price > EMA21 AND ada Green BoS/ChoCh
 *  Step 2 (4H): Deteksi Unmitigated Order Block / Demand Zone
 *  Step 3 (1H): Konfirmasi trigger (Pinbar / Bullish Engulfing / ChoCh)
 *  Step 4 (AI): Auto-analisa teknikal + sentimen → verdict + confidence
 */

import { getCandles } from './bitget.js';
import { config }     from './config.js';
import { log }        from './logger.js';
import { hasPosition } from './state.js';
import { calcEMA, calcRSI } from './indicators.js';
import { analyzeCandidate } from './aiAnalyst.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Step 1: 1D BoS/ChoCh ────────────────────────────────────────────────────
function detectStructure(candles) {
  if (candles.length < 20) return { type: null, bullish: false };
  const closes = candles.map(c => parseFloat(c[4]));
  const highs  = candles.map(c => parseFloat(c[2]));
  const lows   = candles.map(c => parseFloat(c[3]));

  // Coba LB=2 dan LB=3 — pakai yang menghasilkan lebih banyak swing
  const swingHighs = [];
  const swingLows  = [];
  for (const LB of [2, 3]) {
    for (let i = LB; i < candles.length - LB; i++) {
      const isH = highs.slice(i - LB, i).every(h => h <= highs[i])
               && highs.slice(i + 1, i + LB + 1).every(h => h <= highs[i]);
      const isL = lows.slice(i - LB, i).every(l => l >= lows[i])
               && lows.slice(i + 1, i + LB + 1).every(l => l >= lows[i]);
      if (isH && !swingHighs.find(s => s.idx === i)) swingHighs.push({ idx: i, price: highs[i] });
      if (isL && !swingLows.find(s => s.idx === i))  swingLows.push({ idx: i, price: lows[i] });
    }
  }
  swingHighs.sort((a, b) => a.idx - b.idx);
  swingLows.sort((a, b) => a.idx - b.idx);

  const lastClose = closes[closes.length - 1];

  // BoS Bullish: close terbaru menembus swing high sebelumnya
  // Pakai lastClose saja (bukan lastHigh) agar tidak lolos karena wick saja
  if (swingHighs.length >= 2) {
    const prevHigh = swingHighs[swingHighs.length - 2].price;
    if (lastClose > prevHigh) {
      const isChoCh = swingHighs.length >= 3
        && swingHighs[swingHighs.length - 2].price < swingHighs[swingHighs.length - 3].price;
      return { type: isChoCh ? 'ChoCh' : 'BoS', bullish: true };
    }
  }

  // Higher High sederhana — hanya valid jika lastClose juga di atas EMA21
  const ema21val  = calcEMA(closes, 21);
  const recentHigh = Math.max(...highs.slice(-10));
  const prevHigh10 = Math.max(...highs.slice(-20, -10));
  if (recentHigh > prevHigh10 && ema21val && lastClose > ema21val) {
    return { type: 'BoS', bullish: true };
  }

  return { type: null, bullish: false };
}

function validateDailyTrend(candles1D) {
  if (!candles1D || candles1D.length < 30) return { valid: false, reason: 'Data 1D kurang' };
  const closes    = candles1D.map(c => parseFloat(c[4]));
  const ema21     = calcEMA(closes, 21);
  const lastClose = closes[closes.length - 1];
  const lastTs    = parseInt(candles1D[candles1D.length - 1][0]);
  const lastDate  = new Date(lastTs).toISOString().slice(0, 10);

  // Debug: log candle terakhir yang dipakai
  // log('screener', `  [1D debug] lastClose=${lastClose} ema21=${ema21?.toFixed(4)} date=${lastDate}`);

  if (!ema21 || lastClose <= ema21)
    return { valid: false, reason: `Price ${lastClose.toFixed(6)} di bawah EMA21 ${ema21?.toFixed(6)} (candle ${lastDate})`, ema21 };
  const structure = detectStructure(candles1D);
  if (!structure.bullish) return { valid: false, reason: 'Tidak ada BoS/ChoCh bullish', ema21 };
  return { valid: true, reason: `Bullish: price > EMA21 & ${structure.type}`, ema21, structure: structure.type, lastClose };
}

// ── Step 2: 4H Order Block ───────────────────────────────────────────────────
function detectOrderBlocks(candles4H) {
  if (!candles4H || candles4H.length < 30) return [];
  const bodies  = candles4H.map(c => Math.abs(parseFloat(c[4]) - parseFloat(c[1])));
  const avgBody = bodies.slice(-30).reduce((s, b) => s + b, 0) / 30;
  const blocks  = [];

  for (let i = 2; i < candles4H.length - 3; i++) {
    const open  = parseFloat(candles4H[i][1]);
    const close = parseFloat(candles4H[i][4]);
    const body  = close - open;
    if (!(body > avgBody * 1.5 && close > open)) continue;

    let obIdx = -1;
    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      if (parseFloat(candles4H[j][4]) < parseFloat(candles4H[j][1])) { obIdx = j; break; }
    }
    if (obIdx === -1) continue;

    const ob        = candles4H[obIdx];
    const zoneTop   = Math.max(parseFloat(ob[1]), parseFloat(ob[4]));
    const zoneBottom = parseFloat(ob[3]);

    let mitigated = false;
    for (let k = i + 1; k < candles4H.length; k++) {
      if (parseFloat(candles4H[k][3]) <= zoneTop) { mitigated = true; break; }
    }
    if (!mitigated) blocks.push({ zoneTop, zoneBottom, age: candles4H.length - 1 - i });
  }

  const lastClose = parseFloat(candles4H[candles4H.length - 1][4]);
  return blocks
    .filter(ob => ob.zoneTop < lastClose)
    .sort((a, b) => (lastClose - a.zoneTop) - (lastClose - b.zoneTop));
}

function mapEntryZones(candles4H) {
  if (!candles4H || candles4H.length < 30) return { valid: false, reason: 'Data 4H kurang', zones: [] };
  const closes4H    = candles4H.map(c => parseFloat(c[4]));
  const ema21_4H    = calcEMA(closes4H, 21);
  const orderBlocks = detectOrderBlocks(candles4H);
  const swingLow    = Math.min(...candles4H.slice(-21, -1).map(c => parseFloat(c[3])));
  const zones       = [];

  // Cari swing low terbaru (5 candle terakhir) sebagai SL reference untuk EMA21 zone
  // SMC: SL di bawah swing low terdekat sebelum entry
  const recentSwingLow = Math.min(...candles4H.slice(-6, -1).map(c => parseFloat(c[3])));

  if (ema21_4H) zones.push({
    type:        'EMA21',
    entryPct:    30,
    priceTop:    ema21_4H * 1.005,
    priceBottom: ema21_4H * 0.995,
    label:       `EMA21 4H @ ${ema21_4H.toFixed(6)}`,
    // SL untuk zone EMA21: di bawah swing low terbaru sebelum EMA21
    slRef:       recentSwingLow,
    slLabel:     `Swing Low terbaru @ ${recentSwingLow.toFixed(6)}`,
  });

  if (orderBlocks.length > 0) {
    const best = orderBlocks[0];
    zones.push({
      type:        'OrderBlock',
      entryPct:    70,
      priceTop:    best.zoneTop,
      priceBottom: best.zoneBottom,
      label:       `OB Demand ${best.zoneBottom.toFixed(6)} - ${best.zoneTop.toFixed(6)}`,
      obData:      best,
      // SL untuk OB: di bawah wick terendah candle OB (zoneBottom = low candle OB)
      slRef:       best.zoneBottom,
      slLabel:     `Low OB @ ${best.zoneBottom.toFixed(6)}`,
    });
  } else if (swingLow) {
    zones.push({
      type:        'SwingLow',
      entryPct:    70,
      priceTop:    swingLow * 1.02,
      priceBottom: swingLow * 0.985,
      label:       `Swing Low Support @ ${swingLow.toFixed(6)}`,
      // SL untuk SwingLow: di bawah swing low itu sendiri
      slRef:       swingLow,
      slLabel:     `Swing Low @ ${swingLow.toFixed(6)}`,
    });
  }

  if (zones.length === 0) return { valid: false, reason: 'Tidak ada zone entry', zones: [] };

  // SL keseluruhan: ambil slRef terendah dari semua zone yang ada
  const slRefs = zones.map(z => z.slRef).filter(Boolean);
  const overallSlRef = slRefs.length > 0 ? Math.min(...slRefs) : swingLow;

  return { valid: true, zones, ema21_4H, swingLow, orderBlocks, overallSlRef, reason: `${zones.length} zona ditemukan` };
}

// ── Step 3: 1H Trigger ───────────────────────────────────────────────────────
function detectPinbar(c) {
  const [o, h, l, cl] = [parseFloat(c[1]), parseFloat(c[2]), parseFloat(c[3]), parseFloat(c[4])];
  const body = Math.abs(cl - o), lw = Math.min(o, cl) - l, uw = h - Math.max(o, cl), range = h - l;
  return range > 0 && body > 0 && lw >= body * 2 && uw <= body * 0.5 && lw / range >= 0.5;
}

function detectBullishEngulfing(c1, c2) {
  const [o1, cl1, o2, cl2] = [parseFloat(c1[1]), parseFloat(c1[4]), parseFloat(c2[1]), parseFloat(c2[4])];
  return cl1 < o1 && cl2 > o2 && o2 < cl1 && cl2 > o1;
}

function detectChoCh1H(candles1H) {
  if (candles1H.length < 10) return false;
  const closes = candles1H.map(c => parseFloat(c[4]));
  const lows   = candles1H.map(c => parseFloat(c[3]));
  const highs  = candles1H.map(c => parseFloat(c[2]));
  return Math.min(...lows.slice(-5)) > Math.min(...lows.slice(-10, -5))
      && closes[closes.length - 1] > Math.max(...highs.slice(-5, -1));
}

function checkTrigger1H(candles1H, zones) {
  if (!candles1H || candles1H.length < 10) return { triggered: false, reason: 'Data 1H kurang' };
  const last = candles1H[candles1H.length - 1];
  const prev = candles1H[candles1H.length - 2];
  const lastClose = parseFloat(last[4]);
  const lastLow   = parseFloat(last[3]);

  const activeZone = zones.find(z => lastLow <= z.priceTop * 1.01 && lastClose >= z.priceBottom * 0.99);
  if (!activeZone) return { triggered: false, reason: `Harga ${lastClose} belum di zone manapun` };

  const isPinbar    = detectPinbar(last);
  const isEngulfing = detectBullishEngulfing(prev, last);
  const isChoCh     = detectChoCh1H(candles1H);
  const triggered   = isPinbar || isEngulfing || isChoCh;
  const patterns    = [isPinbar && 'Pinbar', isEngulfing && 'Bullish Engulfing', isChoCh && '1H ChoCh'].filter(Boolean);

  return { triggered, activeZone, patterns, reason: triggered ? `${patterns.join(' + ')} di ${activeZone.label}` : `Di zone ${activeZone.label} belum ada konfirmasi` };
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
export async function runMTFScreening(tickers, cfg) {
  const sc         = cfg.screening;
  const mtf        = sc.mtf ?? {};
  const quoteAsset = cfg.trading.quoteAsset || 'USDT';
  const minVol     = mtf.minVolume24h ?? 50_000_000;
  const maxBuy     = mtf.topCandidatesLimit ?? 3;
  const checkLimit = mtf.checkLimit ?? 100;
  const whitelist  = cfg.whitelist ?? [];

  log('screener', '══ MTF Smart Money Screening mulai ══');

  const filtered = tickers
    .filter(t => {
      if (!t.symbol.endsWith(quoteAsset))    return false;
      if (cfg.blacklist?.includes(t.symbol)) return false;
      if (hasPosition(t.symbol))             return false;
      if (parseFloat(t.usdtVol || t.quoteVolume || 0) < minVol) return false;
      if (whitelist.length > 0 && !whitelist.includes(t.symbol)) return false;
      return true;
    })
    .map(t => ({
      symbol:    t.symbol,
      lastPrice: parseFloat(t.lastPr || t.last || 0),
      vol24h:    parseFloat(t.usdtVol || t.quoteVolume || 0),
      change24h: parseFloat(t.change24h || 0),
    }))
    .sort((a, b) => b.vol24h - a.vol24h);

  const toCheck    = filtered.slice(0, checkLimit);
  const candidates = [];
  log('screener', `${toCheck.length} koin lolos filter`);

  for (let i = 0; i < toCheck.length; i++) {
    const coin = toCheck[i];
    log('screener', `  [MTF ${i + 1}/${toCheck.length}] ${coin.symbol} | $${(coin.vol24h / 1e6).toFixed(1)}M`);

    try {
      const [raw1D, raw4H, raw1H] = await Promise.all([
        getCandles(coin.symbol, '1day', 62),  // +2 buffer untuk exclude candle live
        getCandles(coin.symbol, '4h',   102),
        getCandles(coin.symbol, '1h',   52),
      ]);
      await sleep(300);

      // Fix: filter candle live berdasarkan timestamp, bukan posisi index
      // slice(0,-1) tidak reliable untuk 1day dengan limit besar
      const now         = Date.now();
      const parse1D = (raw) => {
        if (!Array.isArray(raw)) return [];
        const periodStart = now - (now % 86400000);
        return raw.filter(c => parseInt(c[0]) < periodStart).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
      };
      const parse4H = (raw) => {
        if (!Array.isArray(raw)) return [];
        const periodStart = now - (now % 14400000);
        return raw.filter(c => parseInt(c[0]) < periodStart).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
      };
      const parse1H = (raw) => {
        if (!Array.isArray(raw)) return [];
        const periodStart = now - (now % 3600000);
        return raw.filter(c => parseInt(c[0]) < periodStart).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
      };

      const c1D = parse1D(raw1D);
      const c4H = parse4H(raw4H);
      const c1H = parse1H(raw1H);

      const step1 = validateDailyTrend(c1D);
      if (!step1.valid) { log('screener', `    ↳ ❌ [1D] ${step1.reason}`); continue; }
      log('screener', `    ↳ ✅ [1D] ${step1.reason}`);

      // ── Filter jarak price ke EMA21 1D ────────────────────────────────────
      // Jika price terlalu jauh di atas EMA21 (> maxDistPct), zone entry tidak realistis
      // Koin yang baru pump besar → EMA21 tertinggal jauh → skip
      const maxDistPct = cfg.screening?.mtf?.maxEMA21DistPct ?? 25; // default 25%
      const ema21Dist  = ((coin.lastPrice - step1.ema21) / step1.ema21) * 100;
      if (ema21Dist > maxDistPct) {
        log('screener', `    ↳ ❌ [1D] Price terlalu jauh dari EMA21 (${ema21Dist.toFixed(1)}% > max ${maxDistPct}%) — zone tidak realistis`);
        continue;
      }
      log('screener', `    ↳ ✅ [1D] Jarak EMA21: ${ema21Dist.toFixed(1)}% (max ${maxDistPct}%)`);

      const step2 = mapEntryZones(c4H);
      if (!step2.valid) { log('screener', `    ↳ ❌ [4H] ${step2.reason}`); continue; }
      log('screener', `    ↳ ✅ [4H] ${step2.reason}`);

      const step3 = checkTrigger1H(c1H, step2.zones);
      log('screener', `    ↳ ${step3.triggered ? '✅' : '⏳'} [1H] ${step3.reason}`);

      // ── SL Calculation (SMC-based) ──────────────────────────────────────────
      // SL ditempatkan di bawah referensi struktur yang relevan:
      //   - OB zone    → di bawah low candle OB (zoneBottom)
      //   - SwingLow   → di bawah swing low aktual
      //   - EMA21 zone → di bawah swing low terbaru sebelum entry
      // Buffer 0.5% ditambahkan agar tidak kena noise / wick palsu
      const buffer    = cfg.management?.slBuffer ?? 0.005;
      const slRefBase = step2.overallSlRef ?? step2.swingLow ?? Math.min(...step2.zones.map(z => z.priceBottom));
      const slPrice   = slRefBase * (1 - buffer);

      // Log SL reference untuk transparansi
      log('screener', `    ↳ 📍 SL ref: ${slRefBase.toFixed(6)} → SL: ${slPrice.toFixed(6)} (buffer ${(buffer*100).toFixed(1)}%)`);
      const score      = (step2.orderBlocks?.length ?? 0) * 30
                       + (step3.triggered ? 50 : 0)
                       + (step1.structure === 'ChoCh' ? 20 : 10)
                       + coin.vol24h / 1e8;

      candidates.push({
        symbol:     coin.symbol,
        lastPrice:  coin.lastPrice,
        change24h:  coin.change24h,
        vol24h:     coin.vol24h,
        score,
        strategy:   'mtfSmartMoney',
        triggered:  step3.triggered,
        zones:      step2.zones,
        entryZone1: step2.zones.find(z => z.type === 'EMA21'),
        entryZone2: step2.zones.find(z => z.type === 'OrderBlock' || z.type === 'SwingLow'),
        slPrice,
        signals: {
          trend1D:     { bullish: true,              label: `1D ${step1.structure} | EMA21 @ ${step1.ema21?.toFixed(4)}` },
          demandZone:  { bullish: true,              label: step2.zones.map(z => z.label).join(' | ') },
          trigger1H:   { bullish: step3.triggered,   label: step3.reason, patterns: step3.patterns ?? [] },
          orderBlocks: { bullish: (step2.orderBlocks?.length ?? 0) > 0, label: `${step2.orderBlocks?.length ?? 0} OB unmitigated`, count: step2.orderBlocks?.length ?? 0 },
        },
        ema21_1D:   step1.ema21,
        ema21_4H:   step2.ema21_4H,
        swingLow4H: step2.swingLow,
        matchCount: (step1.valid ? 1 : 0) + (step2.valid ? 1 : 0) + (step3.triggered ? 1 : 0),
        aiAnalysis: null,
      });

      // Triggered candidates dibatasi maxBuy
      // Pre-alert candidates tetap dikumpulkan untuk notif pantau
      const triggeredCount = candidates.filter(c => c.triggered).length;
      if (triggeredCount >= maxBuy) {
        log('screener', `  Batas ${maxBuy} triggered kandidat tercapai.`);
        break;
      }
      // Total candidates (termasuk pre-alert) max 2x maxBuy
      if (candidates.length >= maxBuy * 2) break;
    } catch (err) {
      log('screener_error', `MTF error ${coin.symbol}: ${err.message}`);
    }
    await sleep(200);
  }

  // ── Step 4: AI Analysis — hanya untuk kandidat yang fully triggered (3/3 TF) ──
  const { isAIEnabled } = await import('./aiAnalyst.js');
  const triggeredCandidates = candidates.filter(c => c.triggered);
  const prealertCandidates  = candidates.filter(c => !c.triggered);

  if (prealertCandidates.length > 0) {
    log('screener', `⏳ ${prealertCandidates.length} kandidat pre-alert (1H belum konfirmasi): ${prealertCandidates.map(c => c.symbol).join(', ')}`);
    log('screener', `   → Tidak dianalisa AI. Masuk queue approval untuk dipantau.`);
  }

  if (triggeredCandidates.length > 0 && isAIEnabled()) {
    log('screener', `🤖 AI analisa untuk ${triggeredCandidates.length} kandidat triggered: ${triggeredCandidates.map(c => c.symbol).join(', ')}`);
    for (const c of triggeredCandidates) {
      try {
        log('screener', `  → Analisa ${c.symbol} (1D✅ 4H✅ 1H✅)...`);
        c.aiAnalysis = await analyzeCandidate(c);
        await sleep(1500);
      } catch (err) {
        log('screener_error', `AI ${c.symbol}: ${err.message}`);
      }
    }
  } else if (triggeredCandidates.length > 0) {
    log('screener', '⚠️ AI tidak aktif — set OPENROUTER_API_KEY atau GEMINI_API_KEY di .env');
  } else if (candidates.length > 0) {
    log('screener', `ℹ️ Semua kandidat pre-alert — tunggu konfirmasi 1H lalu /analyze manual`);
  }

  // Sort: triggered + AI BUY_NOW → triggered biasa → pre-alert
  candidates.sort((a, b) => {
    const score = (c) =>
      (c.triggered ? 1000 : 0) +
      (c.aiAnalysis?.verdict === 'BUY_NOW' ? 500 : 0) +
      (c.aiAnalysis?.verdict === 'WAIT'    ? 100 : 0) +
      (c.aiAnalysis?.confidence ?? 0) +
      c.score;
    return score(b) - score(a);
  });

  const nTriggered = candidates.filter(c => c.triggered).length;
  const nPrealert  = candidates.filter(c => !c.triggered).length;
  log('screener', `MTF selesai → ${nTriggered} triggered ✅ | ${nPrealert} pre-alert ⏳`);
  return candidates;
}
