// ═══════════════════════════════════════════
//  13-backtest.js — Moteur de Backtest Spring
//  Rôle : Simulation historique TP/SL multi-ATR, stats, charts canvas
//  Dépendances : state.js, utils.js, indicators.js, analysis.js
// ═══════════════════════════════════════════

async function runBacktest() {
  if (backtesting || scanning) return;
  if (!selPair && results.length === 0) { log('Lance un scan d\'abord', 'warn'); return; }

  const pair = selPair || results[0].pair;
  backtesting = true; btResult = null;

  const tpMult     = +(document.getElementById('btTpAtr').value)    || 2.5;
  const slMult     = +(document.getElementById('btSlAtr').value)     || 1.5;
  const signalType = document.getElementById('btSignalType').value   || 'SPRING';

  const cfg = {
    bbMult:   +(document.getElementById('bbMult').value)   || 2.0,
    kcMult:   +(document.getElementById('kcMult').value)   || 1.5,
    adxMin:   +(document.getElementById('adxMin').value)   || 20,
    rvolMin:  +(document.getElementById('rvolMin').value)  || 1.5,
    sqzMin:   +(document.getElementById('sqzMin').value)   || 4,
    scoreMin: +(document.getElementById('scoreMin').value) || 55,
  };

  // Réinitialisation UI
  document.getElementById('btnScan').disabled = true;
  document.getElementById('btnScan').textContent = '⏳ BACKTEST...';
  document.getElementById('btEmpty').style.display = 'none';
  document.getElementById('btTableBody').innerHTML = '';
  document.getElementById('panelTitle').textContent = 'BACKTEST SPRING — ' + pair;
  ['btWinRate','btProfit','btAvg','btTrades','btExpect','btMaxDD','btPF','btDur']
    .forEach(id => document.getElementById(id).textContent = '...');
  log(`Backtest Spring · ${pair} · ${tfLabel()} · TP:${tpMult}ATR · SL:${slMult}ATR · signal:${signalType}`, 'sys');

  try {
    const url = `${COINBASE}/products/${pair}/candles?granularity=${TF}`;
    const res = await fetch(url, {headers: {'Accept': 'application/json'}});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const raw = await res.json();
    const candles = raw.slice(0, 300).reverse().map(c => ({
      t: +c[0], low: +c[1], high: +c[2], open: +c[3], close: +c[4], vol: +c[5]
    }));
    if (candles.length < 100) throw new Error('Pas assez de données historiques');

    const trades   = [];
    let openTrade  = null;
    let prevSpring = false;

    for (let i = 80; i < candles.length; i++) {
      const window = candles.slice(0, i + 1);
      const atrV   = calcATR(window);

      let signalDetected = false;
      let signalLabel    = '';

      // Détection Spring
      if (signalType === 'SPRING' || signalType === 'BOTH') {
        const sp = detectSpring(window, cfg.bbMult, cfg.kcMult);
        if (sp.detected && !prevSpring) {
          signalDetected = true;
          signalLabel    = '🌿 SPRING';
          prevSpring     = true;
        } else if (!sp.detected) {
          prevSpring = false;
        }
      }

      // Détection FIRE
      if ((signalType === 'FIRE' || signalType === 'BOTH') && !signalDetected) {
        const sq = analyzeSqueeze(window, cfg);
        if (sq && sq.sqzType === 'FIRE') {
          signalDetected = true;
          signalLabel    = '🔥 FIRE';
        }
      }

      // Entrée si signal + pas de trade ouvert
      if (signalDetected && !openTrade) {
        const entry = candles[i].close;
        openTrade = {
          pair,
          signal:    signalLabel,
          entry,
          entryTime: candles[i].t,
          entryIdx:  i,
          sl:        entry - slMult * atrV,
          tp:        entry + tpMult * atrV,
          slPrice:   entry - slMult * atrV,
          tpPrice:   entry + tpMult * atrV,
          atr:       atrV,
        };
      }

      // Sortie si trade ouvert
      if (openTrade && i > openTrade.entryIdx) {
        const c = candles[i];
        if (c.low <= openTrade.sl) {
          trades.push({
            signal:     openTrade.signal,
            entryTime:  openTrade.entryTime,
            entryPrice: openTrade.entry,
            exitTime:   c.t,
            exitPrice:  openTrade.sl,
            tpPrice:    openTrade.tpPrice,
            slPrice:    openTrade.slPrice,
            entryIdx:   openTrade.entryIdx,
            exitIdx:    i,
            profitPct:  ((openTrade.sl - openTrade.entry) / openTrade.entry) * 100,
            duration:   i - openTrade.entryIdx,
            status: 'LOSS'
          });
          openTrade = null;
        } else if (c.high >= openTrade.tp) {
          trades.push({
            signal:     openTrade.signal,
            entryTime:  openTrade.entryTime,
            entryPrice: openTrade.entry,
            exitTime:   c.t,
            exitPrice:  openTrade.tp,
            tpPrice:    openTrade.tpPrice,
            slPrice:    openTrade.slPrice,
            entryIdx:   openTrade.entryIdx,
            exitIdx:    i,
            profitPct:  ((openTrade.tp - openTrade.entry) / openTrade.entry) * 100,
            duration:   i - openTrade.entryIdx,
            status: 'WIN'
          });
          openTrade = null;
        }
      }
    }

    // ── Calcul des statistiques ──
    const totalTrades = trades.length;
    const wins        = trades.filter(t => t.status === 'WIN');
    const losses      = trades.filter(t => t.status === 'LOSS');
    const winRate     = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;
    const totalProfit = trades.reduce((s, t) => s + t.profitPct, 0);
    const avgProfit   = totalTrades > 0 ? totalProfit / totalTrades : 0;
    const avgWin      = wins.length   > 0 ? wins.reduce((s,t)=>s+t.profitPct,0)/wins.length   : 0;
    const avgLoss     = losses.length > 0 ? losses.reduce((s,t)=>s+t.profitPct,0)/losses.length : 0;
    const expectancy  = (winRate / 100) * avgWin + ((100 - winRate) / 100) * avgLoss;

    let equity = 0, peak = 0, maxDD = 0;
    const equityCurve = [0];
    trades.forEach(t => {
      equity += t.profitPct;
      equityCurve.push(equity);
      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDD) maxDD = dd;
    });

    const grossWins    = wins.reduce((s,t)=>s+t.profitPct,0);
    const grossLosses  = Math.abs(losses.reduce((s,t)=>s+t.profitPct,0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;
    const avgDuration  = totalTrades > 0
      ? (trades.reduce((s,t)=>s+(t.duration||0),0)/totalTrades).toFixed(1)
      : '—';

    btResult = {pair, trades, candles, equityCurve, totalTrades, winRate, totalProfit, avgProfit, expectancy, maxDD, profitFactor, avgDuration, tpMult, slMult};

    // ── Affichage des KPIs ──
    const c = (id, v, pos) => {
      const el = document.getElementById(id);
      el.textContent = v;
      el.className = 'bt-stat-val ' + (pos === undefined ? '' : (pos ? 'g' : 'r'));
    };
    c('btWinRate',  winRate.toFixed(1)+'%',                          winRate >= 50);
    c('btProfit',   (totalProfit>=0?'+':'')+totalProfit.toFixed(2)+'%', totalProfit >= 0);
    c('btAvg',      (avgProfit>=0?'+':'')+avgProfit.toFixed(2)+'%',     avgProfit >= 0);
    document.getElementById('btTrades').textContent = wins.length + 'W / ' + losses.length + 'L';
    c('btExpect',   (expectancy>=0?'+':'')+expectancy.toFixed(2)+'%',   expectancy >= 0);
    c('btMaxDD',    '-' + maxDD.toFixed(2) + '%',                        false);
    c('btPF',       profitFactor === Infinity ? '∞' : profitFactor.toFixed(2), profitFactor >= 1);
    document.getElementById('btDur').textContent = avgDuration + ' bougies';

    // ── Table des trades ──
    const tbody = document.getElementById('btTableBody');
    tbody.innerHTML = '';
    trades.forEach(t => {
      const tr  = document.createElement('tr');
      const dt  = new Date(t.entryTime * 1000).toLocaleString('fr-FR', {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
      const pctCls = t.profitPct >= 0 ? 'style="color:var(--green)"' : 'style="color:var(--red)"';
      const pctStr = (t.profitPct >= 0 ? '+' : '') + t.profitPct.toFixed(2) + '%';
      const stCls  = t.status === 'WIN' ? 'status-win' : 'status-loss';
      tr.innerHTML =
        `<td>${dt}</td>` +
        `<td style="color:var(--green)">${t.signal}</td>` +
        `<td>${fmt(t.entryPrice)}</td>` +
        `<td style="color:var(--green);font-size:9px">${fmt(t.tpPrice)}</td>` +
        `<td style="color:var(--red);font-size:9px">${fmt(t.slPrice)}</td>` +
        `<td>${fmt(t.exitPrice)}</td>` +
        `<td ${pctCls}>${pctStr}</td>` +
        `<td style="color:var(--dim)">${t.duration || '—'}b</td>` +
        `<td><span class="${stCls}">${t.status}</span></td>`;
      tbody.appendChild(tr);
    });

    drawBacktestChart(candles, trades, cfg.bbMult, cfg.kcMult);
    drawEquityCurve(equityCurve);

    log(`Backtest ${pair} : ${totalTrades} trades · Win ${winRate.toFixed(1)}% · Espérance ${expectancy.toFixed(2)}% · PF ${profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)}`, 'ok');
    if (totalTrades === 0) {
      document.getElementById('btEmpty').style.display = '';
      log('Aucun signal détecté sur cette période — essaie FIRE ou ajuste les paramètres', 'warn');
    }

  } catch (e) {
    log('Erreur backtest : ' + e.message, 'err');
    document.getElementById('btEmpty').style.display = '';
  }

  backtesting = false;
  document.getElementById('btnScan').disabled = false;
  document.getElementById('btnScan').textContent = '⚡ RUN BACKTEST';
}

// ═══════════════════════════════════════════
//  CHART BACKTEST — Prix + BB lower + trades (Canvas)
// ═══════════════════════════════════════════

function drawBacktestChart(candles, trades, bbMult, kcMult) {
  const canvas = document.getElementById('btCanvas');
  const dpr    = window.devicePixelRatio || 1;
  const W      = canvas.parentElement.clientWidth - 24;
  const H      = 240;
  canvas.width  = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const prices   = candles.map(c => c.close);
  const bbLowers = candles.map((_, i) => {
    if (i < 20) return null;
    const bb = calcBB(candles.slice(0, i + 1).map(c => c.close), 20, bbMult || 2.0);
    return bb ? bb.lower : null;
  });

  const allVals = [...prices, ...bbLowers.filter(v => v !== null)];
  const minP    = Math.min(...allVals), maxP = Math.max(...allVals);
  const pad     = (maxP - minP) * 0.1;
  const lo      = minP - pad, hi = maxP + pad;
  const scaleY  = v => H - ((v - lo) / (hi - lo)) * H;
  const scaleX  = i => (i / (candles.length - 1)) * W;

  // Fond dégradé
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(0,255,136,0.06)');
  grad.addColorStop(1, 'rgba(0,255,136,0)');
  ctx.beginPath();
  ctx.moveTo(scaleX(0), scaleY(prices[0]));
  prices.forEach((p, i) => ctx.lineTo(scaleX(i), scaleY(p)));
  ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // Grilles
  ctx.strokeStyle = 'rgba(14,42,74,0.5)'; ctx.lineWidth = 1;
  [0.2, 0.4, 0.6, 0.8].forEach(f => {
    const y = Math.round(f * H) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    const val = lo + (1 - f) * (hi - lo);
    ctx.fillStyle = 'rgba(58,80,112,0.7)'; ctx.font = '9px Share Tech Mono,monospace';
    ctx.fillText(fmt(val), 4, y - 3);
  });

  // BB lower
  ctx.beginPath(); ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(0,212,255,0.5)'; ctx.lineWidth = 1;
  let bbStarted = false;
  bbLowers.forEach((v, i) => {
    if (v === null) return;
    if (!bbStarted) { ctx.moveTo(scaleX(i), scaleY(v)); bbStarted = true; }
    else ctx.lineTo(scaleX(i), scaleY(v));
  });
  ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(0,212,255,0.7)'; ctx.font = '8px Share Tech Mono,monospace';
  ctx.fillText('BB lower', 4, H - 8);

  // Prix principal
  ctx.beginPath(); ctx.strokeStyle = 'rgba(0,255,136,0.75)'; ctx.lineWidth = 1.5;
  ctx.moveTo(scaleX(0), scaleY(prices[0]));
  prices.forEach((p, i) => ctx.lineTo(scaleX(i), scaleY(p)));
  ctx.stroke();

  // Trades
  trades.forEach(t => {
    if (t.entryIdx == null || t.exitIdx == null) return;
    const ex = scaleX(t.entryIdx), lx = scaleX(t.exitIdx);
    const isWin = t.status === 'WIN';
    ctx.fillStyle = isWin ? 'rgba(0,255,136,0.06)' : 'rgba(255,51,102,0.06)';
    ctx.fillRect(ex, 0, lx - ex, H);
    const ty = scaleY(t.tpPrice);
    ctx.beginPath(); ctx.setLineDash([2, 3]);
    ctx.strokeStyle = 'rgba(0,255,136,0.3)'; ctx.lineWidth = 1;
    ctx.moveTo(ex, ty); ctx.lineTo(lx, ty); ctx.stroke();
    const sy = scaleY(t.slPrice);
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,51,102,0.3)'; ctx.lineWidth = 1;
    ctx.moveTo(ex, sy); ctx.lineTo(lx, sy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.setLineDash([3, 3]);
    ctx.strokeStyle = isWin ? 'rgba(0,255,136,0.5)' : 'rgba(255,51,102,0.5)'; ctx.lineWidth = 1;
    ctx.moveTo(ex, scaleY(t.entryPrice)); ctx.lineTo(lx, scaleY(t.exitPrice));
    ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(lx, scaleY(t.exitPrice), 5, 0, Math.PI * 2);
    ctx.fillStyle = isWin ? 'var(--green)' : 'var(--red)'; ctx.fill();
    ctx.beginPath(); ctx.arc(ex, scaleY(t.entryPrice), 5, 0, Math.PI * 2);
    ctx.fillStyle = 'var(--green)'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.fill(); ctx.stroke();
  });

  // Tooltip
  const tooltip = document.getElementById('chartTooltip');
  canvas.onmousemove = e => {
    const rect = canvas.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const idx  = Math.round((mx / W) * (candles.length - 1));
    if (idx >= 0 && idx < candles.length) {
      const c  = candles[idx];
      const dt = new Date(c.t * 1000).toLocaleString('fr-FR', {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
      const bbL = bbLowers[idx];
      tooltip.style.display = 'block';
      tooltip.style.left    = Math.min(mx + 10, W - 140) + 'px';
      tooltip.style.top     = Math.max(scaleY(c.close) - 40, 4) + 'px';
      tooltip.innerHTML     = dt + '<br>Close : ' + fmt(c.close) + (bbL ? '<br>BB lower : ' + fmt(bbL) : '');
    }
  };
  canvas.onmouseleave = () => { tooltip.style.display = 'none'; };
}

// ═══════════════════════════════════════════
//  EQUITY CURVE CANVAS
// ═══════════════════════════════════════════

function drawEquityCurve(equityCurve) {
  const canvas = document.getElementById('btEquityCanvas');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.parentElement.clientWidth - 24;
  const H   = 120;
  canvas.width  = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  if (equityCurve.length < 2) {
    ctx.fillStyle = 'var(--dim)'; ctx.font = '11px Share Tech Mono,monospace';
    ctx.fillText('Aucun trade', 10, H / 2); return;
  }

  const minE  = Math.min(...equityCurve), maxE = Math.max(...equityCurve);
  const range = (maxE - minE) || 1;
  const pad   = range * 0.12;
  const lo    = minE - pad, hi = maxE + pad;
  const scaleY = v => H - ((v - lo) / (hi - lo)) * H;
  const scaleX = i => (i / (equityCurve.length - 1)) * W;

  const finalPos = equityCurve[equityCurve.length - 1] >= 0;
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, finalPos ? 'rgba(0,255,136,0.18)' : 'rgba(255,51,102,0.18)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  ctx.moveTo(scaleX(0), scaleY(equityCurve[0]));
  equityCurve.forEach((v, i) => ctx.lineTo(scaleX(i), scaleY(v)));
  ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  const zeroY = scaleY(0);
  ctx.beginPath(); ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(58,80,112,0.7)'; ctx.lineWidth = 1;
  ctx.moveTo(0, zeroY); ctx.lineTo(W, zeroY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(58,80,112,0.8)'; ctx.font = '9px Share Tech Mono,monospace';
  ctx.fillText('0%', 4, zeroY - 3);

  ctx.beginPath();
  ctx.strokeStyle = finalPos ? 'rgba(0,255,136,0.9)' : 'rgba(255,51,102,0.9)';
  ctx.lineWidth = 2;
  ctx.moveTo(scaleX(0), scaleY(equityCurve[0]));
  equityCurve.forEach((v, i) => ctx.lineTo(scaleX(i), scaleY(v)));
  ctx.stroke();

  const last = equityCurve[equityCurve.length - 1];
  ctx.beginPath(); ctx.arc(W, scaleY(last), 5, 0, Math.PI * 2);
  ctx.fillStyle = last >= 0 ? 'var(--green)' : 'var(--red)'; ctx.fill();
  ctx.fillStyle = last >= 0 ? 'var(--green)' : 'var(--red)';
  ctx.font = 'bold 10px Share Tech Mono,monospace';
  ctx.fillText((last >= 0 ? '+' : '') + last.toFixed(2) + '%', W - 80, scaleY(last) - 8);
}

// ═══════════════════════════════════════════
//  EXPORT CSV
// ═══════════════════════════════════════════

function downloadCSV() {
  if (!btResult) return;
  const headers = ['Pair','Signal','Entry Time','Entry Price','TP','SL','Exit Price','Profit %','Durée (bougies)','Status'];
  const rows = btResult.trades.map(t => [
    btResult.pair,
    t.signal || '',
    new Date(t.entryTime * 1000).toISOString(),
    t.entryPrice,
    t.tpPrice?.toFixed(6) || '',
    t.slPrice?.toFixed(6) || '',
    t.exitPrice,
    t.profitPct.toFixed(2),
    t.duration || '',
    t.status
  ]);
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const a   = document.createElement('a');
  a.href     = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'backtest_spring_' + btResult.pair + '_' + Date.now() + '.csv';
  a.click();
  log('CSV téléchargé · ' + btResult.pair, 'sys');
}
