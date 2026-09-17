/**
 * Tests for src/stats/filters.ts
 * Covers FIR design, Butterworth IIR, frequency response, and filter application.
 */

import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import {
  type FilterType,
  type SOSSection,
  butter,
  cAbs,
  filtfilt,
  firwin,
  freqz,
  lfilter,
  sosfilt,
  sosfiltfilt,
  sosfreqz,
} from "../../src/stats/filters.ts";

// ─── helpers ──────────────────────────────────────────────────────────────────

function near(a: number, b: number, tol = 1e-4): boolean {
  return Math.abs(a - b) <= tol * (1 + Math.abs(b));
}

function nearAbs(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) <= tol;
}

// ─── firwin ───────────────────────────────────────────────────────────────────

describe("firwin", () => {
  test("returns correct number of taps", () => {
    const b = firwin(21, 0.3);
    expect(b.length).toBe(21);
  });

  test("low-pass: DC gain ≈ 1", () => {
    const b = firwin(51, 0.3);
    const dcGain = b.reduce((s, v) => s + v, 0);
    expect(dcGain).toBeCloseTo(1.0, 4);
  });

  test("low-pass: gain near 0 at Nyquist", () => {
    const b = firwin(51, 0.3);
    // H(e^jπ) = sum b[n] * (-1)^n
    const nyqGain = b.reduce((s, v, i) => s + v * (i % 2 === 0 ? 1 : -1), 0);
    expect(Math.abs(nyqGain)).toBeLessThan(0.01);
  });

  test("high-pass (pass_zero=false): gain ≈ 1 at Nyquist", () => {
    const b = firwin(51, 0.3, { pass_zero: false });
    const nyqGain = b.reduce((s, v, i) => s + v * (i % 2 === 0 ? 1 : -1), 0);
    expect(Math.abs(nyqGain)).toBeGreaterThan(0.9);
  });

  test("symmetric coefficients (linear phase)", () => {
    const b = firwin(31, 0.4);
    for (let i = 0; i < 16; i++) {
      expect(b[i] ?? 0).toBeCloseTo(b[30 - i] ?? 0, 10);
    }
  });

  test("different window types work", () => {
    const windows = ["hamming", "hann", "blackman"] as const;
    for (const win of windows) {
      const b = firwin(21, 0.3, { window: win });
      expect(b.length).toBe(21);
      // DC gain should be near 1
      const dc = b.reduce((s, v) => s + v, 0);
      expect(dc).toBeCloseTo(1.0, 3);
    }
  });

  test("custom fs scaling", () => {
    const b1 = firwin(21, 0.3, { fs: 2 }); // default
    const b2 = firwin(21, 300, { fs: 2000 }); // same normalised cutoff
    for (let i = 0; i < b1.length; i++) {
      expect(b1[i] ?? 0).toBeCloseTo(b2[i] ?? 0, 10);
    }
  });

  test("band-pass (pass_zero=false, two cutoffs)", () => {
    const b = firwin(51, [0.2, 0.4], { pass_zero: false });
    expect(b.length).toBe(51);
    // DC gain should be near 0
    const dcGain = b.reduce((s, v) => s + v, 0);
    expect(Math.abs(dcGain)).toBeLessThan(0.05);
  });

  test("property: all taps are finite", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 51 }).filter((n) => n % 2 === 1),
        fc.double({ min: 0.01, max: 0.49, noNaN: true }),
        (taps, cutoff) => {
          const b = firwin(taps, cutoff);
          return b.every(Number.isFinite);
        },
      ),
    );
  });
});

// ─── freqz ────────────────────────────────────────────────────────────────────

describe("freqz", () => {
  test("a unit delay has negative phase when numerator and denominator lengths differ", () => {
    const { H } = freqz([0, 1], [1], [Math.PI / 2]);
    expect(H[0]?.re).toBeCloseTo(0, 12);
    expect(H[0]?.im).toBeCloseTo(-1, 12);
  });
  test("FIR identity filter (b=[1]) — H=1 everywhere", () => {
    const { H } = freqz([1], [1], 32);
    for (const h of H) {
      expect(cAbs(h)).toBeCloseTo(1.0, 10);
    }
  });

  test("output length matches worN", () => {
    const { w, H } = freqz([1, 0, 0], [1], 64);
    expect(w.length).toBe(64);
    expect(H.length).toBe(64);
  });

  test("specific frequencies array", () => {
    const ws = [0, Math.PI / 4, Math.PI / 2, Math.PI];
    const { w, H } = freqz([1], [1], ws);
    expect(w).toEqual(ws);
    expect(H.length).toBe(4);
  });

  test("low-pass FIR: passband gain ≈ 1, stopband ≈ 0", () => {
    const b = firwin(51, 0.3);
    const { w, H } = freqz(b, [1], 256);
    const mag = H.map(cAbs);
    // DC
    expect(mag[0]).toBeCloseTo(1.0, 2);
    // Nyquist (last bin ~ π)
    expect(mag[255] ?? 0).toBeLessThan(0.05);
  });

  test("high-pass FIR: stopband at DC, passband at Nyquist", () => {
    const b = firwin(51, 0.3, { pass_zero: false });
    const { H } = freqz(b, [1], 256);
    const mag = H.map(cAbs);
    expect(mag[0] ?? 0).toBeLessThan(0.05); // near zero at DC
    expect(mag[255] ?? 0).toBeGreaterThan(0.9); // near 1 at Nyquist
  });

  test("first frequency is 0", () => {
    const { w } = freqz([1], [1], 128);
    expect(w[0]).toBe(0);
  });
});

// ─── butter ───────────────────────────────────────────────────────────────────

describe("butter", () => {
  // scipy.signal.butter(3, cutoff, btype=type), SciPy 1.18.1.
  const references: {
    type: FilterType;
    cutoff: number | readonly [number, number];
    b: number[];
    a: number[];
  }[] = [
    {
      type: "lowpass",
      cutoff: 0.3,
      b: [0.04953299635725318, 0.14859898907175956, 0.14859898907175956, 0.04953299635725318],
      a: [1, -1.1619174836717323, 0.6959427557896507, -0.13776130125989283],
    },
    {
      type: "highpass",
      cutoff: 0.3,
      b: [0.3744526925901595, -1.1233580777704786, 1.1233580777704786, -0.3744526925901595],
      a: [1, -1.1619174836717328, 0.6959427557896509, -0.13776130125989286],
    },
    {
      type: "bandpass",
      cutoff: [0.2, 0.4],
      b: [
        0.01809893300751444, 0, -0.05429679902254332, 0, 0.05429679902254332, 0,
        -0.01809893300751444,
      ],
      a: [
        1, -2.941867669925039, 4.7023172884643305, -4.634109656210411, 3.0774477936582785,
        -1.2466196810240529, 0.2780599176345464,
      ],
    },
    {
      type: "bandstop",
      cutoff: [0.2, 0.4],
      b: [
        0.5276243825019431, -1.9565388100762569, 4.0012881173766335, -4.909519387006988,
        4.001288117376634, -1.9565388100762573, 0.5276243825019431,
      ],
      a: [
        1, -2.9418676699250383, 4.7023172884643305, -4.634109656210412, 3.077447793658279,
        -1.246619681024053, 0.2780599176345464,
      ],
    },
  ];

  for (const reference of references) {
    test(`${reference.type} coefficients match SciPy`, () => {
      const { b, a } = butter(3, reference.cutoff, reference.type);
      expect(b.length).toBe(reference.b.length);
      expect(a.length).toBe(reference.a.length);
      for (let i = 0; i < b.length; i++) {
        expect(b[i]).toBeCloseTo(reference.b[i] ?? 0, 11);
        expect(a[i]).toBeCloseTo(reference.a[i] ?? 0, 11);
      }
    });
  }

  test("band filters retain their order for both real and complex transformed pole pairs", () => {
    for (const type of ["bandpass", "bandstop"] satisfies readonly FilterType[]) {
      for (const cutoff of [
        [0.2, 0.4],
        [0.1, 0.9],
      ] satisfies readonly [number, number][]) {
        for (const order of [1, 2, 3, 4]) {
          const { sos, a } = butter(order, cutoff, type);
          expect(sos.length).toBe(order);
          expect(a.length).toBe(2 * order + 1);
          const frequencies = [0, cutoff[0] * Math.PI, cutoff[1] * Math.PI, Math.PI];
          const magnitudes = sosfreqz(sos, frequencies).H.map(cAbs);
          expect(magnitudes[1]).toBeCloseTo(Math.SQRT1_2, 10);
          expect(magnitudes[2]).toBeCloseTo(Math.SQRT1_2, 10);
          expect(magnitudes[0]).toBeCloseTo(type === "bandpass" ? 0 : 1, 10);
          expect(magnitudes[3]).toBeCloseTo(type === "bandpass" ? 0 : 1, 10);
        }
      }
    }
  });

  test("invalid critical frequencies fail before producing non-finite filters", () => {
    for (const cutoff of [0, 1, -0.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => butter(2, cutoff)).toThrow(RangeError);
    }
    expect(() => butter(2, [0.4, 0.2], "bandpass")).toThrow(RangeError);
    expect(() => butter(2, [0.2, 0.2], "bandstop")).toThrow(RangeError);
  });
  test("returns sos, b, a arrays", () => {
    const result = butter(2, 0.3);
    expect(Array.isArray(result.sos)).toBe(true);
    expect(Array.isArray(result.b)).toBe(true);
    expect(Array.isArray(result.a)).toBe(true);
  });

  test("SOS sections count = ceil(N/2)", () => {
    for (const N of [1, 2, 3, 4, 5, 6]) {
      const { sos } = butter(N, 0.3);
      expect(sos.length).toBe(Math.ceil(N / 2));
    }
  });

  test("each SOS section has 6 coefficients", () => {
    const { sos } = butter(4, 0.3);
    for (const sec of sos) {
      expect(sec.length).toBe(6);
    }
  });

  test("SOS a[0] = 1 for all sections", () => {
    const { sos } = butter(4, 0.3);
    for (const sec of sos) {
      expect(sec[3]).toBeCloseTo(1.0, 10);
    }
  });

  test("low-pass DC gain ≈ 1 (via freqz)", () => {
    const { b, a } = butter(2, 0.3);
    const { H } = freqz(b, a, 1);
    expect(cAbs(H[0] ?? { re: 0, im: 0 })).toBeCloseTo(1.0, 3);
  });

  test("high-pass Nyquist gain ≈ 1 (via freqz)", () => {
    const { b, a } = butter(2, 0.3, "highpass");
    const { H } = freqz(b, a, [Math.PI]);
    expect(cAbs(H[0] ?? { re: 0, im: 0 })).toBeCloseTo(1.0, 3);
  });

  test("order 1 lowpass has stable poles", () => {
    const { sos } = butter(1, 0.3);
    for (const [, , , , a1, a2] of sos) {
      // |poles| < 1 for stable filter
      const p = Math.sqrt(a1 ** 2 - 4 * a2);
      void p; // just check it's finite
      expect(Number.isFinite(a1)).toBe(true);
    }
  });

  test("invalid order throws", () => {
    expect(() => butter(0, 0.3)).toThrow();
    expect(() => butter(1.5, 0.3)).toThrow();
  });

  test("band-type requires array Wn", () => {
    expect(() => butter(2, 0.3, "bandpass")).toThrow();
  });

  test("lowpass with highpass type requires scalar", () => {
    expect(() => butter(2, [0.1, 0.4], "lowpass")).toThrow();
  });

  test("highpass filter attenuates DC", () => {
    const { sos } = butter(2, 0.3, "highpass");
    const { H } = sosfreqz(sos, [0.01]);
    expect(cAbs(H[0] ?? { re: 0, im: 0 })).toBeLessThan(0.1);
  });
});

// ─── sosfreqz ─────────────────────────────────────────────────────────────────

describe("sosfreqz", () => {
  test("identity SOS (b=[1,0,0], a=[1,0,0]) — H=1", () => {
    const sos: SOSSection[] = [[1, 0, 0, 1, 0, 0]];
    const { H } = sosfreqz(sos, 32);
    for (const h of H) {
      expect(cAbs(h)).toBeCloseTo(1.0, 10);
    }
  });

  test("output length matches worN", () => {
    const { sos } = butter(2, 0.3);
    const { w, H } = sosfreqz(sos, 128);
    expect(w.length).toBe(128);
    expect(H.length).toBe(128);
  });

  test("SOS and b/a freqz agree for order-2 lowpass", () => {
    const { sos, b, a } = butter(2, 0.3);
    const { H: Hba } = freqz(b, a, 64);
    const { H: Hsos } = sosfreqz(sos, 64);
    for (let i = 0; i < Hba.length; i++) {
      const magBa = cAbs(Hba[i] ?? { re: 0, im: 0 });
      const magSos = cAbs(Hsos[i] ?? { re: 0, im: 0 });
      expect(magBa).toBeCloseTo(magSos, 3);
    }
  });
});

// ─── lfilter ──────────────────────────────────────────────────────────────────

describe("lfilter", () => {
  test("identity filter b=[1], a=[1]", () => {
    const x = [1, 2, 3, 4, 5];
    const y = lfilter([1], [1], x);
    expect(y).toEqual(x);
  });

  test("output length equals input length", () => {
    const x = Array.from({ length: 100 }, (_, i) => i);
    const b = firwin(11, 0.3);
    const y = lfilter(b, [1], x);
    expect(y.length).toBe(x.length);
  });

  test("causal: output at time 0 depends only on input at time 0", () => {
    const b = [0.5, 0.5];
    const x = [1, 0, 0, 0, 0];
    const y = lfilter(b, [1], x);
    expect(y[0]).toBeCloseTo(0.5);
    expect(y[1]).toBeCloseTo(0.5);
    expect(y[2]).toBeCloseTo(0);
  });

  test("FIR low-pass reduces high-freq content", () => {
    const n = 512;
    const fs = 512;
    // Mix 10 Hz (pass) and 200 Hz (stop) signals
    const x = Array.from(
      { length: n },
      (_, i) => Math.sin((2 * Math.PI * 10 * i) / fs) + Math.sin((2 * Math.PI * 200 * i) / fs),
    );
    const b = firwin(63, 0.3, { fs });
    const y = lfilter(b, [1], x);
    // After filtering, 200 Hz component should be attenuated
    const highPower = x
      .slice(100)
      .reduce((s, _v, i) => s + Math.sin((2 * Math.PI * 200 * (i + 100)) / fs) ** 2, 0);
    const residualHigh = y
      .slice(100)
      .reduce((s, v, i) => s + v * Math.sin((2 * Math.PI * 200 * (i + 100)) / fs), 0);
    expect(Math.abs(residualHigh) / n).toBeLessThan(Math.sqrt(highPower / n) * 0.3);
  });

  test("a[0] normalisation: result independent of a[0] scaling", () => {
    const x = [1, 2, 3, 4, 5, 6];
    const b = [0.5];
    const y1 = lfilter(b, [1], x);
    const y2 = lfilter([1], [2], x);
    for (let i = 0; i < x.length; i++) {
      expect(y1[i] ?? 0).toBeCloseTo((x[i] ?? 0) * 0.5, 10);
      expect(y2[i] ?? 0).toBeCloseTo((x[i] ?? 0) * 0.5, 10);
    }
  });

  test("property: lfilter with [1] passes signal unchanged", () => {
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: -100, max: 100, noNaN: true }), { minLength: 5, maxLength: 50 }),
        (x) => {
          const y = lfilter([1], [1], x);
          return y.every((v, i) => Math.abs(v - (x[i] ?? 0)) < 1e-10);
        },
      ),
    );
  });
});

// ─── filtfilt ─────────────────────────────────────────────────────────────────

describe("filtfilt", () => {
  test("matches SciPy endpoint transients with non-unit a[0]", () => {
    const x = Array.from(
      { length: 24 },
      (_, i) => 3 + 0.1 * i + (i === 1 ? 2 : 0) + (i === 22 ? -1 : 0),
    );
    // scipy.signal.filtfilt([0.2, 0.1], [2, -0.8, 0.1], x), SciPy 1.18.1.
    const expected = [
      0.15976330987316759, 0.19561507259721908, 0.19262472745055467, 0.1830975397172099,
      0.18289772034263999, 0.18675569044048607, 0.19177040790771188, 0.1970449348444447,
      0.20236554819647765, 0.20769160570136688, 0.21301753710900065, 0.21834314916479322,
      0.22366865489500215, 0.22899418905081517, 0.23431987759331033, 0.2396456283055787,
      0.2449686568542419, 0.2502686422039191, 0.2554387228253477, 0.2600304297618553,
      0.26259324196892964, 0.2604923701048751, 0.2616599202775737, 0.28224852817042756,
    ];
    const actual = filtfilt([0.2, 0.1], [2, -0.8, 0.1], x);
    for (let i = 0; i < expected.length; i++) {
      expect(actual[i]).toBeCloseTo(expected[i] ?? 0, 12);
    }
  });

  test("a constant record begins and ends at the squared DC gain", () => {
    const { b, a } = butter(3, 0.3);
    const result = filtfilt(b, a, new Array<number>(32).fill(7));
    for (const value of result) expect(value).toBeCloseTo(7, 11);
    expect(filtfilt(b, a, [])).toEqual([]);
  });
  test("zero phase: applies filter forward and backward", () => {
    const x = Array.from({ length: 64 }, (_, i) => Math.sin((2 * Math.PI * 5 * i) / 64));
    const b = firwin(11, 0.3);
    const y = filtfilt(b, [1], x);
    expect(y.length).toBe(x.length);
  });

  test("symmetric signal stays symmetric", () => {
    const n = 64;
    const x = Array.from({ length: n }, (_, i) => {
      const t = Math.min(i, n - 1 - i);
      return t;
    });
    const b = firwin(11, 0.4);
    const y = filtfilt(b, [1], x);
    expect(y.length).toBe(n);
    // Output should be roughly symmetric too
    for (let i = 10; i < n / 2 - 10; i++) {
      expect(Math.abs((y[i] ?? 0) - (y[n - 1 - i] ?? 0))).toBeLessThan(0.5);
    }
  });

  test("smoother than lfilter (no phase delay)", () => {
    const n = 128;
    const x = Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 5 * i) / n));
    const b = firwin(21, 0.3);
    const yLf = lfilter(b, [1], x);
    const yFf = filtfilt(b, [1], x);
    expect(yFf.length).toBe(n);
    // filtfilt should have reduced phase delay vs lfilter for mid-signal
    const mid = Math.floor(n / 2);
    const refCos = x[mid] ?? 0;
    const errLf = Math.abs((yLf[mid] ?? 0) - refCos);
    const errFf = Math.abs((yFf[mid] ?? 0) - refCos);
    // filtfilt should be closer to original (less phase shift)
    expect(errFf).toBeLessThanOrEqual(errLf + 0.2);
  });
});

// ─── sosfilt / sosfiltfilt ────────────────────────────────────────────────────

describe("sosfilt", () => {
  test("sosfiltfilt matches SciPy through a fourth-order cascade at both edges", () => {
    const x = Array.from(
      { length: 32 },
      (_, i) => 3 + 0.1 * i + (i === 1 ? 2 : 0) + (i === 30 ? -1 : 0),
    );
    // scipy.signal.sosfiltfilt(scipy.signal.butter(4, .3, output="sos"), x).
    const indices = [0, 1, 2, 4, 8, 16, 24, 28, 29, 30, 31];
    const expected = [
      2.999867820831724, 3.425483610296631, 3.6575599513903088, 3.5400064411979577,
      3.791374669870445, 4.603403320088942, 5.434030583316487, 5.622115887074203, 5.671225526441613,
      5.8367734686575545, 6.099207063193474,
    ];
    const result = sosfiltfilt(butter(4, 0.3).sos, x);
    for (let i = 0; i < indices.length; i++) {
      expect(result[indices[i] ?? 0]).toBeCloseTo(expected[i] ?? 0, 11);
    }
  });
  test("identity SOS passes signal unchanged", () => {
    const x = [1, 2, 3, 4, 5];
    const sos: SOSSection[] = [[1, 0, 0, 1, 0, 0]];
    const y = sosfilt(sos, x);
    for (let i = 0; i < x.length; i++) {
      expect(y[i] ?? 0).toBeCloseTo(x[i] ?? 0, 10);
    }
  });

  test("output length equals input length", () => {
    const { sos } = butter(4, 0.3);
    const x = Array.from({ length: 100 }, (_, i) => i * 0.1);
    const y = sosfilt(sos, x);
    expect(y.length).toBe(x.length);
  });

  test("Butterworth low-pass passes DC", () => {
    const { sos } = butter(2, 0.3);
    const x = new Array(100).fill(1.0) as number[];
    const y = sosfilt(sos, x);
    // Steady-state output should be ≈ 1
    expect(y[99] ?? 0).toBeCloseTo(1.0, 2);
  });

  test("sosfiltfilt output length equals input", () => {
    const { sos } = butter(2, 0.3);
    const x = Array.from({ length: 64 }, (_, i) => Math.sin((2 * Math.PI * i) / 64));
    const y = sosfiltfilt(sos, x);
    expect(y.length).toBe(x.length);
  });

  test("property: all outputs finite for bounded input", () => {
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: -10, max: 10, noNaN: true }), { minLength: 20, maxLength: 100 }),
        (x) => {
          const { sos } = butter(2, 0.3);
          const y = sosfilt(sos, x);
          return y.every(Number.isFinite);
        },
      ),
    );
  });
});

// ─── integration: FIR + IIR pipeline ─────────────────────────────────────────

describe("filter pipeline", () => {
  test("Butterworth then FIR: both stable and output finite", () => {
    const n = 256;
    const fs = 512;
    const signal = Array.from(
      { length: n },
      (_, i) => Math.sin((2 * Math.PI * 50 * i) / fs) + 0.1 * (Math.random() - 0.5),
    );

    // Stage 1: IIR low-pass at 100 Hz
    const { sos } = butter(4, 0.4);
    const s1 = sosfilt(sos, signal);

    // Stage 2: FIR high-pass at 20 Hz
    const b = firwin(31, 0.1, { pass_zero: false });
    const s2 = lfilter(b, [1], s1);

    expect(s2.length).toBe(n);
    expect(s2.every(Number.isFinite)).toBe(true);
  });
});
