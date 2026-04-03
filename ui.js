/**
 * UI.JS — Rendu cards mobile, filtrage, score détaillé au tap
 * v2.3 — saveSettings/loadSettings localStorage (IDs corrects)
 */

const UI = {
    allResults: [],
    currentFilter: 'all',

    init() {
        this.loadSettings();
        this.addLog('SqueezePulse V2.3 prêt.', 'ok');
    },

    // ── Persistance réglages ───────────────────────────────────────────────

    saveSettings() {
        const keys = ['bbMult', 'kcMult', 'adxMin', 'sqzMin', 'scoreMin'];
        const settings = {};
        keys.forEach(k => {
            const el = document.getElementById(k);
            if (el) settings[k] = el.value;
        });
        localStorage.setItem('sp_settings', JSON.stringify(settings));
        this.addLog('Configuration sauvegardée.', 'sys');
    },

    loadSettings() {
        try {
            const saved = localStorage.getItem('sp_settings');
            if (!saved) return;
            const cfg = JSON.parse(saved);
            ['bbMult', 'kcMult', 'adxMin', 'sqzMin', 'scoreMin'].forEach(k => {
                const el = document.getElementById(k);
                if (el && cfg[k] !== undefined) el.value = cfg[k];
            });
        } catch (e) {
            // localStorage corrompu → on ignore
        }
    },

    // ── Logs ───────────────────────────────────────────────────────────────

    addLog(msg, type = 'sys') {
        const box = document.getElementById('logBox');
        if (!box) return;
        const time = new Date().toLocaleTimeString('fr-FR');
        box.innerHTML += `<div class="log-e"><span class="log-t">${time}</span><span class="log-m ${type}">${msg}</span></div>`;
        box.scrollTop = box.scrollHeight;
        if (window.setLogNotif && (type === 'err' || type === 'warn')) setLogNotif(type);
    },

    setFilter(type) {
        this.currentFilter = type;
        // Retour au tableWrap si on était sur le panel sniper
        const sp = document.getElementById('sniper-panel');
        const tw = document.getElementById('tableWrap');
        const b2 = document.getElementById('bt2-panel');
        if (sp) sp.style.display = 'none';
        if (b2) b2.style.display = 'none';
        if (tw) tw.style.display = 'block';
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.getElementById(`tab-${type}`).classList.add('active');
        this.renderTable();
    },

    formatPrice(price) {
        if (price >= 1000) return price.toFixed(2);
        if (price >= 1)    return price.toFixed(3);
        if (price >= 0.01) return price.toFixed(4);
        return price.toFixed(6);
    },

    // ── Rendu throttlé : un seul repaint par frame via rAF ────────────────

    _renderPending: false,

    scheduleRender() {
        if (this._renderPending) return;   // déjà planifié, on ne re-planifie pas
        this._renderPending = true;
        requestAnimationFrame(() => {
            this._renderPending = false;
            this.renderTable();
        });
    },

    // ── Rendu cards ──────────────────────────────────────────────────────────────

    renderTable() {
        const wrap = document.getElementById('tableWrap');
        if (window.Charts) Charts.destroyAll(); // libère les instances LW avant re-render

        const filtered = this.allResults.filter(r => {
            if (this.currentFilter === 'fire')   return r.sqzType === 'FIRE' || r.sqzType === 'BREAKOUT';
            if (this.currentFilter === 'spring') return r.isSpring === true;
            if (this.currentFilter === 'sniper') return r.sniperScore >= 3 && (r.sqzType === 'SQUEEZE' || r.isSpring === true);
            return true;
        }).sort((a, b) => b.score - a.score);

        if (window.updateCountBadge) updateCountBadge(filtered.length);

        if (filtered.length === 0) {
            wrap.innerHTML = `
                <div class="empty">
                    <div class="empty-icon">🔍</div>
                    <div class="empty-lbl">AUCUN RÉSULTAT</div>
                </div>`;
            return;
        }

        const html = filtered.map((r, i) => this.buildCard(r, i)).join('');
        wrap.innerHTML = html;
    },

    buildCard(r, idx) {
        const typeClass  = r.sqzType || 'NEUTRAL';
        const btcIcon    = r.btcBullish === false ? '⚠️' : r.btcBullish === true ? '✅' : '';
        const adxStr     = r.adx  ? r.adx.toFixed(0)   : '—';
        const rvolStr    = r.rvol ? r.rvol.toFixed(1) + 'x' : '—';
        const scoreCls   = r.score >= 85 ? 'score-hi' : r.score >= 70 ? 'score-mid' : 'score-lo';
        const barColor   = r.score >= 85 ? '#00ff88'  : r.score >= 70 ? '#ffcc00'   : '#aa44ff';
        const sqzDur     = r.sqzDuration > 0 ? `<span class="sqz-dur"> ×${r.sqzDuration}</span>` : '';
        const springBadge = r.isSpring
            ? `<span class="type-badge SPRING">🌿 SPRING</span>` : '';
        const sniperBadge = r.sniperScore >= 3
            ? `<span class="type-badge SNIPER">◎ SNIPER${r.sniperFlags?.obvDiverg ? ' OBV' : ''}${r.sniperFlags?.rsiHigherLows ? ' RSI' : ''}${r.sniperFlags?.emaSniper ? ' EMA' : ''}</span>` : '';

        const detailRows = (r.scoreDetail || []).map(c => {
            const cls  = c.earned > 0 ? 'pos' : c.earned < 0 ? 'neg' : 'neu';
            const sign = c.earned > 0 ? '+' : '';
            return `<div class="detail-row"><span class="lbl">${c.label}</span><span class="${cls}">${sign}${c.earned}</span></div>`;
        }).join('');

        const tvLink = `https://www.tradingview.com/chart/?symbol=COINBASE:${r.pair.replace('-', '')}`;
        const bbMult = document.getElementById('bbMult')?.value || 2.0;
        const kcMult = document.getElementById('kcMult')?.value || 1.5;

        return `
        <div class="sig-card ${typeClass}" onclick="UI.toggleCard(${idx})">
            <div class="card-top">
                <span class="card-pair">${r.pair.replace('-USD', '')}</span>
                <button class="btn-chart" id="chart-btn-${idx}" onclick="event.stopPropagation(); Charts.toggle('${r.pair}', ${idx}, '${r.sqzType}', ${bbMult}, ${kcMult})" title="Graphique">📊</button>
                <button class="btn-to-sniper" onclick="event.stopPropagation(); sendToSniper('${r.pair}')" title="Envoyer en Phase 2 LIVE">📡</button>
                <button class="btn-to-sniper" onclick="event.stopPropagation(); sendToBT2('${r.pair}')" title="Backtest Phase 2" style="color:var(--purple);border-color:rgba(170,68,255,.3)">🧪</button>
                <a href="${tvLink}" target="_blank" class="tv-btn" onclick="event.stopPropagation()">📈</a>
                <span class="card-price">${this.formatPrice(r.price)}</span>
            </div>
            <div class="card-badges">
                <span class="type-badge ${typeClass}">${typeClass}${sqzDur}</span>
                ${springBadge}
                ${sniperBadge}
                ${btcIcon ? `<span class="btc-tag">${btcIcon}</span>` : ''}
            </div>
            <div class="card-metrics">
                <div class="metric">
                    <span class="metric-lbl">ADX</span>
                    <span class="metric-val adx">${adxStr}</span>
                </div>
                <div class="metric">
                    <span class="metric-lbl">RVOL</span>
                    <span class="metric-val rvol">${rvolStr}</span>
                </div>
                <div class="metric">
                    <span class="metric-lbl">SCORE</span>
                    <span class="metric-val ${scoreCls}">${r.score}</span>
                    <div class="score-bar-bg" style="width:60px">
                        <div class="score-bar-fill" style="width:${r.score}%;background:${barColor}"></div>
                    </div>
                </div>
            </div>
            <div class="chart-wrap" id="chart-wrap-${idx}"></div>
            ${detailRows ? `
            <div class="card-detail" id="card-detail-${idx}">
                <div class="detail-title">SCORE DÉTAIL</div>
                ${detailRows}
            </div>
            <div class="card-tap-hint" id="card-hint-${idx}">▼ DÉTAILS</div>
            ` : ''}
        </div>`;
    },

    toggleCard(idx) {
        const detail = document.getElementById(`card-detail-${idx}`);
        const hint   = document.getElementById(`card-hint-${idx}`);
        if (!detail) return;
        const open = detail.classList.toggle('open');
        if (hint) hint.textContent = open ? '▲ FERMER' : '▼ DÉTAILS';
    }
};

window.UI = UI;

/* ═══════════════════════════════════════════════════════════════
   DOM HANDLERS
═══════════════════════════════════════════════════════════════ */

function setTF(btn, tf) {
    Engine.TF = tf;
    Engine.resetCache();   // TF changé → indicateurs invalides → reset
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    UI.addLog(`Timeframe → ${tf === 3600 ? 'H1' : 'H6'}`, 'sys');
}

function filterStrategy(type) { UI.setFilter(type); }

/* ═══════════════════════════════════════════════════════════════
   SCAN
═══════════════════════════════════════════════════════════════ */

async function startScan() {
    if (Engine.isScanning) return;
    Engine.isScanning = true;
    UI.allResults = [];

    if (window.setScanState)   setScanState(true);
    if (window.updateProgress) updateProgress(0, 0);

    const cfg = {
        bbMult:   +(document.getElementById('bbMult').value)   || 2.0,
        kcMult:   +(document.getElementById('kcMult').value)   || 1.5,
        adxMin:   +(document.getElementById('adxMin').value)   || 20,
        sqzMin:   +(document.getElementById('sqzMin').value)   || 4,
        scoreMin: +(document.getElementById('scoreMin')?.value || 50),
    };

    // Sauvegarde auto des réglages au lancement du scan
    UI.saveSettings();

    // Ferme la config automatiquement au lancement
    const cfgPanel = document.getElementById('cfgPanel');
    if (cfgPanel && cfgPanel.classList.contains('open')) toggleConfig();

    await Engine.loadActivePairs();
    await Engine.loadBTCContext();
    if (window.updateBTCBadge) updateBTCBadge(Engine.btcContext);

    const total = Engine.pairs.length;
    let done = 0;

    if (window.updateProgress) updateProgress(0, total);

    for (const pair of Engine.pairs) {
        try {
            const candles    = await Engine.getCandles(pair);   // cache-first O(1) après 1er scan
            const btcCtx     = Engine.btcContext;
            const sqzData    = window.Scanner.analyzeSqueeze(candles, cfg, btcCtx);
            // Si sqzData existe, réutilise _sqz/_mom/_rvol déjà calculés → pas de double calcul
            const springData = window.Scanner.detectSpring(
                candles, cfg.bbMult, cfg.kcMult, btcCtx,
                { sqzResult: sqzData?._sqz  ?? null,
                  rvolIn:    sqzData?.rvol   ?? null,
                  momIn:     sqzData?._mom   ?? null }
            );

            if (sqzData || springData.detected) {
                UI.allResults.push({
                    pair,
                    price:       candles[candles.length - 1].close,
                    sqzType:     sqzData ? sqzData.sqzType : 'NEUTRAL',
                    score:       sqzData ? sqzData.score : springData.springScore,
                    scoreDetail: sqzData ? sqzData.scoreDetail : springData.scoreDetail,
                    isSpring:    springData.detected,
                    adx:         sqzData?.adx    || 0,
                    rvol:        sqzData?.rvol   || springData?.rvol || 0,
                    sqzDuration: sqzData?.sqzDuration || 0,
                    btcBullish:  sqzData?.btcBullish ?? springData?.btcBullish ?? true,
                    sniperScore: sqzData?.sniperScore ?? 0,
                    sniperFlags: sqzData?.sniperFlags ?? null,
                });
                UI.scheduleRender();
            }

        } catch (e) {
            UI.addLog(`${pair}: ${e.message}`, 'err');
        }

        done++;
        UI.allResults._scanned = done;
        if (window.updateProgress) updateProgress(done, total);
        if (window.updateStats)    updateStats(UI.allResults);
        if (done % 30 === 0)
            UI.addLog(`${done}/${total} — ${UI.allResults.length} signal(s)`, 'sys');

        await Engine.sleep(120);
    }

    Engine.isScanning = false;
    if (window.setScanState) setScanState(false);
    UI.addLog(`✅ ${UI.allResults.length} signal(s) sur ${total} paires`, 'ok');

    // ── Auto-feed Live M1 ────────────────────────────────────────────────────
    autoFeedSniper(UI.allResults);
}

/**
 * Envoie automatiquement en Live M1 :
 *  — Top 10 SNIPER  (sniperScore ≥ 3, SQUEEZE ou SPRING, trié par sniperScore desc)
 *  — Top 10 SQUEEZE (sqzType === 'SQUEEZE', trié par score desc)
 * Déduplique, respecte MAX_PAIRS (30), ne remet pas les paires déjà présentes.
 */
function autoFeedSniper(results) {
    if (!window.Sniper) return;

    const already = new Set(Sniper.pairs);

    // Top 10 SNIPER
    const topSniper = [...results]
        .filter(r => r.sniperScore >= 3 && (r.sqzType === 'SQUEEZE' || r.isSpring))
        .sort((a, b) => b.sniperScore - a.sniperScore || b.score - a.score)
        .slice(0, 10);

    // Top 20 SQUEEZE (hors doublons avec topSniper)
    const sniperPairs = new Set(topSniper.map(r => r.pair));
    const topSqueeze = [...results]
        .filter(r => r.sqzType === 'SQUEEZE' && !sniperPairs.has(r.pair))
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);

    const toAdd = [...topSniper, ...topSqueeze].filter(r => !already.has(r.pair));

    if (toAdd.length === 0) {
        UI.addLog('Live M1 : aucune nouvelle paire à ajouter.', 'sys');
        return;
    }

    let added = 0;
    for (const r of toAdd) {
        if (Sniper.pairs.length >= Sniper.MAX_PAIRS) break;
        const origin = sniperPairs.has(r.pair) ? 'sniper' : 'squeeze';
        Sniper.addPair(r.pair, origin);
        added++;
    }

    UI.addLog(`📡 Live M1 : ${added} paire(s) ajoutée(s) automatiquement (${topSniper.length} sniper + ${Math.max(0, added - topSniper.length)} squeeze)`, 'ok');
    if (window.updateSniperCount) updateSniperCount();

    // Démarre la surveillance si elle n'est pas déjà active
    if (!Sniper.isRunning) {
        Sniper.start();
        UI.addLog('📡 Live M1 démarré automatiquement.', 'ok');
    }
}

window.onload = () => {
    if (window.applyTheme) applyTheme();
    UI.init();
    if (window.Sniper) Sniper.loadFromLocalStorage();
};
