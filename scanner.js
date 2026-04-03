/**
 * SCANNER.JS - Calculs techniques : BB, KC, TTM Squeeze, Wyckoff Spring
 * v2.2 — Filtre RVOL dur (< 1.0 → rejet), RVOL Burst 1.3 comme bonus score
 */

const Scanner = {

    // ── Utilitaires ──────────────────────────────────────────────────────────

    sma(arr, period) {
        if (arr.length < period) return null;
        const slice = arr.slice(-period);
        return slice.reduce((s, v) => s + v, 0) / period;
    },

    stddev(arr, period) {
        const mean = this.sma(arr, period);
        if (mean === null) return null;
        const slice = arr.slice(-period);
        const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
        return Math.sqrt(variance);
    },

    ema(arr, period) {
        if (arr.length < period) return null;
        const k = 2 / (period + 1);
        let val = arr.slice(0, period).reduce((s, v) => s + v, 0) / period;
        for (let i = period; i < arr.length; i++) val = arr[i] * k + val * (1 - k);
        return val;
    },

    trueRange(candles) {
        return candles.map((c, i) => {
            if (i === 0) return c.high - c.low;
            const prev = candles[i - 1].close;
            return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
        });
    },

    atr(candles, period = 14) {
        const tr = this.trueRange(candles);
        return this.sma(tr, period);
    },

    // ── Bollinger Bands ───────────────────────────────────────────────────────

    calcBB(closes, period = 20, mult = 2.0) {
        const mid = this.sma(closes, period);
        const sd  = this.stddev(closes, period);
        if (mid === null || sd === null) return null;
        return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
    },

    // ── Keltner Channels (EMA + ATR) ──────────────────────────────────────────

    calcKC(candles, period = 20, mult = 1.5) {
        const closes = candles.map(c => c.close);
        const mid    = this.ema(closes, period);
        const atrVal = this.atr(candles, period);
        if (mid === null || atrVal === null) return null;
        return { mid, upper: mid + mult * atrVal, lower: mid - mult * atrVal };
    },

    // ── ADX / DI ──────────────────────────────────────────────────────────────

    calcADX(candles, period = 14) {
        if (candles.length < period * 2) return { adx: 0, diPlus: 0, diMinus: 0 };
        const n = candles.length;
        const dmPlus = [], dmMinus = [], tr = [];

        for (let i = 1; i < n; i++) {
            const c = candles[i], p = candles[i - 1];
            const upMove   = c.high - p.high;
            const downMove = p.low  - c.low;
            dmPlus.push(upMove > downMove && upMove > 0 ? upMove : 0);
            dmMinus.push(downMove > upMove && downMove > 0 ? downMove : 0);
            tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
        }

        const smooth = (arr) => {
            let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
            const out = [s];
            for (let i = period; i < arr.length; i++) { s = s - s / period + arr[i]; out.push(s); }
            return out;
        };

        const sTR  = smooth(tr);
        const sDMP = smooth(dmPlus);
        const sDMM = smooth(dmMinus);
        const dx   = sTR.map((t, i) => {
            const diP = t > 0 ? (sDMP[i] / t) * 100 : 0;
            const diM = t > 0 ? (sDMM[i] / t) * 100 : 0;
            const sum = diP + diM;
            return sum > 0 ? (Math.abs(diP - diM) / sum) * 100 : 0;
        });

        const adx   = this.sma(dx, period) || 0;
        const last  = sTR.length - 1;
        const diPlus  = sTR[last] > 0 ? (sDMP[last] / sTR[last]) * 100 : 0;
        const diMinus = sTR[last] > 0 ? (sDMM[last] / sTR[last]) * 100 : 0;

        return { adx, diPlus, diMinus };
    },

    // ── Momentum TTM (méthode John Carter corrigée) ───────────────────────────
    // val[i] = close[i] - moyenne(midHL_period, SMA_close_period)
    // slope par régression linéaire sur 12 dernières valeurs

    calcMomentum(candles, period = 12) {
        const n = candles.length;
        if (n < period * 2) return { value: 0, rising: false };

        const histogram = [];
        for (let i = period; i < n; i++) {
            const slice  = candles.slice(i - period, i + 1);
            const closes = slice.map(c => c.close);
            const highest = Math.max(...slice.map(c => c.high));
            const lowest  = Math.min(...slice.map(c => c.low));
            const midHL   = (highest + lowest) / 2;
            const smaC    = closes.reduce((s, v) => s + v, 0) / closes.length;
            histogram.push(closes[closes.length - 1] - (midHL + smaC) / 2);
        }

        const hist12 = histogram.slice(-period);
        const m  = hist12.length;
        const mx = (m - 1) / 2;
        const my = hist12.reduce((s, v) => s + v, 0) / m;
        let num = 0, den = 0;
        for (let i = 0; i < m; i++) { num += (i - mx) * (hist12[i] - my); den += (i - mx) ** 2; }
        const slope = den !== 0 ? num / den : 0;

        return { value: slope, rising: slope > 0 };
    },

    // ── RVOL ──────────────────────────────────────────────────────────────────

    calcRVOL(candles, period = 20) {
        if (candles.length < period + 1) return 1;
        const avgVol = this.sma(candles.slice(-period - 1, -1).map(c => c.vol), period);
        const curVol = candles[candles.length - 1].vol;
        return avgVol > 0 ? curVol / avgVol : 1;
    },

    // ── OBV ───────────────────────────────────────────────────────────────────

    calcOBV(candles) {
        let obv = 0;
        const vals = [0];
        for (let i = 1; i < candles.length; i++) {
            if (candles[i].close > candles[i - 1].close)      obv += candles[i].vol;
            else if (candles[i].close < candles[i - 1].close) obv -= candles[i].vol;
            vals.push(obv);
        }
        return vals;
    },

    // ── RSI ───────────────────────────────────────────────────────────────────

    calcRSI(candles, period = 9) {
        if (candles.length < period + 1) return [];
        const closes = candles.map(c => c.close);
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) {
            const diff = closes[i] - closes[i - 1];
            if (diff > 0) gains += diff; else losses -= diff;
        }
        let avgGain = gains / period;
        let avgLoss = losses / period;
        const rsi = [];
        for (let i = period + 1; i < closes.length; i++) {
            const diff = closes[i] - closes[i - 1];
            avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
            avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
            const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
            rsi.push(100 - 100 / (1 + rs));
        }
        return rsi;
    },

    // ── SNIPER : détecte l'accumulation silencieuse ───────────────────────────
    // OBV monte / prix plat + RSI 9 higher lows + momentum dot reprend

    calcSniperSignals(candles, lookback = 10) {
        if (candles.length < lookback + 5) return { sniperScore: 0, obvDiverg: false, rsiHigherLows: false, emaSniper: false };

        const slice = candles.slice(-lookback);

        // 1. OBV divergence : prix range plat mais OBV en hausse
        const prices = slice.map(c => c.close);
        const priceRange = (Math.max(...prices) - Math.min(...prices)) / prices[0];
        const obvSeries = this.calcOBV(slice);
        const obvTrend = obvSeries[obvSeries.length - 1] - obvSeries[0];
        const obvDiverg = priceRange < 0.04 && obvTrend > 0;

        // 2. RSI 9 higher lows sur les 3 derniers creux locaux
        const rsiSeries = this.calcRSI(candles, 9);
        let rsiHigherLows = false;
        if (rsiSeries.length >= 6) {
            const lows = [];
            for (let i = 1; i < rsiSeries.length - 1; i++) {
                if (rsiSeries[i] < rsiSeries[i - 1] && rsiSeries[i] < rsiSeries[i + 1])
                    lows.push(rsiSeries[i]);
            }
            if (lows.length >= 2) {
                const last = lows.slice(-3);
                rsiHigherLows = last[last.length - 1] > last[last.length - 2];
            }
        }

        // 3. EMA 9 > EMA 20 (croisement haussier récent)
        const closes = candles.map(c => c.close);
        const ema9  = this.ema(closes, 9);
        const ema20 = this.ema(closes, 20);
        const ema9Prev  = this.ema(closes.slice(0, -1), 9);
        const ema20Prev = this.ema(closes.slice(0, -1), 20);
        const emaSniper = ema9 !== null && ema20 !== null && ema9 > ema20 &&
                          ema9Prev !== null && ema20Prev !== null && ema9Prev <= ema20Prev;

        const sniperScore = (obvDiverg ? 2 : 0) + (rsiHigherLows ? 2 : 0) + (emaSniper ? 1 : 0);

        return { sniperScore, obvDiverg, rsiHigherLows, emaSniper };
    },

    // ── CONTEXTE BTC ──────────────────────────────────────────────────────────

    calcBTCContext(candles) {
        const closes = candles.map(c => c.close);
        const ema50  = this.ema(closes, 50);
        const price  = closes[closes.length - 1];
        return {
            bullish: ema50 !== null ? price > ema50 : true,
            price,
            ema50: ema50 || price
        };
    },

    // ── SQUEEZE DETECTION (O(n) pour la durée) ────────────────────────────────

    detectSqueeze(candles, bbMult = 2.0, kcMult = 1.5, period = 20) {
        const closes = candles.map(c => c.close);
        const bb = this.calcBB(closes, period, bbMult);
        const kc = this.calcKC(candles, period, kcMult);
        if (!bb || !kc) return { inSqueeze: false, duration: 0 };

        const inSqueeze = bb.upper < kc.upper && bb.lower > kc.lower;
        let duration = 0;

        if (inSqueeze) {
            for (let i = candles.length - 1; i >= period; i--) {
                const sliceCl = closes.slice(i - period, i);
                const sliceCa = candles.slice(i - period, i);
                const bb2 = this.calcBB(sliceCl, period, bbMult);
                const kc2 = this.calcKC(sliceCa, period, kcMult);
                if (bb2 && kc2 && bb2.upper < kc2.upper && bb2.lower > kc2.lower) duration++;
                else break;
            }
        }

        return {
            inSqueeze, duration,
            bbUpper: bb.upper, bbLower: bb.lower,
            kcUpper: kc.upper, kcLower: kc.lower,
            bbMid:   bb.mid
        };
    },

    // ── SCORE BUILDER ─────────────────────────────────────────────────────────

    buildScore(components) {
        const total = Math.max(0, Math.min(
            components.reduce((s, c) => s + c.earned, 0),
            100
        ));
        return { total, components };
    },

    // ── ANALYSE SQUEEZE / BREAKOUT / FIRE ────────────────────────────────────

    analyzeSqueeze(candles, cfg, btcContext = null) {
        if (candles.length < 50) return null;
        const { bbMult = 2.0, kcMult = 1.5, adxMin = 20, sqzMin = 4, scoreMin = 50 } = cfg;
        const closes = candles.map(c => c.close);

        const sqz    = this.detectSqueeze(candles, bbMult, kcMult);
        const mom    = this.calcMomentum(candles);
        const adxD   = this.calcADX(candles);
        const rvol   = this.calcRVOL(candles);
        const sniper = this.calcSniperSignals(candles);

        // ── Filtre dur : volume insuffisant
        // Exception sniper : OBV diverge = accumulation silencieuse détectée → on abaisse le seuil
        if (rvol < 1.0 && sniper.sniperScore < 2) return null;

        const btcPenalty = btcContext && !btcContext.bullish ? -20 : 0;

        // ── SQUEEZE actif ─────────────────────────────────────────────────
        if (sqz.inSqueeze && sqz.duration >= sqzMin) {
            const score = this.buildScore([
                { label: 'Base squeeze',                                        earned: 50 },
                { label: `Momentum ${mom.rising ? '↑' : '—'}`,                 earned: mom.rising ? 15 : 0 },
                { label: `ADX ${adxD.adx.toFixed(0)}`,                         earned: adxD.adx >= adxMin ? 10 : 0 },
                { label: `DI+ ${adxD.diPlus.toFixed(0)} / DI- ${adxD.diMinus.toFixed(0)}`, earned: adxD.diPlus > adxD.diMinus ? 10 : 0 },
                { label: `Volume Burst (${rvol.toFixed(1)}x)`,                  earned: rvol >= 1.3 ? 15 : 0 },
                { label: `OBV divergence`,                                      earned: sniper.obvDiverg ? 10 : 0 },
                { label: `RSI higher lows`,                                     earned: sniper.rsiHigherLows ? 8 : 0 },
                { label: `EMA 9>20 cross`,                                      earned: sniper.emaSniper ? 5 : 0 },
                { label: `BTC ${btcContext?.bullish ? '✅' : '⚠️'}`,            earned: btcPenalty },
            ]);
            if (score.total < scoreMin) return null;
            return { sqzType: 'SQUEEZE', score: score.total, scoreDetail: score.components, adx: adxD.adx, diPlus: adxD.diPlus, diMinus: adxD.diMinus, rvol, sqzDuration: sqz.duration, momentum: mom.value, btcBullish: btcPenalty === 0, sniperScore: sniper.sniperScore, sniperFlags: sniper, _sqz: sqz, _mom: mom };
        }

        // ── BREAKOUT (sortie squeeze N-1) ─────────────────────────────────
        const prevSqz = (() => {
            if (candles.length < 22) return false;
            const slCl = closes.slice(-21, -1);
            const slCa = candles.slice(-21, -1);
            const bb2  = this.calcBB(slCl, 20, bbMult);
            const kc2  = this.calcKC(slCa, 20, kcMult);
            return bb2 && kc2 && bb2.upper < kc2.upper && bb2.lower > kc2.lower;
        })();

        if (prevSqz && !sqz.inSqueeze && mom.rising && adxD.adx >= adxMin) {
            const score = this.buildScore([
                { label: 'Sortie squeeze',                                      earned: 60 },
                { label: `DI+ ${adxD.diPlus.toFixed(0)} / DI- ${adxD.diMinus.toFixed(0)}`, earned: adxD.diPlus > adxD.diMinus ? 15 : 0 },
                { label: `Volume Burst (${rvol.toFixed(1)}x)`,                  earned: rvol >= 1.3 ? 15 : 0 },
                { label: `ADX ${adxD.adx.toFixed(0)} ≥ 30`,                    earned: adxD.adx >= 30 ? 10 : 0 },
                { label: `BTC ${btcContext?.bullish ? '✅' : '⚠️'}`,            earned: btcPenalty },
            ]);
            if (score.total < scoreMin) return null;
            return { sqzType: 'BREAKOUT', score: score.total, scoreDetail: score.components, adx: adxD.adx, diPlus: adxD.diPlus, diMinus: adxD.diMinus, rvol, sqzDuration: 0, momentum: mom.value, btcBullish: btcPenalty === 0, sniperScore: sniper.sniperScore, sniperFlags: sniper, _sqz: sqz, _mom: mom };
        }

        // ── FIRE (momentum fort — filtres renforcés) ──────────────────────
        const diGap = adxD.diPlus - adxD.diMinus;
        if (mom.rising && adxD.adx >= 30 && adxD.diPlus > adxD.diMinus && rvol > 1.8 && diGap > 10) {
            const score = this.buildScore([
                { label: 'Base FIRE',                                           earned: 50 },
                { label: `ADX ${adxD.adx.toFixed(0)}`,                         earned: Math.min(Math.round(adxD.adx - 30), 20) },
                { label: `Volume Burst (${rvol.toFixed(1)}x)`,                  earned: rvol >= 2.0 ? 15 : 5 },
                { label: `DI écart ${diGap.toFixed(0)}`,                       earned: diGap > 20 ? 15 : 5 },
                { label: `BTC ${btcContext?.bullish ? '✅' : '⚠️'}`,            earned: btcPenalty },
            ]);
            if (score.total < scoreMin) return null;
            return { sqzType: 'FIRE', score: score.total, scoreDetail: score.components, adx: adxD.adx, diPlus: adxD.diPlus, diMinus: adxD.diMinus, rvol, sqzDuration: 0, momentum: mom.value, btcBullish: btcPenalty === 0, sniperScore: sniper.sniperScore, sniperFlags: sniper, _sqz: sqz, _mom: mom };
        }

        return null;
    },

    // ── WYCKOFF SPRING ────────────────────────────────────────────────────────────────────────────
    // sqzResult, rvolIn, momIn : résultats pré-calculés par analyzeSqueeze (optionnels)
    // → évite de recalculer BB/KC/RVOL/momentum une deuxième fois par paire

    detectSpring(candles, bbMult = 2.0, kcMult = 1.5, btcContext = null,
                 { sqzResult = null, rvolIn = null, momIn = null } = {}) {
        if (candles.length < 50) return { detected: false };

        // RVOL : réutilise la valeur déjà calculée si fournie
        const rvol = rvolIn !== null ? rvolIn : this.calcRVOL(candles);
        if (rvol < 1.0) return { detected: false };

        // detectSqueeze : réutilise sqzResult si fourni
        const sqz = sqzResult !== null ? sqzResult : this.detectSqueeze(candles, bbMult, kcMult);
        if (!sqz.inSqueeze) return { detected: false };

        const lastCandle = candles[candles.length - 1];
        const washout    = lastCandle.low < sqz.bbLower && lastCandle.close > sqz.bbLower;
        if (!washout) return { detected: false };

        // Momentum : réutilise momIn si fourni, sinon calcule
        const mom     = momIn !== null ? momIn : this.calcMomentum(candles);
        const momPrev = this.calcMomentum(candles.slice(0, -3));
        if (!mom.rising || mom.value <= momPrev.value) return { detected: false };

        const washoutDepth = ((sqz.bbLower - lastCandle.low) / sqz.bbLower) * 100;
        const obv          = this.calcOBV(candles);
        const n            = obv.length;
        // OBV : 5 bougies consécutives croissantes
        const obvRising = n >= 5 &&
            obv[n-1] > obv[n-2] && obv[n-2] > obv[n-3] &&
            obv[n-3] > obv[n-4] && obv[n-4] > obv[n-5];

        const btcPenalty = btcContext && !btcContext.bullish ? -20 : 0;

        const score = this.buildScore([
            { label: 'Wash-out confirmé',                                       earned: 60 },
            { label: `Depth ${washoutDepth.toFixed(1)}%`,                       earned: washoutDepth > 2 ? 15 : washoutDepth > 1 ? 8 : 0 },
            { label: `Volume Burst (${rvol.toFixed(1)}x)`,                      earned: rvol >= 1.3 ? 10 : 0 },
            { label: `OBV 5 bougies ${obvRising ? '↑' : '—'}`,                 earned: obvRising ? 15 : 0 },
            { label: `BTC ${btcContext?.bullish ? '✅' : '⚠️'}`,                earned: btcPenalty },
        ]);

        return {
            detected:     true,
            springScore:  score.total,
            scoreDetail:  score.components,
            washoutDepth: +washoutDepth.toFixed(2),
            obvRising,
            rvol,
            btcBullish:   btcPenalty === 0
        };
    }
};

window.Scanner = Scanner;
