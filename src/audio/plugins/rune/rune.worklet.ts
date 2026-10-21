// Rune — analog-style semi-modular poly synth (AudioWorkletProcessor 'lf-rune').
// Signal flow per voice: 3 oscillators → routing → filter 1 / filter 2 (serial or parallel) → distortion →
// VCA (ENV1) → pan; voices are summed → FX chain → master. Modulation runs at control rate (≤ 32 frames)
// with linear interpolation of gains; parameters are smoothed. Nothing allocates inside render().
import { InstrumentProcessor } from '../../worklets/kit';
import {
  normalize, OSC_TYPES, FILTER_TYPES, DIST_TYPES, LFO_SHAPES, LFO_DIVS, ARP_RATES, DELAY_DIVS, ARP_MODES, VOICE_MODES,
  SRC_INDEX, DST_INDEX, MOD_DESTS, MOD_SLOTS, RuneState,
} from './defs';
import { getTables, levelFor, lk, TableSet, SH_SAW, SH_SQR, SH_TRI, SH_SIN, SH_ORGAN, SH_VOX, SH_CHIP } from './dsp/tables';
import { Filter, FT_OFF, FT_COMB } from './dsp/filters';
import { FxChain, FxSettings } from './dsp/fx';

const BLOCK = 32;
const MAXV = 112;
const LN2_12 = Math.LN2 / 12;
const TWO_PI = 6.283185307179586;
const VOICE_SCALE = 0.26;

// oscillator types (index in OSC_TYPES)
const OT_OFF = 0, OT_ANALOG = 1, OT_MULTI = 2, OT_FM = 3, OT_PM = 4, OT_CHIP = 5, OT_NOISE = 6, OT_VECTOR = 7;
// param vector layout
const O_LEVEL = 0, O_PAN = 1, O_WAVE = 2, O_PW = 3, O_DETUNE = 4, O_SPREAD = 5, O_RATIO = 6, O_INDEX = 7, O_FB = 8, O_COLOR = 9, O_X = 10, O_Y = 11, O_FM = 12;
const FB0 = 48;
const F_CUT = 0, F_RES = 1, F_DRIVE = 2, F_KEY = 3, F_ENV = 4, F_VEL = 5, F_LEVEL = 6, F_MORPH = 7;
const P_AGAIN = 72, P_APAN = 73, P_AVEL = 74, P_DDRIVE = 75, P_DMIX = 76, P_MASTER = 77, P_UDET = 78, P_USPREAD = 79, P_DRIFT = 80;
const P_CH_RATE = 88, P_CH_DEPTH = 89, P_PH_RATE = 90, P_PH_DEPTH = 91, P_PH_FB = 92, P_FL_RATE = 93, P_FL_DEPTH = 94, P_FL_FB = 95;
const P_DL_FB = 96, P_DL_TONE = 97, P_RV_DAMP = 99;
const P_CH_MIX = 100, P_PH_MIX = 101, P_FL_MIX = 102, P_DL_MIX = 103, P_RV_MIX = 104;
const P_MACRO = 105; // 4 macro knob values (+ playlist automation from the AudioParams)
const P_MOD = 112;
const NP = 128;

// modulation sources (MOD_SOURCES order)
const NSRC = 18;
const S_ENV1 = SRC_INDEX.env1, S_LFO1 = SRC_INDEX.lfo1, S_VEL = SRC_INDEX.vel, S_KEY = SRC_INDEX.key, S_WHEEL = SRC_INDEX.wheel;
const S_RAND = SRC_INDEX.rand, S_UNI = SRC_INDEX.uni, S_SEQ = SRC_INDEX.seq, S_M1 = SRC_INDEX.macro1;
// destinations
const NDST = MOD_DESTS.length;
const D_OPITCH = [1, 2, 3].map((i) => DST_INDEX[`o${i}.pitch`]);
const D_OLEVEL = [1, 2, 3].map((i) => DST_INDEX[`o${i}.level`]);
const D_OSHAPE = [1, 2, 3].map((i) => DST_INDEX[`o${i}.shape`]);
const D_OPW = [1, 2, 3].map((i) => DST_INDEX[`o${i}.pw`]);
const D_OFM = [1, 2, 3].map((i) => DST_INDEX[`o${i}.fm`]);
const D_OPAN = [1, 2, 3].map((i) => DST_INDEX[`o${i}.pan`]);
const D_PITCH = DST_INDEX.pitch, D_UNIDET = DST_INDEX['uni.detune'];
const D_FCUT = [1, 2].map((i) => DST_INDEX[`f${i}.cutoff`]);
const D_FRES = [1, 2].map((i) => DST_INDEX[`f${i}.res`]);
const D_FDRIVE = [1, 2].map((i) => DST_INDEX[`f${i}.drive`]);
const D_FMORPH = [1, 2].map((i) => DST_INDEX[`f${i}.morph`]);
const D_AGAIN = DST_INDEX['amp.gain'], D_APAN = DST_INDEX['amp.pan'], D_DDRIVE = DST_INDEX['dist.drive'], D_DMIX = DST_INDEX['dist.mix'];
const D_LRATE = [1, 2, 3, 4].map((i) => DST_INDEX[`lfo${i}.rate`]);
const D_FX0 = DST_INDEX['fx.chorus'];

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

class Rng {
  s: number;
  constructor(seed: number) {
    this.s = seed | 0 || 1;
  }
  /** [-1, 1) */
  bi() {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x;
    return (x | 0) * 4.656612873077393e-10;
  }
  uni() {
    return 0.5 + 0.5 * this.bi();
  }
}

class Env {
  lv = 0;
  st = 0; // 0 idle, 1 attack, 2 decay/sustain, 3 release
  t = 0;
  on(fromZero: boolean) {
    if (fromZero) this.lv = 0;
    this.st = 1;
    this.t = 0;
  }
  off() {
    if (this.st !== 0) this.st = 3;
  }
  advance(n: number, p: Float64Array, o: number, loop: boolean, sr: number) {
    const a = p[o], d = p[o + 1], s = p[o + 2], r = p[o + 3];
    switch (this.st) {
      case 1: {
        const c = Math.exp((-n * 1.466) / (a * sr));
        this.lv = 1.3 - (1.3 - this.lv) * c;
        if (this.lv >= 1) {
          this.lv = 1;
          this.st = 2;
          this.t = 0;
        }
        break;
      }
      case 2: {
        const c = Math.exp((-n * 4) / (d * sr));
        this.lv = s + (this.lv - s) * c;
        this.t += n;
        if (loop && this.t >= d * sr) {
          this.st = 1;
          this.t = 0;
        }
        break;
      }
      case 3: {
        const c = Math.exp((-n * 3.93) / (r * sr));
        this.lv = -0.02 + (this.lv + 0.02) * c;
        if (this.lv <= 0) {
          this.lv = 0;
          this.st = 0;
        }
        break;
      }
      default:
        this.lv = 0;
    }
  }
}

class Lfo {
  ph = 0;
  val = 0;
  sh = 0;
  a = 0;
  b = 0;
  fade = 1;
  hz = 1;
  rng: Rng;
  constructor(seed: number) {
    this.rng = new Rng(seed);
  }
  copyFrom(o: Lfo) {
    this.ph = o.ph;
    this.sh = o.sh;
    this.a = o.a;
    this.b = o.b;
    this.val = o.val;
  }
  advance(shape: number, n: number, sr: number) {
    let ph = this.ph + (this.hz * n) / sr;
    let wrapped = false;
    if (ph >= 1) {
      ph -= Math.floor(ph);
      wrapped = true;
    }
    this.ph = ph;
    switch (shape) {
      case 0: this.val = Math.sin(TWO_PI * ph); break;
      case 1: this.val = ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4; break;
      case 2: this.val = 2 * ph - 1; break;
      case 3: this.val = ph < 0.5 ? 1 : -1; break;
      case 4:
        if (wrapped) this.sh = this.rng.bi();
        this.val = this.sh;
        break;
      default: {
        if (wrapped) {
          this.a = this.b;
          this.b = this.rng.bi();
        }
        const f = ph * ph * (3 - 2 * ph);
        this.val = this.a + (this.b - this.a) * f;
      }
    }
  }
}

class Voice {
  active = false;
  id = 0;
  key = 60;
  vel = 0.8;
  gate = false;
  fading = false;
  fade = 1;
  age = 0;
  uniPos = 0;
  rand = 0;
  pitch = 60;
  target = 60;
  detune0 = 0;
  ampG = 0;
  panL = 1;
  panR = 1;
  // oscillators
  ph = new Float64Array(3);
  ph2 = new Float64Array(3);
  prev = new Float64Array(3);
  mfb = new Float64Array(3);
  mdc = new Float64Array(3);
  mph = new Float64Array(24);
  pink = new Float64Array(9);
  nlp = new Float64Array(6);
  crk = new Float64Array(6);
  olv = new Float64Array(3);
  mp = 0; // sync master phase
  drift = new Float64Array(9); // per osc: phase, a, b
  // distortion state
  crc = 0;
  crL = 0;
  crR = 0;
  env = [new Env(), new Env(), new Env()];
  lfo: Lfo[];
  src = new Float64Array(NSRC);
  dst = new Float64Array(NDST);
  f1 = new Filter();
  f2 = new Filter();
  rng: Rng;
  constructor(i: number) {
    this.rng = new Rng(0x1234567 + i * 7919);
    this.lfo = [0, 1, 2, 3].map((l) => new Lfo(0x9e3779b + i * 131 + l * 17));
  }
}

class RuneProcessor extends InstrumentProcessor {
  private sr = sampleRate;
  private ready = false;
  private tabs: TableSet = getTables(sampleRate);
  private voices: Voice[] = [];
  private P = new Float64Array(NP);
  private T = new Float64Array(NP);
  private SM = new Uint8Array(NP);
  private mac = new Float64Array(4);
  private ageCounter = 0;
  // discrete config
  private oT = new Int32Array(3);
  private oTune = new Float64Array(3);
  private oSync = new Uint8Array(3);
  private oReset = new Uint8Array(3);
  private oRoute = new Int32Array(3);
  private oVoices = new Int32Array(3);
  private oDuty = new Int32Array(3);
  private oNoise = new Int32Array(3);
  private fT = new Int32Array(2);
  private fMode = new Int32Array(2);
  private serial = true;
  private distT = 0;
  private envP = new Float64Array(15);
  private envLoop = new Uint8Array(3);
  private lShape = new Int32Array(4);
  private lRate = new Float64Array(4);
  private lSync = new Uint8Array(4);
  private lDiv = new Float64Array(4);
  private lRetrig = new Uint8Array(4);
  private lFade = new Float64Array(4);
  private lHz = new Float64Array(4);
  private glide = 0;
  private unison = 1;
  private polyMax = 12;
  private vmode = 0; // 0 poly, 1 mono, 2 legato
  // matrix
  private mS = new Int32Array(MOD_SLOTS);
  private mD = new Int32Array(MOD_SLOTS);
  private mV = new Int32Array(MOD_SLOTS);
  private vSlots = new Int32Array(MOD_SLOTS);
  private nV = 0;
  private gSlots = new Int32Array(MOD_SLOTS);
  private nG = 0;
  // global modulation (FX destinations)
  private glfo = [0, 1, 2, 3].map((l) => new Lfo(0x51ed27 + l * 977));
  private gsrc = new Float64Array(NSRC);
  private gfx = new Float64Array(5);
  // scratch
  private oA = [new Float64Array(BLOCK), new Float64Array(BLOCK), new Float64Array(BLOCK)];
  private oB = [new Float64Array(BLOCK), new Float64Array(BLOCK), new Float64Array(BLOCK)];
  private syncBuf = new Float64Array(BLOCK);
  private aL = new Float64Array(BLOCK);
  private aR = new Float64Array(BLOCK);
  private bL = new Float64Array(BLOCK);
  private bR = new Float64Array(BLOCK);
  private sumL = new Float64Array(BLOCK);
  private sumR = new Float64Array(BLOCK);
  /** scratch "registers": doubles handed to helpers without boxing (inc, fmDepth, shapeMod, pwMod, drive, mix) */
  private rg = new Float64Array(8);
  /** table-oscillator weights [saw/t0, t1, t2, t3, pulse, pw, pulseNorm] and tables [t0..t3, saw] */
  private tw = new Float64Array(8);
  private tt: Float32Array[] = [];
  private mgl = new Float64Array(8);
  private mgr = new Float64Array(8);
  private minc = new Float64Array(8);
  // fx / master
  private fx: FxChain;
  private fxs = new FxSettings();
  private delayBeats = 0.75;
  private masterG = 1;
  private dcxL = 0;
  private dcyL = 0;
  private dcxR = 0;
  private dcyR = 0;
  private idle = 0;
  // mono note stack
  private stId = new Float64Array(32);
  private stKey = new Float64Array(32);
  private stVel = new Float64Array(32);
  private stN = 0;
  private monoId = 0;
  private lastPitch = -1;
  // arpeggiator
  private arpOn = false;
  private arpMode = 0;
  private arpOct = 1;
  private arpRate = 0.25;
  private arpGate = 0.6;
  private arpSwing = 0;
  private arpLatch = false;
  private arpLen = 16;
  private arpSteps = new Float64Array(16);
  private arpVals = new Float64Array(16);
  private hId = new Float64Array(32);
  private hKey = new Float64Array(32);
  private hVel = new Float64Array(32);
  private hPhys = new Uint8Array(32);
  private hN = 0;
  private physN = 0;
  private arpRun = false;
  private arpTime = 0;
  private arpNext = 0;
  private arpBase = 0;
  private arpOff = -1;
  private arpStep = 0;
  private arpIdx = 0;
  private arpCurId = new Float64Array(32);
  private arpCurN = 0;
  private arpIdSeq = 0;
  private arpViz = -1;
  private seqVal = 0;
  private sortK = new Float64Array(32);
  private sortV = new Float64Array(32);
  private arpRng = new Rng(4242);
  private lastVoice: Voice | null = null;

  constructor(options?: any) {
    super(options);
    for (let i = 0; i < MAXV; i++) this.voices.push(new Voice(i));
    this.fx = new FxChain(this.sr);
    const t0 = this.tabs.t[SH_SAW][0];
    this.tt = [t0, t0, t0, t0, t0];
    const smooth = [
      ...[0, 1, 2].flatMap((k) => [O_LEVEL, O_PAN, O_WAVE, O_PW, O_DETUNE, O_SPREAD, O_RATIO, O_INDEX, O_FB, O_COLOR, O_X, O_Y, O_FM].map((o) => k * 16 + o)),
      ...[0, 1].flatMap((j) => [F_CUT, F_RES, F_DRIVE, F_KEY, F_ENV, F_VEL, F_LEVEL, F_MORPH].map((o) => FB0 + j * 12 + o)),
      P_AGAIN, P_APAN, P_AVEL, P_DDRIVE, P_DMIX, P_MASTER, P_UDET, P_USPREAD, P_DRIFT,
      P_CH_RATE, P_CH_DEPTH, P_PH_RATE, P_PH_DEPTH, P_PH_FB, P_FL_RATE, P_FL_DEPTH, P_FL_FB, P_DL_FB, P_DL_TONE, P_RV_DAMP,
      P_CH_MIX, P_PH_MIX, P_FL_MIX, P_DL_MIX, P_RV_MIX, P_MACRO, P_MACRO + 1, P_MACRO + 2, P_MACRO + 3,
      ...Array.from({ length: MOD_SLOTS }, (_, j) => P_MOD + j),
    ];
    for (const i of smooth) this.SM[i] = 1;
  }

  // ======================= state =======================
  protected onState(raw: any) {
    const s: RuneState = normalize(raw);
    const T = this.T;
    for (let k = 0; k < 3; k++) {
      const o = s.osc[k], b = k * 16;
      const type = OSC_TYPES.indexOf(o.type);
      this.oT[k] = type;
      this.oTune[k] = o.oct * 12 + o.semi + o.fine / 100;
      this.oSync[k] = o.sync && k > 0 ? 1 : 0;
      this.oReset[k] = o.reset ? 1 : 0;
      this.oRoute[k] = o.route;
      this.oVoices[k] = o.voices;
      this.oDuty[k] = o.duty;
      this.oNoise[k] = o.noise;
      T[b + O_LEVEL] = o.level;
      T[b + O_PAN] = o.pan;
      T[b + O_WAVE] = o.wave;
      T[b + O_PW] = o.pw;
      T[b + O_DETUNE] = o.detune;
      T[b + O_SPREAD] = o.spread;
      T[b + O_RATIO] = o.ratio;
      T[b + O_INDEX] = o.index;
      T[b + O_FB] = o.fb;
      T[b + O_COLOR] = o.color;
      T[b + O_X] = o.x;
      T[b + O_Y] = o.y;
      T[b + O_FM] = k > 0 ? o.fm : 0;
    }
    for (let j = 0; j < 2; j++) {
      const f = s.flt[j], b = FB0 + j * 12;
      const type = FILTER_TYPES.indexOf(f.type);
      if (type !== this.fT[j] || f.mode !== this.fMode[j]) {
        for (const v of this.voices) {
          const fl = j === 0 ? v.f1 : v.f2;
          if (type === FT_COMB) fl.ensureComb(this.sr);
          if (fl.type !== type) fl.reset();
          fl.type = type;
          fl.mode = f.mode;
        }
      }
      this.fT[j] = type;
      this.fMode[j] = f.mode;
      T[b + F_CUT] = 69 + 12 * Math.log2(f.cutoff / 440);
      T[b + F_RES] = f.res;
      T[b + F_DRIVE] = f.drive;
      T[b + F_KEY] = f.key;
      T[b + F_ENV] = f.env;
      T[b + F_VEL] = f.vel;
      T[b + F_LEVEL] = f.level;
      T[b + F_MORPH] = f.morph;
    }
    this.serial = s.serial;
    T[P_AGAIN] = Math.pow(10, s.amp.gain / 20);
    T[P_APAN] = s.amp.pan;
    T[P_AVEL] = s.amp.vel;
    this.distT = DIST_TYPES.indexOf(s.amp.dist);
    T[P_DDRIVE] = s.amp.drive;
    T[P_DMIX] = s.amp.mix;
    T[P_MASTER] = Math.pow(10, s.master / 20);
    for (let i = 0; i < 4; i++) T[P_MACRO + i] = s.macros[i];
    for (let e = 0; e < 3; e++) {
      const en = s.env[e];
      this.envP[e * 5] = en.a;
      this.envP[e * 5 + 1] = en.d;
      this.envP[e * 5 + 2] = en.s;
      this.envP[e * 5 + 3] = en.r;
      this.envLoop[e] = en.loop ? 1 : 0;
    }
    for (let l = 0; l < 4; l++) {
      const lf = s.lfo[l];
      this.lShape[l] = LFO_SHAPES.indexOf(lf.shape);
      this.lRate[l] = lf.rate;
      this.lSync[l] = lf.sync ? 1 : 0;
      this.lDiv[l] = LFO_DIVS[lf.div].beats;
      this.lRetrig[l] = lf.retrig ? 1 : 0;
      this.lFade[l] = lf.fade;
    }
    // matrix
    this.nV = 0;
    this.nG = 0;
    for (let j = 0; j < MOD_SLOTS; j++) {
      const m = s.mod[j];
      this.mS[j] = SRC_INDEX[m.src];
      this.mD[j] = DST_INDEX[m.dst];
      this.mV[j] = SRC_INDEX[m.via];
      T[P_MOD + j] = m.amt;
      if (this.mS[j] === 0 || this.mD[j] === 0) continue;
      if (MOD_DESTS[this.mD[j]].global) this.gSlots[this.nG++] = j;
      else this.vSlots[this.nV++] = j;
    }
    // voice
    const vm = VOICE_MODES.indexOf(s.voice.mode);
    if (vm !== this.vmode && this.ready) this.releaseAll(true);
    this.vmode = vm;
    this.polyMax = s.voice.voices;
    this.glide = s.voice.glide;
    this.unison = s.voice.unison;
    T[P_UDET] = s.voice.detune;
    T[P_USPREAD] = s.voice.spread;
    T[P_DRIFT] = s.voice.drift;
    // arp
    const a = s.arp;
    if (this.arpOn && !a.on) this.arpStop(true);
    this.arpOn = a.on;
    this.arpMode = ARP_MODES.indexOf(a.mode);
    this.arpOct = a.oct;
    this.arpRate = ARP_RATES[a.rate].beats;
    this.arpGate = a.gate;
    this.arpSwing = a.swing;
    if (this.arpLatch && !a.latch && this.arpRun) {
      // unlatching: drop notes that are no longer physically held
      let w = 0;
      for (let i = 0; i < this.hN; i++) if (this.hPhys[i]) this.copyHeld(i, w++);
      this.hN = w;
      if (!w) this.arpStop(false);
    }
    this.arpLatch = a.latch;
    this.arpLen = a.len;
    for (let i = 0; i < 16; i++) {
      this.arpSteps[i] = a.steps[i];
      this.arpVals[i] = a.vals[i];
    }
    // fx
    const fx = s.fx, F = this.fxs;
    F.chOn = fx.chorus.on;
    T[P_CH_MIX] = fx.chorus.mix;
    T[P_CH_RATE] = fx.chorus.rate;
    T[P_CH_DEPTH] = fx.chorus.depth;
    F.phOn = fx.phaser.on;
    T[P_PH_MIX] = fx.phaser.mix;
    T[P_PH_RATE] = fx.phaser.rate;
    T[P_PH_DEPTH] = fx.phaser.depth;
    T[P_PH_FB] = fx.phaser.fb;
    F.flOn = fx.flanger.on;
    T[P_FL_MIX] = fx.flanger.mix;
    T[P_FL_RATE] = fx.flanger.rate;
    T[P_FL_DEPTH] = fx.flanger.depth;
    T[P_FL_FB] = fx.flanger.fb;
    F.dlOn = fx.delay.on;
    T[P_DL_MIX] = fx.delay.mix;
    T[P_DL_FB] = fx.delay.fb;
    T[P_DL_TONE] = fx.delay.tone;
    F.dlPP = fx.delay.pingpong;
    this.delayBeats = DELAY_DIVS[fx.delay.div].beats;
    F.rvOn = fx.reverb.on;
    T[P_RV_MIX] = fx.reverb.mix;
    F.rvSize = fx.reverb.size;
    T[P_RV_DAMP] = fx.reverb.damp;
    F.rvPre = fx.reverb.pre;
    if (!this.ready) {
      this.P.set(T);
      this.ready = true;
    }
    this.idle = 0;
  }

  // ======================= notes =======================
  protected noteOn(id: number, key: number, vel: number) {
    if (!this.ready) return;
    this.idle = 0;
    if (this.arpOn) this.arpAdd(id, key, vel);
    else this.engineOn(id, key, vel);
  }
  protected noteOff(id: number) {
    if (this.arpOn && this.arpRemove(id)) return;
    this.engineOff(id);
  }
  protected kill(id: number) {
    if (this.arpOn) {
      const i = this.heldIndex(id);
      if (i >= 0) {
        this.removeHeld(i);
        if (!this.hN) this.arpStop(true);
      }
    }
    for (const v of this.voices) if (v.active && v.id === id) this.fadeOut(v);
    this.stackRemove(id);
  }
  protected allOff(hard: boolean) {
    this.hN = 0;
    this.physN = 0;
    this.arpStop(hard);
    this.releaseAll(hard);
  }
  protected onTempo(_bpm: number) {}

  private releaseAll(hard: boolean) {
    this.stN = 0;
    for (const v of this.voices) {
      if (!v.active) continue;
      if (hard) this.fadeOut(v);
      else this.gateOff(v);
    }
  }
  private fadeOut(v: Voice) {
    v.fading = true;
    v.gate = false;
  }
  private gateOff(v: Voice) {
    v.gate = false;
    for (const e of v.env) e.off();
  }

  private engineOn(id: number, key: number, vel: number) {
    if (this.vmode === 0) {
      // polyphony limit counts notes (unison groups)
      let notes = 0;
      for (const v of this.voices) if (v.active && !v.fading && v.uniPos <= -1 + 1e-9) notes++;
      while (notes >= this.polyMax) {
        // steal: oldest released note first, then oldest held
        let best: Voice | null = null;
        for (const v of this.voices) {
          if (!v.active || v.fading || v.uniPos > -1 + 1e-9) continue;
          if (!best || (v.gate ? 1 : 0) < (best.gate ? 1 : 0) || ((v.gate ? 1 : 0) === (best.gate ? 1 : 0) && v.age < best.age)) best = v;
        }
        if (!best) break;
        const sid = best.id;
        for (const v of this.voices) if (v.active && v.id === sid && !v.fading) this.fadeOut(v);
        notes--;
      }
      this.startGroup(id, key, vel);
      return;
    }
    // mono / legato
    if (this.stN < 32) {
      this.stId[this.stN] = id;
      this.stKey[this.stN] = key;
      this.stVel[this.stN] = vel;
      this.stN++;
    }
    let found = false;
    for (const v of this.voices) {
      if (!v.active || v.fading || v.id !== this.monoId) continue;
      found = true;
      const legato = this.vmode === 2 && v.gate;
      v.id = id;
      v.key = key;
      v.target = key;
      if (this.glide <= 0) v.pitch = key;
      v.vel = legato ? v.vel : vel;
      v.gate = true;
      if (!legato) for (const e of v.env) e.on(false);
      else for (const e of v.env) if (e.st === 3) e.on(false);
    }
    this.monoId = id;
    this.lastPitch = key;
    if (!found) this.startGroup(id, key, vel);
  }

  private engineOff(id: number) {
    if (this.vmode === 0) {
      for (const v of this.voices) if (v.active && v.id === id) this.gateOff(v);
      return;
    }
    const wasCur = id === this.monoId;
    this.stackRemove(id);
    if (!wasCur) return;
    if (this.stN > 0) {
      const t = this.stN - 1;
      const nid = this.stId[t], key = this.stKey[t];
      for (const v of this.voices) {
        if (!v.active || v.fading || v.id !== id) continue;
        v.id = nid;
        v.key = key;
        v.target = key;
        if (this.glide <= 0) v.pitch = key;
        if (this.vmode === 1) for (const e of v.env) e.on(false);
      }
      this.monoId = nid;
      this.lastPitch = key;
    } else for (const v of this.voices) if (v.active && v.id === id) this.gateOff(v);
  }

  private stackRemove(id: number) {
    let w = 0;
    for (let i = 0; i < this.stN; i++) {
      if (this.stId[i] === id) continue;
      this.stId[w] = this.stId[i];
      this.stKey[w] = this.stKey[i];
      this.stVel[w] = this.stVel[i];
      w++;
    }
    this.stN = w;
  }

  private allocVoice(): Voice {
    let best: Voice | null = null;
    for (const v of this.voices) if (!v.active) return v;
    for (const v of this.voices) if (v.fading && (!best || v.age < best.age)) best = v;
    if (best) return best;
    for (const v of this.voices) if (!best || v.age < best.age) best = v;
    return best!;
  }

  private startGroup(id: number, key: number, vel: number) {
    const U = this.unison;
    const from = this.glide > 0 && this.lastPitch >= 0 ? this.lastPitch : key;
    this.lastPitch = key;
    const drift = this.T[P_DRIFT];
    const groupRand = this.arpRng.bi();
    for (let u = 0; u < U; u++) {
      const v = this.allocVoice();
      v.active = true;
      v.id = id;
      v.key = key;
      v.vel = vel;
      v.gate = true;
      v.fading = false;
      v.fade = 1;
      v.age = ++this.ageCounter;
      v.uniPos = U === 1 ? -1 : (u / (U - 1)) * 2 - 1;
      v.rand = groupRand;
      v.pitch = from;
      v.target = key;
      v.detune0 = v.rng.bi() * drift * 0.07;
      v.ampG = 0;
      v.crc = 0;
      v.crL = v.crR = 0;
      v.mp = 0;
      for (let k = 0; k < 3; k++) {
        const r = this.oReset[k] === 1;
        v.ph[k] = r ? 0 : v.rng.uni();
        v.ph2[k] = r ? 0 : v.rng.uni();
        v.prev[k] = 0;
        v.mfb[k] = 0;
        v.mdc[k] = this.T[k * 16 + O_FB] * 0.12;
        for (let j = 0; j < 8; j++) v.mph[k * 8 + j] = r ? (j * 0.618) % 1 : v.rng.uni();
        v.olv[k] = this.P[k * 16 + O_LEVEL];
        v.drift[k * 3] = v.rng.uni();
        v.drift[k * 3 + 1] = v.rng.bi();
        v.drift[k * 3 + 2] = v.rng.bi();
      }
      if (this.oT[0] !== OT_OFF) v.mp = v.ph[0];
      v.pink.fill(0);
      v.nlp.fill(0);
      v.crk.fill(0);
      v.f1.reset();
      v.f2.reset();
      for (const e of v.env) e.on(true);
      for (let l = 0; l < 4; l++) {
        const lf = v.lfo[l];
        if (this.lRetrig[l]) {
          lf.ph = 0;
          lf.sh = lf.rng.bi();
          lf.a = lf.sh;
          lf.b = lf.rng.bi();
        } else lf.copyFrom(this.glfo[l]);
        lf.fade = this.lFade[l] > 0 ? 0 : 1;
      }
      // pan / gain start values
      const p = clamp(this.P[P_APAN] + (U > 1 ? v.uniPos * this.P[P_USPREAD] : 0), -1, 1);
      v.panL = Math.cos((p + 1) * 0.7853981633974483) * 1.4142135623730951;
      v.panR = Math.sin((p + 1) * 0.7853981633974483) * 1.4142135623730951;
      this.lastVoice = v;
    }
    if (this.vmode !== 0) this.monoId = id;
  }

  // ======================= arpeggiator =======================
  private heldIndex(id: number) {
    for (let i = 0; i < this.hN; i++) if (this.hId[i] === id) return i;
    return -1;
  }
  private copyHeld(from: number, to: number) {
    this.hId[to] = this.hId[from];
    this.hKey[to] = this.hKey[from];
    this.hVel[to] = this.hVel[from];
    this.hPhys[to] = this.hPhys[from];
  }
  private removeHeld(i: number) {
    for (let j = i; j < this.hN - 1; j++) this.copyHeld(j + 1, j);
    this.hN--;
  }
  private arpAdd(id: number, key: number, vel: number) {
    if (this.arpLatch && this.physN === 0) this.hN = 0; // a new chord replaces the latched one
    this.physN++;
    if (this.hN < 32) {
      this.hId[this.hN] = id;
      this.hKey[this.hN] = key;
      this.hVel[this.hN] = vel;
      this.hPhys[this.hN] = 1;
      this.hN++;
    }
    if (!this.arpRun) {
      this.arpRun = true;
      this.arpTime = 0;
      this.arpNext = 0;
      this.arpBase = 0;
      this.arpOff = -1;
      this.arpStep = 0;
      this.arpIdx = 0;
      this.arpCurN = 0;
    }
  }
  /** Returns true when the id belonged to the arp. */
  private arpRemove(id: number): boolean {
    const i = this.heldIndex(id);
    if (i < 0) return false;
    if (this.hPhys[i]) {
      this.hPhys[i] = 0;
      this.physN = Math.max(0, this.physN - 1);
    }
    if (!this.arpLatch) {
      this.removeHeld(i);
      if (!this.hN) this.arpStop(false);
    }
    return true;
  }
  private arpStop(hard: boolean) {
    for (let i = 0; i < this.arpCurN; i++) {
      if (hard) this.kill(this.arpCurId[i]);
      else this.engineOff(this.arpCurId[i]);
    }
    this.arpCurN = 0;
    this.arpRun = false;
    this.arpViz = -1;
    if (!this.arpOn || hard) {
      this.hN = 0;
      this.physN = 0;
    }
  }
  private arpReleaseCurrent() {
    for (let i = 0; i < this.arpCurN; i++) this.engineOff(this.arpCurId[i]);
    this.arpCurN = 0;
  }
  private arpPlay(key: number, vel: number) {
    const id = -1 - (this.arpIdSeq++ % 1e9);
    if (this.arpCurN < 32) this.arpCurId[this.arpCurN++] = id;
    this.engineOn(id, key, vel);
  }
  /** Fire the step due at this.arpNext. */
  private arpFire() {
    const sr = this.sr;
    const stepLen = ((this.arpRate * 60) / this.bpm) * sr;
    this.arpReleaseCurrent();
    const s = this.arpStep % this.arpLen;
    this.arpViz = s;
    this.seqVal = this.arpVals[s];
    const n = this.hN;
    if (n > 0 && this.arpSteps[s] >= 0.5) {
      // order notes
      for (let i = 0; i < n; i++) {
        this.sortK[i] = this.hKey[i];
        this.sortV[i] = this.hVel[i];
      }
      if (this.arpMode !== 4) {
        for (let i = 1; i < n; i++) {
          const k = this.sortK[i], vv = this.sortV[i];
          let j = i - 1;
          while (j >= 0 && this.sortK[j] > k) {
            this.sortK[j + 1] = this.sortK[j];
            this.sortV[j + 1] = this.sortV[j];
            j--;
          }
          this.sortK[j + 1] = k;
          this.sortV[j + 1] = vv;
        }
      }
      const total = n * this.arpOct;
      const idx = this.arpIdx++;
      if (this.arpMode === 5) {
        const oc = (idx % this.arpOct) * 12;
        for (let i = 0; i < n; i++) this.arpPlay(this.sortK[i] + oc, this.sortV[i]);
      } else {
        let p: number;
        switch (this.arpMode) {
          case 1: p = total - 1 - (idx % total); break;
          case 2: {
            const per = Math.max(1, 2 * total - 2);
            const q = idx % per;
            p = total === 1 ? 0 : q < total ? q : per - q;
            break;
          }
          case 3: p = Math.floor(this.arpRng.uni() * total) % total; break;
          default: p = idx % total;
        }
        const ni = p % n, oc = Math.floor(p / n) * 12;
        this.arpPlay(this.sortK[ni] + oc, this.sortV[ni]);
      }
    }
    // schedule
    const start = this.arpNext;
    const gate = this.arpGate >= 0.995 ? stepLen - 1 : Math.max(16, this.arpGate * stepLen);
    this.arpOff = this.arpCurN ? start + gate : -1;
    this.arpStep++;
    this.arpBase += stepLen;
    this.arpNext = this.arpBase + (this.arpStep % 2 === 1 ? this.arpSwing * 0.5 * stepLen : 0);
  }

  // ======================= render =======================
  protected render(out: Float32Array[], from: number, to: number, macros: number[]) {
    if (!this.ready) return;
    const mac = this.mac;
    for (let i = 0; i < 4; i++) mac[i] = Math.min(1, Math.max(0, this.P[P_MACRO + i] + (macros[i] ?? 0)));
    if (this.idle > this.sr * 2 && !this.arpRun) {
      let anyVoice = false;
      for (const v of this.voices)
        if (v.active) {
          anyVoice = true;
          break;
        }
      if (!anyVoice) return; // silent for 2 s: skip all processing until the next note
      this.idle = 0;
    }
    let pos = from;
    while (pos < to) {
      let n = Math.min(BLOCK, to - pos);
      if (this.arpOn && this.arpRun) {
        for (let guard = 0; guard < 8; guard++) {
          if (this.arpOff >= 0 && this.arpTime >= this.arpOff && this.arpOff <= this.arpNext) {
            this.arpReleaseCurrent();
            this.arpOff = -1;
          } else if (this.arpTime >= this.arpNext) this.arpFire();
          else break;
        }
        let due = this.arpNext;
        if (this.arpOff >= 0 && this.arpOff < due) due = this.arpOff;
        const dt = Math.ceil(due - this.arpTime);
        if (dt >= 1 && dt < n) n = dt;
      }
      this.renderBlock(out, pos, n);
      if (this.arpRun) this.arpTime += n;
      pos += n;
    }
  }

  private renderBlock(out: Float32Array[], pos: number, n: number) {
    const P = this.P, T = this.T, SM = this.SM, sr = this.sr;
    // parameter smoothing (≈12 ms)
    const ks = 1 - Math.exp(-n / (0.012 * sr));
    for (let i = 0; i < NP; i++) {
      if (SM[i] === 1) P[i] += (T[i] - P[i]) * ks;
      else P[i] = T[i];
    }
    // LFO rates + global (free-running) LFOs
    const bps = this.bpm / 60;
    for (let l = 0; l < 4; l++) {
      this.lHz[l] = this.lSync[l] === 1 ? bps / this.lDiv[l] : this.lRate[l];
      const g = this.glfo[l];
      g.hz = this.lHz[l];
      g.advance(this.lShape[l], n, sr);
    }
    // global modulation (FX destinations)
    const gs = this.gsrc, gfx = this.gfx;
    gfx.fill(0);
    if (this.nG > 0) {
      const lv = this.lastVoice !== null && this.lastVoice.active ? this.lastVoice : null;
      gs[S_ENV1] = lv !== null ? lv.env[0].lv : 0;
      gs[S_ENV1 + 1] = lv !== null ? lv.env[1].lv : 0;
      gs[S_ENV1 + 2] = lv !== null ? lv.env[2].lv : 0;
      for (let l = 0; l < 4; l++) gs[S_LFO1 + l] = this.glfo[l].val;
      gs[S_VEL] = lv !== null ? lv.vel : 0;
      gs[S_KEY] = lv !== null ? (lv.key - 60) / 48 : 0;
      gs[S_WHEEL] = 0;
      gs[S_RAND] = lv !== null ? lv.rand : 0;
      gs[S_UNI] = 0;
      gs[S_SEQ] = this.seqVal;
      for (let m = 0; m < 4; m++) gs[S_M1 + m] = this.mac[m];
      for (let q = 0; q < this.nG; q++) {
        const j = this.gSlots[q];
        const via = this.mV[j];
        gfx[this.mD[j] - D_FX0] += gs[this.mS[j]] * P[P_MOD + j] * (via !== 0 ? gs[via] : 1);
      }
    }
    // voices
    const sumL = this.sumL, sumR = this.sumR;
    for (let i = 0; i < n; i++) sumL[i] = sumR[i] = 0;
    let nAct = 0;
    const vs = this.voices;
    for (let i = 0; i < MAXV; i++) {
      const v = vs[i];
      if (v.active) {
        nAct++;
        this.renderVoice(v, n);
      }
    }
    // fx
    const F = this.fxs;
    F.chMix = P[P_CH_MIX]; F.chRate = P[P_CH_RATE]; F.chDepth = P[P_CH_DEPTH];
    F.phMix = P[P_PH_MIX]; F.phRate = P[P_PH_RATE]; F.phDepth = P[P_PH_DEPTH]; F.phFb = P[P_PH_FB];
    F.flMix = P[P_FL_MIX]; F.flRate = P[P_FL_RATE]; F.flDepth = P[P_FL_DEPTH]; F.flFb = P[P_FL_FB];
    F.dlMix = P[P_DL_MIX]; F.dlFb = P[P_DL_FB]; F.dlTone = P[P_DL_TONE]; F.dlTime = (this.delayBeats * 60) / this.bpm;
    F.rvMix = P[P_RV_MIX]; F.rvDamp = P[P_RV_DAMP];
    this.fx.process(sumL, sumR, n, F, gfx);
    // master: gain, DC blocker, soft safety clip above -0.9 dBFS (peak always < 0 dBFS)
    const g0 = this.masterG, g1 = P[P_MASTER];
    this.masterG = g1;
    const R = 1 - (TWO_PI * 8) / sr;
    let xl = this.dcxL, yl = this.dcyL, xr = this.dcxR, yr = this.dcyR;
    const oL = out[0], oR = out.length > 1 ? out[1] : out[0];
    const mono = oR === oL;
    const inv = 1 / n;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const g = g0 + (g1 - g0) * i * inv;
      const l = sumL[i] * g, r = sumR[i] * g;
      yl = l - xl + R * yl;
      xl = l;
      yr = r - xr + R * yr;
      xr = r;
      let a = yl < 0 ? -yl : yl;
      let c = yl;
      if (a > 0.9) {
        let u = (a - 0.9) * 10;
        u = u > 3 ? 1 : (u * (27 + u * u)) / (27 + 9 * u * u);
        c = yl < 0 ? -0.9 - 0.098 * u : 0.9 + 0.098 * u;
      }
      if (a > peak) peak = a;
      oL[pos + i] += c;
      if (!mono) {
        a = yr < 0 ? -yr : yr;
        c = yr;
        if (a > 0.9) {
          let u = (a - 0.9) * 10;
          u = u > 3 ? 1 : (u * (27 + u * u)) / (27 + 9 * u * u);
          c = yr < 0 ? -0.9 - 0.098 * u : 0.9 + 0.098 * u;
        }
        if (a > peak) peak = a;
        oR[pos + i] += c;
      }
    }
    this.dcxL = xl; this.dcyL = yl < 1e-20 && yl > -1e-20 ? 0 : yl;
    this.dcxR = xr; this.dcyR = yr < 1e-20 && yr > -1e-20 ? 0 : yr;
    if (nAct === 0 && peak < 2e-5) this.idle += n;
    else this.idle = 0;
  }

  private renderVoice(v: Voice, n: number) {
    const P = this.P, sr = this.sr, src = v.src, dst = v.dst, rg = this.rg;
    // ---- envelopes / LFOs
    const ep = this.envP;
    v.env[0].advance(n, ep, 0, this.envLoop[0] === 1, sr);
    v.env[1].advance(n, ep, 5, this.envLoop[1] === 1, sr);
    v.env[2].advance(n, ep, 10, this.envLoop[2] === 1, sr);
    for (let l = 0; l < 4; l++) {
      const lf = v.lfo[l];
      const rm = dst[D_LRATE[l]];
      lf.hz = rm !== 0 ? this.lHz[l] * Math.exp(rm * 2.772588722239781) : this.lHz[l];
      lf.advance(this.lShape[l], n, sr);
      if (lf.fade < 1) lf.fade = Math.min(1, lf.fade + n / (this.lFade[l] * sr));
    }
    // ---- sources & matrix
    src[S_ENV1] = v.env[0].lv;
    src[S_ENV1 + 1] = v.env[1].lv;
    src[S_ENV1 + 2] = v.env[2].lv;
    for (let l = 0; l < 4; l++) src[S_LFO1 + l] = v.lfo[l].val * v.lfo[l].fade;
    src[S_VEL] = v.vel;
    src[S_KEY] = (v.key - 60) / 48;
    src[S_WHEEL] = 0;
    src[S_RAND] = v.rand;
    src[S_UNI] = this.unison > 1 ? v.uniPos : 0;
    src[S_SEQ] = this.seqVal;
    for (let m = 0; m < 4; m++) src[S_M1 + m] = this.mac[m];
    dst.fill(0);
    for (let q = 0; q < this.nV; q++) {
      const j = this.vSlots[q];
      const via = this.mV[j];
      dst[this.mD[j]] += src[this.mS[j]] * P[P_MOD + j] * (via !== 0 ? src[via] : 1);
    }
    // ---- pitch (glide, unison detune, drift)
    if (v.pitch !== v.target) {
      if (this.glide > 0) {
        v.pitch = v.target + (v.pitch - v.target) * Math.exp((-n * 3) / (this.glide * sr));
        if (Math.abs(v.pitch - v.target) < 0.001) v.pitch = v.target;
      } else v.pitch = v.target;
    }
    const uniDet = this.unison > 1 ? v.uniPos * Math.min(2, Math.max(0, P[P_UDET] + dst[D_UNIDET])) * 0.45 : 0;
    const base = v.pitch + uniDet + dst[D_PITCH] * 24 + v.detune0;
    const driftAmt = P[P_DRIFT] * 0.12;
    // ---- oscillators
    let stereo = false;
    let needSync = false;
    if (this.oT[0] !== OT_OFF) for (let k = 1; k < 3; k++) if (this.oSync[k] === 1 && this.oT[k] !== OT_OFF) needSync = true;
    let routedA = false, routedB = false;
    for (let k = 0; k < 3; k++) {
      const type = this.oT[k];
      if (type === OT_OFF) continue;
      // drift: smooth random walk per oscillator
      let dr = 0;
      if (driftAmt > 0) {
        const di = k * 3;
        let dp = v.drift[di] + ((0.6 + k * 0.17) * n) / sr;
        if (dp >= 1) {
          dp -= 1;
          v.drift[di + 1] = v.drift[di + 2];
          let x = v.rng.s;
          x ^= x << 13;
          x ^= x >>> 17;
          x ^= x << 5;
          v.rng.s = x;
          v.drift[di + 2] = (x | 0) * 4.656612873077393e-10;
        }
        v.drift[di] = dp;
        dr = (v.drift[di + 1] + (v.drift[di + 2] - v.drift[di + 1]) * dp) * driftAmt;
      }
      const pk = base + this.oTune[k] + dst[D_OPITCH[k]] * 24 + dr;
      let inc = (440 * Math.exp((pk - 69) * LN2_12)) / sr;
      if (inc > 0.45) inc = 0.45;
      if (k === 0 && needSync) {
        // master phase of oscillator 1 → sub-sample reset positions for the hard-synced slaves
        const sb = this.syncBuf;
        let mp = v.mp;
        for (let i = 0; i < n; i++) {
          mp += inc;
          if (mp >= 1) {
            mp -= 1;
            sb[i] = mp / inc;
          } else sb[i] = -1;
        }
        v.mp = mp;
      }
      rg[0] = inc;
      if (this.renderOsc(v, k, type, n, needSync && this.oSync[k] === 1)) stereo = true;
      const r = this.oRoute[k];
      if (r !== 1) routedA = true;
      if (r !== 0) routedB = true;
      const pn = P[k * 16 + O_PAN] + dst[D_OPAN[k]];
      if (pn > 0.001 || pn < -0.001) stereo = true;
    }
    const aL = this.aL, aR = this.aR, bL = this.bL, bR = this.bR;
    for (let i = 0; i < n; i++) aL[i] = aR[i] = bL[i] = bR[i] = 0;
    const inv = 1 / n;
    for (let k = 0; k < 3; k++) {
      const type = this.oT[k];
      if (type === OT_OFF) continue;
      const lv1 = Math.min(1.5, Math.max(0, P[k * 16 + O_LEVEL] + dst[D_OLEVEL[k]]));
      const lv0 = v.olv[k];
      v.olv[k] = lv1;
      const pan = Math.min(1, Math.max(-1, P[k * 16 + O_PAN] + dst[D_OPAN[k]]));
      const gl = stereo ? Math.cos((pan + 1) * 0.7853981633974483) * 1.4142135623730951 : 1;
      const gr = stereo ? Math.sin((pan + 1) * 0.7853981633974483) * 1.4142135623730951 : 1;
      const x = this.oA[k];
      const xr = type === OT_MULTI && P[k * 16 + O_SPREAD] > 0.002 ? this.oB[k] : x;
      const r = this.oRoute[k];
      const dl = (lv1 - lv0) * inv;
      if (r !== 1) {
        let lv = lv0;
        if (stereo) for (let i = 0; i < n; i++, lv += dl) { aL[i] += x[i] * lv * gl; aR[i] += xr[i] * lv * gr; }
        else for (let i = 0; i < n; i++, lv += dl) aL[i] += x[i] * lv;
      }
      if (r !== 0) {
        let lv = lv0;
        if (stereo) for (let i = 0; i < n; i++, lv += dl) { bL[i] += x[i] * lv * gl; bR[i] += xr[i] * lv * gr; }
        else for (let i = 0; i < n; i++, lv += dl) bL[i] += x[i] * lv;
      }
    }
    // ---- filters
    const t1 = this.fT[0], t2 = this.fT[1];
    let oL = aL, oR = aR;
    if (this.serial) {
      if (routedA && t1 !== FT_OFF) this.runFilter(v, 0, aL, aR, n, stereo);
      const l1 = P[FB0 + F_LEVEL];
      for (let i = 0; i < n; i++) bL[i] += aL[i] * l1;
      if (stereo) for (let i = 0; i < n; i++) bR[i] += aR[i] * l1;
      if (t2 !== FT_OFF) {
        this.runFilter(v, 1, bL, bR, n, stereo);
        const l2 = P[FB0 + 12 + F_LEVEL];
        for (let i = 0; i < n; i++) bL[i] *= l2;
        if (stereo) for (let i = 0; i < n; i++) bR[i] *= l2;
      }
      oL = bL;
      oR = bR;
    } else {
      if (routedA && t1 !== FT_OFF) this.runFilter(v, 0, aL, aR, n, stereo);
      if (routedB && t2 !== FT_OFF) this.runFilter(v, 1, bL, bR, n, stereo);
      const l1 = P[FB0 + F_LEVEL], l2 = P[FB0 + 12 + F_LEVEL];
      for (let i = 0; i < n; i++) aL[i] = aL[i] * l1 + bL[i] * l2;
      if (stereo) for (let i = 0; i < n; i++) aR[i] = aR[i] * l1 + bR[i] * l2;
    }
    // ---- distortion
    if (this.distT !== 0) {
      rg[4] = Math.min(1, Math.max(0, P[P_DDRIVE] + dst[D_DDRIVE]));
      rg[5] = Math.min(1, Math.max(0, P[P_DMIX] + dst[D_DMIX]));
      if (rg[5] > 0.0005) this.distort(v, oL, stereo ? oR : null, n);
    }
    // ---- VCA + pan
    const velS = P[P_AVEL];
    const velG = 1 - velS + velS * v.vel;
    const uniN = this.unison > 1 ? 1 / Math.sqrt(this.unison) : 1;
    const g1 = Math.max(0, P[P_AGAIN] * velG * v.env[0].lv * (1 + dst[D_AGAIN])) * VOICE_SCALE * uniN;
    const g0 = v.ampG;
    v.ampG = g1;
    let f0 = 1, f1 = 1;
    if (v.fading) {
      f0 = v.fade;
      f1 = Math.max(0, f0 - n / (0.005 * sr));
      v.fade = f1;
    }
    const p = Math.min(1, Math.max(-1, P[P_APAN] + (this.unison > 1 ? v.uniPos * P[P_USPREAD] : 0) + dst[D_APAN]));
    const pl1 = Math.cos((p + 1) * 0.7853981633974483) * 1.4142135623730951;
    const pr1 = Math.sin((p + 1) * 0.7853981633974483) * 1.4142135623730951;
    const pl0 = v.panL, pr0 = v.panR;
    v.panL = pl1;
    v.panR = pr1;
    const sumL = this.sumL, sumR = this.sumR;
    const srcR = stereo ? oR : oL;
    for (let i = 0; i < n; i++) {
      const f = i * inv;
      const g = (g0 + (g1 - g0) * f) * (f0 + (f1 - f0) * f);
      sumL[i] += oL[i] * g * (pl0 + (pl1 - pl0) * f);
      sumR[i] += srcR[i] * g * (pr0 + (pr1 - pr0) * f);
    }
    // ---- voice end
    if ((v.env[0].st === 0 && !v.gate) || (v.fading && v.fade <= 0)) {
      v.active = false;
      v.fading = false;
      if (this.lastVoice === v) this.lastVoice = null;
    }
  }

  private runFilter(v: Voice, j: number, L: Float64Array, R: Float64Array, n: number, stereo: boolean) {
    const P = this.P, dst = v.dst, b = FB0 + j * 12;
    const pitch = P[b + F_CUT] + P[b + F_KEY] * (v.pitch - 60) + P[b + F_ENV] * v.env[1].lv * 72 + P[b + F_VEL] * v.vel * 48 + dst[D_FCUT[j]] * 96;
    const fl = j === 0 ? v.f1 : v.f2;
    fl.fc = 440 * Math.exp((Math.min(140, Math.max(-20, pitch)) - 69) * LN2_12);
    fl.res = Math.min(1, Math.max(0, P[b + F_RES] + dst[D_FRES[j]]));
    fl.drive = Math.min(1, Math.max(0, P[b + F_DRIVE] + dst[D_FDRIVE[j]]));
    fl.morph = Math.min(1, Math.max(0, P[b + F_MORPH] + dst[D_FMORPH[j]]));
    fl.sr = this.sr;
    fl.process(L, R, n, stereo);
  }

  /** Per-voice distortion; drive / mix in rg[4] / rg[5]. */
  private distort(v: Voice, L: Float64Array, R: Float64Array | null, n: number) {
    const t = this.distT, drive = this.rg[4], mix = this.rg[5];
    if (t === 4) {
      // bit / rate crusher (both channels share the sample-and-hold clock)
      const q = Math.pow(2, 15 - drive * 12.5);
      const hold = 1 + Math.floor(drive * drive * 24);
      let c = v.crc, hl = v.crL, hr = v.crR;
      for (let i = 0; i < n; i++) {
        if (++c >= hold) {
          c = 0;
          hl = Math.round(L[i] * q) / q;
          if (R !== null) hr = Math.round(R[i] * q) / q;
        }
        L[i] += (hl - L[i]) * mix;
        if (R !== null) R[i] += (hr - R[i]) * mix;
      }
      v.crc = c;
      v.crL = hl;
      v.crR = hr;
      return;
    }
    for (let ch = 0; ch < 2; ch++) {
      const b = ch === 0 ? L : R;
      if (b === null) break;
      if (t === 1) {
        // tube: asymmetric soft saturation
        const g = 1 + drive * 14, bias = 0.12, tb = 0.1194904458598726; // ftanh(0.12)
        const comp = 1 / (1 + drive * 1.2);
        for (let i = 0; i < n; i++) {
          const x = b[i];
          let u = x * g + bias;
          u = u > 3 ? 1 : u < -3 ? -1 : (u * (27 + u * u)) / (27 + 9 * u * u);
          b[i] = x + ((u - tb) * comp - x) * mix;
        }
      } else if (t === 2) {
        // sine wavefolder
        const g = (1 + drive * 9) * 1.3;
        for (let i = 0; i < n; i++) {
          const x = b[i];
          b[i] = x + (Math.sin(x * g) * 0.8 - x) * mix;
        }
      } else if (t === 3) {
        // rectifier: identity → half-wave → full-wave
        const g = 1 + drive * 1.5, neg = 1 - 2 * drive, comp = 1 / (1 + drive * 0.6);
        for (let i = 0; i < n; i++) {
          const x = b[i] * g;
          b[i] += ((x >= 0 ? x : x * neg) * comp - b[i]) * mix;
        }
      }
    }
  }

  /** Render oscillator k into oA[k] (and oB[k] for stereo Multi). Increment in rg[0]. Returns true when stereo. */
  private renderOsc(v: Voice, k: number, type: number, n: number, sync: boolean): boolean {
    const P = this.P, dst = v.dst, b = k * 16, rg = this.rg, tw = this.tw, tt = this.tt;
    const inc = rg[0];
    rg[2] = dst[D_OSHAPE[k]];
    rg[3] = dst[D_OPW[k]];
    let fmIn: Float64Array | null = null;
    rg[1] = 0;
    if (k > 0 && this.oT[k - 1] !== OT_OFF) {
      const fa = Math.min(1, Math.max(0, P[b + O_FM] + dst[D_OFM[k]]));
      if (fa > 0.0005) {
        fmIn = this.oA[k - 1];
        rg[1] = fa * fa * 6;
      }
    }
    const tabs = this.tabs.t;
    switch (type) {
      case OT_ANALOG: {
        const wave = Math.min(3, Math.max(0, P[b + O_WAVE] + rg[2] * 3));
        const pw = Math.min(0.97, Math.max(0.03, P[b + O_PW] + rg[3] * 0.5));
        const lev = levelFor(this.tabs, inc * (1 + rg[1]));
        const seg = Math.min(2, wave | 0), f = wave - seg;
        tw[0] = seg === 0 ? 1 - f : 0; // saw
        tw[1] = seg === 1 ? f : seg === 2 ? 1 - f : 0; // triangle
        tw[2] = seg === 2 ? f : 0; // sine
        tw[3] = 0;
        tw[4] = seg === 0 ? f : seg === 1 ? 1 - f : 0; // pulse
        tw[5] = pw;
        tw[6] = 1 / (1 + Math.abs(1 - 2 * pw));
        tt[0] = tabs[SH_SAW][lev];
        tt[1] = tabs[SH_TRI][lev];
        tt[2] = tabs[SH_SIN][0];
        tt[3] = tabs[SH_SIN][0];
        tt[4] = tabs[SH_SAW][lev];
        this.tableOsc(v, k, n, fmIn, sync);
        return false;
      }
      case OT_CHIP: {
        const duty = this.oDuty[k];
        const lev = levelFor(this.tabs, inc * (1 + rg[1]));
        const pw = duty === 0 ? 0.125 : duty === 1 ? 0.25 : 0.5;
        tw[0] = duty === 3 ? 1 : 0;
        tw[1] = tw[2] = tw[3] = 0;
        tw[4] = duty === 3 ? 0 : 1;
        tw[5] = pw;
        tw[6] = 1 / (1 + Math.abs(1 - 2 * pw));
        tt[0] = tt[1] = tt[2] = tt[3] = tabs[SH_CHIP][lev];
        tt[4] = tabs[SH_SAW][lev];
        this.tableOsc(v, k, n, fmIn, sync);
        return false;
      }
      case OT_VECTOR: {
        const x = Math.min(1, Math.max(0, P[b + O_X] + rg[2])), y = Math.min(1, Math.max(0, P[b + O_Y] + rg[3]));
        const lev = levelFor(this.tabs, inc * (1 + rg[1]));
        tw[0] = (1 - x) * (1 - y);
        tw[1] = x * (1 - y);
        tw[2] = (1 - x) * y;
        tw[3] = x * y;
        tw[4] = 0;
        tw[5] = 0.5;
        tw[6] = 1;
        tt[0] = tabs[SH_SIN][0];
        tt[1] = tabs[SH_SAW][lev];
        tt[2] = tabs[SH_ORGAN][lev];
        tt[3] = tabs[SH_VOX][lev];
        tt[4] = tabs[SH_SAW][lev];
        this.tableOsc(v, k, n, fmIn, sync);
        return false;
      }
      case OT_MULTI: return this.multiOsc(v, k, n, fmIn);
      case OT_FM: return this.fmOsc(v, k, n, fmIn, false);
      case OT_PM: return this.fmOsc(v, k, n, fmIn, true);
      case OT_NOISE: return this.noiseOsc(v, k, n);
    }
    return false;
  }

  /** Waveform value at phase (used only on the hard-sync path). */
  private mixAt(ph: number): number {
    const w = this.tw, t = this.tt;
    let y = 0;
    if (w[0] !== 0) y += w[0] * lk(t[0], ph);
    if (w[1] !== 0) y += w[1] * lk(t[1], ph);
    if (w[2] !== 0) y += w[2] * lk(t[2], ph);
    if (w[3] !== 0) y += w[3] * lk(t[3], ph);
    if (w[4] !== 0) {
      let p2 = ph + w[5];
      if (p2 >= 1) p2 -= 1;
      y += w[4] * w[6] * (lk(t[4], ph) - lk(t[4], p2));
    }
    return y;
  }

  /**
   * Weighted sum of up to four band-limited tables + a band-limited pulse (difference of two saws);
   * FM through-zero, hard sync with PolyBLEP-corrected resets. Output is delayed by one sample so the
   * BLEP residual can also correct the sample before the reset.
   */
  private tableOsc(v: Voice, k: number, n: number, fmIn: Float64Array | null, sync: boolean) {
    const rg = this.rg, tw = this.tw, tt = this.tt, out = this.oA[k];
    const inc = rg[0], fmDepth = rg[1];
    const w0 = tw[0], w1 = tw[1], w2 = tw[2], w3 = tw[3], wp = tw[4], pw = tw[5], wpn = tw[4] * tw[6];
    const t0 = tt[0], t1 = tt[1], t2 = tt[2], t3 = tt[3], ts = tt[4];
    let ph = v.ph[k], prev = v.prev[k];
    const sb = this.syncBuf;
    for (let i = 0; i < n; i++) {
      let di = inc;
      if (fmIn !== null) di = inc * (1 + fmDepth * fmIn[i]);
      ph += di;
      if (ph >= 1 || ph < 0) ph -= Math.floor(ph);
      let y = 0;
      if (sync && sb[i] >= 0) {
        const d = sb[i];
        let pa = ph - di * d;
        pa -= Math.floor(pa);
        const before = this.mixAt(pa);
        ph = di * d;
        ph -= Math.floor(ph);
        const h = this.mixAt(0) - before;
        y = this.mixAt(ph) - h * (1 - d) * (1 - d) * 0.5;
        prev += h * d * d * 0.5;
      } else {
        const x = ph * 2048;
        const ii = x | 0;
        const fr = x - ii;
        if (w0 !== 0) y += w0 * (t0[ii] + fr * (t0[ii + 1] - t0[ii]));
        if (w1 !== 0) y += w1 * (t1[ii] + fr * (t1[ii + 1] - t1[ii]));
        if (w2 !== 0) y += w2 * (t2[ii] + fr * (t2[ii + 1] - t2[ii]));
        if (w3 !== 0) y += w3 * (t3[ii] + fr * (t3[ii + 1] - t3[ii]));
        if (wp !== 0) {
          let p2 = ph + pw;
          if (p2 >= 1) p2 -= 1;
          const x2 = p2 * 2048;
          const i2 = x2 | 0;
          const f2 = x2 - i2;
          y += wpn * (ts[ii] + fr * (ts[ii + 1] - ts[ii]) - (ts[i2] + f2 * (ts[i2 + 1] - ts[i2])));
        }
      }
      out[i] = prev;
      prev = y;
    }
    v.ph[k] = ph;
    v.prev[k] = prev;
  }

  /** Supersaw-style stack of 2–8 detuned saw/pulse voices with stereo spread. */
  private multiOsc(v: Voice, k: number, n: number, fmIn: Float64Array | null): boolean {
    const P = this.P, b = k * 16, rg = this.rg;
    const inc = rg[0], fmDepth = rg[1];
    const K = this.oVoices[k];
    const det = Math.min(1, Math.max(0, P[b + O_DETUNE] + rg[2]));
    const spread = Math.min(1, Math.max(0, P[b + O_SPREAD] + rg[3]));
    const wave = Math.min(1, Math.max(0, P[b + O_WAVE]));
    const stereo = P[b + O_SPREAD] > 0.002;
    const outL = this.oA[k], outR = this.oB[k];
    for (let i = 0; i < n; i++) outL[i] = outR[i] = 0;
    const span = Math.pow(det, 1.5) * 0.9; // semitones at the outer voices
    const norm = 1.25 / Math.sqrt(K);
    let maxInc = inc;
    for (let j = 0; j < K; j++) {
      const pos = (j / (K - 1)) * 2 - 1;
      this.minc[j] = inc * Math.exp(pos * span * LN2_12 * (pos > -0.999 && pos < 0.999 ? 0.92 : 1));
      if (this.minc[j] > maxInc) maxInc = this.minc[j];
      const pp = spread * ((((j * 5) % K) / (K - 1)) * 2 - 1);
      this.mgl[j] = Math.sqrt(0.5 * (1 - pp)) * 1.4142135623730951 * norm;
      this.mgr[j] = Math.sqrt(0.5 * (1 + pp)) * 1.4142135623730951 * norm;
    }
    const lev = levelFor(this.tabs, maxInc * (1 + fmDepth));
    const ts = this.tabs.t[SH_SAW][lev], tq = this.tabs.t[SH_SQR][lev];
    const ws = 1 - wave, wq = wave;
    for (let j = 0; j < K; j++) {
      let ph = v.mph[k * 8 + j];
      const di0 = this.minc[j], gl = this.mgl[j], gr = this.mgr[j];
      for (let i = 0; i < n; i++) {
        ph += fmIn !== null ? di0 * (1 + fmDepth * fmIn[i]) : di0;
        if (ph >= 1 || ph < 0) ph -= Math.floor(ph);
        const x = ph * 2048;
        const ii = x | 0;
        const fr = x - ii;
        let y = ws * (ts[ii] + fr * (ts[ii + 1] - ts[ii]));
        if (wq !== 0) y += wq * (tq[ii] + fr * (tq[ii + 1] - tq[ii]));
        outL[i] += y * gl;
        outR[i] += y * gr;
      }
      v.mph[k * 8 + j] = ph;
    }
    if (!stereo) for (let i = 0; i < n; i++) outL[i] = (outL[i] + outR[i]) * 0.5;
    return stereo;
  }

  /** 2-operator FM (through-zero, sine/sine) or PM (shape-morphing modulator). */
  private fmOsc(v: Voice, k: number, n: number, fmIn: Float64Array | null, pm: boolean): boolean {
    const P = this.P, b = k * 16, rg = this.rg;
    const inc = rg[0], fmDepth = rg[1];
    const ratio = P[b + O_RATIO];
    let index = Math.min(10, Math.max(0, P[b + O_INDEX] + rg[2] * 10));
    const minc = inc * ratio;
    // keep sidebands below Nyquist (Carson): (I + 1)·fm + fc < 0.45·sr
    const imax = Math.max(0, (0.45 - inc) / Math.max(1e-9, minc) - 1);
    if (index > imax) index = imax;
    const fb = P[b + O_FB] * 0.3;
    const sin = this.tabs.t[SH_SIN][0];
    let pc = v.ph[k], pmod = v.ph2[k], mprev = v.mfb[k];
    const out = this.oA[k];
    if (!pm) {
      const dev = index * ratio;
      // feedback gives the modulator a DC offset, which through-zero FM would turn into a pitch shift
      let dc = v.mdc[k];
      const dcc = fb > 0 ? 1 - Math.exp((-TWO_PI * 8) / this.sr) : 0;
      for (let i = 0; i < n; i++) {
        let mp = pmod + fb * mprev;
        mp -= Math.floor(mp);
        const mx = mp * 2048, mi = mx | 0;
        const m = sin[mi] + (mx - mi) * (sin[mi + 1] - sin[mi]);
        mprev = m;
        dc += dcc * (m - dc);
        pmod += minc;
        if (pmod >= 1) pmod -= 1;
        let di = inc * (1 + dev * (m - dc));
        if (fmIn !== null) di += inc * fmDepth * fmIn[i];
        pc += di;
        if (pc >= 1 || pc < 0) pc -= Math.floor(pc);
        const cx = pc * 2048, ci = cx | 0;
        out[i] = sin[ci] + (cx - ci) * (sin[ci + 1] - sin[ci]);
      }
      v.mdc[k] = dc;
    } else {
      // phase modulation; modulator shape morphs sine → triangle → saw → square (band-limited)
      const wave = Math.min(3, Math.max(0, P[b + O_WAVE]));
      // fewer modulator partials as the index grows, so PM sidebands stay below Nyquist
      const lev = levelFor(this.tabs, minc * (1 + index * 2.5 + inc / Math.max(1e-9, minc)));
      const seg = Math.min(2, wave | 0), f = wave - seg;
      const tA = this.tabs.t[seg === 0 ? SH_SIN : seg === 1 ? SH_TRI : SH_SAW][seg === 0 ? 0 : lev];
      const tB = this.tabs.t[seg === 0 ? SH_TRI : seg === 1 ? SH_SAW : SH_SQR][lev];
      const ia = (1 - f) * index * 0.159, ib = f * index * 0.159;
      for (let i = 0; i < n; i++) {
        let mp = pmod + fb * mprev;
        mp -= Math.floor(mp);
        const mx = mp * 2048, mi = mx | 0, mf = mx - mi;
        const ma = tA[mi] + mf * (tA[mi + 1] - tA[mi]);
        const mb = tB[mi] + mf * (tB[mi + 1] - tB[mi]);
        mprev = ma * (1 - f) + mb * f;
        pmod += minc;
        if (pmod >= 1) pmod -= 1;
        pc += fmIn !== null ? inc * (1 + fmDepth * fmIn[i]) : inc;
        if (pc >= 1 || pc < 0) pc -= Math.floor(pc);
        let p = pc + ia * ma + ib * mb;
        p -= Math.floor(p);
        const cx = p * 2048, ci = cx | 0;
        out[i] = sin[ci] + (cx - ci) * (sin[ci + 1] - sin[ci]);
      }
    }
    v.ph[k] = pc;
    v.ph2[k] = pmod;
    v.mfb[k] = mprev;
    return false;
  }

  /** White / pink / crackle noise with a tilt colour filter. */
  private noiseOsc(v: Voice, k: number, n: number): boolean {
    const P = this.P, sr = this.sr;
    const color = Math.min(1, Math.max(0, P[k * 16 + O_COLOR] + this.rg[2]));
    const out = this.oA[k];
    const kind = this.oNoise[k];
    let seed = v.rng.s;
    const pk = k * 3;
    if (kind === 2) {
      // crackle: sparse random impulses through a short decay
      const dens = (8 + color * color * 1600) / sr;
      let e = v.crk[pk], hp = v.crk[pk + 1];
      const dec = Math.exp(-1 / (0.0004 * sr));
      for (let i = 0; i < n; i++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        const r = (seed | 0) * 4.656612873077393e-10;
        if (r * 0.5 + 0.5 < dens) e += (r * 7919 - Math.floor(r * 7919) - 0.5) * 3.2;
        e *= dec;
        const y = e - hp;
        hp += 0.05 * y;
        out[i] = y;
      }
      v.crk[pk] = e;
      v.crk[pk + 1] = hp;
      v.rng.s = seed;
      return false;
    }
    let b0 = v.pink[pk], b1 = v.pink[pk + 1], b2 = v.pink[pk + 2];
    let lp = v.nlp[k * 2], lp2 = v.nlp[k * 2 + 1];
    // colour: < 0.5 low-pass (dark), > 0.5 high-pass (bright)
    const dark = color < 0.5;
    const fc = dark ? 200 * Math.pow(100, color * 2) : 60 * Math.pow(80, (color - 0.5) * 2);
    const c = 1 - Math.exp((-TWO_PI * Math.min(fc, sr * 0.45)) / sr);
    const amt = dark ? 1 : (color - 0.5) * 2;
    const pink = kind === 1;
    for (let i = 0; i < n; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const w = (seed | 0) * 4.656612873077393e-10;
      let x: number;
      if (pink) {
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        x = (b0 + b1 + b2 + w * 0.1848) * 0.28;
      } else x = w * 0.75;
      lp += c * (x - lp);
      let y: number;
      if (dark) y = lp;
      else {
        lp2 = x - lp;
        y = x + (lp2 - x) * amt;
      }
      out[i] = y;
    }
    v.pink[pk] = b0;
    v.pink[pk + 1] = b1;
    v.pink[pk + 2] = b2;
    v.nlp[k * 2] = lp;
    v.nlp[k * 2 + 1] = lp2;
    v.rng.s = seed;
    return false;
  }

  // ======================= visualisation =======================
  // reused visualisation payload (posted ~30×/s while the UI is open; structured-cloned by postMessage)
  private viz = { e: [0, 0, 0], es: [0, 0, 0], l: [0, 0, 0, 0], lp: [0, 0, 0, 0], s: -1, v: 0, k: -1, m: [0, 0, 0, 0] };
  protected vizData() {
    let nv = 0;
    for (let i = 0; i < MAXV; i++) if (this.voices[i].active && !this.voices[i].fading) nv++;
    const lv = this.lastVoice !== null && this.lastVoice.active ? this.lastVoice : null;
    const z = this.viz;
    for (let e = 0; e < 3; e++) {
      z.e[e] = lv !== null ? lv.env[e].lv : 0;
      z.es[e] = lv !== null ? lv.env[e].st : 0;
    }
    for (let l = 0; l < 4; l++) {
      z.l[l] = lv !== null ? lv.lfo[l].val * lv.lfo[l].fade : this.glfo[l].val;
      z.lp[l] = lv !== null ? lv.lfo[l].ph : this.glfo[l].ph;
      z.m[l] = this.mac[l];
    }
    z.s = this.arpOn && this.arpRun ? this.arpViz : -1;
    z.v = nv;
    z.k = lv !== null ? lv.key : -1;
    return z;
  }
}

registerProcessor('lf-rune', RuneProcessor);
