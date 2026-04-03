/**
 * CHARTS.JS — Mini-graphiques Lightweight Charts dans les cards scan
 * SqueezePulse V2.5
 * - Candlestick OHLCV
 * - BB upper / lower / mid
 * - KC upper / lower
 * - Zone squeeze colorée (BB inside KC)
 * - Marker signal (dernière bougie)
 * - Données depuis Engine.cache → zéro fetch supplémentaire
 */

const Charts = {

    instances: {}, // instances LW par paire (pour destroy propre)
    VISIBLE_BARS: 60, // bougies affichées par défaut

    // ── LW Charts chargé ? ─────────────────────────────────────────────────

    ready() {
        return typeof window.LightweightCharts !== 'undefined';
    },

    // ── Ouvre ou ferme le graphique d'une card ─────────────────────────────

    toggle(pair, idx, sqzType, bbMult, kcMult) {
        const container = document.getElementById(`chart-wrap-${idx}`);
        if (!container) return;

        const isOpen = container.classList.contains('open');

        if (isOpen) {
            this.destroy(pair);
            container.classList.remove('open');
            container.innerHTML = '';
            const btn = document.getElementById(`chart-btn-${idx}`);
            if (btn) btn.textContent = '📊';
            return;
        }

        container.classList.add('open');
        const btn = document.getElementById(`chart-btn-${idx}`);
        if (btn) btn.textContent = '✕';

        // Données depuis le cache Engine
        const cached = window.Engine?.cache?.[pair];
        if (!cached || !cached.candles || cached.candles.length < 20) {
            container.innerHTML = `<div class="chart-err">Pas de données en cache pour ${pair}<br><small>Lancez un scan d'abord</small></div>`;
            return;
        }

        if (!this.ready()) {
            // Fallback : graphique Canvas natif si LW non chargé
            this.renderFallback(pair, idx, cached.candles);
            return;
        }

        this.render(pair, idx, cached.candles, sqzType, bbMult || 2.0, kcMult || 1.5);
    },

    // ── Fallback Canvas natif si LW non disponible ────────────────────────────

    renderFallback(pair, idx, candles) {
        const wrap = document.getElementById(`chart-wrap-${idx}`);
        if (!wrap) return;
        wrap.innerHTML = `<canvas id="fb-${idx}" style="width:100%;height:180px;display:block;"></canvas>
            <div class="chart-legend" id="chart-legend-${idx}">
                <span class="cl-time">${pair} — graphique simplifié (LW non chargé)</span>
            </div>`;

        const canvas = document.getElementById(`fb-${idx}`);
        if (!canvas) return;
        const W = canvas.offsetWidth || 320;
        const H = 180;
        canvas.width  = W * devicePixelRatio;
        canvas.height = H * devicePixelRatio;
        canvas.style.width  = W + 'px';
        canvas.style.height = H + 'px';
        const ctx = canvas.getContext('2d');
        ctx.scale(devicePixelRatio, devicePixelRatio);

        const closes = candles.map(c => c.close);
        const n      = Math.min(closes.length, 80);
        const slice  = closes.slice(-n);
        const minV   = Math.min(...slice) * 0.998;
        const maxV   = Math.max(...slice) * 1.002;
        const pad    = { t: 10, r: 10, b: 20, l: 50 };
        const cW     = W - pad.l - pad.r;
        const cH     = H - pad.t - pad.b;

        ctx.fillStyle = '#080f20';
        ctx.fillRect(0, 0, W, H);

        // Ligne de prix
        ctx.beginPath();
        slice.forEach((v, i) => {
            const x = pad.l + (i / (n - 1)) * cW;
            const y = pad.t + cH - ((v - minV) / (maxV - minV)) * cH;
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        const last  = slice[slice.length - 1];
        const first = slice[0];
        ctx.strokeStyle = last >= first ? '#00ff88' : '#ff3366';
        ctx.lineWidth   = 1.5;
        ctx.stroke();

        // Labels Y
        ctx.fillStyle   = '#4a7a9b';
        ctx.font        = '10px monospace';
        ctx.textAlign   = 'right';
        [minV, (minV + maxV) / 2, maxV].forEach(v => {
            const y = pad.t + cH - ((v - minV) / (maxV - minV)) * cH;
            ctx.fillText(v.toFixed(v >= 1 ? 3 : 5), pad.l - 4, y + 3);
        });
    },

    // ── Rendu principal ────────────────────────────────────────────────────

    render(pair, idx, candles, sqzType, bbMult, kcMult) {
        const S   = window.Scanner;
        const wrap = document.getElementById(`chart-wrap-${idx}`);
        if (!wrap) return;

        // Destroy instance précédente si elle existe
        this.destroy(pair);

        // Conteneur interne
        wrap.innerHTML = `<div id="lw-${idx}" style="width:100%;height:200px;"></div>
            <div class="chart-legend" id="chart-legend-${idx}"></div>`;

        const el = document.getElementById(`lw-${idx}`);
        if (!el) return;

        // ── Crée le chart LW ──────────────────────────────────────────────
        const chart = LightweightCharts.createChart(el, {
            width:  el.offsetWidth || 320,
            height: 200,
            layout: {
                background:  { type: 'solid', color: '#080f20' },
                textColor:   '#4a7a9b',
                fontFamily:  'Share Tech Mono, monospace',
                fontSize:    10,
            },
            grid: {
                vertLines:   { color: 'rgba(13,37,64,0.6)' },
                horzLines:   { color: 'rgba(13,37,64,0.6)' },
            },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Normal,
            },
            rightPriceScale: {
                borderColor: '#0d2540',
                scaleMargins: { top: 0.1, bottom: 0.1 },
            },
            timeScale: {
                borderColor:     '#0d2540',
                timeVisible:     true,
                secondsVisible:  false,
                fixLeftEdge:     true,
                fixRightEdge:    true,
            },
            handleScroll:  true,
            handleScale:   true,
        });

        // ── Candlestick ───────────────────────────────────────────────────
        const candleSeries = chart.addCandlestickSeries({
            upColor:          '#00ff88',
            downColor:        '#ff3366',
            borderUpColor:    '#00ff88',
            borderDownColor:  '#ff3366',
            wickUpColor:      '#00d4aa',
            wickDownColor:    '#cc2255',
        });

        const candleData = candles.map(c => ({
            time:  c.t,
            open:  c.open,
            high:  c.high,
            low:   c.low,
            close: c.close,
        }));
        candleSeries.setData(candleData);

        // ── Calcul BB et KC sur tout l'historique ─────────────────────────
        const closes = candles.map(c => c.close);
        const n      = candles.length;

        const bbUpperData = [], bbLowerData = [], bbMidData = [];
        const kcUpperData = [], kcLowerData = [];
        const sqzBgData   = []; // zone colorée squeeze

        for (let i = 20; i < n; i++) {
            const sliceCl = closes.slice(0, i + 1);
            const sliceCa = candles.slice(0, i + 1);

            const bb = S.calcBB(sliceCl, 20, bbMult);
            const kc = S.calcKC(sliceCa, 20, kcMult);
            if (!bb || !kc) continue;

            const t = candles[i].t;
            bbUpperData.push({ time: t, value: bb.upper });
            bbLowerData.push({ time: t, value: bb.lower });
            bbMidData.push({  time: t, value: bb.mid   });
            kcUpperData.push({ time: t, value: kc.upper });
            kcLowerData.push({ time: t, value: kc.lower });

            // Squeeze actif = BB inside KC
            const inSqz = bb.upper < kc.upper && bb.lower > kc.lower;
            sqzBgData.push({ time: t, value: bb.upper, inSqz });
        }

        // ── BB upper ──────────────────────────────────────────────────────
        const bbUpperSeries = chart.addLineSeries({
            color:           '#5577cc',
            lineWidth:       1,
            lineStyle:       LightweightCharts.LineStyle.Dashed,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
        });
        bbUpperSeries.setData(bbUpperData);

        // ── BB lower ──────────────────────────────────────────────────────
        const bbLowerSeries = chart.addLineSeries({
            color:           '#5577cc',
            lineWidth:       1,
            lineStyle:       LightweightCharts.LineStyle.Dashed,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
        });
        bbLowerSeries.setData(bbLowerData);

        // ── BB mid ────────────────────────────────────────────────────────
        const bbMidSeries = chart.addLineSeries({
            color:           'rgba(85,119,204,0.4)',
            lineWidth:       1,
            lineStyle:       LightweightCharts.LineStyle.Dotted,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
        });
        bbMidSeries.setData(bbMidData);

        // ── KC upper ──────────────────────────────────────────────────────
        const kcUpperSeries = chart.addLineSeries({
            color:           '#cc6600',
            lineWidth:       1,
            lineStyle:       LightweightCharts.LineStyle.LargeDashed,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
        });
        kcUpperSeries.setData(kcUpperData);

        // ── KC lower ──────────────────────────────────────────────────────
        const kcLowerSeries = chart.addLineSeries({
            color:           '#cc6600',
            lineWidth:       1,
            lineStyle:       LightweightCharts.LineStyle.LargeDashed,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
        });
        kcLowerSeries.setData(kcLowerData);

        // ── Marker signal sur la dernière bougie ──────────────────────────
        const lastCandle = candles[n - 1];
        const markerColor = sqzType === 'FIRE'     ? '#ff3366'
                          : sqzType === 'BREAKOUT'  ? '#00d4ff'
                          : sqzType === 'SQUEEZE'   ? '#aa44ff'
                          : '#00ff88';
        const markerShape = sqzType === 'FIRE' || sqzType === 'BREAKOUT' ? 'arrowUp' : 'circle';

        candleSeries.setMarkers([{
            time:     lastCandle.t,
            position: 'belowBar',
            color:    markerColor,
            shape:    markerShape,
            text:     sqzType,
            size:     1,
        }]);

        // ── Fit aux VISIBLE_BARS dernières bougies ────────────────────────
        const visibleFrom = candles[Math.max(0, n - this.VISIBLE_BARS)].t;
        const visibleTo   = lastCandle.t + (candles[1]?.t - candles[0]?.t || 3600) * 2;
        chart.timeScale().setVisibleRange({ from: visibleFrom, to: visibleTo });

        // ── Légende crosshair ─────────────────────────────────────────────
        chart.subscribeCrosshairMove(param => {
            const legend = document.getElementById(`chart-legend-${idx}`);
            if (!legend) return;
            if (!param.time || !param.seriesData) {
                legend.innerHTML = '';
                return;
            }
            const cd = param.seriesData.get(candleSeries);
            if (!cd) return;
            const pnl   = ((cd.close - cd.open) / cd.open * 100).toFixed(2);
            const pnlCl = cd.close >= cd.open ? 'pos' : 'neg';
            const date  = new Date(param.time * 1000);
            const dStr  = date.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit' })
                        + ' ' + date.toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });
            legend.innerHTML = `
                <span class="cl-time">${dStr}</span>
                <span class="cl-o">O <b>${cd.open?.toFixed?.(4) ?? '—'}</b></span>
                <span class="cl-h">H <b>${cd.high?.toFixed?.(4) ?? '—'}</b></span>
                <span class="cl-l">L <b>${cd.low?.toFixed?.(4) ?? '—'}</b></span>
                <span class="cl-c">C <b>${cd.close?.toFixed?.(4) ?? '—'}</b></span>
                <span class="cl-pnl ${pnlCl}">${pnl > 0 ? '+' : ''}${pnl}%</span>`;
        });

        // Resize observer pour responsive
        const ro = new ResizeObserver(entries => {
            const w = entries[0].contentRect.width;
            if (w > 0) chart.resize(w, 200);
        });
        ro.observe(el);

        this.instances[pair] = { chart, ro };

        // ── Légende statique initiale ─────────────────────────────────────
        const legend = document.getElementById(`chart-legend-${idx}`);
        if (legend) {
            // Compte bougies en squeeze
            const sqzCount = sqzBgData.filter(d => d.inSqz).length;
            const pct      = sqzBgData.length > 0 ? Math.round(sqzCount / sqzBgData.length * 100) : 0;
            legend.innerHTML = `
                <span class="cl-time">${pair}</span>
                <span style="color:#5577cc">── BB</span>
                <span style="color:#cc6600">── KC</span>
                <span style="color:${sqzCount > 0 ? '#aa44ff' : '#2e4a66'}">⬡ SQZ ${sqzCount}/${sqzBgData.length} (${pct}%)</span>`;
        }
    },

    // ── Destroy propre ─────────────────────────────────────────────────────

    destroy(pair) {
        if (this.instances[pair]) {
            try {
                this.instances[pair].ro?.disconnect();
                this.instances[pair].chart?.remove();
            } catch(e) {}
            delete this.instances[pair];
        }
    },

    destroyAll() {
        Object.keys(this.instances).forEach(p => this.destroy(p));
    }
};

window.Charts = Charts;
