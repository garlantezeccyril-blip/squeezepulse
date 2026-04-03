/**
 * ENGINE.JS - Requêtes Coinbase + cache incrémental + rate-limit
 * v2.5 — Cache par paire : candles, indicateurs O(1), fetch dernière bougie seulement
 *
 * Architecture :
 *   Engine.cache[pair] = {
 *     candles       : [],          // historique figé (clôturées)
 *     currentCandle : {},          // bougie en cours (non clôturée)
 *     ind           : {            // indicateurs mis à jour O(1)
 *       ema20, ema50,              // EMA incrémentale
 *       sma20, smaSum20,           // SMA rolling (somme glissante)
 *       sumX, sumX2,               // somme + somme carrés → stddev O(1)
 *       atr14, prevClose,          // ATR incrémental (Wilder)
 *       obv,                       // OBV courant
 *       lastTs                     // timestamp dernière bougie connue
 *     }
 *   }
 */

const COINBASE    = 'https://api.exchange.coinbase.com';
const MAX_RETRIES = 4;
const CACHE_SIZE  = 210; // bougies max gardées en mémoire par paire

const EXCLUDED = new Set([
    'USDC','USDT','DAI','BUSD','TUSD','USDP','GUSD','PAX','FRAX','LUSD',
    'EURC','EURT','EURS','AGEUR','GYEN','FDUSD','PYUSD','USDM','USDD',
    'WBTC','WETH','WSTETH','CBETH','RETH','STETH','SBTC','RENBTC',
]);

const Engine = {
    pairs:      [],
    TF:         3600,
    isScanning: false,
    btcContext: null,
    cache:      {},   // cache[pair] = { candles, currentCandle, ind }

    // ── Chargement des paires ──────────────────────────────────────────────

    async loadActivePairs() {
        this.log('Chargement des paires USD...', 'sys');
        const res = await fetch(`${COINBASE}/products`);
        if (!res.ok) throw new Error(`HTTP ${res.status} sur /products`);
        const products = await res.json();
        this.pairs = products
            .filter(p => p.status === 'online' && p.quote_currency === 'USD' && !EXCLUDED.has(p.base_currency))
            .map(p => p.id)
            .sort();
        this.log(`${this.pairs.length} paires USD chargées.`, 'ok');
    },

    // ── Contexte BTC ───────────────────────────────────────────────────────

    async loadBTCContext() {
        this.log('Analyse contexte BTC...', 'sys');
        try {
            const candles = await this.fetchCandles('BTC-USD', 200);
            const ctx = window.Scanner.calcBTCContext(candles);
            this.btcContext = ctx;
            const icon = ctx.bullish ? '✅' : '⚠️';
            this.log(
                `${icon} BTC ${ctx.bullish ? 'HAUSSIER' : 'BAISSIER'} — ${ctx.price.toFixed(0)} / EMA50 ${ctx.ema50.toFixed(0)}`,
                ctx.bullish ? 'ok' : 'warn'
            );
        } catch (e) {
            this.log('Contexte BTC indispo — scan sans filtre macro.', 'warn');
            this.btcContext = null;
        }
    },

    // ── Utilitaire : fetch avec retry exponentiel sur 429 ─────────────────
    //   Options : maxRetries (défaut MAX_RETRIES), baseMs (défaut 1000), capMs (défaut 16000)

    async fetchWithRetry(url, { maxRetries = MAX_RETRIES, baseMs = 1000, capMs = 16000, label = url } = {}) {
        let attempt = 0;
        while (attempt <= maxRetries) {
            const res = await fetch(url);
            if (res.ok) return res;
            if (res.status === 429) {
                const wait = Math.min(baseMs * Math.pow(2, attempt), capMs);
                this.log(`429 ${label} — attente ${wait / 1000}s`, 'warn');
                await this.sleep(wait);
                attempt++;
                continue;
            }
            throw new Error(`HTTP ${res.status} — ${label}`);
        }
        throw new Error(`Max retries (${maxRetries}) dépassé — ${label}`);
    },

    // ── Fetch complet (premier chargement ou désync) ──────────────────────

    async fetchCandles(pair, limit = 200) {
        const url = `${COINBASE}/products/${pair}/candles?granularity=${this.TF}`;
        const res = await this.fetchWithRetry(url, { label: pair });
        const raw = await res.json();
        return raw.slice(0, limit).reverse().map(c => ({
            t: +c[0], low: +c[1], high: +c[2], open: +c[3], close: +c[4], vol: +c[5]
        }));
    },

    // ── Fetch dernières bougies seulement (refresh) ───────────────────────

    async fetchLastCandles(pair, count = 3) {
        const url = `${COINBASE}/products/${pair}/candles?granularity=${this.TF}`;
        const res = await this.fetchWithRetry(url, { label: pair, capMs: 8000 });
        const raw = await res.json();
        return raw.slice(0, count).reverse().map(c => ({
            t: +c[0], low: +c[1], high: +c[2], open: +c[3], close: +c[4], vol: +c[5]
        }));
    },

    // ── Init cache pour une paire (chargement initial) ────────────────────

    initCache(pair, candles) {
        const S      = window.Scanner;
        const closes = candles.map(c => c.close);
        const n      = candles.length;

        // EMA 20 et EMA 50 : calcul complet une fois
        const ema20 = S.ema(closes, 20) || closes[n-1];
        const ema50 = S.ema(closes, 50) || closes[n-1];

        // SMA 20 rolling : somme des 20 dernières closes
        const win20    = closes.slice(-20);
        const smaSum20 = win20.reduce((s, v) => s + v, 0);
        const sma20    = smaSum20 / 20;

        // Somme et somme des carrés pour stddev O(1)
        const sumX  = smaSum20;
        const sumX2 = win20.reduce((s, v) => s + v * v, 0);

        // ATR14 Wilder : calcul complet une fois
        const atr14 = S.atr(candles, 14) || 0;

        // OBV courant
        const obvArr = S.calcOBV(candles);
        const obv    = obvArr[obvArr.length - 1];

        this.cache[pair] = {
            candles:       candles.slice(-CACHE_SIZE),
            currentCandle: candles[n - 1],
            ind: {
                ema20, ema50,
                smaSum20, sma20,
                sumX, sumX2,
                atr14,
                obv,
                prevClose: closes[n - 1],
                lastTs:    candles[n - 1].t,
            }
        };
    },

    // ── Mise à jour incrémentale sur nouvelle bougie clôturée O(1) ────────

    updateCache(pair, newCandle) {
        const c   = this.cache[pair];
        if (!c) return;
        const ind = c.ind;

        // EMA 20 et 50 : O(1)
        const k20 = 2 / 21;
        const k50 = 2 / 51;
        ind.ema20 = newCandle.close * k20 + ind.ema20 * (1 - k20);
        ind.ema50 = newCandle.close * k50 + ind.ema50 * (1 - k50);

        // SMA 20 rolling : retire la plus vieille, ajoute la nouvelle O(1)
        const oldest = c.candles.length >= 20 ? c.candles[c.candles.length - 20].close : newCandle.close;
        ind.smaSum20 = ind.smaSum20 - oldest + newCandle.close;
        ind.sma20    = ind.smaSum20 / 20;

        // Stddev rolling O(1) : mise à jour somme et somme des carrés
        ind.sumX  = ind.sumX  - oldest + newCandle.close;
        ind.sumX2 = ind.sumX2 - oldest * oldest + newCandle.close * newCandle.close;

        // ATR14 Wilder incrémental : O(1)
        const tr = Math.max(
            newCandle.high - newCandle.low,
            Math.abs(newCandle.high - ind.prevClose),
            Math.abs(newCandle.low  - ind.prevClose)
        );
        ind.atr14     = (ind.atr14 * 13 + tr) / 14;

        // OBV : O(1)
        if      (newCandle.close > ind.prevClose) ind.obv += newCandle.vol;
        else if (newCandle.close < ind.prevClose) ind.obv -= newCandle.vol;

        ind.prevClose = newCandle.close;
        ind.lastTs    = newCandle.t;

        // Ajoute la bougie, purge si dépassement CACHE_SIZE
        c.candles.push(newCandle);
        if (c.candles.length > CACHE_SIZE) c.candles.shift();
    },

    // ── Lecture BB + KC depuis le cache → O(1) ────────────────────────────

    getCachedIndicators(pair) {
        const c = this.cache[pair];
        if (!c) return null;
        const ind = c.ind;

        // Stddev depuis somme des carrés : sqrt(E[X²] - E[X]²)
        const mean   = ind.sma20;
        const stddev = Math.sqrt(Math.max(0, ind.sumX2 / 20 - (ind.sumX / 20) ** 2));

        return {
            bb: {
                mid:   mean,
                upper: mean + 2 * stddev,
                lower: mean - 2 * stddev,
            },
            kc: {
                mid:   ind.ema20,
                upper: ind.ema20 + 1.5 * ind.atr14,
                lower: ind.ema20 - 1.5 * ind.atr14,
            },
            ema20: ind.ema20,
            ema50: ind.ema50,
            obv:   ind.obv,
            atr14: ind.atr14,
        };
    },

    // ── getCandles : cache-first, fetch minimal si déjà initialisé ────────
    // Interface identique à fetchCandles pour ui.js — transparent

    async getCandles(pair) {
        if (!this.cache[pair]) {
            // Premier chargement → fetch complet + init cache
            const candles = await this.fetchCandles(pair, 200);
            this.initCache(pair, candles);
            return this.cache[pair].candles;
        }

        // Cache présent → fetch seulement les 3 dernières bougies
        const last = await this.fetchLastCandles(pair, 3);
        const ind  = this.cache[pair].ind;

        // Détecte désync : gap > 2 bougies manquantes → refetch complet
        if (last.length > 0) {
            const latestTs = last[last.length - 1].t;
            if (latestTs > ind.lastTs + this.TF * 3) {
                this.log(`${pair} désync — refetch complet`, 'warn');
                delete this.cache[pair];
                return this.getCandles(pair);
            }

            // Mise à jour incrémentale des bougies clôturées
            for (const candle of last) {
                if (candle.t > ind.lastTs && candle.t < latestTs) {
                    this.updateCache(pair, candle);
                }
            }

            // Avant-dernière = dernière clôturée
            if (last.length >= 2) {
                const prevLast = last[last.length - 2];
                if (prevLast.t > ind.lastTs) {
                    this.updateCache(pair, prevLast);
                }
            }

            // Dernière bougie = en cours (non clôturée)
            this.cache[pair].currentCandle = last[last.length - 1];
        }

        return this.cache[pair].candles;
    },

    // ── Reset cache (changement TF ou nouveau scan forcé) ─────────────────

    resetCache() {
        this.cache = {};
        this.log('Cache vidé — prochain scan fera un fetch complet.', 'sys');
    },

    log(msg, type = 'sys') {
        if (window.UI) window.UI.addLog(msg, type);
    },

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
};

window.Engine = Engine;
