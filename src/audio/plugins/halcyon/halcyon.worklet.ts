// Halcyon — wavetable synthesizer AudioWorkletProcessor.
// Signal flow per voice: 3 wavetable oscs (unison, warp) + sub + noise → routing (F1 / F2 / both / dry)
// → 2 filters (serial / parallel) → amp (ENV1) → global FX chain (dist → chorus → delay → reverb) → out.
// Modulation runs at control rate (≤ 32-sample blocks); every continuous value is smoothed and
// linearly interpolated inside the block, so nothing zips. render() never allocates.
import { InstrumentProcessor, Rng } from '../../worklets/kit';
import {
  clamp01, combFb, customTable, cutToNorm, CUT_OCT, D_ENV, D_FILT, D_FX, D_LFO_RATE, D_MASTER, D_NOISE, D_OSC, D_PITCH, D_SUB, DELAY_DIVS, dstIndex, ensureState,
  envCurve, formantQ, formantSet, formantShift, FT_BP12, FT_BP24, FT_COMB, FT_FORMANT, FT_HP12, FT_HP24, FT_LADDER, FT_LP12, FT_LP24, FT_N24, ladderK,
  lfoBasic, LFO_CUSTOM, LFO_HZ_MAX, LFO_HZ_MIN, LFO_SH, LFO_SMOOTH, MAX_MOD, MAX_POLY, MAX_UNI, N_DST, N_ENV, N_LFO, N_OSC, N_SRC, normToCut, PITCH_MOD_RANGE, S_MACRO,
  S_NOTE, S_RAND, S_VEL, srcIndex, svfK, svfK24a, svfK24b, SYNC_DIVS, timeToNorm, T_LN, T_MIN, W_BENDM, W_BENDP, W_FM, W_MIRROR, W_NONE, W_QUANT, W_RM, W_SQUEEZE, W_SYNC,
} from './defs';
import { buildWavetable, MIP_SIZE, Wavetable, WT_COUNT, WT_FRAMES, WT_SIZE } from './wavetables';

const CH = 64; // control block (samples); pitch / levels / frames / cutoff are ramped per sample inside it
const POOL = MAX_POLY + 8; // extra slots for voices fading out after being stolen
const OUT = 0.3; // voice output scale
const LN2 = Math.LN2;

// Wavetables are built lazily and shared by every Halcyon instance in this audio context.
const TABLES: (Wavetable | undefined)[] = [];
const getTable = (i: number) => (TABLES[i] ??= buildWavetable(i));

// ---- smoothed parameter slots ----
const PO_LEVEL = 0, PO_PAN = 1, PO_FRAME = 2, PO_PITCH = 3, PO_DETUNE = 4, PO_SPREAD = 5, PO_BLEND = 6, PO_WARP = 7, PO_STRIDE = 8;
const P_SUB_LEVEL = 24, P_SUB_PAN = 25, P_NOISE_LEVEL = 26, P_NOISE_PAN = 27;
const P_FILT = 28, PF_CUT = 0, PF_RESO = 1, PF_DRIVE = 2, PF_KEY = 3, PF_MIX = 4, PF_MORPH = 5, PF_STRIDE = 6;
const P_SUS = 40;
const P_VOL = 43;
const P_DIST_DRIVE = 44, P_DIST_TONE = 45, P_DIST_MIX = 46;
const P_CH_RATE = 47, P_CH_DEPTH = 48, P_CH_FB = 49, P_CH_MIX = 50;
const P_DL_FB = 51, P_DL_TONE = 52, P_DL_MIX = 53;
const P_RV_SIZE = 54, P_RV_DAMP = 55, P_RV_WIDTH = 56, P_RV_MIX = 57;
const P_FX_ON = 58;
const P_MACRO = 62;
const P_MOD = 66;
const P_MACRO_IN = P_MOD + MAX_MOD; // playlist automation of macro1..4 (AudioParams)
const P_COUNT = P_MACRO_IN + 4;

// envelope stages
const E_ATT = 0, E_HOLD = 1, E_DEC = 2, E_SUS = 3, E_REL = 4, E_IDLE = 5;

const fastTanh = (x: number) => (x < -3 ? -1 : x > 3 ? 1 : (x * (27 + x * x)) / (27 + 9 * x * x));
const pow2 = (n: number) => {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
};

class Voice {
  active = false;
  id = -1;
  key = 60;
  vel = 0.8;
  order = 0;
  gate = false;
  fading = false;
  fade = 1;
  fadeStep = 0;
  pitch = 60;
  glideRate = 0;
  rand = 0;
  time = 0;
  first = true;
  eStage = new Int8Array(N_ENV);
  eT = new Float64Array(N_ENV);
  eLvl = new Float64Array(N_ENV);
  eStart = new Float64Array(N_ENV);
  lPh = new Float64Array(N_LFO);
  lVal = new Float64Array(N_LFO);
  lHold = new Float64Array(N_LFO);
  lPrev = new Float64Array(N_LFO);
  lNext = new Float64Array(N_LFO);
  src = new Float64Array(N_SRC);
  mod = new Float64Array(N_DST);
  ph = new Float64Array(N_OSC * MAX_UNI);
  prevFrame = new Float64Array(N_OSC);
  prevLevel = new Float64Array(N_OSC);
  prevWarp = new Float64Array(N_OSC);
  prevInc = new Float64Array(N_OSC);
  modGen = -1;
  subPh = 0;
  prevSub = 0;
  prevNoise = 0;
  pink = new Float64Array(6);
  fs = new Float64Array(2 * 16);
  prevG = new Float64Array(2 * 4);
  prevFMix = new Float64Array(2);
  comb: Float32Array[] = [];
  combW = new Int32Array(2);
  prevAmp = 0;
  panL = 1; // note pan (piano roll) as a balance
  panR = 1;
  rng: Rng;
  cutViz = new Float64Array(2);
  constructor(seed: number) {
    this.rng = new Rng(0x9e3779b9 ^ (seed * 2654435761));
  }
}

class HalcyonProcessor extends InstrumentProcessor {
  private ready = false;
  private T = new Float64Array(P_COUNT);
  private C = new Float64Array(P_COUNT);
  private voices: Voice[] = [];
  private counter = 0;
  private lastKey = NaN;
  private rng = new Rng(0x1234567);
  // osc config
  private oscOn = new Uint8Array(N_OSC);
  private oscUni = new Int32Array(N_OSC);
  private oscWarp = new Int32Array(N_OSC);
  private oscSrc = new Int32Array(N_OSC);
  private oscDest = new Int32Array(N_OSC);
  private oscPhase = new Float64Array(N_OSC);
  private oscRand = new Float64Array(N_OSC);
  private oscOrder = new Int32Array([0, 1, 2]);
  private oscIsSrc = new Uint8Array(N_OSC);
  private use1 = false;
  private use2 = false;
  private useD = false;
  private lfoUsed = new Uint8Array(N_LFO);
  private envUsed = new Uint8Array(N_ENV);
  private modGen = 0;
  private vizT = -1;
  private tab: (Wavetable | null)[] = [null, null, null];
  private uniOff = new Float64Array(N_OSC * MAX_UNI);
  private uniPan = new Float64Array(N_OSC * MAX_UNI);
  private uniCenter = new Uint8Array(N_OSC * MAX_UNI);
  // sub / noise
  private subOn = false;
  private subShape = 0;
  private subOct = -1;
  private subDest = 0;
  private noiseOn = false;
  private noiseType = 0;
  private noiseDest = 0;
  // filters
  private filtOn = new Uint8Array(2);
  private filtType = new Int32Array(2);
  private parallel = false;
  private combSize = 0;
  // envelopes (base values; times as log-norm for modulation)
  private eA = new Float64Array(N_ENV);
  private eH = new Float64Array(N_ENV);
  private eD = new Float64Array(N_ENV);
  private eR = new Float64Array(N_ENV);
  private eAc = new Float64Array(N_ENV);
  private eDc = new Float64Array(N_ENV);
  private eRc = new Float64Array(N_ENV);
  // lfos
  private lShape = new Int32Array(N_LFO);
  private lSync = new Uint8Array(N_LFO);
  private lRate = new Float64Array(N_LFO);
  private lBeats = new Float64Array(N_LFO);
  private lMode = new Int32Array(N_LFO);
  private lPhase = new Float64Array(N_LFO);
  private lDelay = new Float64Array(N_LFO);
  private lFade = new Float64Array(N_LFO);
  private lCustom: Float32Array[] = [0, 1, 2, 3].map(() => new Float32Array(256));
  private gPh = new Float64Array(N_LFO);
  private gVal = new Float64Array(N_LFO);
  private gHold = new Float64Array(N_LFO);
  private gPrev = new Float64Array(N_LFO);
  private gNext = new Float64Array(N_LFO);
  // mod matrix
  private modSrc = new Int32Array(MAX_MOD);
  private modDst = new Int32Array(MAX_MOD);
  private modSlot = new Int32Array(MAX_MOD);
  private modN = 0;
  private slotKey: string[] = [];
  private gSrc = new Float64Array(N_SRC);
  private gMod = new Float64Array(N_DST);
  private macroEff = new Float64Array(4);
  private macroKnob = new Float64Array(4); // knob values from the state (used when not automated)
  // voice settings
  private vMode = 0;
  private poly = 16;
  private glide = 0;
  private glideMode = 0;
  private velSens = 0.6;
  private monoVoice: Voice | null = null;
  private stackId = new Int32Array(64);
  private stackKey = new Float64Array(64);
  private stackVel = new Float64Array(64);
  private stackN = 0;
  // scratch
  private b1L = new Float32Array(CH);
  private b1R = new Float32Array(CH);
  private b2L = new Float32Array(CH);
  private b2R = new Float32Array(CH);
  private bdL = new Float32Array(CH);
  private bdR = new Float32Array(CH);
  private oL = new Float32Array(CH);
  private oR = new Float32Array(CH);
  private oscMono = new Float32Array(N_OSC * CH);
  private fa = new Int32Array(CH);
  private fb = new Int32Array(CH);
  private ff = new Float32Array(CH);
  private mixL = new Float32Array(CH);
  private mixR = new Float32Array(CH);
  private fmt = new Float64Array(6);
  // fx
  private fxOn = new Uint8Array(4);
  private distType = 0;
  private distLpL = 0;
  private distLpR = 0;
  private chL: Float32Array;
  private chR: Float32Array;
  private chW = 0;
  private chPh = 0;
  private chFbL = 0;
  private chFbR = 0;
  private dlL: Float32Array | null = null;
  private dlR: Float32Array | null = null;
  private dlW = 0;
  private dlD = 0;
  private dlBeats = 0.75;
  private dlPing = true;
  private dlLpL = 0;
  private dlLpR = 0;
  private dlHpL = 0;
  private dlHpR = 0;
  private rvLines: Float32Array[];
  private rvLen = new Int32Array(8);
  private rvLp = new Float64Array(8);
  private rvO = new Float64Array(8);
  private rvG = new Float64Array(8);
  private rvAp: Float32Array[];
  private rvApLen = new Int32Array(4);
  private rvW = 0;
  private rvMask: number;
  private apMask: number;
  private fxIdle = true;
  private dcR = 1 - (2 * Math.PI * 5) / sampleRate;
  private dcXL = 0;
  private dcYL = 0;
  private dcXR = 0;
  private dcYR = 0;
  private silent = 0;
  private fxCleared = new Uint8Array(4);

  constructor(options?: any) {
    super(options);
    for (let i = 0; i < POOL; i++) this.voices.push(new Voice(i + 1));
    const sr = sampleRate;
    const chN = pow2(Math.ceil(0.06 * sr));
    this.chL = new Float32Array(chN);
    this.chR = new Float32Array(chN);
    const rvN = pow2(Math.ceil(0.08 * sr));
    this.rvMask = rvN - 1;
    this.rvLines = [0, 1, 2, 3, 4, 5, 6, 7].map(() => new Float32Array(rvN));
    [31.3, 37.9, 41.7, 47.3, 53.9, 59.1, 67.3, 73.7].forEach((ms, i) => (this.rvLen[i] = Math.round((ms / 1000) * sr)));
    const apN = pow2(Math.ceil(0.016 * sr));
    this.apMask = apN - 1;
    this.rvAp = [0, 1, 2, 3].map(() => new Float32Array(apN));
    [4.77, 3.59, 12.73, 9.31].forEach((ms, i) => (this.rvApLen[i] = Math.round((ms / 1000) * sr)));
  }

  // ======================= state =======================
  protected onState(raw: any) {
    const s = ensureState(raw);
    const T = this.T;
    for (let o = 0; o < N_OSC; o++) {
      const os = s.osc[o];
      const b = o * PO_STRIDE;
      this.oscOn[o] = os.on ? 1 : 0;
      const wt = Math.max(0, Math.min(WT_COUNT - 1, Math.round(os.wt)));
      this.tab[o] = os.on ? getTable(wt) : null;
      const uni = Math.max(1, Math.min(MAX_UNI, Math.round(os.uni)));
      if (uni !== this.oscUni[o]) {
        this.oscUni[o] = uni;
        this.layoutUnison(o, uni);
      }
      this.oscWarp[o] = Math.max(0, Math.min(8, Math.round(os.warp)));
      this.oscSrc[o] = Math.max(0, Math.min(N_OSC - 1, Math.round(os.warpSrc)));
      this.oscDest[o] = Math.max(0, Math.min(3, Math.round(os.dest)));
      this.oscPhase[o] = clamp01(os.phase);
      this.oscRand[o] = clamp01(os.rand);
      T[b + PO_LEVEL] = clamp01(os.level);
      T[b + PO_PAN] = Math.max(-1, Math.min(1, os.pan));
      T[b + PO_FRAME] = clamp01(os.frame);
      T[b + PO_PITCH] = os.semi + os.fine / 100;
      T[b + PO_DETUNE] = clamp01(os.detune);
      T[b + PO_SPREAD] = clamp01(os.spread);
      T[b + PO_BLEND] = clamp01(os.blend);
      T[b + PO_WARP] = clamp01(os.warpAmt);
    }
    this.orderOscs();
    this.subOn = s.sub.on;
    this.subShape = s.sub.shape | 0;
    this.subOct = Math.max(-2, Math.min(0, Math.round(s.sub.oct)));
    this.subDest = s.sub.dest | 0;
    T[P_SUB_LEVEL] = clamp01(s.sub.level);
    T[P_SUB_PAN] = Math.max(-1, Math.min(1, s.sub.pan));
    this.noiseOn = s.noise.on;
    this.noiseType = s.noise.type | 0;
    this.noiseDest = s.noise.dest | 0;
    T[P_NOISE_LEVEL] = clamp01(s.noise.level);
    T[P_NOISE_PAN] = Math.max(-1, Math.min(1, s.noise.pan));
    this.parallel = s.filtMode === 1;
    let needComb = false;
    for (let f = 0; f < 2; f++) {
      const fs = s.filt[f];
      const b = P_FILT + f * PF_STRIDE;
      this.filtOn[f] = fs.on ? 1 : 0;
      const ty = Math.max(0, Math.min(FT_FORMANT, Math.round(fs.type)));
      if (ty !== this.filtType[f]) for (const v of this.voices) v.fs.fill(0, f * 16, f * 16 + 16);
      this.filtType[f] = ty;
      if (fs.on && ty === FT_COMB) needComb = true;
      T[b + PF_CUT] = cutToNorm(fs.cutoff);
      T[b + PF_RESO] = clamp01(fs.reso);
      T[b + PF_DRIVE] = clamp01(fs.drive);
      T[b + PF_KEY] = Math.max(-1, Math.min(1, fs.key));
      T[b + PF_MIX] = clamp01(fs.mix);
      T[b + PF_MORPH] = clamp01(fs.morph);
    }
    if (needComb && !this.combSize) {
      this.combSize = pow2(Math.ceil(sampleRate / 18) + 4);
      for (let vi = 0; vi < this.voices.length; vi++) {
        const v = this.voices[vi];
        v.comb = [0, 1, 2, 3].map(() => new Float32Array(this.combSize));
      }
    }
    for (let e = 0; e < N_ENV; e++) {
      const es = s.env[e];
      this.eA[e] = timeToNorm(es.a);
      this.eH[e] = Math.max(0, Math.min(20, es.h));
      this.eD[e] = timeToNorm(es.d);
      this.eR[e] = timeToNorm(es.r);
      this.eAc[e] = Math.max(-1, Math.min(1, es.ac));
      this.eDc[e] = Math.max(-1, Math.min(1, es.dc));
      this.eRc[e] = Math.max(-1, Math.min(1, es.rc));
      T[P_SUS + e] = clamp01(es.s);
    }
    for (let l = 0; l < N_LFO; l++) {
      const ls = s.lfo[l];
      this.lShape[l] = Math.max(0, Math.min(LFO_CUSTOM, Math.round(ls.shape)));
      this.lSync[l] = ls.sync ? 1 : 0;
      this.lRate[l] = Math.max(LFO_HZ_MIN, Math.min(LFO_HZ_MAX, ls.rate));
      this.lBeats[l] = (SYNC_DIVS[Math.max(0, Math.min(SYNC_DIVS.length - 1, Math.round(ls.div)))] ?? SYNC_DIVS[8])[1];
      this.lMode[l] = Math.max(0, Math.min(2, Math.round(ls.mode)));
      this.lPhase[l] = clamp01(ls.phase);
      this.lDelay[l] = Math.max(0, ls.delay);
      this.lFade[l] = Math.max(0, ls.fade);
      if (this.lShape[l] === LFO_CUSTOM) customTable(ls.pts, this.lCustom[l]);
    }
    // mod matrix
    let n = 0;
    for (let i = 0; i < s.mod.length && i < MAX_MOD; i++) {
      const m = s.mod[i];
      const si = srcIndex(m.src), di = dstIndex(m.dst);
      const key = m.src + '>' + m.dst;
      T[P_MOD + i] = Math.max(-1, Math.min(1, m.amt));
      if (this.slotKey[i] !== key) {
        this.C[P_MOD + i] = T[P_MOD + i];
        this.slotKey[i] = key;
      }
      if (si < 0 || di < 0 || m.amt === 0) continue;
      this.modSrc[n] = si;
      this.modDst[n] = di;
      this.modSlot[n] = i;
      n++;
    }
    this.modN = n;
    this.modGen++;
    this.lfoUsed.fill(0);
    this.envUsed.fill(0);
    this.envUsed[0] = 1;
    for (let k = 0; k < n; k++) {
      const si = this.modSrc[k];
      if (si < 3) this.envUsed[si] = 1;
      else if (si < 7) this.lfoUsed[si - 3] = 1;
    }
    // routing usage (which buses carry signal) and FM / RM sources
    const dests: number[] = [];
    for (let o = 0; o < N_OSC; o++) if (this.oscOn[o]) dests.push(this.oscDest[o]);
    if (this.subOn) dests.push(this.subDest);
    if (this.noiseOn) dests.push(this.noiseDest);
    this.use1 = dests.some((d) => d === 0 || d === 2);
    this.use2 = dests.some((d) => d === 1 || (d === 2 && this.parallel));
    this.useD = dests.some((d) => d === 3);
    this.oscIsSrc.fill(0);
    for (let o = 0; o < N_OSC; o++) if (this.oscOn[o] && (this.oscWarp[o] === W_FM || this.oscWarp[o] === W_RM) && this.oscSrc[o] !== o) this.oscIsSrc[this.oscSrc[o]] = 1;
    const vs = s.voice;
    this.vMode = Math.max(0, Math.min(2, Math.round(vs.mode)));
    this.poly = Math.max(1, Math.min(MAX_POLY, Math.round(vs.poly)));
    this.glide = Math.max(0, Math.min(5, vs.glide));
    this.glideMode = vs.glideMode | 0;
    this.velSens = clamp01(vs.vel);
    T[P_VOL] = Math.max(0, Math.min(1.5, vs.vol));
    const fx = s.fx;
    this.fxOn[0] = fx.dist.on ? 1 : 0;
    this.fxOn[1] = fx.chorus.on ? 1 : 0;
    this.fxOn[2] = fx.delay.on ? 1 : 0;
    this.fxOn[3] = fx.reverb.on ? 1 : 0;
    for (let i = 0; i < 4; i++) {
      T[P_FX_ON + i] = this.fxOn[i];
      if (this.fxOn[i]) this.fxCleared[i] = 0;
    }
    this.distType = fx.dist.type | 0;
    T[P_DIST_DRIVE] = clamp01(fx.dist.drive);
    T[P_DIST_TONE] = clamp01(fx.dist.tone);
    T[P_DIST_MIX] = clamp01(fx.dist.mix);
    T[P_CH_RATE] = clamp01(fx.chorus.rate);
    T[P_CH_DEPTH] = clamp01(fx.chorus.depth);
    T[P_CH_FB] = clamp01(fx.chorus.fb);
    T[P_CH_MIX] = clamp01(fx.chorus.mix);
    this.dlBeats = (DELAY_DIVS[Math.max(0, Math.min(DELAY_DIVS.length - 1, Math.round(fx.delay.div)))] ?? DELAY_DIVS[6])[1];
    this.dlPing = !!fx.delay.ping;
    T[P_DL_FB] = Math.min(0.95, clamp01(fx.delay.fb));
    T[P_DL_TONE] = clamp01(fx.delay.tone);
    T[P_DL_MIX] = clamp01(fx.delay.mix);
    if (fx.delay.on && !this.dlL) {
      const n2 = pow2(Math.ceil(4.2 * sampleRate));
      this.dlL = new Float32Array(n2);
      this.dlR = new Float32Array(n2);
    }
    T[P_RV_SIZE] = clamp01(fx.reverb.size);
    T[P_RV_DAMP] = clamp01(fx.reverb.damp);
    T[P_RV_WIDTH] = clamp01(fx.reverb.width);
    T[P_RV_MIX] = clamp01(fx.reverb.mix);
    for (let i = 0; i < 4; i++) T[P_MACRO + i] = this.macroKnob[i] = clamp01(s.macros[i]);
    if (!this.ready) {
      this.C.set(T);
      this.ready = true;
    }
  }

  /** Symmetric detune offsets −1..1, alternating stereo positions, centre voice flags. */
  private layoutUnison(o: number, uni: number) {
    const b = o * MAX_UNI;
    for (let k = 0; k < MAX_UNI; k++) {
      const u = uni === 1 ? 0 : -1 + (2 * k) / (uni - 1);
      const j = Math.min(k, uni - 1 - k);
      this.uniOff[b + k] = u;
      this.uniPan[b + k] = u * (j & 1 ? -1 : 1);
      const mid = (uni - 1) / 2;
      this.uniCenter[b + k] = uni === 1 || Math.abs(k - mid) < 0.6 ? 1 : 0;
    }
  }

  /** FM / RM sources must render before the osc that reads them. */
  private orderOscs() {
    const dep = [0, 1, 2].map((o) => (this.oscOn[o] && (this.oscWarp[o] === W_FM || this.oscWarp[o] === W_RM) && this.oscSrc[o] !== o ? this.oscSrc[o] : -1));
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    for (const p of perms) {
      let ok = true;
      for (let o = 0; o < 3; o++) if (dep[o] >= 0 && p.indexOf(dep[o]) > p.indexOf(o)) ok = false;
      if (ok) {
        this.oscOrder.set(p);
        return;
      }
    }
    this.oscOrder.set([0, 1, 2]);
  }

  // ======================= notes =======================
  private notePan = 0;
  protected noteOn(id: number, key: number, vel: number, pan = 0) {
    if (!this.ready) return;
    this.notePan = pan;
    this.fxIdle = false;
    this.silent = 0;
    if (this.vMode !== 0) return this.monoOn(id, key, vel);
    let count = 0;
    let anyHeld = false;
    for (let vi = 0; vi < this.voices.length; vi++) {
      const v = this.voices[vi];
      if (v.active && !v.fading) {
        count++;
        if (v.gate) anyHeld = true;
      }
    }
    while (count >= this.poly) {
      let pick: Voice | null = null;
      for (let vi = 0; vi < this.voices.length; vi++) {
        const v = this.voices[vi];
        if (!v.active || v.fading) continue;
        if (!pick) pick = v;
        else if (pick.gate && !v.gate) pick = v;
        else if (pick.gate === v.gate && v.order < pick.order) pick = v;
      }
      if (!pick) break;
      this.fadeOut(pick, 0.004);
      count--;
    }
    const glideFrom = this.glide > 0 && !isNaN(this.lastKey) && (this.glideMode === 0 || anyHeld) ? this.lastKey : NaN;
    this.startVoice(this.allocVoice(), id, key, vel, glideFrom);
    this.lastKey = key;
  }

  private allocVoice(): Voice {
    let best: Voice | null = null;
    for (let vi = 0; vi < this.voices.length; vi++) {
      const v = this.voices[vi];
      if (!v.active) return v;
      if (v.fading && (!best || v.fade < best.fade)) best = v;
    }
    if (best) return best;
    let old = this.voices[0];
    for (let vi = 0; vi < this.voices.length; vi++) {
      const v = this.voices[vi];
      if (v.order < old.order) old = v;
    }
    return old;
  }

  private startVoice(v: Voice, id: number, key: number, vel: number, from: number) {
    v.active = true;
    v.id = id;
    v.key = key;
    v.vel = vel;
    v.order = ++this.counter;
    v.gate = true;
    v.fading = false;
    v.fade = 1;
    v.first = true;
    v.time = 0;
    v.pitch = isNaN(from) ? key : from;
    v.glideRate = this.glide > 0 ? Math.abs(key - v.pitch) / this.glide : 0;
    v.rand = v.rng.bi();
    v.prevAmp = 0;
    const np = this.notePan;
    v.panL = np > 0 ? Math.cos(np * 1.5707963267948966) : 1;
    v.panR = np < 0 ? Math.cos(-np * 1.5707963267948966) : 1;
    for (let e = 0; e < N_ENV; e++) {
      v.eStage[e] = E_ATT;
      v.eT[e] = 0;
      v.eLvl[e] = 0;
      v.eStart[e] = 0;
    }
    for (let l = 0; l < N_LFO; l++) {
      v.lPh[l] = this.lPhase[l];
      v.lHold[l] = v.rng.bi();
      v.lPrev[l] = v.rng.bi();
      v.lNext[l] = v.rng.bi();
      v.lVal[l] = 0;
    }
    for (let o = 0; o < N_OSC; o++)
      for (let u = 0; u < MAX_UNI; u++) {
        const p = this.oscPhase[o] + this.oscRand[o] * v.rng.next();
        v.ph[o * MAX_UNI + u] = p - Math.floor(p);
      }
    v.subPh = 0;
    v.mod.fill(0);
    v.fs.fill(0);
    v.pink.fill(0);
    if (v.comb.length) {
      for (const c of v.comb) c.fill(0);
    }
  }

  private release(v: Voice) {
    v.gate = false;
    for (let e = 0; e < N_ENV; e++) {
      if (v.eStage[e] === E_IDLE) continue;
      v.eStart[e] = v.eLvl[e];
      v.eStage[e] = E_REL;
      v.eT[e] = 0;
    }
  }

  private fadeOut(v: Voice, sec: number) {
    v.fading = true;
    v.gate = false;
    v.fadeStep = 1 / Math.max(1, sec * sampleRate);
  }

  private monoOn(id: number, key: number, vel: number) {
    if (this.stackN >= 64) {
      this.stackId.copyWithin(0, 1);
      this.stackKey.copyWithin(0, 1);
      this.stackVel.copyWithin(0, 1);
      this.stackN--;
    }
    this.stackId[this.stackN] = id;
    this.stackKey[this.stackN] = key;
    this.stackVel[this.stackN] = vel;
    this.stackN++;
    const v = this.monoVoice;
    if (v && v.active && !v.fading) {
      const legato = v.gate;
      const glide = this.glide > 0 && (this.glideMode === 0 || legato);
      v.id = id;
      v.key = key;
      v.vel = vel;
      if (glide) v.glideRate = Math.abs(key - v.pitch) / this.glide;
      else v.pitch = key;
      if (this.vMode === 1 || !legato) {
        for (let e = 0; e < N_ENV; e++) {
          v.eStart[e] = v.eLvl[e];
          v.eStage[e] = E_ATT;
          v.eT[e] = 0;
        }
        if (!legato) for (let l = 0; l < N_LFO; l++) v.lPh[l] = this.lPhase[l];
      }
      v.gate = true;
    } else {
      const nv = this.allocVoice();
      const from = this.glide > 0 && this.glideMode === 0 && !isNaN(this.lastKey) ? this.lastKey : NaN;
      this.startVoice(nv, id, key, vel, from);
      this.monoVoice = nv;
    }
    this.lastKey = key;
  }

  private stackRemove(id: number) {
    for (let i = 0; i < this.stackN; i++)
      if (this.stackId[i] === id) {
        this.stackId.copyWithin(i, i + 1, this.stackN);
        this.stackKey.copyWithin(i, i + 1, this.stackN);
        this.stackVel.copyWithin(i, i + 1, this.stackN);
        this.stackN--;
        return;
      }
  }

  protected noteOff(id: number) {
    if (this.vMode !== 0) {
      this.stackRemove(id);
      const v = this.monoVoice;
      if (!v || !v.active || v.id !== id) return;
      if (this.stackN > 0) {
        const k = this.stackKey[this.stackN - 1];
        v.id = this.stackId[this.stackN - 1];
        v.key = k;
        if (this.glide > 0) v.glideRate = Math.abs(k - v.pitch) / this.glide;
        else v.pitch = k;
        this.lastKey = k;
      } else this.release(v);
      return;
    }
    for (let vi = 0; vi < this.voices.length; vi++) {
      const v = this.voices[vi];
      if (v.active && v.id === id && !v.fading && v.gate) this.release(v);
    }
  }

  protected kill(id: number) {
    this.stackRemove(id);
    for (let vi = 0; vi < this.voices.length; vi++) {
      const v = this.voices[vi];
      if (v.active && v.id === id && !v.fading) this.fadeOut(v, 0.005);
    }
  }

  protected allOff(hard: boolean) {
    this.stackN = 0;
    for (let vi = 0; vi < this.voices.length; vi++) {
      const v = this.voices[vi];
      if (!v.active) continue;
      if (hard) {
        if (!v.fading) this.fadeOut(v, 0.003);
      } else if (v.gate && !v.fading) this.release(v);
    }
  }

  // ======================= render =======================
  protected render(out: Float32Array[], from: number, to: number, macros: number[]) {
    if (!this.ready) return;
    // playlist automation (>= 0) replaces the knob value; negative = not automated
    for (let i = 0; i < 4; i++) {
      const m = macros[i] ?? -1;
      this.T[P_MACRO + i] = m >= 0 ? clamp01(m) : this.macroKnob[i];
      this.T[P_MACRO_IN + i] = 0;
    }
    let pos = from;
    while (pos < to) {
      const n = Math.min(CH, to - pos);
      this.block(out, pos, n);
      pos += n;
    }
  }

  private block(out: Float32Array[], off: number, n: number) {
    const sr = sampleRate;
    const dt = n / sr;
    // parameter smoothing (~12 ms)
    const a = 1 - Math.exp(-dt / 0.012);
    const T = this.T, C = this.C;
    for (let i = 0; i < P_COUNT; i++) {
      const d = T[i] - C[i];
      C[i] = d > 1e-7 || d < -1e-7 ? C[i] + d * a : T[i];
    }
    // macro = knob value + playlist automation
    for (let i = 0; i < 4; i++) this.macroEff[i] = clamp01(C[P_MACRO + i] + C[P_MACRO_IN + i]);

    // global modulation (FX mixes, free-running LFO rates): newest voice's sources + macros
    const nv = this.newest();
    const gs = this.gSrc;
    for (let i = 0; i < N_SRC; i++) gs[i] = nv ? nv.src[i] : 0;
    for (let l = 0; l < N_LFO; l++) if (this.lMode[l] === 1) gs[3 + l] = this.gVal[l];
    for (let i = 0; i < 4; i++) gs[S_MACRO + i] = this.macroEff[i];
    const gm = this.gMod;
    gm.fill(0);
    for (let k = 0; k < this.modN; k++) gm[this.modDst[k]] += C[P_MOD + this.modSlot[k]] * gs[this.modSrc[k]];
    this.globalLfos(dt);

    const mL = this.mixL, mR = this.mixR;
    mL.fill(0, 0, n);
    mR.fill(0, 0, n);
    let active = 0;
    for (let vi = 0; vi < this.voices.length; vi++) {
      const v = this.voices[vi];
      if (!v.active) continue;
      active++;
      this.voiceBlock(v, n, dt);
    }

    // FX (skipped once everything has decayed to silence)
    if (!this.fxIdle) {
      this.fx(n);
      if (active === 0) {
        let pk = 0;
        for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(mL[i]), Math.abs(mR[i]));
        if (pk < 1e-5) {
          this.silent += n;
          if (this.silent > 5 * sr) {
            this.fxIdle = true;
            this.clearFx();
          }
        } else this.silent = 0;
      } else this.silent = 0;
    }
    if (this.fxIdle && active === 0) return;
    // master volume + DC blocker (~5 Hz)
    const L = out[0], R = out[1] ?? out[0];
    const g = C[P_VOL] * C[P_VOL] * 2;
    const rc = this.dcR;
    let xl = this.dcXL, yl = this.dcYL, xr = this.dcXR, yr = this.dcYR;
    for (let i = 0; i < n; i++) {
      const il = mL[i] * g, ir = mR[i] * g;
      yl = il - xl + rc * yl;
      xl = il;
      yr = ir - xr + rc * yr;
      xr = ir;
      L[off + i] += yl;
      R[off + i] += yr;
    }
    this.dcXL = xl;
    this.dcYL = Math.abs(yl) < 1e-20 ? 0 : yl;
    this.dcXR = xr;
    this.dcYR = Math.abs(yr) < 1e-20 ? 0 : yr;
  }

  private newest(): Voice | null {
    let best: Voice | null = null;
    for (let vi = 0; vi < this.voices.length; vi++) {
      const v = this.voices[vi];
      if (v.active && !v.fading && (!best || v.order > best.order)) best = v;
    }
    return best;
  }

  private lfoHz(l: number, m: number) {
    let hz = this.lSync[l] ? this.bpm / 60 / this.lBeats[l] : this.lRate[l];
    if (m !== 0) hz *= Math.exp(m * 6 * LN2);
    return hz;
  }

  private lfoShapeVal(l: number, ph: number, hold: number, prev: number, next: number) {
    const sh = this.lShape[l];
    if (sh <= 4) return lfoBasic(sh, ph);
    if (sh === LFO_SH) return hold;
    if (sh === LFO_SMOOTH) return prev + (next - prev) * (0.5 - 0.5 * Math.cos(Math.PI * ph));
    const t = this.lCustom[l];
    const x = ph * 255;
    const i = x | 0;
    const fr = x - i;
    return t[i] + (t[i < 255 ? i + 1 : 255] - t[i]) * fr;
  }

  private globalLfos(dt: number) {
    for (let l = 0; l < N_LFO; l++) {
      if (this.lMode[l] !== 1) continue;
      let ph = this.gPh[l] + this.lfoHz(l, this.gMod[D_LFO_RATE + l]) * dt;
      if (ph >= 1) {
        ph -= Math.floor(ph);
        this.gHold[l] = this.rng.bi();
        this.gPrev[l] = this.gNext[l];
        this.gNext[l] = this.rng.bi();
      }
      this.gPh[l] = ph;
      let p = ph + this.lPhase[l];
      p -= Math.floor(p);
      this.gVal[l] = this.lfoShapeVal(l, p, this.gHold[l], this.gPrev[l], this.gNext[l]);
    }
  }

  private envAdvance(v: Voice, e: number, dt: number) {
    let st = v.eStage[e];
    let t = v.eT[e] + dt;
    const md = v.mod;
    const S = this.C[P_SUS + e];
    let lvl = 0;
    for (let guard = 0; guard < 6; guard++) {
      if (st === E_ATT) {
        const A = T_MIN * Math.exp(clamp01(this.eA[e] + md[D_ENV + e * 3]) * T_LN);
        if (t >= A) {
          t -= A;
          st = E_HOLD;
          continue;
        }
        const s0 = v.eStart[e];
        lvl = s0 + (1 - s0) * envCurve(t / A, this.eAc[e]);
      } else if (st === E_HOLD) {
        if (t >= this.eH[e]) {
          t -= this.eH[e];
          st = E_DEC;
          continue;
        }
        lvl = 1;
      } else if (st === E_DEC) {
        const D = T_MIN * Math.exp(clamp01(this.eD[e] + md[D_ENV + e * 3 + 1]) * T_LN);
        if (t >= D) {
          st = E_SUS;
          lvl = S;
        } else lvl = 1 - (1 - S) * envCurve(t / D, this.eDc[e]);
      } else if (st === E_SUS) lvl = S;
      else if (st === E_REL) {
        const R = T_MIN * Math.exp(clamp01(this.eR[e] + md[D_ENV + e * 3 + 2]) * T_LN);
        if (t >= R) {
          st = E_IDLE;
          lvl = 0;
        } else lvl = v.eStart[e] * (1 - envCurve(t / R, this.eRc[e]));
      } else lvl = 0;
      break;
    }
    v.eStage[e] = st;
    v.eT[e] = t;
    v.eLvl[e] = lvl;
  }

  private lfoAdvance(v: Voice, l: number, dt: number) {
    let val: number;
    const mode = this.lMode[l];
    if (mode === 1) val = this.gVal[l];
    else {
      let ph = v.lPh[l] + this.lfoHz(l, v.mod[D_LFO_RATE + l]) * dt;
      if (ph >= 1) {
        if (mode === 2) ph = 0.99999;
        else {
          ph -= Math.floor(ph);
          v.lHold[l] = v.rng.bi();
          v.lPrev[l] = v.lNext[l];
          v.lNext[l] = v.rng.bi();
        }
      }
      v.lPh[l] = ph;
      val = this.lfoShapeVal(l, ph, v.lHold[l], v.lPrev[l], v.lNext[l]);
    }
    const d = this.lDelay[l], f = this.lFade[l];
    if (d > 0 || f > 0) {
      const t = v.time - d;
      val *= t <= 0 ? 0 : f > 0 ? Math.min(1, t / f) : 1;
    }
    v.lVal[l] = val;
  }

  private voiceBlock(v: Voice, n: number, dt: number) {
    const C = this.C;
    v.time += dt;
    if (v.pitch !== v.key) {
      const step = v.glideRate * dt;
      const d = v.key - v.pitch;
      if (v.glideRate <= 0 || Math.abs(d) <= step) v.pitch = v.key;
      else v.pitch += d > 0 ? step : -step;
    }
    const viz = currentTime - this.vizT < 0.25;
    this.envAdvance(v, 0, dt);
    for (let e = 1; e < N_ENV; e++) if (this.envUsed[e] || viz) this.envAdvance(v, e, dt);
    for (let l = 0; l < N_LFO; l++) if (this.lfoUsed[l] || viz) this.lfoAdvance(v, l, dt);
    // sources
    const src = v.src;
    src[0] = v.eLvl[0];
    src[1] = v.eLvl[1];
    src[2] = v.eLvl[2];
    for (let l = 0; l < N_LFO; l++) src[3 + l] = v.lVal[l];
    src[S_VEL] = v.vel;
    src[S_NOTE] = Math.max(-1, Math.min(1, (v.key - 60) / 60));
    src[S_RAND] = v.rand;
    for (let i = 0; i < 4; i++) src[S_MACRO + i] = this.macroEff[i];
    const md = v.mod;
    if (v.modGen !== this.modGen) {
      md.fill(0);
      v.modGen = this.modGen;
    } else for (let k = 0; k < this.modN; k++) md[this.modDst[k]] = 0;
    for (let k = 0; k < this.modN; k++) md[this.modDst[k]] += C[P_MOD + this.modSlot[k]] * src[this.modSrc[k]];

    // ---- sources → buses ----
    const b1L = this.b1L, b1R = this.b1R, b2L = this.b2L, b2R = this.b2R, dL = this.bdL, dR = this.bdR;
    const use1 = this.use1, use2 = this.use2, useD = this.useD;
    if (use1) {
      b1L.fill(0, 0, n);
      b1R.fill(0, 0, n);
    }
    if (use2) {
      b2L.fill(0, 0, n);
      b2R.fill(0, 0, n);
    }
    if (useD) {
      dL.fill(0, 0, n);
      dR.fill(0, 0, n);
    }
    for (let o = 0; o < N_OSC; o++) if (this.oscIsSrc[o]) this.oscMono.fill(0, o * CH, o * CH + CH);
    for (let k = 0; k < N_OSC; k++) {
      const o = this.oscOrder[k];
      if (this.oscOn[o] && this.tab[o]) this.renderOsc(v, o, n);
    }
    if (this.subOn) this.renderSub(v, n);
    if (this.noiseOn) this.renderNoise(v, n);

    // ---- filters ----
    let pL: Float32Array | null = null, pR: Float32Array | null = null; // main output
    let qL: Float32Array | null = null, qR: Float32Array | null = null; // 2nd parallel output
    if (this.parallel) {
      if (use1) {
        if (this.filtOn[0]) this.runFilter(v, 0, b1L, b1R, n);
        pL = b1L;
        pR = b1R;
      }
      if (use2) {
        if (this.filtOn[1]) this.runFilter(v, 1, b2L, b2R, n);
        if (pL) {
          qL = b2L;
          qR = b2R;
        } else {
          pL = b2L;
          pR = b2R;
        }
      }
    } else {
      if (use1 && this.filtOn[0]) this.runFilter(v, 0, b1L, b1R, n);
      if (use1 && use2)
        for (let i = 0; i < n; i++) {
          b2L[i] += b1L[i];
          b2R[i] += b1R[i];
        }
      if (use2) {
        pL = b2L;
        pR = b2R;
      } else if (use1) {
        pL = b1L;
        pR = b1R;
      }
      if (pL && pR && this.filtOn[1]) this.runFilter(v, 1, pL, pR, n);
    }

    // ---- amp ----
    let amp = v.eLvl[0] * (1 - this.velSens + this.velSens * v.vel) * OUT;
    const master = 1 + md[D_MASTER];
    amp *= master < 0 ? 0 : master > 2 ? 2 : master;
    let done = v.eStage[0] === E_IDLE;
    if (v.fading) {
      v.fade -= v.fadeStep * n;
      if (v.fade <= 0) {
        v.fade = 0;
        done = true;
      }
      amp *= v.fade;
    }
    if (done) amp = 0;
    const a0 = v.prevAmp, da = (amp - a0) / n;
    const mL = this.mixL, mR = this.mixR;
    const bl = v.panL, br = v.panR;
    if (pL && pR) {
      if (qL && qR)
        for (let i = 0; i < n; i++) {
          const g = a0 + da * (i + 1);
          mL[i] += (pL[i] + qL[i]) * g * bl;
          mR[i] += (pR[i] + qR[i]) * g * br;
        }
      else
        for (let i = 0; i < n; i++) {
          const g = a0 + da * (i + 1);
          mL[i] += pL[i] * g * bl;
          mR[i] += pR[i] * g * br;
        }
    }
    if (useD)
      for (let i = 0; i < n; i++) {
        const g = a0 + da * (i + 1);
        mL[i] += dL[i] * g * bl;
        mR[i] += dR[i] * g * br;
      }
    v.prevAmp = amp;
    v.first = false;
    if (done) {
      v.active = false;
      v.fading = false;
      if (this.monoVoice === v) this.monoVoice = null;
    }
  }

  /** Add `x` into the routing buses for destination `dest`. */
  private route(dest: number, xl: Float32Array, xr: Float32Array, n: number, g0: number, g1: number) {
    const dg = (g1 - g0) / n;
    const to1 = dest === 0 || dest === 2;
    const to2 = dest === 1 || (dest === 2 && this.parallel);
    if (dest === 3) {
      const L = this.bdL, R = this.bdR;
      for (let i = 0; i < n; i++) {
        const g = g0 + dg * (i + 1);
        L[i] += xl[i] * g;
        R[i] += xr[i] * g;
      }
      return;
    }
    if (to1) {
      const L = this.b1L, R = this.b1R;
      for (let i = 0; i < n; i++) {
        const g = g0 + dg * (i + 1);
        L[i] += xl[i] * g;
        R[i] += xr[i] * g;
      }
    }
    if (to2) {
      const L = this.b2L, R = this.b2R;
      for (let i = 0; i < n; i++) {
        const g = g0 + dg * (i + 1);
        L[i] += xl[i] * g;
        R[i] += xr[i] * g;
      }
    }
  }

  private renderOsc(v: Voice, o: number, n: number) {
    const C = this.C, md = v.mod;
    const b = o * PO_STRIDE, d = D_OSC + o * 6;
    const sr = sampleRate;
    const semis = v.pitch + C[b + PO_PITCH] + (md[d] + md[D_PITCH]) * PITCH_MOD_RANGE;
    let incE = (440 * Math.exp(((semis - 69) / 12) * LN2)) / sr;
    if (incE > 0.45) incE = 0.45;
    const incS = v.first ? incE : v.prevInc[o];
    v.prevInc[o] = incE;
    const F1 = WT_FRAMES - 1;
    const fiE = clamp01(C[b + PO_FRAME] + md[d + 2]) * F1;
    const fiS = v.first ? fiE : v.prevFrame[o];
    v.prevFrame[o] = fiE;
    const lvE = clamp01(C[b + PO_LEVEL] + md[d + 1]);
    const lvS = v.first ? lvE : v.prevLevel[o];
    v.prevLevel[o] = lvE;
    const waE = clamp01(C[b + PO_WARP] + md[d + 5]);
    const waS = v.first ? waE : v.prevWarp[o];
    v.prevWarp[o] = waE;
    let pan = C[b + PO_PAN] + md[d + 3];
    pan = pan < -1 ? -1 : pan > 1 ? 1 : pan;
    const det = clamp01(C[b + PO_DETUNE] + md[d + 4]);
    const spread = C[b + PO_SPREAD], blend = C[b + PO_BLEND];
    const warp = this.oscWarp[o];
    const uni = this.oscUni[o];
    const detC = 100 * det * det;
    // band-limit: pick the mip level from the fastest unison voice
    let sEff = (incE > incS ? incE : incS) * (1 + (uni > 1 ? detC : 0) * 0.000578) * WT_SIZE;
    if (warp === W_SYNC) sEff *= 1 + (waE > waS ? waE : waS) * 7;
    let lvl = 0;
    if (sEff > 1.2) {
      lvl = Math.ceil(Math.log2(sEff / 1.2));
      if (lvl > 10) lvl = 10;
    }
    const size = MIP_SIZE[lvl], mask = size - 1;
    const tab = this.tab[o]!.levels[lvl];
    const fa = this.fa, fb = this.fb, ff = this.ff;
    const moving = fiS !== fiE;
    const i0c = fiE | 0;
    const A0 = i0c * size, B0 = (i0c < F1 ? i0c + 1 : F1) * size, FF = fiE - i0c;
    if (moving || warp !== W_NONE) {
      const dfi = (fiE - fiS) / n;
      for (let i = 0; i < n; i++) {
        const f = fiS + dfi * (i + 1);
        const i0 = f | 0;
        fa[i] = i0 * size;
        fb[i] = (i0 < F1 ? i0 + 1 : F1) * size;
        ff[i] = f - i0;
      }
    }
    // unison weights
    let wsum = 0;
    for (let u = 0; u < uni; u++) {
      const w = this.uniCenter[o * MAX_UNI + u] ? 1 : blend;
      wsum += w * w;
    }
    const norm = wsum > 1e-9 ? 1 / Math.sqrt(wsum) : 0;
    const oL = this.oL, oR = this.oR;
    oL.fill(0, 0, n);
    oR.fill(0, 0, n);
    const fm = this.oscMono;
    const fmOff = this.oscSrc[o] * CH;
    const dwa = (waE - waS) / n;
    for (let u = 0; u < uni; u++) {
      const ui = o * MAX_UNI + u;
      const uo = this.uniOff[ui];
      const ratio = uo === 0 ? 1 : Math.exp(((detC * uo) / 1200) * LN2);
      let uinc = incS * ratio;
      const duinc = ((incE - incS) * ratio) / n;
      const w = (this.uniCenter[ui] ? 1 : blend) * norm;
      let ph = v.ph[ui];
      if (w === 0) {
        ph += (uinc + duinc * 0.5 * n) * n;
        v.ph[ui] = ph - Math.floor(ph);
        continue;
      }
      let p = pan + spread * this.uniPan[ui];
      p = p < -1 ? -1 : p > 1 ? 1 : p;
      const gl = w * (p > 0 ? 1 - p : 1), gr = w * (p < 0 ? 1 + p : 1);
      if (warp === W_NONE && !moving && FF === 0) {
        // single static frame: 2 reads / sample
        for (let i = 0; i < n; i++) {
          const pos = ph * size;
          let ip = pos | 0;
          const fr = pos - ip;
          ip &= mask;
          const x0 = tab[A0 + ip];
          const s = x0 + fr * (tab[A0 + ((ip + 1) & mask)] - x0);
          oL[i] += s * gl;
          oR[i] += s * gr;
          ph += uinc;
          uinc += duinc;
          if (ph >= 1) ph -= 1;
        }
      } else if (warp === W_NONE && !moving) {
        for (let i = 0; i < n; i++) {
          const pos = ph * size;
          let ip = pos | 0;
          const fr = pos - ip;
          ip &= mask;
          const ip2 = (ip + 1) & mask;
          const x0 = tab[A0 + ip], y0 = tab[B0 + ip];
          const xa = x0 + fr * (tab[A0 + ip2] - x0);
          const s = xa + FF * (y0 + fr * (tab[B0 + ip2] - y0) - xa);
          oL[i] += s * gl;
          oR[i] += s * gr;
          ph += uinc;
          uinc += duinc;
          if (ph >= 1) ph -= 1;
        }
      } else if (warp === W_NONE) {
        for (let i = 0; i < n; i++) {
          const pos = ph * size;
          let ip = pos | 0;
          const fr = pos - ip;
          ip &= mask;
          const ip2 = (ip + 1) & mask;
          const A = fa[i], B = fb[i];
          const x0 = tab[A + ip], y0 = tab[B + ip];
          const xa = x0 + fr * (tab[A + ip2] - x0);
          const s = xa + ff[i] * (y0 + fr * (tab[B + ip2] - y0) - xa);
          oL[i] += s * gl;
          oR[i] += s * gr;
          ph += uinc;
          uinc += duinc;
          if (ph >= 1) ph -= 1;
        }
      } else {
        for (let i = 0; i < n; i++) {
          const wa = waS + dwa * (i + 1);
          let q = ph;
          switch (warp) {
            case W_BENDP: {
              const c = wa * 8;
              q = (q * (1 + c)) / (1 + c * q);
              break;
            }
            case W_BENDM: {
              const c = wa * 8;
              q = q / (1 + c * (1 - q));
              break;
            }
            case W_SQUEEZE: {
              const c = wa * 8;
              const x = 2 * q - 1;
              const ax = x < 0 ? -x : x;
              const y = (ax * (1 + c)) / (1 + c * ax);
              q = 0.5 + 0.5 * (x < 0 ? -y : y);
              break;
            }
            case W_SYNC:
              q = q * (1 + wa * 7);
              q -= Math.floor(q);
              break;
            case W_MIRROR: {
              const m = q < 0.5 ? 2 * q : 2 - 2 * q;
              q += wa * (m - q);
              break;
            }
            case W_FM:
              q += wa * 1.5 * fm[fmOff + i];
              q -= Math.floor(q);
              break;
          }
          const pos = q * size;
          let ip = pos | 0;
          const fr = pos - ip;
          ip &= mask;
          const ip2 = (ip + 1) & mask;
          const A = fa[i], B = fb[i];
          const x0 = tab[A + ip], y0 = tab[B + ip];
          const xa = x0 + fr * (tab[A + ip2] - x0);
          let s = xa + ff[i] * (y0 + fr * (tab[B + ip2] - y0) - xa);
          if (warp === W_QUANT) {
            const L = 2 + (1 - wa) * (1 - wa) * 126;
            s = Math.floor(s * L + 0.5) / L;
          } else if (warp === W_RM) s *= 1 - wa + wa * fm[fmOff + i];
          oL[i] += s * gl;
          oR[i] += s * gr;
          ph += uinc;
          uinc += duinc;
          if (ph >= 1) ph -= 1;
        }
      }
      v.ph[ui] = ph;
    }
    if (this.oscIsSrc[o]) {
      const mono = this.oscMono, mo = o * CH;
      for (let i = 0; i < n; i++) mono[mo + i] = (oL[i] + oR[i]) * 0.5;
    }
    this.route(this.oscDest[o], oL, oR, n, lvS, lvE);
  }

  private renderSub(v: Voice, n: number) {
    const C = this.C;
    const lvE = clamp01(C[P_SUB_LEVEL] + v.mod[D_SUB]);
    const lvS = v.first ? lvE : v.prevSub;
    v.prevSub = lvE;
    const semis = v.pitch + this.subOct * 12 + v.mod[D_PITCH] * PITCH_MOD_RANGE;
    let inc = (440 * Math.exp(((semis - 69) / 12) * LN2)) / sampleRate;
    if (inc > 0.45) inc = 0.45;
    const pan = C[P_SUB_PAN];
    const gl = pan > 0 ? 1 - pan : 1, gr = pan < 0 ? 1 + pan : 1;
    const oL = this.oL, oR = this.oR;
    let ph = v.subPh;
    const sh = this.subShape;
    for (let i = 0; i < n; i++) {
      let s: number;
      if (sh === 0) s = Math.sin(ph * 6.283185307179586);
      else if (sh === 1) s = 1 - 4 * Math.abs(ph - 0.5);
      else {
        s = ph < 0.5 ? 1 : -1;
        // polyBLEP at both edges
        let t = ph;
        if (t < inc) {
          t /= inc;
          s += t + t - t * t - 1;
        } else if (t > 1 - inc) {
          t = (t - 1) / inc;
          s += t * t + t + t + 1;
        }
        t = ph + 0.5;
        if (t >= 1) t -= 1;
        if (t < inc) {
          t /= inc;
          s -= t + t - t * t - 1;
        } else if (t > 1 - inc) {
          t = (t - 1) / inc;
          s -= t * t + t + t + 1;
        }
        s *= 0.8;
      }
      oL[i] = s * gl;
      oR[i] = s * gr;
      ph += inc;
      if (ph >= 1) ph -= 1;
    }
    v.subPh = ph;
    this.route(this.subDest, oL, oR, n, lvS, lvE);
  }

  private renderNoise(v: Voice, n: number) {
    const C = this.C;
    const lvE = clamp01(C[P_NOISE_LEVEL] + v.mod[D_NOISE]);
    const lvS = v.first ? lvE : v.prevNoise;
    v.prevNoise = lvE;
    const pan = C[P_NOISE_PAN];
    const gl = pan > 0 ? 1 - pan : 1, gr = pan < 0 ? 1 + pan : 1;
    const oL = this.oL, oR = this.oR;
    const r = v.rng;
    const pk = v.pink;
    for (let i = 0; i < n; i++) {
      let a = r.bi(), b = r.bi();
      if (this.noiseType === 1) {
        pk[0] = 0.99765 * pk[0] + a * 0.099046;
        pk[1] = 0.963 * pk[1] + a * 0.2965164;
        pk[2] = 0.57 * pk[2] + a * 1.0526913;
        a = (pk[0] + pk[1] + pk[2] + a * 0.1848) * 0.28;
        pk[3] = 0.99765 * pk[3] + b * 0.099046;
        pk[4] = 0.963 * pk[4] + b * 0.2965164;
        pk[5] = 0.57 * pk[5] + b * 1.0526913;
        b = (pk[3] + pk[4] + pk[5] + b * 0.1848) * 0.28;
      } else {
        a *= 0.6;
        b *= 0.6;
      }
      oL[i] = a * gl;
      oR[i] = b * gr;
    }
    this.route(this.noiseDest, oL, oR, n, lvS, lvE);
  }

  // ---------------- filters ----------------
  private runFilter(v: Voice, f: number, L: Float32Array, R: Float32Array, n: number) {
    const C = this.C, md = v.mod;
    const sr = sampleRate;
    const pb = P_FILT + f * PF_STRIDE, dd = D_FILT + f * 5;
    const cutN = C[pb + PF_CUT] + (C[pb + PF_KEY] * (v.pitch - 60)) / 12 / CUT_OCT + md[dd];
    v.cutViz[f] = cutN;
    const reso = clamp01(C[pb + PF_RESO] + md[dd + 1]);
    const drive = clamp01(C[pb + PF_DRIVE] + md[dd + 2]);
    const mixE = clamp01(C[pb + PF_MIX] + md[dd + 3]);
    const morph = clamp01(C[pb + PF_MORPH] + md[dd + 4]);
    const mixS = v.first ? mixE : v.prevFMix[f];
    v.prevFMix[f] = mixE;
    const dmix = (mixE - mixS) / n;
    const type = this.filtType[f];
    const st = v.fs, so = f * 16, pg = f * 4;
    const nyq = 0.45 * sr;
    const dg = 1 + drive * 15;
    const dc = 1 / Math.sqrt(dg);
    const useDrive = drive > 0.001;

    if (type === FT_COMB) {
      let fc = normToCut(cutN);
      if (fc > sr / 3) fc = sr / 3;
      const DE = sr / fc;
      const DS = v.first ? DE : v.prevG[pg];
      v.prevG[pg] = DE;
      const dD = (DE - DS) / n;
      const fbk = combFb(reso) * (1 - 2 * morph);
      const nrm = Math.pow(1 - Math.abs(fbk), 0.5) * 1.4;
      const bl = v.comb[f * 2], br = v.comb[f * 2 + 1];
      if (!bl) return;
      const m = this.combSize - 1;
      let w = v.combW[f];
      let lpl = st[so], lpr = st[so + 1];
      for (let i = 0; i < n; i++) {
        const D = DS + dD * (i + 1);
        const rp = w - D;
        let ri = Math.floor(rp);
        const fr = rp - ri;
        ri &= m;
        const ri2 = (ri + 1) & m;
        const dl = bl[ri] + fr * (bl[ri2] - bl[ri]);
        const dr = br[ri] + fr * (br[ri2] - br[ri]);
        lpl += (dl - lpl) * 0.7;
        lpr += (dr - lpr) * 0.7;
        let xl = L[i], xr = R[i];
        const inl = useDrive ? fastTanh(xl * dg) * dc : xl;
        const inr = useDrive ? fastTanh(xr * dg) * dc : xr;
        const yl = inl + fbk * lpl, yr = inr + fbk * lpr;
        bl[w] = fastTanh(yl);
        br[w] = fastTanh(yr);
        w = (w + 1) & m;
        const mx = mixS + dmix * (i + 1);
        L[i] = xl + mx * (yl * nrm - xl);
        R[i] = xr + mx * (yr * nrm - xr);
      }
      v.combW[f] = w;
      st[so] = lpl + 1e-20;
      st[so + 1] = lpr + 1e-20;
      return;
    }

    if (type === FT_FORMANT) {
      const fm = this.fmt;
      formantSet(morph, fm);
      const sh = formantShift(cutN);
      const k = 1 / formantQ(reso);
      let g0e = 0, g1e = 0, g2e = 0;
      {
        const f0 = Math.min(nyq, fm[0] * sh), f1 = Math.min(nyq, fm[1] * sh), f2 = Math.min(nyq, fm[2] * sh);
        g0e = Math.tan((Math.PI * f0) / sr);
        g1e = Math.tan((Math.PI * f1) / sr);
        g2e = Math.tan((Math.PI * f2) / sr);
      }
      const g0s = v.first ? g0e : v.prevG[pg], g1s = v.first ? g1e : v.prevG[pg + 1], g2s = v.first ? g2e : v.prevG[pg + 2];
      v.prevG[pg] = g0e;
      v.prevG[pg + 1] = g1e;
      v.prevG[pg + 2] = g2e;
      const d0 = (g0e - g0s) / n, d1 = (g1e - g1s) / n, d2 = (g2e - g2s) / n;
      const A0 = fm[3] * k * 3.2, A1 = fm[4] * k * 3.2, A2 = fm[5] * k * 3.2;
      for (let i = 0; i < n; i++) {
        const xl = L[i], xr = R[i];
        const il = useDrive ? fastTanh(xl * dg) * dc : xl;
        const ir = useDrive ? fastTanh(xr * dg) * dc : xr;
        let yl = 0, yr = 0;
        for (let j = 0; j < 3; j++) {
          const g = j === 0 ? g0s + d0 * (i + 1) : j === 1 ? g1s + d1 * (i + 1) : g2s + d2 * (i + 1);
          const amp = j === 0 ? A0 : j === 1 ? A1 : A2;
          const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
          const o = so + j * 4;
          let v3 = il - st[o + 1];
          let v1 = a1 * st[o] + a2 * v3;
          let v2 = st[o + 1] + a2 * st[o] + a3 * v3;
          st[o] = 2 * v1 - st[o];
          st[o + 1] = 2 * v2 - st[o + 1];
          yl += v1 * amp;
          v3 = ir - st[o + 3];
          v1 = a1 * st[o + 2] + a2 * v3;
          v2 = st[o + 3] + a2 * st[o + 2] + a3 * v3;
          st[o + 2] = 2 * v1 - st[o + 2];
          st[o + 3] = 2 * v2 - st[o + 3];
          yr += v1 * amp;
        }
        const mx = mixS + dmix * (i + 1);
        L[i] = xl + mx * (yl - xl);
        R[i] = xr + mx * (yr - xr);
      }
      return;
    }

    let fc = normToCut(cutN);
    if (fc > nyq) fc = nyq;
    const gE = Math.tan((Math.PI * fc) / sr);
    const gS = v.first ? gE : v.prevG[pg];
    v.prevG[pg] = gE;
    const dgc = (gE - gS) / n;

    if (type === FT_LADDER) {
      const k = ladderK(reso);
      const din = 1 + drive * 7;
      const dout = 1 / Math.pow(din, 0.6);
      const comp = 1 + k * 0.55;
      let s1 = st[so], s2 = st[so + 1], s3 = st[so + 2], s4 = st[so + 3];
      let r1 = st[so + 4], r2 = st[so + 5], r3 = st[so + 6], r4 = st[so + 7];
      for (let i = 0; i < n; i++) {
        const g = gS + dgc * (i + 1);
        const G = g / (1 + g), H = 1 - G;
        const G2 = G * G, G3 = G2 * G, G4 = G3 * G;
        const xl = L[i], xr = R[i];
        // left
        let S = G3 * H * s1 + G2 * H * s2 + G * H * s3 + H * s4;
        let y4 = (G4 * xl + S) / (1 + k * G4);
        let u = fastTanh((xl - k * y4) * din) * dout;
        let t = (u - s1) * G;
        let y = t + s1;
        s1 = y + t;
        t = (y - s2) * G;
        y = t + s2;
        s2 = y + t;
        t = (y - s3) * G;
        y = t + s3;
        s3 = y + t;
        t = (y - s4) * G;
        y = t + s4;
        s4 = y + t;
        const yl = y * comp;
        // right
        S = G3 * H * r1 + G2 * H * r2 + G * H * r3 + H * r4;
        y4 = (G4 * xr + S) / (1 + k * G4);
        u = fastTanh((xr - k * y4) * din) * dout;
        t = (u - r1) * G;
        y = t + r1;
        r1 = y + t;
        t = (y - r2) * G;
        y = t + r2;
        r2 = y + t;
        t = (y - r3) * G;
        y = t + r3;
        r3 = y + t;
        t = (y - r4) * G;
        y = t + r4;
        r4 = y + t;
        const yr = y * comp;
        const mx = mixS + dmix * (i + 1);
        L[i] = xl + mx * (yl - xl);
        R[i] = xr + mx * (yr - xr);
      }
      st[so] = s1;
      st[so + 1] = s2;
      st[so + 2] = s3;
      st[so + 3] = s4;
      st[so + 4] = r1;
      st[so + 5] = r2;
      st[so + 6] = r3;
      st[so + 7] = r4;
      return;
    }

    // State-variable (TPT) types: 12 dB = one stage, 24 dB = two cascaded stages
    const two = type === FT_LP24 || type === FT_HP24 || type === FT_BP24 || type === FT_N24;
    const k1 = two ? svfK24a(reso) : svfK(reso);
    const k2 = svfK24b(reso);
    let cl = 0, cb = 0, ch = 0;
    if (type === FT_LP12 || type === FT_LP24) cl = 1;
    else if (type === FT_HP12 || type === FT_HP24) ch = 1;
    else if (type === FT_BP12 || type === FT_BP24) cb = 1;
    else {
      cl = 1;
      ch = 1;
    }
    const cb1 = cb * k1, cb2 = cb * k2;
    let a = st[so], b = st[so + 1], c = st[so + 2], d = st[so + 3];
    let e = st[so + 4], ff = st[so + 5], g2 = st[so + 6], h = st[so + 7];
    const stat = dgc === 0;
    // static cutoff: coefficients once per block
    let a1 = 1 / (1 + gE * (gE + k1)), a2 = gE * a1, a3 = gE * a2;
    let b1 = 1 / (1 + gE * (gE + k2)), b2 = gE * b1, b3 = gE * b2;
    for (let i = 0; i < n; i++) {
      if (!stat) {
        const g = gS + dgc * (i + 1);
        a1 = 1 / (1 + g * (g + k1));
        a2 = g * a1;
        a3 = g * a2;
        if (two) {
          b1 = 1 / (1 + g * (g + k2));
          b2 = g * b1;
          b3 = g * b2;
        }
      }
      const xl = L[i], xr = R[i];
      let il = xl, ir = xr;
      if (useDrive) {
        il = fastTanh(il * dg) * dc;
        ir = fastTanh(ir * dg) * dc;
      }
      let v3 = il - b;
      let v1 = a1 * a + a2 * v3;
      let v2 = b + a2 * a + a3 * v3;
      a = 2 * v1 - a;
      b = 2 * v2 - b;
      let yl = cl * v2 + cb1 * v1 + ch * (il - k1 * v1 - v2);
      v3 = ir - d;
      v1 = a1 * c + a2 * v3;
      v2 = d + a2 * c + a3 * v3;
      c = 2 * v1 - c;
      d = 2 * v2 - d;
      let yr = cl * v2 + cb1 * v1 + ch * (ir - k1 * v1 - v2);
      if (two) {
        v3 = yl - ff;
        v1 = b1 * e + b2 * v3;
        v2 = ff + b2 * e + b3 * v3;
        e = 2 * v1 - e;
        ff = 2 * v2 - ff;
        yl = cl * v2 + cb2 * v1 + ch * (yl - k2 * v1 - v2);
        v3 = yr - h;
        v1 = b1 * g2 + b2 * v3;
        v2 = h + b2 * g2 + b3 * v3;
        g2 = 2 * v1 - g2;
        h = 2 * v2 - h;
        yr = cl * v2 + cb2 * v1 + ch * (yr - k2 * v1 - v2);
      }
      const mx = mixS + dmix * (i + 1);
      L[i] = xl + mx * (yl - xl);
      R[i] = xr + mx * (yr - xr);
    }
    st[so] = a;
    st[so + 1] = b;
    st[so + 2] = c;
    st[so + 3] = d;
    st[so + 4] = e;
    st[so + 5] = ff;
    st[so + 6] = g2;
    st[so + 7] = h;
  }

  // ======================= FX =======================
  private clearFx() {
    this.chL.fill(0);
    this.chR.fill(0);
    this.dlL?.fill(0);
    this.dlR?.fill(0);
    for (const l of this.rvLines) l.fill(0);
    for (const a of this.rvAp) a.fill(0);
    this.rvLp.fill(0);
    this.distLpL = this.distLpR = this.chFbL = this.chFbR = 0;
    this.dlLpL = this.dlLpR = this.dlHpL = this.dlHpR = 0;
  }

  private fx(n: number) {
    const C = this.C, gm = this.gMod, sr = sampleRate;
    const L = this.mixL, R = this.mixR;
    // ---- distortion ----
    const en0 = C[P_FX_ON];
    if (en0 > 1e-4) {
      const gain = Math.pow(10, (C[P_DIST_DRIVE] * 36) / 20);
      const comp = 1 / Math.pow(gain, 0.55);
      const mix = clamp01(C[P_DIST_MIX] + gm[D_FX]) * en0;
      const tc = 1 - Math.exp((-2 * Math.PI * Math.min(0.45 * sr, 700 * Math.pow(2, C[P_DIST_TONE] * 4.8))) / sr);
      const ty = this.distType;
      let lpl = this.distLpL, lpr = this.distLpR;
      for (let i = 0; i < n; i++) {
        const xl = L[i], xr = R[i];
        let yl = xl * gain, yr = xr * gain;
        if (ty === 0) {
          yl = fastTanh(yl);
          yr = fastTanh(yr);
        } else if (ty === 1) {
          yl = yl > 1 ? 1 : yl < -1 ? -1 : yl;
          yr = yr > 1 ? 1 : yr < -1 ? -1 : yr;
        } else {
          let t = (yl + 1) * 0.25;
          t -= Math.floor(t);
          yl = 1 - 4 * Math.abs(t - 0.5);
          t = (yr + 1) * 0.25;
          t -= Math.floor(t);
          yr = 1 - 4 * Math.abs(t - 0.5);
        }
        lpl += (yl - lpl) * tc;
        lpr += (yr - lpr) * tc;
        L[i] = xl + mix * (lpl * comp - xl);
        R[i] = xr + mix * (lpr * comp - xr);
      }
      this.distLpL = lpl;
      this.distLpR = lpr;
    } else if (!this.fxCleared[0]) {
      this.distLpL = this.distLpR = 0;
      this.fxCleared[0] = 1;
    }
    // ---- chorus ----
    const en1 = C[P_FX_ON + 1];
    if (en1 > 1e-4) {
      const bl = this.chL, br = this.chR, m = bl.length - 1;
      const rate = 0.05 + C[P_CH_RATE] * C[P_CH_RATE] * 4.95;
      const base = 0.011 * sr, depth = (0.0006 + C[P_CH_DEPTH] * 0.0062) * sr;
      const fbk = C[P_CH_FB] * 0.75;
      const mix = clamp01(C[P_CH_MIX] + gm[D_FX + 1]) * en1;
      const p0 = this.chPh;
      let p1 = p0 + (rate * n) / sr;
      p1 -= Math.floor(p1);
      this.chPh = p1;
      const TP = 2 * Math.PI;
      const pe = p1 < p0 ? p1 + 1 : p1;
      const half = depth * 0.5;
      const a0 = base + half * (1 + Math.sin(TP * p0)), a1 = base + half * (1 + Math.sin(TP * pe));
      const b0 = base + half * (1 + Math.sin(TP * (p0 + 0.5))), b1 = base + half * (1 + Math.sin(TP * (pe + 0.5)));
      const c0 = base + half * (1 + Math.sin(TP * (p0 + 0.25))), c1 = base + half * (1 + Math.sin(TP * (pe + 0.25)));
      const d0 = base + half * (1 + Math.sin(TP * (p0 + 0.75))), d1 = base + half * (1 + Math.sin(TP * (pe + 0.75)));
      let w = this.chW;
      let fl = this.chFbL, fr = this.chFbR;
      for (let i = 0; i < n; i++) {
        const t = (i + 1) / n;
        const xl = L[i], xr = R[i];
        bl[w] = xl + fl * fbk;
        br[w] = xr + fr * fbk;
        let rp = w - (a0 + (a1 - a0) * t);
        let ri = Math.floor(rp);
        let f = rp - ri;
        ri &= m;
        let wl = bl[ri] + f * (bl[(ri + 1) & m] - bl[ri]);
        rp = w - (b0 + (b1 - b0) * t);
        ri = Math.floor(rp);
        f = rp - ri;
        ri &= m;
        wl = 0.5 * (wl + bl[ri] + f * (bl[(ri + 1) & m] - bl[ri]));
        rp = w - (c0 + (c1 - c0) * t);
        ri = Math.floor(rp);
        f = rp - ri;
        ri &= m;
        let wr = br[ri] + f * (br[(ri + 1) & m] - br[ri]);
        rp = w - (d0 + (d1 - d0) * t);
        ri = Math.floor(rp);
        f = rp - ri;
        ri &= m;
        wr = 0.5 * (wr + br[ri] + f * (br[(ri + 1) & m] - br[ri]));
        fl = wl;
        fr = wr;
        w = (w + 1) & m;
        L[i] = xl * (1 - 0.45 * mix) + wl * mix;
        R[i] = xr * (1 - 0.45 * mix) + wr * mix;
      }
      this.chW = w;
      this.chFbL = fl + 1e-20;
      this.chFbR = fr + 1e-20;
    } else if (!this.fxCleared[1]) {
      this.chL.fill(0);
      this.chR.fill(0);
      this.chFbL = this.chFbR = 0;
      this.fxCleared[1] = 1;
    }
    // ---- delay (tempo-synced, optional ping-pong) ----
    const en2 = C[P_FX_ON + 2];
    if (en2 > 1e-4 && this.dlL && this.dlR) {
      const bl = this.dlL, br = this.dlR, m = bl.length - 1;
      const target = Math.min(4 * sr, Math.max(32, ((this.dlBeats * 60) / Math.max(20, this.bpm)) * sr));
      if (this.dlD <= 0) this.dlD = target;
      const fbk = C[P_DL_FB];
      const mix = clamp01(C[P_DL_MIX] + gm[D_FX + 2]) * en2;
      const dry = Math.min(1, 2 - 2 * mix), wet = Math.min(1, 2 * mix);
      const tc = 1 - Math.exp((-2 * Math.PI * (600 * Math.pow(2, C[P_DL_TONE] * 4.6))) / sr);
      const hc = 1 - Math.exp((-2 * Math.PI * 90) / sr);
      const sm = 1 - Math.exp(-1 / (0.05 * sr));
      let w = this.dlW, D = this.dlD;
      let lpl = this.dlLpL, lpr = this.dlLpR, hpl = this.dlHpL, hpr = this.dlHpR;
      const ping = this.dlPing;
      for (let i = 0; i < n; i++) {
        D += (target - D) * sm;
        const rp = w - D;
        let ri = Math.floor(rp);
        const f = rp - ri;
        ri &= m;
        const ri2 = (ri + 1) & m;
        const rl = bl[ri] + f * (bl[ri2] - bl[ri]);
        const rr = br[ri] + f * (br[ri2] - br[ri]);
        lpl += (rl - lpl) * tc;
        lpr += (rr - lpr) * tc;
        hpl += (lpl - hpl) * hc;
        hpr += (lpr - hpr) * hc;
        const ol = lpl - hpl, or = lpr - hpr;
        const xl = L[i], xr = R[i];
        if (ping) {
          bl[w] = (xl + xr) * 0.5 + fbk * or;
          br[w] = fbk * ol;
        } else {
          bl[w] = xl + fbk * ol;
          br[w] = xr + fbk * or;
        }
        w = (w + 1) & m;
        L[i] = xl * dry + ol * wet;
        R[i] = xr * dry + or * wet;
      }
      this.dlW = w;
      this.dlD = D;
      this.dlLpL = lpl + 1e-20;
      this.dlLpR = lpr + 1e-20;
      this.dlHpL = hpl;
      this.dlHpR = hpr;
    } else if (!this.fxCleared[2]) {
      this.dlL?.fill(0);
      this.dlR?.fill(0);
      this.dlLpL = this.dlLpR = this.dlHpL = this.dlHpR = 0;
      this.fxCleared[2] = 1;
    }
    // ---- reverb (8-line FDN, Householder feedback, damped) ----
    const en3 = C[P_FX_ON + 3];
    if (en3 > 1e-4) {
      const size = C[P_RV_SIZE];
      const t60 = 0.35 + size * size * 11;
      for (let k = 0; k < 8; k++) this.rvG[k] = Math.pow(10, (-3 * this.rvLen[k]) / (t60 * sr));
      const damp = 1 - Math.exp((-2 * Math.PI * (1200 * Math.pow(2, (1 - C[P_RV_DAMP]) * 4))) / sr);
      const width = C[P_RV_WIDTH];
      const mix = clamp01(C[P_RV_MIX] + gm[D_FX + 3]) * en3;
      const dry = Math.min(1, 2 - 2 * mix), wet = Math.min(1, 2 * mix) * 0.42;
      const lines = this.rvLines, len = this.rvLen, lp = this.rvLp, gk = this.rvG, ap = this.rvAp, apl = this.rvApLen;
      const m = this.rvMask, am = this.apMask;
      let w = this.rvW;
      const o = this.rvO;
      for (let i = 0; i < n; i++) {
        const xl = L[i], xr = R[i];
        let x = (xl + xr) * 0.5 + 1e-18;
        for (let k = 0; k < 4; k++) {
          const buf = ap[k];
          const dd = buf[(w - apl[k]) & am];
          const y = dd - 0.62 * x;
          buf[w & am] = x + 0.62 * y;
          x = y;
        }
        let sum = 0;
        for (let k = 0; k < 8; k++) {
          const r = lines[k][(w - len[k]) & m];
          lp[k] += (r - lp[k]) * damp;
          o[k] = lp[k];
          sum += lp[k];
        }
        const hh = sum * 0.25;
        for (let k = 0; k < 8; k++) lines[k][w & m] = (o[k] - hh) * gk[k] + (k & 1 ? -x : x) * 0.5;
        w = (w + 1) & 0x7fffffff;
        const wl = o[0] - o[2] + o[4] - o[6] + 0.5 * (o[1] + o[5]);
        const wr = o[1] - o[3] + o[5] - o[7] + 0.5 * (o[0] + o[4]);
        const mid = (wl + wr) * 0.5, side = (wl - wr) * 0.5 * width;
        L[i] = xl * dry + (mid + side) * wet;
        R[i] = xr * dry + (mid - side) * wet;
      }
      this.rvW = w;
    } else if (!this.fxCleared[3]) {
      for (const l of this.rvLines) l.fill(0);
      for (const a of this.rvAp) a.fill(0);
      this.rvLp.fill(0);
      this.fxCleared[3] = 1;
    }
  }

  // ======================= viz =======================
  protected vizData() {
    if (!this.ready) return undefined;
    this.vizT = currentTime;
    const v = this.newest();
    const C = this.C;
    const fr: number[] = [], cut: number[] = [], lv: number[] = [], lp: number[] = [], env: number[] = [];
    for (let o = 0; o < N_OSC; o++) fr.push(clamp01(C[o * PO_STRIDE + PO_FRAME] + (v ? v.mod[D_OSC + o * 6 + 2] : this.gMod[D_OSC + o * 6 + 2])));
    for (let f = 0; f < 2; f++) cut.push(v ? v.cutViz[f] : C[P_FILT + f * PF_STRIDE + PF_CUT] + this.gMod[D_FILT + f * 5]);
    for (let l = 0; l < N_LFO; l++) {
      const free = this.lMode[l] === 1;
      lv.push(free ? this.gVal[l] : v ? v.lVal[l] : 0);
      let p = free ? this.gPh[l] + this.lPhase[l] : v ? v.lPh[l] : this.lPhase[l];
      lp.push(p - Math.floor(p));
    }
    for (let e = 0; e < N_ENV; e++) env.push(v ? v.eLvl[e] : 0);
    let n = 0;
    for (let vi = 0; vi < this.voices.length; vi++) {
      const x = this.voices[vi];
      if (x.active && !x.fading) n++;
    }
    return { fr, cut, lv, lp, env, es: v ? Array.from(v.eStage) : [5, 5, 5], n, mac: Array.from(this.macroEff) };
  }
}

registerProcessor('lf-halcyon', HalcyonProcessor);
