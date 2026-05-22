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
  const swingHighs = [];
  const LB = 3;
  for (let i = LB; i < candles.length - LB; i++) {
    const isH = highs.slice(i - LB, i).every(h => h <= highs[i])
             && highs.slice(i + 1, i + LB + 1).every(h => h <= highs[i]);
    if (isH) swingHighs.push({ idx: i, price: highs[i] });
  }
  if (swingHighs.length < 2) return { type: null, bullish: false };
  const lastClose = closes[closes.length - 1];
  const prevHigh  = swingHighs[swingHighs.length - 2].price;
  if (lastClose > prevHigh) {
    const isChoCh = swingHighs.length >= 3
      && swingHighs[swingHighs.length - 2].price < swingHighs[swingHighs.length - 3].price;
    return { type: isChoCh ? 'ChoCh' : 'BoS', bullish: true };
  }
  return { type: null, bullish: false };
}

function validateDailyTrend(candles1D) {
  if (!candles1D || candles1D.length < 30) return { valid: false, reason: 'Data 1D kurang' };
  const closes    = candles1D.map(c => parseFloat(c[4]));
  const ema21     = calcEMA(closes, 21);
  const lastClose = closes[closes.length - 1];
  if (!ema21 || lastClose <= ema21)
    return { valid: false, reason: `Price di bawah EMA21 ${ema21?.toFixed(6)}`, ema21 };
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

  if (ema21_4H) zones.push({
    type: 'EMA21', entryPct: 30,
    priceTop: ema21_4H * 1.005, priceBottom: ema21_4H * 0.995,
    label: `EMA21 4H @ ${ema21_4H.toFixed(6)}`,
  });

  if (orderBlocks.length > 0) {
    const best = orderBlocks[0];
    zones.push({ type: 'OrderBlock', entryPct: 70, priceTop: best.zoneTop, priceBottom: best.zoneBottom, label: `OB Demand ${best.zoneBottom.toFixed(6)} - ${best.zoneTop.toFixed(6)}`, obData: best });
  } else if (swingLow) {
    zones.push({ type: 'SwingLow', entryPct: 70, priceTop: swingLow * 1.02, priceBottom: swingLow * 0.98, label: `Swing Low @ ${swingLow.toFixed(6)}` });
  }

  if (zones.length === 0) return { valid: false, reason: 'Tidak ada zone entry', zones: [] };
  return { valid: true, zones, ema21_4H, swingLow, orderBlocks, reason: `${zones.length} zona ditemukan` };
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
        getCandles(coin.symbol, '1day', 60),
        getCandles(coin.symbol, '4h',   100),
        getCandles(coin.symbol, '1H',   50),
      ]);
      await sleep(300);

      const c1D = Array.isArray(raw1D) ? raw1D.slice().reverse() : [];
      const c4H = Array.isArray(raw4H) ? raw4H.slice().reverse() : [];
      const c1H = Array.isArray(raw1H) ? raw1H.slice().reverse() : [];

      const step1 = validateDailyTrend(c1D);
      if (!step1.valid) { log('screener', `    ↳ ❌ [1D] ${step1.reason}`); continue; }
      log('screener', `    ↳ ✅ [1D] ${step1.reason}`);

      const step2 = mapEntryZones(c4H);
      if (!step2.valid) { log('screener', `    ↳ ❌ [4H] ${step2.reason}`); continue; }
      log('screener', `    ↳ ✅ [4H] ${step2.reason}`);

      const step3 = checkTrigger1H(c1H, step2.zones);
      log('screener', `    ↳ ${step3.triggered ? '✅' : '⏳'} [1H] ${step3.reason}`);

      const lowestZone = Math.min(...step2.zones.map(z => z.priceBottom));
      const slPrice    = lowestZone * (1 - (cfg.management?.slBuffer ?? 0.005));
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

      if (candidates.length >= maxBuy) { log('screener', `  Batas ${maxBuy} tercapai.`); break; }
    } catch (err) {
      log('screener_error', `MTF error ${coin.symbol}: ${err.message}`);
    }
    await sleep(200);
  }

  // ── Step 4: AI Analysis ───────────────────────────────────────────────────
  if (candidates.length > 0 && process.env.ANTHROPIC_API_KEY) {
    log('screener', `🤖 AI analisa untuk ${candidates.length} kandidat...`);
    for (const c of candidates) {
      try {
        c.aiAnalysis = await analyzeCandidate(c);
        await sleep(1500);
      } catch (err) {
        log('screener_error', `AI ${c.symbol}: ${err.message}`);
      }
    }
  } else if (!process.env.ANTHROPIC_API_KEY) {
    log('screener', '⚠️ ANTHROPIC_API_KEY tidak ada — AI dilewati');
  }

  candidates.sort((a, b) => {
    const as = (a.triggered ? 100 : 0) + (a.aiAnalysis?.verdict === 'BUY_NOW' ? 50 : 0) + a.score;
    const bs = (b.triggered ? 100 : 0) + (b.aiAnalysis?.verdict === 'BUY_NOW' ? 50 : 0) + b.score;
    return bs - as;
  });

  log('screener', `MTF selesai → ${candidates.length} kandidat`);
  return candidates;
}
