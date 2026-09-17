/**
 * filters — Digital filter design and application.
 *
 * Mirrors `scipy.signal` filter utilities. Implemented from scratch with no
 * external dependencies.
 *
 * Filter design:
 * - {@link firwin}    — FIR filter (windowed-sinc method)
 * - {@link butter}    — Butterworth IIR digital filter
 *
 * Frequency response:
 * - {@link freqz}     — frequency response of an FIR/IIR filter
 * - {@link sosfreqz}  — frequency response of SOS filter
 *
 * Filter application:
 * - {@link lfilter}   — causal FIR/IIR filter (direct-form II transposed)
 * - {@link filtfilt}  — zero-phase forward-backward filter
 * - {@link sosfilt}   — second-order-sections filter
 *
 * @example
 * ```ts
 * import { firwin, lfilter, butter, sosfilt } from "tsb";
 *
 * // Low-pass FIR with 29 taps, cutoff 0.25 (Nyquist = 0.5)
 * const b = firwin(29, 0.25);
 * const y = lfilter(b, [1], signal);
 *
 * // Butterworth low-pass, order 4, cutoff 0.2
 * const { sos } = butter(4, 0.2, "lowpass");
 * const filtered = sosfilt(sos, signal);
 * ```
 *
 * @module
 */

import {
  type Complex,
  type WindowName,
  blackmanWindow,
  cAbs,
  complex,
  hammingWindow,
  hannWindow,
  kaiserWindow,
} from "./signal.ts";

// ─── internal helpers ─────────────────────────────────────────────────────────

/** sinc(x) = sin(πx) / (πx), sinc(0) = 1 (normalised). */
function sinc(x: number): number {
  if (x === 0) {
    return 1;
  }
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/** Polynomial multiplication (convolution). */
function polyMul(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      out[i + j] = (out[i + j] ?? 0) + (a[i] ?? 0) * (b[j] ?? 0);
    }
  }
  return out;
}

// ─── FIR filter design ────────────────────────────────────────────────────────

/** Options for {@link firwin}. */
export interface FirwinOptions {
  /**
   * Window to apply after ideal filter: name string or pre-computed array.
   * Default `"hamming"`.
   */
  window?: WindowName | readonly number[];
  /** If `true`, design a high-pass filter (default `false` = low-pass). */
  pass_zero?: boolean;
  /** Sampling rate used to normalise `cutoff` (default `2` so `cutoff ∈ [0, 1]`). */
  fs?: number;
}

/**
 * Design a low- or high-pass FIR filter using the windowed-sinc method.
 *
 * Mirrors `scipy.signal.firwin`.
 *
 * @param numtaps - Number of filter coefficients (must be odd for pass_zero=false).
 * @param cutoff  - Cutoff frequency. With default `fs=2`, cutoff is normalised
 *                  so `1.0` equals the Nyquist frequency.
 * @param options - {@link FirwinOptions}.
 * @returns       - FIR filter coefficients `b` (length `numtaps`).
 *
 * @example
 * ```ts
 * import { firwin, lfilter } from "tsb";
 * const b = firwin(51, 0.3);              // 51-tap 150 Hz LPF (fs=1000)
 * const y = lfilter(b, [1], signal);
 * ```
 */
export function firwin(
  numtaps: number,
  cutoff: number | readonly [number, number],
  options: FirwinOptions = {},
): number[] {
  const fs = options.fs ?? 2;
  const passZero = options.pass_zero ?? true;
  const nyq = fs / 2;

  // Normalise cutoff(s) to [0..1] where 1 = Nyquist
  const cuts = (typeof cutoff === "number" ? [cutoff] : cutoff).map((c) => c / nyq);

  const M = numtaps - 1;

  // Build window
  let win: number[];
  if (options.window !== undefined) {
    win =
      typeof options.window === "string"
        ? buildFirWindow(options.window, numtaps)
        : Array.from(options.window);
  } else {
    win = hammingWindow(numtaps);
  }

  // Ideal sinc coefficients
  const h = new Array<number>(numtaps).fill(0);

  if (cuts.length === 1) {
    const fc = cuts[0] ?? 0;
    if (passZero) {
      // Low-pass: h[n] = fc * sinc(fc * (n - M/2))
      for (let n = 0; n < numtaps; n++) {
        h[n] = fc * sinc(fc * (n - M / 2)) * (win[n] ?? 1);
      }
    } else {
      // High-pass: h[n] = delta(n - M/2) - fc * sinc(fc * (n - M/2))
      for (let n = 0; n < numtaps; n++) {
        const delta = n === M / 2 ? 1 : 0;
        h[n] = (delta - fc * sinc(fc * (n - M / 2))) * (win[n] ?? 1);
      }
    }
  } else {
    // Band-pass or band-stop
    const f1 = cuts[0] ?? 0;
    const f2 = cuts[1] ?? 0;
    if (passZero) {
      // Band-stop (notch): LP(f1) + HP(f2)
      for (let n = 0; n < numtaps; n++) {
        const mid = M / 2;
        const delta = n === mid ? 1 : 0;
        h[n] = (f1 * sinc(f1 * (n - mid)) + (delta - f2 * sinc(f2 * (n - mid)))) * (win[n] ?? 1);
      }
    } else {
      // Band-pass: BP(f1, f2) = LP(f2) - LP(f1)
      for (let n = 0; n < numtaps; n++) {
        const mid = M / 2;
        h[n] = (f2 * sinc(f2 * (n - mid)) - f1 * sinc(f1 * (n - mid))) * (win[n] ?? 1);
      }
    }
  }

  // Normalise DC gain
  const dcGain = h.reduce((s, v) => s + v, 0);
  if (Math.abs(dcGain) > 1e-12 && passZero && cuts.length === 1) {
    // Low-pass: normalise DC to 1
    const scale = 1 / dcGain;
    return h.map((v) => v * scale);
  }
  return h;
}

/** Build a named window for FIR design. */
function buildFirWindow(name: WindowName, n: number): number[] {
  switch (name) {
    case "hamming":
      return hammingWindow(n);
    case "hann":
      return hannWindow(n);
    case "blackman":
      return blackmanWindow(n);
    case "kaiser":
      return kaiserWindow(n, 14);
    default:
      return hammingWindow(n);
  }
}

// ─── frequency response ───────────────────────────────────────────────────────

/** Result of {@link freqz} and {@link sosfreqz}. */
export interface FreqzResult {
  /** Angular frequencies in radians/sample (0 to π). */
  w: number[];
  /** Complex frequency response H(e^jω). */
  H: Complex[];
}

/**
 * Compute the frequency response H(e^jω) of a digital filter.
 *
 * Mirrors `scipy.signal.freqz`.
 *
 * @param b    - Numerator polynomial coefficients.
 * @param a    - Denominator polynomial coefficients (default `[1]` = FIR).
 * @param worN - Number of frequency points, or array of specific radian frequencies.
 * @returns    - `{ w, H }` where `w` is in radians/sample and `H` is complex.
 *
 * @example
 * ```ts
 * import { firwin, freqz } from "tsb";
 * const b = firwin(31, 0.3);
 * const { w, H } = freqz(b, [1], 512);
 * const mag = H.map(h => cAbs(h));
 * ```
 */
export function freqz(
  b: readonly number[],
  a: readonly number[] = [1],
  worN: number | readonly number[] = 512,
): FreqzResult {
  const ws =
    typeof worN === "number"
      ? Array.from({ length: worN }, (_, i) => (Math.PI * i) / worN)
      : Array.from(worN);

  const H: Complex[] = ws.map((w) => {
    // H(e^jw) = B(e^jw) / A(e^jw)
    // Evaluate in z^-1 so numerator and denominator can have different lengths.
    const z: Complex = { re: Math.cos(w), im: -Math.sin(w) };
    const Bw = evalPolyZ(b, z);
    const Aw = evalPolyZ(a, z);
    return divComplex(Bw, Aw);
  });

  return { w: ws, H };
}

/** Evaluate p[0] + p[1]*z + ... using Horner's method. */
function evalPolyZ(p: readonly number[], z: Complex): Complex {
  let acc: Complex = complex(0, 0);
  for (let i = p.length - 1; i >= 0; i--) {
    // acc = acc * z + p[i]
    acc = {
      re: acc.re * z.re - acc.im * z.im + (p[i] ?? 0),
      im: acc.re * z.im + acc.im * z.re,
    };
  }
  return acc;
}

/** Divide two complex numbers (b / a), returns 0 when |a| < eps. */
function divComplex(b: Complex, a: Complex): Complex {
  const denom = a.re * a.re + a.im * a.im;
  if (denom < 1e-300) {
    return complex(0, 0);
  }
  return {
    re: (b.re * a.re + b.im * a.im) / denom,
    im: (b.im * a.re - b.re * a.im) / denom,
  };
}

// ─── Butterworth IIR filter ───────────────────────────────────────────────────

/** A second-order section: `[b0, b1, b2, 1, a1, a2]`. */
export type SOSSection = [number, number, number, number, number, number];

/** Result of {@link butter}. */
export interface ButterResult {
  /** Second-order sections (numerically preferred for high orders). */
  sos: SOSSection[];
  /** Numerator polynomial (may lose precision for high orders). */
  b: number[];
  /** Denominator polynomial (may lose precision for high orders). */
  a: number[];
}

/** Butter filter type. */
export type FilterType = "lowpass" | "highpass" | "bandpass" | "bandstop";

/**
 * Design an N-th order Butterworth digital filter (bilinear transform).
 *
 * Mirrors `scipy.signal.butter`.
 *
 * Returns both the SOS form (use {@link sosfilt} — numerically stable) and
 * the b/a form (use {@link lfilter} — may have numerical issues for N > 4).
 *
 * @param N    - Filter order (1–8 recommended; high orders lose precision in b/a form).
 * @param Wn   - Critical frequency. Normalised to `[0, 1]` where `1 = Nyquist`.
 *               Provide `[low, high]` for band-pass or band-stop.
 * @param type - Filter type (default `"lowpass"`).
 * @returns    - `{ sos, b, a }`.
 *
 * @example
 * ```ts
 * import { butter, sosfilt } from "tsb";
 * const { sos } = butter(4, 0.2);
 * const y = sosfilt(sos, signal);
 * ```
 */
export function butter(
  N: number,
  Wn: number | readonly [number, number],
  type: FilterType = "lowpass",
): ButterResult {
  if (N < 1 || N > 20 || !Number.isInteger(N)) {
    throw new RangeError("Order N must be an integer 1–20");
  }

  const isBand = type === "bandpass" || type === "bandstop";
  if (isBand && typeof Wn === "number") {
    throw new TypeError("Band filters require Wn = [low, high]");
  }
  if (!isBand && typeof Wn !== "number") {
    throw new TypeError("Low/high-pass filters require scalar Wn");
  }
  const cuts = typeof Wn === "number" ? [Wn] : Wn;
  if (cuts.some((cut) => !Number.isFinite(cut) || cut <= 0 || cut >= 1)) {
    throw new RangeError("Critical frequencies must be finite and strictly between 0 and 1");
  }
  if (typeof Wn !== "number" && Wn[0] >= Wn[1]) {
    throw new RangeError("Band critical frequencies must satisfy low < high");
  }

  // Unit-cutoff Butterworth poles in the left half-plane.
  const poles = Array.from({ length: N }, (_, k) => {
    const angle = (Math.PI * (2 * k + N + 1)) / (2 * N);
    return complex(Math.cos(angle), Math.sin(angle));
  });
  if (typeof Wn !== "number") {
    const warped: [number, number] = [
      2 * Math.tan((Math.PI * Wn[0]) / 2),
      2 * Math.tan((Math.PI * Wn[1]) / 2),
    ];
    return butterBand(warped, type === "bandstop" ? "bandstop" : "bandpass", poles);
  }

  const omega = 2 * Math.tan((Math.PI * Wn) / 2);
  const digitalPoles = poles.map((pole) => {
    const scaled =
      type === "highpass"
        ? divComplex(complex(omega, 0), pole)
        : complex(omega * pole.re, omega * pole.im);
    return bilinearPole(scaled);
  });
  const sections = pairPoles(digitalPoles).map(([p, q]): SOSSection => {
    const zero = type === "highpass" ? 1 : -1;
    return [
      1,
      q === null ? -zero : -2 * zero,
      q === null ? 0 : 1,
      1,
      -(p.re + (q?.re ?? 0)),
      q === null ? 0 : p.re * q.re - p.im * q.im,
    ];
  });
  const sos = normaliseSOS(sections, type === "highpass" ? Math.PI : 0);
  return { sos, ...sosToBA(sos) };
}

/** Bilinear transform: analog pole s → digital pole z = (2+s)/(2-s). */
function bilinearPole(s: Complex): Complex {
  return divComplex(complex(2 + s.re, s.im), complex(2 - s.re, -s.im));
}

/** Pair conjugate poles, and pair real poles with each other where possible. */
function pairPoles(poles: readonly Complex[]): [Complex, Complex | null][] {
  const remaining = [...poles].sort((a, b) => cAbs(a) - cAbs(b));
  const pairs: [Complex, Complex | null][] = [];
  while (remaining.length > 0) {
    const pole = remaining.shift();
    if (pole === undefined) break;
    const real = Math.abs(pole.im) < 1e-10;
    const partner = remaining.findIndex((candidate) =>
      real
        ? Math.abs(candidate.im) < 1e-10
        : Math.abs(pole.re - candidate.re) < 1e-10 && Math.abs(pole.im + candidate.im) < 1e-10,
    );
    if (partner < 0 && !real) {
      throw new Error("Could not pair Butterworth conjugate poles");
    }
    pairs.push([pole, partner < 0 ? null : (remaining.splice(partner, 1)[0] ?? null)]);
  }
  return pairs;
}

/** Normalize each section at a frequency in the unit-gain passband. */
function normaliseSOS(sections: readonly SOSSection[], frequency: number): SOSSection[] {
  const z = complex(Math.cos(frequency), -Math.sin(frequency));
  return sections.map(([b0, b1, b2, a0, a1, a2]): SOSSection => {
    const numerator = cAbs(evalPolyZ([b0, b1, b2], z));
    const denominator = cAbs(evalPolyZ([a0, a1, a2], z));
    const scale = denominator / numerator;
    return [b0 * scale, b1 * scale, b2 * scale, a0, a1, a2];
  });
}

/** Apply the low-pass prototype's band transformation before the bilinear map. */
function butterBand(
  warped: readonly [number, number],
  type: "bandpass" | "bandstop",
  protoPoles: readonly Complex[],
): ButterResult {
  const [w1, w2] = warped;
  const bandwidth = w2 - w1;
  const center = Math.sqrt(w1 * w2);
  const digitalPoles: Complex[] = [];
  for (const pole of protoPoles) {
    // BP: s² - BW*p*s + center² = 0.
    // BS: s² - (BW/p)*s + center² = 0.
    const linear =
      type === "bandpass"
        ? complex(bandwidth * pole.re, bandwidth * pole.im)
        : divComplex(complex(bandwidth, 0), pole);
    const [rootRe, rootIm] = complexSqrt(
      linear.re ** 2 - linear.im ** 2 - 4 * center ** 2,
      2 * linear.re * linear.im,
    );
    digitalPoles.push(
      bilinearPole(complex((linear.re + rootRe) / 2, (linear.im + rootIm) / 2)),
      bilinearPole(complex((linear.re - rootRe) / 2, (linear.im - rootIm) / 2)),
    );
  }

  // BP zeros map to z=±1. BS zeros at ±j*center map to a unit-circle pair.
  const stopZero = bilinearPole(complex(0, center));
  const sections = pairPoles(digitalPoles).map(([p, q]): SOSSection => {
    if (q === null) throw new Error("Band filters require paired poles");
    return [
      1,
      type === "bandpass" ? 0 : -2 * stopZero.re,
      type === "bandpass" ? -1 : 1,
      1,
      -(p.re + q.re),
      p.re * q.re - p.im * q.im,
    ];
  });
  const frequency = type === "bandpass" ? 2 * Math.atan(center / 2) : 0;
  const sos = normaliseSOS(sections, frequency);
  return { sos, ...sosToBA(sos) };
}

/** Real and imaginary parts of the principal square root, including negative real inputs. */
function complexSqrt(re: number, im: number): [number, number] {
  const magnitude = Math.hypot(re, im);
  const rootRe = Math.sqrt(Math.max(0, (magnitude + re) / 2));
  const rootIm = Math.sqrt(Math.max(0, (magnitude - re) / 2));
  return [rootRe, im < 0 ? -rootIm : rootIm];
}

/** Convert SOS to b/a transfer function, omitting first-order padding. */
function sosToBA(sections: readonly SOSSection[]): { b: number[]; a: number[] } {
  let b: number[] = [1];
  let a: number[] = [1];
  for (const [b0, b1, b2, a0, a1, a2] of sections) {
    const firstOrder = b2 === 0 && a2 === 0;
    b = polyMul(b, firstOrder ? [b0, b1] : [b0, b1, b2]);
    a = polyMul(a, firstOrder ? [a0, a1] : [a0, a1, a2]);
  }
  return { b, a };
}

/**
 * Compute the frequency response of a SOS filter.
 *
 * @param sos  - SOS sections as from {@link butter}.
 * @param worN - Number of frequency points or explicit frequencies.
 * @returns    - `{ w, H }`.
 */
export function sosfreqz(
  sos: readonly SOSSection[],
  worN: number | readonly number[] = 512,
): FreqzResult {
  const ws =
    typeof worN === "number"
      ? Array.from({ length: worN }, (_, i) => (Math.PI * i) / worN)
      : Array.from(worN);

  const H: Complex[] = ws.map((w) => {
    const z: Complex = { re: Math.cos(w), im: -Math.sin(w) };
    let acc: Complex = complex(1, 0);
    for (const [b0, b1, b2, a0, a1, a2] of sos) {
      const num = evalPolyZ([b0, b1, b2], z);
      const den = evalPolyZ([a0, a1, a2], z);
      const secH = divComplex(num, den);
      acc = { re: acc.re * secH.re - acc.im * secH.im, im: acc.re * secH.im + acc.im * secH.re };
    }
    return acc;
  });

  return { w: ws, H };
}

// ─── filter application ───────────────────────────────────────────────────────

/**
 * Apply an IIR or FIR filter using direct-form II transposed.
 *
 * Mirrors `scipy.signal.lfilter`. Computes `y[n] = b[0]*x[n] + b[1]*x[n-1] + ...
 * - a[1]*y[n-1] - a[2]*y[n-2] - ...` (a[0] is assumed to be 1 or is normalised).
 *
 * @param b - Numerator coefficients (length M+1).
 * @param a - Denominator coefficients (length N+1, a[0] normalised to 1).
 * @param x - Input signal.
 * @returns - Filtered signal (same length as `x`).
 *
 * @example
 * ```ts
 * import { firwin, lfilter } from "tsb";
 * const b = firwin(21, 0.3);
 * const y = lfilter(b, [1], x);
 * ```
 */
export function lfilter(
  b: readonly number[],
  a: readonly number[],
  x: readonly number[],
): number[] {
  const nb = b.length;
  const na = a.length;
  const n = x.length;

  // Normalise a[0]
  const a0 = a[0] ?? 1;
  const bn = b.map((v) => v / a0);
  const an = a.map((v) => v / a0);

  const m = Math.max(nb, na);
  const z = new Float64Array(m); // state buffer
  const y = new Array<number>(n);

  for (let i = 0; i < n; i++) {
    const xi = x[i] ?? 0;
    const yi = (bn[0] ?? 0) * xi + (z[0] ?? 0);
    y[i] = yi;
    for (let j = 0; j < m - 1; j++) {
      z[j] = (bn[j + 1] ?? 0) * xi - (an[j + 1] ?? 0) * yi + (z[j + 1] ?? 0);
    }
    z[m - 1] = (bn[m] ?? 0) * xi - (an[m] ?? 0) * yi;
  }

  return y;
}

/**
 * Zero-phase forward-backward filter. Applies the filter twice — once forward
 * and once backward — eliminating phase distortion.
 *
 * Mirrors `scipy.signal.filtfilt`.
 *
 * @param b - Numerator coefficients.
 * @param a - Denominator coefficients.
 * @param x - Input signal.
 * @returns - Zero-phase filtered signal (same length as `x`).
 */
export function filtfilt(
  b: readonly number[],
  a: readonly number[],
  x: readonly number[],
): number[] {
  if (x.length === 0) return [];
  const edge = Math.min(3 * Math.max(a.length, b.length), x.length - 1);
  const extended = oddExtension(x, edge);
  const forward = filterSteadyState(b, a, extended);
  const backward = filterSteadyState(b, a, forward.reverse());
  return backward.reverse().slice(edge, edge + x.length);
}

/** Reflect endpoint deviations to avoid introducing artificial jumps. */
function oddExtension(x: readonly number[], edge: number): number[] {
  const first = x[0] ?? 0;
  const last = x[x.length - 1] ?? 0;
  const left = Array.from({ length: edge }, (_, i) => 2 * first - (x[edge - i] ?? first));
  const right = Array.from({ length: edge }, (_, i) => 2 * last - (x[x.length - 2 - i] ?? last));
  return [...left, ...x, ...right];
}

/** Direct-form II filtering initialized to the first sample's steady state. */
function filterSteadyState(
  b: readonly number[],
  a: readonly number[],
  x: readonly number[],
): number[] {
  const a0 = a[0] ?? 1;
  const bn = b.map((v) => v / a0);
  const an = a.map((v) => v / a0);
  const order = Math.max(a.length, b.length) - 1;
  const state = new Array<number>(order + 1).fill(0);
  const first = x[0] ?? 0;
  const denominator = an.reduce((sum, v) => sum + v, 0);
  const steady = denominator === 0 ? 0 : (first * bn.reduce((sum, v) => sum + v, 0)) / denominator;
  for (let i = order - 1; i >= 0; i--) {
    state[i] = (state[i + 1] ?? 0) + (bn[i + 1] ?? 0) * first - (an[i + 1] ?? 0) * steady;
  }
  return x.map((value) => {
    const out = (bn[0] ?? 0) * value + (state[0] ?? 0);
    for (let i = 0; i < order; i++) {
      state[i] = (state[i + 1] ?? 0) + (bn[i + 1] ?? 0) * value - (an[i + 1] ?? 0) * out;
    }
    return out;
  });
}

/**
 * Apply a second-order-sections filter.
 *
 * Numerically more stable than {@link lfilter} for high-order IIR filters.
 * Mirrors `scipy.signal.sosfilt`.
 *
 * @param sos - SOS sections from {@link butter}.
 * @param x   - Input signal.
 * @returns   - Filtered signal (same length as `x`).
 */
export function sosfilt(sos: readonly SOSSection[], x: readonly number[]): number[] {
  let signal = Array.from(x);
  for (const [b0, b1, b2, a0, a1, a2] of sos) {
    signal = lfilter([b0, b1, b2], [a0, a1, a2], signal);
  }
  return signal;
}

/**
 * Zero-phase SOS filter with one padded forward cascade and one backward cascade.
 *
 * @param sos - SOS sections from {@link butter}.
 * @param x   - Input signal.
 * @returns   - Zero-phase filtered signal.
 */
export function sosfiltfilt(sos: readonly SOSSection[], x: readonly number[]): number[] {
  if (x.length === 0) return [];
  const numeratorPadding = sos.filter((section) => section[2] === 0).length;
  const denominatorPadding = sos.filter((section) => section[5] === 0).length;
  const taps = 2 * sos.length + 1 - Math.min(numeratorPadding, denominatorPadding);
  const edge = Math.min(3 * taps, x.length - 1);
  let signal = oddExtension(x, edge);
  for (let pass = 0; pass < 2; pass++) {
    for (const [b0, b1, b2, a0, a1, a2] of sos) {
      signal = filterSteadyState([b0, b1, b2], [a0, a1, a2], signal);
    }
    signal.reverse();
  }
  return signal.slice(edge, edge + x.length);
}

// Re-export cAbs for convenience
export { cAbs };
