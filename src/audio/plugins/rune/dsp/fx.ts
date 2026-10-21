// Rune — post-voice effects in series: chorus → phaser → flanger → delay → reverb.
// All buffers are allocated in the constructor; process() never allocates.

export class FxSettings {
  chOn = false; chMix = 0; chRate = 0.5; chDepth = 0.5;
  phOn = false; phMix = 0; phRate = 0.3; phDepth = 0.7; phFb = 0.5;
  flOn = false; flMix = 0; flRate = 0.2; flDepth = 0.6; flFb = 0.5;
  dlOn = false; dlMix = 0; dlTime = 0.375; dlFb = 0.35; dlTone = 0.6; dlPP = true;
  rvOn = false; rvMix = 0; rvSize = 0.6; rvDamp = 0.4; rvPre = 0.01;
}

const pow2 = (n: number) => {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
};

/** Linear-interpolated read `d` samples behind write index `w`. */
function tap(buf: Float32Array, mask: number, w: number, d: number): number {
  const rp = w - d;
  const i = Math.floor(rp);
  const f = rp - i;
  const a = buf[i & mask];
  return a + (buf[(i + 1) & mask] - a) * f;
}

const RV_BASE = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const RV_DIFF = [142, 107, 379, 277];

export class FxChain {
  private sr: number;
  // smoothed effective mixes (fade in/out on enable)
  private m = new Float64Array(5);
  private live = [false, false, false, false, false];
  // chorus
  private chL: Float32Array; private chR: Float32Array; private chMask: number; private chW = 0; private chPh = 0;
  // phaser
  private phZ = new Float64Array(12); private phFbL = 0; private phFbR = 0; private phPh = 0;
  // flanger
  private flL: Float32Array; private flR: Float32Array; private flMask: number; private flW = 0; private flPh = 0; private flFbL = 0; private flFbR = 0; private flDl = 0;
  // delay
  private dlL: Float32Array; private dlR: Float32Array; private dlMask: number; private dlW = 0; private dlCur = -1;
  private dlLpL = 0; private dlLpR = 0; private dlHpL = 0; private dlHpR = 0;
  // reverb
  private rvLines: Float32Array[] = []; private rvMask: number; private rvW = 0; private rvLen = new Int32Array(8);
  private rvLp = new Float64Array(8); private rvG = new Float64Array(8); private rvSizeCur = -1; private rvDampC = 0;
  private rvDiff: Float32Array[] = []; private rvDiffLen = new Int32Array(4); private rvDiffMask: number; private rvDiffW = 0;
  private rvPreBuf: Float32Array; private rvPreMask: number; private rvPreW = 0;
  private o = new Float64Array(8);
  private tg = new Float64Array(5);
  private m0 = 0;
  private m1 = 0;

  constructor(sr: number) {
    this.sr = sr;
    this.chMask = pow2(Math.ceil(sr * 0.04)) - 1;
    this.chL = new Float32Array(this.chMask + 1);
    this.chR = new Float32Array(this.chMask + 1);
    this.flMask = pow2(Math.ceil(sr * 0.02)) - 1;
    this.flL = new Float32Array(this.flMask + 1);
    this.flR = new Float32Array(this.flMask + 1);
    this.dlMask = pow2(Math.ceil(sr * 4.2)) - 1;
    this.dlL = new Float32Array(this.dlMask + 1);
    this.dlR = new Float32Array(this.dlMask + 1);
    const sc = sr / 44100;
    this.rvMask = pow2(Math.ceil(1617 * 1.7 * sc) + 4) - 1;
    for (let i = 0; i < 8; i++) this.rvLines.push(new Float32Array(this.rvMask + 1));
    this.rvDiffMask = pow2(Math.ceil(400 * sc) + 2) - 1;
    for (let i = 0; i < 4; i++) {
      this.rvDiff.push(new Float32Array(this.rvDiffMask + 1));
      this.rvDiffLen[i] = Math.round(RV_DIFF[i] * sc);
    }
    this.rvPreMask = pow2(Math.ceil(sr * 0.22)) - 1;
    this.rvPreBuf = new Float32Array(this.rvPreMask + 1);
  }

  private clear(k: number) {
    if (k === 0) { this.chL.fill(0); this.chR.fill(0); }
    else if (k === 1) { this.phZ.fill(0); this.phFbL = this.phFbR = 0; }
    else if (k === 2) { this.flL.fill(0); this.flR.fill(0); this.flFbL = this.flFbR = 0; }
    else if (k === 3) { this.dlL.fill(0); this.dlR.fill(0); this.dlLpL = this.dlLpR = this.dlHpL = this.dlHpR = 0; }
    else { for (const l of this.rvLines) l.fill(0); for (const d of this.rvDiff) d.fill(0); this.rvPreBuf.fill(0); this.rvLp.fill(0); }
  }

  /** true while any effect still has signal to output (for idle detection). */
  get active() {
    return this.live[0] || this.live[1] || this.live[2] || this.live[3] || this.live[4];
  }

  process(L: Float64Array, R: Float64Array, n: number, s: FxSettings, mods: Float64Array) {
    const k = 1 - Math.exp(-n / (0.02 * this.sr));
    const tg = this.tg;
    tg[0] = s.chOn ? clamp01(s.chMix + mods[0]) : 0;
    tg[1] = s.phOn ? clamp01(s.phMix + mods[1]) : 0;
    tg[2] = s.flOn ? clamp01(s.flMix + mods[2]) : 0;
    tg[3] = s.dlOn ? clamp01(s.dlMix + mods[3]) : 0;
    tg[4] = s.rvOn ? clamp01(s.rvMix + mods[4]) : 0;
    for (let i = 0; i < 5; i++) {
      const was = this.live[i];
      const m0 = this.m[i];
      this.m[i] += (tg[i] - this.m[i]) * k;
      if (tg[i] === 0 && this.m[i] < 1e-4) {
        this.m[i] = 0;
        if (was) {
          this.live[i] = false;
          this.clear(i);
        }
        continue;
      }
      if (!was) this.live[i] = true;
      this.m0 = m0;
      this.m1 = this.m[i];
      switch (i) {
        case 0: this.chorus(L, R, n, s); break;
        case 1: this.phaser(L, R, n, s); break;
        case 2: this.flanger(L, R, n, s); break;
        case 3: this.delay(L, R, n, s); break;
        case 4: this.reverb(L, R, n, s); break;
      }
    }
  }

  private chorus(L: Float64Array, R: Float64Array, n: number, s: FxSettings) {
    const m0 = this.m0, m1 = this.m1;
    const sr = this.sr, mask = this.chMask, bl = this.chL, br = this.chR;
    const base = 0.0075 * sr, sw = (0.0005 + s.chDepth * 0.0065) * sr;
    const ph0 = this.chPh;
    const dph = (s.chRate * n) / sr;
    const T = 6.283185307179586;
    // four taps (two per side), delay times ramped linearly across the block
    const a0 = base + sw * (1 + Math.sin(T * ph0)), a1 = base + sw * (1 + Math.sin(T * (ph0 + dph)));
    const b0 = base + sw * (1 + Math.sin(T * (ph0 + 0.33))), b1 = base + sw * (1 + Math.sin(T * (ph0 + 0.33 + dph)));
    const c0 = base + sw * (1 + Math.sin(T * (ph0 + 0.17))), c1 = base + sw * (1 + Math.sin(T * (ph0 + 0.17 + dph)));
    const d0 = base + sw * (1 + Math.sin(T * (ph0 + 0.58))), d1 = base + sw * (1 + Math.sin(T * (ph0 + 0.58 + dph)));
    this.chPh = (ph0 + dph) % 1;
    let w = this.chW;
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      const f = i * inv;
      const mx = m0 + (m1 - m0) * f;
      const xl = L[i], xr = R[i];
      bl[w & mask] = xl;
      br[w & mask] = xr;
      const wl = 0.5 * (tap(bl, mask, w, a0 + (a1 - a0) * f) + tap(bl, mask, w, b0 + (b1 - b0) * f));
      const wr = 0.5 * (tap(br, mask, w, c0 + (c1 - c0) * f) + tap(br, mask, w, d0 + (d1 - d0) * f));
      L[i] = xl * (1 - 0.45 * mx) + wl * 0.85 * mx;
      R[i] = xr * (1 - 0.45 * mx) + wr * 0.85 * mx;
      w++;
    }
    this.chW = w & mask;
  }

  private phaser(L: Float64Array, R: Float64Array, n: number, s: FxSettings) {
    const m0 = this.m0, m1 = this.m1;
    const sr = this.sr, z = this.phZ;
    const T = 6.283185307179586;
    this.phPh = (this.phPh + (s.phRate * n) / sr) % 1;
    const aL = this.apCoef(Math.sin(T * this.phPh), s.phDepth), aR = this.apCoef(Math.sin(T * (this.phPh + 0.25)), s.phDepth);
    const fb = s.phFb * 0.9;
    let fl = this.phFbL, fr = this.phFbR;
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      const mx = m0 + (m1 - m0) * i * inv;
      let x = L[i] + fb * fl;
      for (let st = 0; st < 6; st++) {
        const y = aL * x + z[st];
        z[st] = x - aL * y;
        x = y;
      }
      fl = x;
      let y2 = R[i] + fb * fr;
      for (let st = 6; st < 12; st++) {
        const y = aR * y2 + z[st];
        z[st] = y2 - aR * y;
        y2 = y;
      }
      fr = y2;
      L[i] = L[i] * (1 - 0.5 * mx) + x * 0.5 * mx;
      R[i] = R[i] * (1 - 0.5 * mx) + y2 * 0.5 * mx;
    }
    this.phFbL = fl + 1e-20;
    this.phFbR = fr + 1e-20;
  }

  private apCoef(lfo: number, depth: number) {
    const f = Math.min(this.sr * 0.4, 650 * Math.pow(2, depth * 3.3 * lfo));
    const t = Math.tan((Math.PI * f) / this.sr);
    return (t - 1) / (t + 1);
  }
  private flDelay(p: number, depth: number) {
    return (0.0003 + depth * 0.0045 * (0.5 + 0.5 * Math.sin(6.283185307179586 * p))) * this.sr;
  }

  private flanger(L: Float64Array, R: Float64Array, n: number, s: FxSettings) {
    const m0 = this.m0, m1 = this.m1;
    const sr = this.sr, mask = this.flMask, bl = this.flL, br = this.flR;
    const ph0 = this.flPh, dph = (s.flRate * n) / sr;
    this.flPh = (ph0 + dph) % 1;
    const dp = s.flDepth;
    const l0 = this.flDelay(ph0, dp), l1 = this.flDelay(ph0 + dph, dp), r0 = this.flDelay(ph0 + 0.25, dp), r1 = this.flDelay(ph0 + 0.25 + dph, dp);
    const fb = s.flFb;
    let w = this.flW, fl = this.flFbL, fr = this.flFbR;
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      const f = i * inv;
      const mx = m0 + (m1 - m0) * f;
      const xl = L[i], xr = R[i];
      bl[w & mask] = xl + fb * fl;
      br[w & mask] = xr + fb * fr;
      fl = tap(bl, mask, w, l0 + (l1 - l0) * f);
      fr = tap(br, mask, w, r0 + (r1 - r0) * f);
      L[i] = xl * (1 - 0.5 * mx) + fl * 0.5 * mx;
      R[i] = xr * (1 - 0.5 * mx) + fr * 0.5 * mx;
      w++;
    }
    this.flW = w & mask;
    this.flFbL = fl + 1e-20;
    this.flFbR = fr + 1e-20;
    void this.flDl;
  }

  private delay(L: Float64Array, R: Float64Array, n: number, s: FxSettings) {
    const m0 = this.m0, m1 = this.m1;
    const sr = this.sr, mask = this.dlMask, bl = this.dlL, br = this.dlR;
    const target = Math.min(mask - 4, Math.max(16, s.dlTime * sr));
    if (this.dlCur < 0) this.dlCur = target;
    const d0 = this.dlCur;
    const d1 = d0 + (target - d0) * (1 - Math.exp(-n / (0.08 * sr)));
    this.dlCur = d1;
    const fb = s.dlFb;
    const lpc = 1 - Math.exp((-2 * Math.PI * (900 + s.dlTone * s.dlTone * 15000)) / sr);
    const hpc = 1 - Math.exp((-2 * Math.PI * 90) / sr);
    const pp = s.dlPP;
    let w = this.dlW, lpL = this.dlLpL, lpR = this.dlLpR, hpL = this.dlHpL, hpR = this.dlHpR;
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      const f = i * inv;
      const mx = m0 + (m1 - m0) * f;
      const dd = d0 + (d1 - d0) * f;
      const xl = L[i], xr = R[i];
      let yl = tap(bl, mask, w, dd), yr = tap(br, mask, w, dd);
      lpL += lpc * (yl - lpL);
      lpR += lpc * (yr - lpR);
      hpL += hpc * (lpL - hpL);
      hpR += hpc * (lpR - hpR);
      yl = lpL - hpL;
      yr = lpR - hpR;
      if (pp) {
        bl[w & mask] = (xl + xr) * 0.5 + fb * yr + 1e-20;
        br[w & mask] = fb * yl + 1e-20;
      } else {
        bl[w & mask] = xl + fb * yl + 1e-20;
        br[w & mask] = xr + fb * yr + 1e-20;
      }
      L[i] = xl + yl * mx;
      R[i] = xr + yr * mx;
      w++;
    }
    this.dlW = w & mask;
    this.dlLpL = lpL; this.dlLpR = lpR; this.dlHpL = hpL; this.dlHpR = hpR;
  }

  private reverb(L: Float64Array, R: Float64Array, n: number, s: FxSettings) {
    const m0 = this.m0, m1 = this.m1;
    const sr = this.sr;
    if (Math.abs(s.rvSize - this.rvSizeCur) > 0.004) {
      this.rvSizeCur = s.rvSize;
      const sc = (sr / 44100) * (0.45 + s.rvSize * 1.2);
      const rt = 0.35 + s.rvSize * s.rvSize * 7.5;
      for (let i = 0; i < 8; i++) {
        this.rvLen[i] = Math.min(this.rvMask - 2, Math.round(RV_BASE[i] * sc));
        this.rvG[i] = Math.pow(10, (-3 * this.rvLen[i]) / (rt * sr));
      }
    }
    this.rvDampC = 0.05 + s.rvDamp * 0.8;
    const lines = this.rvLines, mask = this.rvMask, len = this.rvLen, g = this.rvG, lp = this.rvLp, o = this.o;
    const dif = this.rvDiff, dl = this.rvDiffLen, dmask = this.rvDiffMask;
    const pre = this.rvPreBuf, pmask = this.rvPreMask, preD = Math.max(1, Math.round(s.rvPre * sr));
    const dc = this.rvDampC;
    let w = this.rvW, dw = this.rvDiffW, pw = this.rvPreW;
    const H = 0.35355339059327373;
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      const mx = m0 + (m1 - m0) * i * inv;
      const xl = L[i], xr = R[i];
      pre[pw & pmask] = (xl + xr) * 0.5;
      let x = pre[(pw - preD) & pmask];
      pw++;
      // input diffusion (4 series all-passes)
      for (let j = 0; j < 4; j++) {
        const buf = dif[j];
        const dly = buf[(dw - dl[j]) & dmask];
        const v = x + 0.62 * dly;
        buf[dw & dmask] = v;
        x = dly - 0.62 * v;
      }
      dw++;
      for (let j = 0; j < 8; j++) {
        const y = lines[j][(w - len[j]) & mask];
        lp[j] = y + dc * (lp[j] - y);
        o[j] = lp[j];
      }
      // 8×8 Hadamard feedback matrix
      const a0 = o[0] + o[1], a1 = o[0] - o[1], a2 = o[2] + o[3], a3 = o[2] - o[3];
      const a4 = o[4] + o[5], a5 = o[4] - o[5], a6 = o[6] + o[7], a7 = o[6] - o[7];
      const b0 = a0 + a2, b2 = a0 - a2, b1 = a1 + a3, b3 = a1 - a3;
      const b4 = a4 + a6, b6 = a4 - a6, b5 = a5 + a7, b7 = a5 - a7;
      const xin = x * 0.6;
      lines[0][w & mask] = (b0 + b4) * H * g[0] + xin + 1e-20;
      lines[1][w & mask] = (b1 + b5) * H * g[1] - xin;
      lines[2][w & mask] = (b2 + b6) * H * g[2] + xin;
      lines[3][w & mask] = (b3 + b7) * H * g[3] - xin;
      lines[4][w & mask] = (b0 - b4) * H * g[4] + xin;
      lines[5][w & mask] = (b1 - b5) * H * g[5] - xin;
      lines[6][w & mask] = (b2 - b6) * H * g[6] + xin;
      lines[7][w & mask] = (b3 - b7) * H * g[7] - xin;
      w++;
      const wl = (o[0] - o[2] + o[4] - o[6]) * 0.5;
      const wr = (o[1] - o[3] + o[5] - o[7]) * 0.5;
      L[i] = xl + wl * mx;
      R[i] = xr + wr * mx;
    }
    this.rvW = w & mask;
    this.rvDiffW = dw & dmask;
    this.rvPreW = pw & pmask;
  }
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
