/**
 * BACKTEST2.JS — Backtest Phase 2 (Sniper M1)
 * SqueezePulse V2.4
 * Rejoue les signaux Sniper sur historique M1 (300 bougies)
 * TP/SL configurables, equity curve canvas, stats complètes
 */

const Backtest2 = {

    COINBASE: 'https://api.exchange.coinbase.com',
    GRAN:     60,    // M1

    // Config par défaut
    CFG: {
        tpPct:        3.0,   // Take Profit %
        slPct:        1.5,   // Stop Loss %
        minSignals:   4,     // signaux minimum pour déclencher (sur 6)
        capital:      1000,  // capital simulé en USD
        feePct:       0.06,  // frais Coinbase taker (%)
    },

    currentPair: '',
    isRunning:   false,
    trades:      [],
    candles:     [],

    // ── Fetch M1 ─────────────────────────────────────────────────────────────

    // ── Utilitaire : fetch avec retry exponentiel sur 429 ─────────────────

    async fetchWithRetry(url, { maxRetries = 3, baseMs = 1000, capMs = 8000, label = url } = {}) {
        let attempt = 0;
        while (attempt <= maxRetries) {
            const res = await fetch(url);
            if (res.ok) return res;
            if (res.status === 429) {
                await this.sleep(Math.min(baseMs * Math.pow(2, attempt), capMs));
                attempt++; continue;
            }
            throw new Error(`HTTP ${res.status} — ${label}`);
        }
        throw new Error(`Max retries — ${label}`);
    },

    async fetchCandles(pair, limit = 300) {
        const url = `${this.COINBASE}/products/${pair}/candles?granularity=${this.GRAN}`;
        const res = await this.fetchWithRetry(url, { label: pair });
        const raw = await res.json();
        return raw.slice(0, limit).reverse().map(c => ({
            t: +c[0], low: +c[1], high: +c[2], open: +c[3], close: +c[4], vol: +c[5]
        }));
    },

    // ── Replay historique ─────────────────────────────────────────────────────
    // Optimisation cache incrémental :
    // - on ne recalcule que ce qui change à chaque bougie (OBV, RSI, MACD)
    // - les séries longues (EMA26, SMA20) sont étendues d'une valeur, pas recalculées
    // - slice() remplacé par un pointeur d'index → zéro allocation

    replayHistory(candles, cfg) {
        const S      = window.Scanner;
        const trades = [];
        const minIdx = 50;
        let inTrade  = false;
        let entry    = null;

        // ── Pré-calcul des séries complètes une seule fois ────────────────────
        const closes  = candles.map(c => c.close);
        const vols    = candles.map(c => c.vol);
        const n       = candles.length;

        // OBV complet — O(n)
        const obvFull = S.calcOBV(candles);

        // RSI 14 complet — O(n)
        const rsiFull = S.calcRSI(candles, 14);

        // ── SMA20 rolling O(1) via somme glissante ────────────────────────
        const sma20Full = new Array(n).fill(null);
        const std20Full = new Array(n).fill(null);
        let sumC = 0, sumC2 = 0;
        for (let i = 0; i < n; i++) {
            sumC  += closes[i];
            sumC2 += closes[i] * closes[i];
            if (i >= 19) {
                if (i > 19) { sumC -= closes[i - 20]; sumC2 -= closes[i - 20] * closes[i - 20]; }
                const mean    = sumC / 20;
                const variance = Math.max(0, sumC2 / 20 - mean * mean);
                sma20Full[i] = mean;
                std20Full[i] = Math.sqrt(variance);
            }
        }

        // ── Volume SMA20 rolling O(1) ─────────────────────────────────────
        const volSma20Full = new Array(n).fill(null);
        let sumV = 0;
        for (let i = 0; i < n; i++) {
            sumV += vols[i];
            if (i >= 20) { sumV -= vols[i - 20]; volSma20Full[i] = sumV / 20; }
        }

        // ── MACD incrémental O(n) ─────────────────────────────────────────
        // EMA12, EMA26 : initialisées sur les 12/26 premières bougies, puis mise à jour O(1)
        const k12 = 2 / 13, k26 = 2 / 27, k9 = 2 / 10;
        const macdFull   = new Array(n).fill(null);
        const signalFull = new Array(n).fill(null);
        let ema12 = null, ema26 = null, emaSignal = null;
        let sum12 = 0, sum26 = 0;
        let macdCount = 0; // nb de valeurs MACD non-null pour init signal
        for (let i = 0; i < n; i++) {
            // Amorçage SMA → puis EMA
            if (i < 12)       { sum12 += closes[i]; }
            else if (i === 12) { sum12 += closes[i]; ema12 = sum12 / 13; }
            else               { ema12 = closes[i] * k12 + ema12 * (1 - k12); }

            if (i < 26)       { sum26 += closes[i]; }
            else if (i === 26) { sum26 += closes[i]; ema26 = sum26 / 27; }
            else               { ema26 = closes[i] * k26 + ema26 * (1 - k26); }

            if (ema12 !== null && ema26 !== null && i >= 26) {
                const macd = ema12 - ema26;
                macdFull[i] = macd;
                // Signal = EMA9 du MACD
                macdCount++;
                if (macdCount < 9)       { /* pas encore assez */ }
                else if (macdCount === 9) { emaSignal = macd; signalFull[i] = emaSignal; }
                else                     { emaSignal = macd * k9 + emaSignal * (1 - k9); signalFull[i] = emaSignal; }
            }
        }

        // ── RSI MA9 rolling O(1) ──────────────────────────────────────────
        const rsiMaFull = new Array(rsiFull.length).fill(null);
        let sumRsi = 0;
        for (let i = 0; i < rsiFull.length; i++) {
            sumRsi += rsiFull[i];
            if (i >= 9) sumRsi -= rsiFull[i - 9];
            if (i >= 8) rsiMaFull[i] = sumRsi / 9;
        }

        // ── Replay bougie par bougie ──────────────────────────────────────────
        for (let i = minIdx; i < n; i++) {
            const c = candles[i];

            // ── Si en position : vérifie TP / SL ─────────────────────────────
            if (inTrade && entry) {
                const tp = entry.price * (1 + cfg.tpPct / 100);
                const sl = entry.price * (1 - cfg.slPct / 100);
                let exitPrice = null, exitType = null;

                if (c.low <= sl)       { exitPrice = sl; exitType = 'SL'; }
                else if (c.high >= tp) { exitPrice = tp; exitType = 'TP'; }

                if (exitPrice !== null) {
                    const pnlPct = ((exitPrice - entry.price) / entry.price) * 100 - cfg.feePct * 2;
                    const pnlUsd = (pnlPct / 100) * entry.capital;
                    trades.push({
                        entryTs: entry.ts, entryPrice: entry.price,
                        exitTs: c.t, exitPrice, exitType,
                        pnlPct: +pnlPct.toFixed(3), pnlUsd: +pnlUsd.toFixed(4),
                        capital: entry.capital,
                        signals: entry.signals, signalCount: entry.signalCount,
                        duration: Math.round((c.t - entry.ts) / 60),
                    });
                    inTrade = false; entry = null;
                }
                continue;
            }

            // ── Calcul des 6 signaux à partir des séries pré-calculées ────────
            const bbMid   = sma20Full[i];
            const bbStd   = std20Full[i];
            if (!bbMid || !bbStd) continue;

            const bbUpper = bbMid + 2 * bbStd;
            const bbLower = bbMid - 2 * bbStd;
            const bbWidth = (bbUpper - bbLower) / bbMid;

            // BB width minimum sur les 60 dernières bougies
            let bbWidthMin = Infinity;
            for (let j = Math.max(20, i - 59); j <= i; j++) {
                if (!sma20Full[j] || !std20Full[j]) continue;
                const w = (sma20Full[j] + 2 * std20Full[j] - (sma20Full[j] - 2 * std20Full[j])) / sma20Full[j];
                if (w < bbWidthMin) bbWidthMin = w;
            }
            const bbSqueeze = bbWidthMin < Infinity && bbWidth <= bbWidthMin * 1.05;
            const bbClap    = c.close >= bbUpper * 0.995;

            // RSI (index décalé car rsiFull démarre à période+1)
            const rsiIdx  = i - 15; // décalage RSI14
            const rsi     = rsiIdx >= 0 && rsiIdx < rsiFull.length ? rsiFull[rsiIdx] : null;
            const rsiMA   = rsiIdx >= 0 && rsiIdx < rsiMaFull.length ? rsiMaFull[rsiIdx] : null;
            const rsiAbove60 = rsi !== null && rsi >= 55;
            const rsiCross   = rsi !== null && rsiMA !== null && rsi > rsiMA;

            // MACD
            const macdLine   = macdFull[i];
            const signalLine = signalFull[i];
            const histNow    = macdLine !== null && signalLine !== null ? macdLine - signalLine : null;
            const histPrev   = i > 0 && macdFull[i-1] !== null && signalFull[i-1] !== null
                               ? macdFull[i-1] - signalFull[i-1] : null;
            const histGreen  = histNow !== null && histNow > 0 && (histPrev === null || histNow > histPrev);
            const macdCross  = macdLine !== null && signalLine !== null && macdLine > signalLine
                               && histPrev !== null && histPrev <= 0;

            // Volume
            const volMA  = volSma20Full[i];
            const volRatio = volMA && volMA > 0 ? c.vol / volMA : null;
            const volOK    = volRatio !== null && volRatio >= 1.2;

            // EMA 9 / 20 (léger — seulement sur window i)
            const ema9  = S.ema(closes.slice(Math.max(0, i - 40), i + 1), 9);
            const ema20e = S.ema(closes.slice(Math.max(0, i - 50), i + 1), 20);
            const emaOK  = ema9 !== null && ema20e !== null && c.close > ema9 && ema9 > ema20e;

            // OBV 4 bougies montantes (O(1) : on lit les 4 derniers de obvFull)
            const obvRising = i >= 4 &&
                obvFull[i]   > obvFull[i-1] && obvFull[i-1] > obvFull[i-2] &&
                obvFull[i-2] > obvFull[i-3] && obvFull[i-3] > obvFull[i-4];

            const signals = [bbSqueeze && bbClap, rsiAbove60 && rsiCross, histGreen, volOK, emaOK, obvRising];
            const signalCount = signals.filter(Boolean).length;

            if (signalCount < cfg.minSignals) continue;

            // Front montant : le tick précédent n'avait pas le seuil
            if (i > minIdx) {
                const prevBBW  = sma20Full[i-1] ? (sma20Full[i-1] + 2*std20Full[i-1] - (sma20Full[i-1] - 2*std20Full[i-1])) / sma20Full[i-1] : null;
                const prevBBClap = prevBBW !== null && candles[i-1].close >= (sma20Full[i-1] + 2*std20Full[i-1]) * 0.995;
                const prevRsi  = (i-1-15) >= 0 ? rsiFull[i-1-15] : null;
                const prevHist = i > 1 && macdFull[i-1] !== null && signalFull[i-1] !== null ? macdFull[i-1] - signalFull[i-1] : null;
                const prevVolR = volSma20Full[i-1] ? candles[i-1].vol / volSma20Full[i-1] : null;
                const prevSigs = [
                    prevBBClap,
                    prevRsi !== null && prevRsi >= 55,
                    prevHist !== null && prevHist > 0,
                    prevVolR !== null && prevVolR >= 1.2,
                    false, // EMA on ne recalcule pas pour le prev — approximation acceptable
                    i >= 5 && obvFull[i-1] > obvFull[i-2] && obvFull[i-2] > obvFull[i-3] && obvFull[i-3] > obvFull[i-4],
                ];
                if (prevSigs.filter(Boolean).length >= cfg.minSignals) continue;
            }

            const currentCapital = trades.length > 0
                ? cfg.capital + trades.reduce((s, t) => s + t.pnlUsd, 0)
                : cfg.capital;

            inTrade = true;
            entry = { ts: c.t, price: c.close, capital: currentCapital, signals, signalCount };
        }

        // Position ouverte en fin d'historique → fermeture au dernier prix
        if (inTrade && entry) {
            const last     = candles[candles.length - 1];
            const pnlPct   = ((last.close - entry.price) / entry.price) * 100 - cfg.feePct * 2;
            const pnlUsd   = (pnlPct / 100) * entry.capital;
            trades.push({
                entryTs:    entry.ts,
                entryPrice: entry.price,
                exitTs:     last.t,
                exitPrice:  last.close,
                exitType:   'OPEN',
                pnlPct:     +pnlPct.toFixed(3),
                pnlUsd:     +pnlUsd.toFixed(4),
                capital:    entry.capital,
                signals:    entry.signals,
                signalCount: entry.signalCount,
                duration:   Math.round((last.t - entry.ts) / 60),
            });
        }

        return trades;
    },

    // ── Stats ─────────────────────────────────────────────────────────────────

    calcStats(trades, cfg) {
        if (trades.length === 0) return null;

        const wins   = trades.filter(t => t.pnlPct > 0);
        const losses = trades.filter(t => t.pnlPct <= 0);
        const tpHits = trades.filter(t => t.exitType === 'TP');
        const slHits = trades.filter(t => t.exitType === 'SL');

        const totalPnlUsd = trades.reduce((s, t) => s + t.pnlUsd, 0);
        const totalPnlPct = (totalPnlUsd / cfg.capital) * 100;

        const avgWin  = wins.length  > 0 ? wins.reduce((s, t)   => s + t.pnlPct, 0) / wins.length  : 0;
        const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
        const rr      = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

        // Expectancy = (winRate × avgWin) + (lossRate × avgLoss)
        const winRate    = wins.length / trades.length;
        const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;

        // Max drawdown (sur l'equity curve)
        let peak = cfg.capital, maxDD = 0, equity = cfg.capital;
        for (const t of trades) {
            equity += t.pnlUsd;
            if (equity > peak) peak = equity;
            const dd = (peak - equity) / peak * 100;
            if (dd > maxDD) maxDD = dd;
        }

        const avgDuration = trades.reduce((s, t) => s + t.duration, 0) / trades.length;

        return {
            total:       trades.length,
            wins:        wins.length,
            losses:      losses.length,
            tpHits:      tpHits.length,
            slHits:      slHits.length,
            winRate:     +(winRate * 100).toFixed(1),
            avgWin:      +avgWin.toFixed(2),
            avgLoss:     +avgLoss.toFixed(2),
            rr:          +rr.toFixed(2),
            expectancy:  +expectancy.toFixed(3),
            totalPnlUsd: +totalPnlUsd.toFixed(2),
            totalPnlPct: +totalPnlPct.toFixed(2),
            finalCapital:+(cfg.capital + totalPnlUsd).toFixed(2),
            maxDD:       +maxDD.toFixed(2),
            avgDuration: +avgDuration.toFixed(0),
        };
    },

    // ── Run ───────────────────────────────────────────────────────────────────

    async run(pair) {
        if (this.isRunning) return;
        this.isRunning   = true;
        this.currentPair = pair.toUpperCase();
        if (!this.currentPair.includes('-')) this.currentPair += '-USD';
        this.trades = [];

        this.setStatus('Chargement des bougies M1...');
        this.renderLoading();

        const cfg = this.readCfg();

        try {
            this.candles = await this.fetchCandles(this.currentPair, 300);
            this.setStatus(`Replay sur ${this.candles.length} bougies M1 (TP ${cfg.tpPct}% / SL ${cfg.slPct}%)...`);
            await this.sleep(30);
            const t0 = performance.now();
            this.trades = this.replayHistory(this.candles, cfg);
            const ms = (performance.now() - t0).toFixed(0);
            this.setStatus(`Replay terminé en ${ms}ms`);
        } catch(e) {
            this.setStatus(`Erreur : ${e.message}`);
            this.isRunning = false;
            return;
        }

        this.isRunning = false;
        const stats = this.calcStats(this.trades, cfg);
        this.setStatus(`Terminé — ${this.trades.length} trade(s) sur ${this.currentPair}`);
        this.renderResults(stats, cfg);
    },

    readCfg() {
        const g = id => parseFloat(document.getElementById(id)?.value) || 0;
        return {
            tpPct:      g('bt2-tp')      || this.CFG.tpPct,
            slPct:      g('bt2-sl')      || this.CFG.slPct,
            minSignals: parseInt(document.getElementById('bt2-minsig')?.value) || this.CFG.minSignals,
            capital:    g('bt2-capital') || this.CFG.capital,
            feePct:     this.CFG.feePct,
        };
    },

    // ── Rendu ─────────────────────────────────────────────────────────────────

    renderLoading() {
        const w = document.getElementById('bt2-results');
        if (w) w.innerHTML = `<div class="bt-loading">Analyse en cours…</div>`;
    },

    setStatus(msg) {
        const el = document.getElementById('bt2-status');
        if (el) el.textContent = msg;
    },

    formatPrice(p) {
        if (!p) return '—';
        if (p >= 1000) return p.toFixed(2);
        if (p >= 1)    return p.toFixed(3);
        if (p >= 0.01) return p.toFixed(4);
        return p.toFixed(6);
    },

    renderResults(stats, cfg) {
        const wrap = document.getElementById('bt2-results');
        if (!wrap) return;

        if (!stats || this.trades.length === 0) {
            wrap.innerHTML = `<div class="bt-empty">Aucun signal Sniper détecté sur les 300 dernières bougies M1.<br>
                <span style="font-size:11px;color:#555;">Essayez de réduire le seuil MIN SIGNAUX.</span></div>`;
            return;
        }

        const pnlCls  = stats.totalPnlPct >= 0 ? 'pos' : 'neg';
        const wRateCls = stats.winRate >= 55 ? 'pos' : stats.winRate >= 45 ? 'neu' : 'neg';

        // ── Stat cards ───────────────────────────────────────────────────────
        const statCards = [
            { lbl: 'TRADES',    val: stats.total,                   cls: '' },
            { lbl: 'WIN RATE',  val: stats.winRate + '%',           cls: wRateCls },
            { lbl: 'PNL',       val: (stats.totalPnlPct >= 0 ? '+' : '') + stats.totalPnlPct + '%', cls: pnlCls },
            { lbl: 'PNL USD',   val: (stats.totalPnlUsd >= 0 ? '+' : '') + '$' + stats.totalPnlUsd, cls: pnlCls },
            { lbl: 'R/R',       val: stats.rr,                      cls: stats.rr >= 1.5 ? 'pos' : 'neu' },
            { lbl: 'EXPECT.',   val: stats.expectancy + '%',        cls: stats.expectancy >= 0 ? 'pos' : 'neg' },
            { lbl: 'MAX DD',    val: stats.maxDD + '%',             cls: stats.maxDD > 15 ? 'neg' : 'neu' },
            { lbl: 'CAPITAL',   val: '$' + stats.finalCapital,      cls: pnlCls },
        ].map(s => `
            <div class="bt2-stat">
                <span class="bt2-stat-lbl">${s.lbl}</span>
                <span class="bt2-stat-val ${s.cls}">${s.val}</span>
            </div>`).join('');

        // ── Equity curve canvas ───────────────────────────────────────────────
        const equityPoints = [cfg.capital];
        let eq = cfg.capital;
        for (const t of this.trades) { eq += t.pnlUsd; equityPoints.push(+eq.toFixed(4)); }

        // ── Liste des trades ──────────────────────────────────────────────────
        const tradeRows = [...this.trades].reverse().map((t, i) => {
            const entryDate = new Date(t.entryTs * 1000);
            const exitDate  = new Date(t.exitTs  * 1000);
            const dStr = d => d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })
                             + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
            const pnlCl = t.pnlPct > 0 ? 'pos' : 'neg';
            const exitCl = t.exitType === 'TP' ? 'tp' : t.exitType === 'SL' ? 'sl' : 'open';
            const sigIcons = ['BB','RSI','MACD','VOL','EMA','OBV']
                .map((lbl, j) => `<span class="bt2-sig-dot ${t.signals[j] ? 'on' : 'off'}" title="${lbl}">●</span>`)
                .join('');
            return `
            <div class="bt2-trade-row">
                <div class="bt2-trade-head">
                    <span class="bt2-exit-type ${exitCl}">${t.exitType}</span>
                    <span class="bt2-trade-date">${dStr(entryDate)}</span>
                    <span class="bt2-trade-pnl ${pnlCl}">${t.pnlPct > 0 ? '+' : ''}${t.pnlPct}%</span>
                    <span class="bt2-trade-dur">${t.duration}min</span>
                </div>
                <div class="bt2-trade-prices">
                    <span>ENT <b>${this.formatPrice(t.entryPrice)}</b></span>
                    <span>EXT <b>${this.formatPrice(t.exitPrice)}</b></span>
                    <span class="bt2-sigs">${sigIcons} ${t.signalCount}/6</span>
                </div>
            </div>`;
        }).join('');

        wrap.innerHTML = `
        <div class="bt2-stat-grid">${statCards}</div>

        <div class="bt2-section-title">EQUITY CURVE — ${this.currentPair} M1</div>
        <div class="bt2-chart-wrap">
            <canvas id="bt2-equity-canvas"></canvas>
        </div>

        <div class="bt2-cfg-recap">
            TP ${cfg.tpPct}% &nbsp;|&nbsp; SL ${cfg.slPct}% &nbsp;|&nbsp;
            MIN ${cfg.minSignals}/6 signaux &nbsp;|&nbsp;
            Capital $${cfg.capital} &nbsp;|&nbsp; Frais ${cfg.feePct}%/trade
        </div>

        <div class="bt2-section-title">${this.trades.length} TRADES</div>
        <div class="bt2-trade-list">${tradeRows}</div>`;

        // Dessine l'equity curve après rendu DOM
        requestAnimationFrame(() => this.drawEquityCurve(equityPoints, cfg.capital));
    },

    // ── Equity curve canvas ───────────────────────────────────────────────────

    drawEquityCurve(points, startCapital) {
        const canvas = document.getElementById('bt2-equity-canvas');
        if (!canvas) return;
        const W = canvas.offsetWidth || 320;
        const H = 140;
        canvas.width  = W * window.devicePixelRatio;
        canvas.height = H * window.devicePixelRatio;
        canvas.style.width  = W + 'px';
        canvas.style.height = H + 'px';
        const ctx = canvas.getContext('2d');
        ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

        const minV = Math.min(...points) * 0.99;
        const maxV = Math.max(...points) * 1.01;
        const pad  = { t: 10, r: 10, b: 24, l: 52 };
        const cW   = W - pad.l - pad.r;
        const cH   = H - pad.t - pad.b;

        const px = (i) => pad.l + (i / (points.length - 1)) * cW;
        const py = (v) => pad.t + cH - ((v - minV) / (maxV - minV)) * cH;

        // Fond
        ctx.fillStyle = '#080f20';
        ctx.fillRect(0, 0, W, H);

        // Ligne de départ (capital initial)
        ctx.strokeStyle = 'rgba(46,74,102,0.5)';
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 4]);
        const yStart = py(startCapital);
        ctx.beginPath(); ctx.moveTo(pad.l, yStart); ctx.lineTo(W - pad.r, yStart);
        ctx.stroke();
        ctx.setLineDash([]);

        // Zone remplie sous la courbe
        const final = points[points.length - 1];
        const lineColor = final >= startCapital ? '#00ff88' : '#ff3366';
        const fillColor = final >= startCapital ? 'rgba(0,255,136,0.08)' : 'rgba(255,51,102,0.08)';

        ctx.beginPath();
        ctx.moveTo(px(0), py(points[0]));
        for (let i = 1; i < points.length; i++) ctx.lineTo(px(i), py(points[i]));
        ctx.lineTo(px(points.length - 1), H - pad.b);
        ctx.lineTo(px(0), H - pad.b);
        ctx.closePath();
        ctx.fillStyle = fillColor;
        ctx.fill();

        // Courbe principale
        ctx.beginPath();
        ctx.moveTo(px(0), py(points[0]));
        for (let i = 1; i < points.length; i++) ctx.lineTo(px(i), py(points[i]));
        ctx.strokeStyle = lineColor;
        ctx.lineWidth   = 1.5;
        ctx.stroke();

        // Points trades (cercles)
        for (let i = 1; i < points.length; i++) {
            const trade = this.trades[i - 1];
            const col   = trade.pnlPct > 0 ? '#00ff88' : '#ff3366';
            ctx.beginPath();
            ctx.arc(px(i), py(points[i]), 3, 0, Math.PI * 2);
            ctx.fillStyle = col;
            ctx.fill();
        }

        // Axe Y (labels)
        ctx.fillStyle   = '#2e4a66';
        ctx.font        = `${10 * window.devicePixelRatio / window.devicePixelRatio}px monospace`;
        ctx.textAlign   = 'right';
        ctx.fillStyle   = '#4a7a9b';
        [minV, startCapital, maxV].forEach(v => {
            const y = py(v);
            ctx.fillText('$' + v.toFixed(0), pad.l - 4, y + 3);
        });

        // Axe X : nombre de trades
        ctx.textAlign  = 'center';
        ctx.fillStyle  = '#2e4a66';
        ctx.fillText(`0`, px(0), H - 6);
        ctx.fillText(`${points.length - 1}`, px(points.length - 1), H - 6);
    },

    sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
};

window.Backtest2 = Backtest2;
