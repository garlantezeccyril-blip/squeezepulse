/**
 * SNIPER.JS — Phase 2 Live Monitor M1
 * SqueezePulse V2.5
 *
 * Architecture polling optimisé :
 *   - 1 timer global (pas un par paire)
 *   - Paires traitées séquentiellement avec 2s d'écart → zéro 429
 *   - Cache candles par paire → fetch seulement 3 dernières bougies après init
 *   - Reconstruction bougie courante entre les fetches
 *   - Alerte vocale + visuelle sur front montant ≥ 4 signaux
 */

const Sniper = {

    COINBASE:     'https://api.exchange.coinbase.com',
    MAX_PAIRS:    30,
    GRAN:         60,         // M1

    // ── Configuration signaux M1 ──────────────────────────────────────
    cfg: { rsiMin: 55, volMin: 1.2, obvBars: 4 },

    saveCfg() {
        const rsi = +document.getElementById('snpRsiMin')?.value  || 55;
        const vol = +document.getElementById('snpVolMin')?.value  || 1.2;
        const obv = +document.getElementById('snpObvBars')?.value || 4;
        this.cfg = { rsiMin: rsi, volMin: vol, obvBars: obv };
        try { localStorage.setItem('sniper_cfg', JSON.stringify(this.cfg)); } catch(e) {}
    },

    loadCfg() {
        try {
            const saved = localStorage.getItem('sniper_cfg');
            if (!saved) return;
            const p = JSON.parse(saved);
            this.cfg = {
                rsiMin:  +p.rsiMin  || 55,
                volMin:  +p.volMin  || 1.2,
                obvBars: +p.obvBars || 4,
            };
            const set = (id, val, displayId, fmt) => {
                const el  = document.getElementById(id);
                const dEl = document.getElementById(displayId);
                if (el)  el.value = val;
                if (dEl) dEl.textContent = fmt(val);
            };
            set('snpRsiMin',  this.cfg.rsiMin,  'snpRsiMinVal',  v => v);
            set('snpVolMin',  this.cfg.volMin,  'snpVolMinVal',  v => parseFloat(v).toFixed(1) + 'x');
            set('snpObvBars', this.cfg.obvBars, 'snpObvBarsVal', v => v);
        } catch(e) {}
    },

    CANDLE_LIMIT: 100,        // bougies max en cache par paire
    PAIR_DELAY:   2000,       // ms entre chaque fetch de paire (évite 429)
    REFRESH_SEC:  60,         // refresh complet toutes les 60s

    pairs:        [],
    states:       {},
    origins:      {},
    caches:       {},         // caches[pair] = { candles[], lastTs }
    isRunning:    false,
    voiceEnabled: true,
    alertCooldown:{},
    _timer:       null,       // timer global unique
    _tickCount:   0,

    // ── Démarrage / arrêt ─────────────────────────────────────────────────────

    async start() {
        if (this.pairs.length === 0) {
            this.log('Aucune paire à surveiller.', 'warn'); return;
        }
        this.isRunning = true;
        this.updateStartStopBtn();
        this.renderGrid();
        this.log(`Live M1 démarré — ${this.pairs.length} paire(s) — refresh ${this.REFRESH_SEC}s`, 'ok');

        // Premier cycle immédiat
        await this._runCycle();

        // Timer global : 1 cycle toutes les REFRESH_SEC secondes
        this._timer = setInterval(() => this._runCycle(), this.REFRESH_SEC * 1000);
    },

    stop() {
        this.isRunning = false;
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        this.log('Surveillance arrêtée.', 'warn');
        this.updateStartStopBtn();
    },

    // ── Cycle global : traite toutes les paires séquentiellement ─────────────

    async _runCycle() {
        if (!this.isRunning) return;
        this._tickCount++;
        const cycleStart = Date.now();

        for (const pair of [...this.pairs]) {
            if (!this.isRunning) break;
            try {
                const candles = await this._getCandles(pair);
                if (!candles || candles.length < 30) continue;

                const prevCount = this.states[pair]?.signalCount || 0;
                const result    = this.analyze(candles);
                this.states[pair] = { ...result, error: null };
                this.updateCard(pair);

                if (result.signalCount >= 4 && prevCount < 4) {
                    this.triggerAlert(pair, result);
                }
            } catch(e) {
                if (this.states[pair]) this.states[pair].error = e.message.slice(0, 30);
                this.updateCard(pair);
            }
            // Pause entre chaque paire pour éviter 429
            await this.sleep(this.PAIR_DELAY);
        }

        const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(0);
        if (this._tickCount % 5 === 0) {
            this.log(`Cycle #${this._tickCount} — ${this.pairs.length} paires en ${elapsed}s`, 'sys');
        }
    },

    // ── Cache candles : fetch complet au 1er appel, 3 bougies ensuite ─────────

    async _getCandles(pair, _depth = 0) {
        if (!this.caches[pair]) {
            const candles = await this.fetchCandles(pair, this.CANDLE_LIMIT);
            // Guard : paire sans données (inactive, suspendue...)
            if (!candles || candles.length < 30) {
                this.log(`${pair} — données insuffisantes (${candles?.length ?? 0} bougies), ignorée`, 'warn');
                return null;
            }
            this.caches[pair] = {
                candles: candles,
                lastTs:  candles[candles.length - 1].t,
            };
            return candles;
        }

        // Fetch seulement les 3 dernières bougies
        const last = await this.fetchLastCandles(pair, 3);
        const cache = this.caches[pair];

        if (!last || last.length === 0) return cache.candles;

        // Détecte désync (gap > 3 bougies)
        const latestTs = last[last.length - 1].t;
        if (latestTs > cache.lastTs + this.GRAN * 2) {
            this.log(`${pair} désync — refetch`, 'warn');
            delete this.caches[pair];
            if (_depth >= 2) {
                this.log(`${pair} refetch échoué (limit atteinte)`, 'err');
                return null;
            }
            return this._getCandles(pair, _depth + 1);
        }

        // Ajoute les nouvelles bougies clôturées
        for (const c of last) {
            if (c.t > cache.lastTs) {
                cache.candles.push(c);
                if (cache.candles.length > this.CANDLE_LIMIT) cache.candles.shift();
                cache.lastTs = c.t;
            }
        }

        return cache.candles;
    },

    // ── Fetch REST ────────────────────────────────────────────────────────────

    // ── Utilitaire : fetch avec retry exponentiel sur 429 ─────────────────

    async fetchWithRetry(url, { maxRetries = 3, baseMs = 2000, capMs = 16000, label = url } = {}) {
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

    async fetchCandles(pair, limit = 100) {
        const url = `${this.COINBASE}/products/${pair}/candles?granularity=${this.GRAN}`;
        const res = await this.fetchWithRetry(url, { label: pair });
        const raw = await res.json();
        if (!Array.isArray(raw) || raw.length === 0) return [];
        return raw.slice(0, limit).reverse().map(c => ({
            t: +c[0], low: +c[1], high: +c[2], open: +c[3], close: +c[4], vol: +c[5]
        }));
    },

    async fetchLastCandles(pair, count = 3) {
        const url = `${this.COINBASE}/products/${pair}/candles?granularity=${this.GRAN}`;
        const res = await this.fetchWithRetry(url, { maxRetries: 2, capMs: 8000, label: pair });
        const raw = await res.json();
        if (!Array.isArray(raw) || raw.length === 0) return [];
        return raw.slice(0, count).reverse().map(c => ({
            t: +c[0], low: +c[1], high: +c[2], open: +c[3], close: +c[4], vol: +c[5]
        }));
    },

    // ── Ajout / suppression paires ────────────────────────────────────────────

    // ── Persistance localStorage ────────────────────────────────────────

    saveToLocalStorage() {
        try {
            localStorage.setItem('sniper_pairs',   JSON.stringify(this.pairs));
            localStorage.setItem('sniper_origins', JSON.stringify(this.origins));
        } catch (e) { /* quota exceeded — silencieux */ }
    },

    loadFromLocalStorage() {
        try {
            const raw = localStorage.getItem('sniper_pairs');
            if (!raw) return;
            const pairs = JSON.parse(raw);
            if (!Array.isArray(pairs) || pairs.length === 0) return;
            this.origins = JSON.parse(localStorage.getItem('sniper_origins') || '{}');
            for (const pair of pairs) {
                if (!this.pairs.includes(pair)) {
                    this.pairs.push(pair);
                    this.states[pair] = this.defaultState();
                }
            }
            this.renderGrid();
            if (window.updateSniperCount) updateSniperCount();
            this.log(`💾 ${this.pairs.length} paire(s) rechargée(s) depuis la dernière session.`, 'ok');
        } catch (e) {
            this.log('Erreur chargement session sniper : ' + e.message, 'warn');
        }
        this.loadCfg(); // restaure les seuils sauvegardés
    },

    addPair(raw, origin = '') {
        let pair = raw.trim().toUpperCase();
        if (!pair.includes('-')) pair += '-USD';
        if (this.pairs.includes(pair)) { this.log(`${pair} déjà surveillée.`, 'warn'); return; }
        if (this.pairs.length >= this.MAX_PAIRS) { this.log(`Max ${this.MAX_PAIRS} paires atteint.`, 'warn'); return; }
        this.pairs.push(pair);
        this.origins[pair] = origin;
        this.states[pair]  = this.defaultState();
        this.log(`+ ${pair}${origin ? ' [' + origin.toUpperCase() + ']' : ''}`, 'ok');
        this.renderGrid();
        if (window.updateSniperCount) updateSniperCount();
        this.saveToLocalStorage();
    },

    removePair(pair) {
        this.pairs = this.pairs.filter(p => p !== pair);
        delete this.states[pair];
        delete this.origins[pair];
        delete this.caches[pair];
        delete this.alertCooldown[pair];
        this.log(`- ${pair} retirée`, 'sys');
        this.renderGrid();
        if (window.updateSniperCount) updateSniperCount();
        this.saveToLocalStorage();
    },

    clearAll() {
        this.stop();
        this.pairs         = [];
        this.states        = {};
        this.origins       = {};
        this.caches        = {};
        this.alertCooldown = {};
        this._tickCount    = 0;
        this.log('Toutes les paires supprimées.', 'sys');
        this.renderGrid();
        if (window.updateSniperCount) updateSniperCount();
        try { localStorage.removeItem('sniper_pairs'); localStorage.removeItem('sniper_origins'); } catch(e) {}
    },

    defaultState() {
        return {
            price: null, bbWidth: null, bbWidthMin: Infinity,
            rsi: null, rsiMA: null, rsiAbove60: false,
            macdLine: null, signalLine: null, histGreen: false, macdCross: false,
            volRatio: null, volOK: false, obvRising: false, emaOK: false,
            signalCount: 0, lastSignal: null, status: 'WAITING', error: null,
        };
    },

    // ── Analyse technique M1 ──────────────────────────────────────────────────

    analyze(candles) {
        const S      = window.Scanner;
        const closes = candles.map(c => c.close);
        const n      = candles.length;
        const last   = candles[n - 1];

        // 1. BB squeeze + claquement
        const bb = S.calcBB(closes, 20, 2.0);
        const bbWidth = bb ? (bb.upper - bb.lower) / bb.mid : null;
        const widths = [];
        for (let i = 20; i < n; i++) {
            const b = S.calcBB(closes.slice(0, i + 1), 20, 2.0);
            if (b && b.mid > 0) widths.push((b.upper - b.lower) / b.mid);
        }
        const bbWidthMin = widths.length > 0 ? Math.min(...widths) : Infinity;
        const bbSqueeze  = bbWidth !== null && widths.length >= 10 && bbWidth <= bbWidthMin * 1.05;
        const bbClap     = bb && last.close > bb.upper * 0.995;

        // 2. RSI 14 + MA
        const rsiSeries  = S.calcRSI(candles, 14);
        const rsi        = rsiSeries.length > 0 ? rsiSeries[rsiSeries.length - 1] : null;
        const rsiMA      = rsiSeries.length >= 9 ? S.sma(rsiSeries, 9) : null;
        const rsiAbove60 = rsi !== null && rsi >= (this.cfg?.rsiMin ?? 55);
        const rsiCross   = rsi !== null && rsiMA !== null && rsi > rsiMA;

        // 3. MACD 12/26/9
        const ema12    = S.ema(closes, 12);
        const ema26    = S.ema(closes, 26);
        const macdLine = ema12 !== null && ema26 !== null ? ema12 - ema26 : null;
        const macdSeries = [];
        for (let i = 26; i < n; i++) {
            const e12 = S.ema(closes.slice(0, i + 1), 12);
            const e26 = S.ema(closes.slice(0, i + 1), 26);
            if (e12 !== null && e26 !== null) macdSeries.push(e12 - e26);
        }
        const signalLine = macdSeries.length >= 9 ? S.ema(macdSeries, 9) : null;
        const histValue  = macdLine !== null && signalLine !== null ? macdLine - signalLine : null;
        let histPrev = null;
        if (macdSeries.length >= 10 && signalLine !== null) {
            const pArr = macdSeries.slice(0, -1);
            const pSig = pArr.length >= 9 ? S.ema(pArr, 9) : null;
            histPrev   = pSig !== null ? macdSeries[macdSeries.length - 2] - pSig : null;
        }
        const histGreen = histValue !== null && histValue > 0 && (histPrev === null || histValue > histPrev);
        const macdCross = macdLine !== null && signalLine !== null && macdLine > signalLine && histPrev !== null && histPrev <= 0;

        // 4. Volume > MA20
        const vols     = candles.map(c => c.vol);
        const volMA    = S.sma(vols.slice(0, -1), 20);
        const volRatio = volMA && volMA > 0 ? last.vol / volMA : null;
        const volOK    = volRatio !== null && volRatio >= (this.cfg?.volMin ?? 1.2);

        // 5. EMA 9 > 20
        const ema9   = S.ema(closes, 9);
        const ema20  = S.ema(closes, 20);
        const emaOK  = ema9 !== null && ema20 !== null && last.close > ema9 && ema9 > ema20;

        // 6. OBV 4 bougies montantes
        const obv = S.calcOBV(candles);
        const _obvBars = this.cfg?.obvBars ?? 4;
        let obvRising = obv.length >= _obvBars;
        for (let _i = 1; _i < _obvBars && obvRising; _i++)
            obvRising = obv[obv.length - _i] > obv[obv.length - _i - 1];

        const signals     = [bbSqueeze && bbClap, rsiAbove60 && rsiCross, histGreen, volOK, emaOK, obvRising];
        const signalCount = signals.filter(Boolean).length;

        let status = 'WAITING';
        if (signalCount >= 5)      status = 'FIRE';
        else if (signalCount >= 4) status = 'ALERT';
        else if (signalCount >= 2) status = 'WARM';

        return {
            price: last.close,
            bbWidth:    bbWidth    ? +(bbWidth    * 100).toFixed(3) : null,
            bbWidthMin: bbWidthMin ? +(bbWidthMin * 100).toFixed(3) : null,
            bbSqueeze, bbClap,
            rsi:        rsi        ? +rsi.toFixed(1)        : null,
            rsiMA:      rsiMA      ? +rsiMA.toFixed(1)      : null,
            rsiAbove60, rsiCross,
            macdLine:   macdLine   ? +macdLine.toFixed(6)   : null,
            signalLine: signalLine ? +signalLine.toFixed(6) : null,
            histGreen, macdCross,
            volRatio:   volRatio   ? +volRatio.toFixed(2)   : null,
            volOK, emaOK, obvRising,
            signalCount, status,
            lastSignal: signalCount >= 4 ? new Date() : (this.states[Object.keys(this.states)[0]]?.lastSignal || null),
            signals,
        };
    },

    // ── Alerte vocale + visuelle ──────────────────────────────────────────────

    triggerAlert(pair, result) {
        const now      = Date.now();
        const cooldown = 5 * 60 * 1000;
        if (this.alertCooldown[pair] && now - this.alertCooldown[pair] < cooldown) return;
        this.alertCooldown[pair] = now;

        const symbol = pair.replace('-USD', '');
        const score  = result.signalCount;
        const msg    = score >= 5
            ? `Signal FIRE sur ${symbol}. ${score} indicateurs confirmés. Prix ${this.formatPrice(result.price)}. Entrée possible.`
            : `Alerte sur ${symbol}. ${score} indicateurs alignés. Surveiller l'entrée.`;

        this.log(`🔔 ${pair} — ${score}/6 — ${result.status}`, score >= 5 ? 'ok' : 'warn');
        if (this.voiceEnabled) this.speak(msg);

        const card = document.getElementById(`sniper-card-${pair.replace('-', '_')}`);
        if (card) { card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 2000); }
    },

    // ── Alertes vocales : queue FIFO, toast visuel ─────────────────

    _voiceQueue:   [],
    _voiceBusy:    false,

    speak(text) {
        if (!window.speechSynthesis) return;
        this._voiceQueue.push(text);
        if (!this._voiceBusy) this._voiceNext();
    },

    _voiceNext() {
        if (this._voiceQueue.length === 0) {
            this._voiceBusy = false;
            this._voiceToast(false);
            return;
        }
        this._voiceBusy = true;
        const text = this._voiceQueue.shift();
        this._voiceToast(true, text);
        const utt = new SpeechSynthesisUtterance(text);
        utt.lang = 'fr-FR'; utt.rate = 1.1; utt.pitch = 1.0; utt.volume = 1.0;
        const frVoice = window.speechSynthesis.getVoices().find(v => v.lang.startsWith('fr'));
        if (frVoice) utt.voice = frVoice;
        utt.onend = utt.onerror = () => this._voiceNext();
        window.speechSynthesis.speak(utt);
    },

    _voiceToast(show, text = '') {
        let el = document.getElementById('voice-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'voice-toast';
            el.style.cssText = [
                'position:fixed','top:60px','left:50%','transform:translateX(-50%)',
                'background:rgba(0,212,255,.15)','border:1px solid rgba(0,212,255,.4)',
                'color:var(--cyan,#00d4ff)','padding:6px 14px','border-radius:20px',
                'font-size:12px','font-family:monospace','z-index:9999',
                'pointer-events:none','transition:opacity .25s','white-space:nowrap',
                'max-width:90vw','overflow:hidden','text-overflow:ellipsis',
            ].join(';');
            document.body.appendChild(el);
        }
        if (show) {
            const queue = this._voiceQueue.length;
            el.textContent = '🔊 ' + text + (queue > 0 ? ' (+' + queue + ')' : '');
            el.style.opacity = '1';
        } else {
            el.style.opacity = '0';
        }
    },

    // ── Rendu ─────────────────────────────────────────────────────────────────

    renderGrid() {
        const wrap = document.getElementById('sniper-grid');
        if (!wrap) return;
        if (this.pairs.length === 0) {
            wrap.innerHTML = `<div class="sniper-empty">Ajoutez des paires depuis Phase 1 (📡) ou saisissez ci-dessus</div>`;
            return;
        }
        // Tri par signalCount desc (FIRE > ALERT > WARM > WAITING)
        const sorted = [...this.pairs].sort((a, b) => {
            const sa = this.states[a]?.signalCount ?? 0;
            const sb = this.states[b]?.signalCount ?? 0;
            return sb - sa;
        });
        wrap.innerHTML = sorted.map(p => this.buildCard(p)).join('');
    },

    buildCard(pair) {
        const s         = this.states[pair] || this.defaultState();
        const id        = `sniper-card-${pair.replace('-', '_')}`;
        const sym       = pair.replace('-USD', '');
        const statusCls = s.status || 'WAITING';
        const origin    = this.origins[pair] || '';
        const cached    = this.caches[pair];
        const refreshed = cached ? new Date(cached.lastTs * 1000).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' }) : '…';

        const originBadge = origin === 'sniper'
            ? `<span class="snp-origin sniper">◎ SNIPER</span>`
            : origin === 'squeeze'
            ? `<span class="snp-origin squeeze">⬡ SQUEEZE</span>`
            : '';

        const sig = (ok, label) =>
            `<span class="snp-sig ${ok ? 'on' : 'off'}">${ok ? '●' : '○'} ${label}</span>`;

        return `
        <div class="sniper-card ${statusCls}" id="${id}">
            <div class="snp-head">
                <span class="snp-pair">${sym}</span>
                ${originBadge}
                <span class="snp-status ${statusCls}">${statusCls}</span>
                <button class="btn-chart" id="snp-chart-btn-${id}" onclick="event.stopPropagation(); SniperCharts.toggle('${pair}', '${id}')" title="Graphique">📊</button>
                <button class="snp-remove" onclick="Sniper.removePair('${pair}')">✕</button>
            </div>
            <div class="snp-price">${s.price ? this.formatPrice(s.price) : '…'}
                <span style="font-size:8px;color:var(--dim);margin-left:6px;">@${refreshed}</span>
            </div>
            <div class="snp-signals">
                ${sig(s.bbSqueeze && s.bbClap,    'BB')}
                ${sig(s.rsiAbove60 && s.rsiCross, 'RSI')}
                ${sig(s.histGreen,                'MACD')}
                ${sig(s.volOK,                    'VOL')}
                ${sig(s.emaOK,                    'EMA')}
                ${sig(s.obvRising,                'OBV↑')}
            </div>
            <div class="snp-score-bar">
                <div class="snp-score-fill" style="width:${Math.round((s.signalCount || 0) / 6 * 100)}%"></div>
            </div>
            <div class="snp-score-label">${s.signalCount ?? 0}/6 signaux${s.error ? ' ⚠ ' + s.error : ''}</div>
            ${s.lastSignal ? `<div class="snp-time">Signal : ${s.lastSignal.toLocaleTimeString('fr-FR')}</div>` : ''}
            <div class="chart-wrap" id="snp-chart-wrap-${id}"></div>
        </div>`;
    },

    updateCard(pair) {
        const card = document.getElementById(`sniper-card-${pair.replace('-', '_')}`);
        if (!card) return;
        const tmp = document.createElement('div');
        tmp.innerHTML = this.buildCard(pair);
        card.replaceWith(tmp.firstElementChild);
    },

    updateStartStopBtn() {
        const btn = document.getElementById('sniper-startstop');
        if (!btn) return;
        btn.textContent = this.isRunning ? '⏹ STOP' : '▶ DÉMARRER';
        btn.classList.toggle('running', this.isRunning);
    },

    log(msg, type = 'sys') {
        if (window.UI) window.UI.addLog(`[SNIPER] ${msg}`, type);
    },

    formatPrice(price) {
        if (!price) return '—';
        if (price >= 1000) return price.toFixed(2);
        if (price >= 1)    return price.toFixed(3);
        if (price >= 0.01) return price.toFixed(4);
        return price.toFixed(6);
    },

    sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
};

window.Sniper = Sniper;

// ── SniperCharts : adapte Charts pour les cards Live M1 ──────────────────────
// Les candles viennent de Sniper.caches (M1) et non de Engine.cache (H1/H6)

const SniperCharts = {
    instances: {},

    toggle(pair, cardId) {
        const wrap = document.getElementById(`snp-chart-wrap-${cardId}`);
        const btn  = document.getElementById(`snp-chart-btn-${cardId}`);
        if (!wrap) return;

        const isOpen = wrap.classList.contains('open');
        if (isOpen) {
            this.destroy(cardId);
            wrap.classList.remove('open');
            wrap.innerHTML = '';
            if (btn) btn.textContent = '📊';
            return;
        }

        wrap.classList.add('open');
        if (btn) btn.textContent = '✕';

        // Candles depuis Sniper.caches (M1)
        const cached = Sniper.caches[pair];
        if (!cached || !cached.candles || cached.candles.length < 20) {
            wrap.innerHTML = `<div class="chart-err">Pas encore de données M1 pour ${pair}<br><small>Démarrez la surveillance d'abord</small></div>`;
            return;
        }

        const candles = cached.candles;

        if (!window.LightweightCharts) {
            // Fallback canvas natif
            if (window.Charts) Charts.renderFallback(pair, `snp-${cardId}`, candles);
            // Reroute le wrap
            wrap.innerHTML = `<canvas id="fb-snp-${cardId}" style="width:100%;height:160px;display:block;"></canvas>`;
            this._drawFallback(`fb-snp-${cardId}`, candles);
            return;
        }

        this._renderLW(pair, cardId, wrap, candles);
    },

    _renderLW(pair, cardId, wrap, candles) {
        this.destroy(cardId);
        wrap.innerHTML = `<div id="lw-snp-${cardId}" style="width:100%;height:180px;"></div>
            <div class="chart-legend" id="snp-legend-${cardId}">
                <span class="cl-time">${pair} M1</span>
            </div>`;

        const el = document.getElementById(`lw-snp-${cardId}`);
        if (!el) return;

        const chart = LightweightCharts.createChart(el, {
            width: el.offsetWidth || 300, height: 180,
            layout:    { background: { type: 'solid', color: '#080f20' }, textColor: '#4a7a9b', fontSize: 9 },
            grid:      { vertLines: { color: 'rgba(13,37,64,0.6)' }, horzLines: { color: 'rgba(13,37,64,0.6)' } },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
            rightPriceScale: { borderColor: '#0d2540', scaleMargins: { top: 0.1, bottom: 0.1 } },
            timeScale: { borderColor: '#0d2540', timeVisible: true, secondsVisible: false },
            handleScroll: true, handleScale: true,
        });

        const candleSeries = chart.addCandlestickSeries({
            upColor: '#00ff88', downColor: '#ff3366',
            borderUpColor: '#00ff88', borderDownColor: '#ff3366',
            wickUpColor: '#00d4aa', wickDownColor: '#cc2255',
        });
        candleSeries.setData(candles.map(c => ({ time: c.t, open: c.open, high: c.high, low: c.low, close: c.close })));

        // BB sur M1
        const S      = window.Scanner;
        const closes = candles.map(c => c.close);
        const n      = candles.length;
        const bbU = [], bbL = [];
        for (let i = 20; i < n; i++) {
            const bb = S.calcBB(closes.slice(0, i + 1), 20, 2.0);
            if (!bb) continue;
            bbU.push({ time: candles[i].t, value: bb.upper });
            bbL.push({ time: candles[i].t, value: bb.lower });
        }
        const bbUS = chart.addLineSeries({ color: '#5577cc', lineWidth: 1, lineStyle: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        const bbLS = chart.addLineSeries({ color: '#5577cc', lineWidth: 1, lineStyle: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        bbUS.setData(bbU);
        bbLS.setData(bbL);

        // Fit aux 60 dernières bougies
        const visFrom = candles[Math.max(0, n - 60)].t;
        chart.timeScale().setVisibleRange({ from: visFrom, to: candles[n-1].t + 120 });

        // Crosshair legend
        chart.subscribeCrosshairMove(param => {
            const leg = document.getElementById(`snp-legend-${cardId}`);
            if (!leg || !param.time) return;
            const cd = param.seriesData?.get(candleSeries);
            if (!cd) return;
            const pnl = ((cd.close - cd.open) / cd.open * 100).toFixed(2);
            leg.innerHTML = `<span class="cl-time">${pair} M1</span>
                <span class="cl-o">O<b>${cd.open?.toFixed?.(5)}</b></span>
                <span class="cl-h">H<b>${cd.high?.toFixed?.(5)}</b></span>
                <span class="cl-l">L<b>${cd.low?.toFixed?.(5)}</b></span>
                <span class="cl-c">C<b>${cd.close?.toFixed?.(5)}</b></span>
                <span class="cl-pnl ${pnl>=0?'pos':'neg'}">${pnl>0?'+':''}${pnl}%</span>`;
        });

        const ro = new ResizeObserver(e => { const w = e[0].contentRect.width; if (w > 0) chart.resize(w, 180); });
        ro.observe(el);
        this.instances[cardId] = { chart, ro };
    },

    _drawFallback(canvasId, candles) {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const W = canvas.offsetWidth || 300, H = 160;
        canvas.width = W * devicePixelRatio; canvas.height = H * devicePixelRatio;
        canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
        const ctx = canvas.getContext('2d');
        ctx.scale(devicePixelRatio, devicePixelRatio);
        const closes = candles.map(c => c.close);
        const slice  = closes.slice(-60);
        const minV   = Math.min(...slice) * 0.998, maxV = Math.max(...slice) * 1.002;
        const pad    = { t: 8, r: 8, b: 18, l: 48 };
        const cW = W - pad.l - pad.r, cH = H - pad.t - pad.b;
        ctx.fillStyle = '#080f20'; ctx.fillRect(0, 0, W, H);
        ctx.beginPath();
        slice.forEach((v, i) => {
            const x = pad.l + (i / (slice.length - 1)) * cW;
            const y = pad.t + cH - ((v - minV) / (maxV - minV)) * cH;
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.strokeStyle = slice[slice.length-1] >= slice[0] ? '#00ff88' : '#ff3366';
        ctx.lineWidth = 1.5; ctx.stroke();
    },

    destroy(cardId) {
        if (this.instances[cardId]) {
            try { this.instances[cardId].ro?.disconnect(); this.instances[cardId].chart?.remove(); } catch(e) {}
            delete this.instances[cardId];
        }
    }
};

window.SniperCharts = SniperCharts;
