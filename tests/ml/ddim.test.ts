/**
 * Tests for src/ml/ddim.ts
 */
import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import type { NoiseSchedule } from "../../src/index.ts";
import { addNoise, computeNoiseSchedule, ddimTimesteps, snrAtTimestep } from "../../src/index.ts";

describe("computeNoiseSchedule — linear", () => {
  it("has correct length", () => {
    const s = computeNoiseSchedule({
      numTrainTimesteps: 100,
      schedule: "linear",
      eta: 0,
      betaStart: 0.0001,
      betaEnd: 0.02,
    });
    expect(s.betas.length).toBe(100);
    expect(s.alphasCumprod.length).toBe(100);
  });

  it("alphasCumprod is decreasing", () => {
    const s = computeNoiseSchedule({
      numTrainTimesteps: 50,
      schedule: "linear",
      eta: 0,
      betaStart: 0.0001,
      betaEnd: 0.02,
    });
    for (let i = 1; i < 50; i++) {
      expect(s.alphasCumprod[i]!).toBeLessThan(s.alphasCumprod[i - 1]!);
    }
  });

  it("sqrtAlphasCumprod[0] close to 1", () => {
    const s = computeNoiseSchedule({
      numTrainTimesteps: 1000,
      schedule: "linear",
      eta: 0,
      betaStart: 0.0001,
      betaEnd: 0.02,
    });
    expect(s.sqrtAlphasCumprod[0]!).toBeGreaterThan(0.99);
  });
});

describe("computeNoiseSchedule — validation and edge cases", () => {
  for (const schedule of ["linear", "sqrt"] satisfies readonly ("linear" | "sqrt")[]) {
    it(`${schedule} uses betaStart for a single timestep`, () => {
      const s = computeNoiseSchedule({
        numTrainTimesteps: 1,
        schedule,
        eta: 0,
        betaStart: 0.01,
        betaEnd: 0.1,
      });
      expect(Array.from(s.betas)).toEqual([0.01]);
      expect(s.alphasCumprod[0]).toBeCloseTo(0.99, 12);
      expect(s.sqrtAlphasCumprod[0]).toBeCloseTo(Math.sqrt(0.99), 12);
      expect(s.sqrtOneMinusAlphasCumprod[0]).toBeCloseTo(0.1, 12);
    });
  }

  it("rejects invalid timestep counts", () => {
    for (const numTrainTimesteps of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        computeNoiseSchedule({
          numTrainTimesteps,
          schedule: "linear",
          eta: 0,
          betaStart: 0.01,
          betaEnd: 0.1,
        }),
      ).toThrow(RangeError);
    }
  });

  it("rejects invalid beta endpoints", () => {
    for (const value of [-0.1, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        computeNoiseSchedule({
          numTrainTimesteps: 10,
          schedule: "linear",
          eta: 0,
          betaStart: value,
          betaEnd: 0.1,
        }),
      ).toThrow(RangeError);
      expect(() =>
        computeNoiseSchedule({
          numTrainTimesteps: 10,
          schedule: "sqrt",
          eta: 0,
          betaStart: 0.01,
          betaEnd: value,
        }),
      ).toThrow(RangeError);
    }
  });

  it("produces finite schedule values for valid inputs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.constantFrom<NoiseSchedule>("linear", "sqrt", "cosine"),
        fc.double({ min: 0, max: 0.1, noNaN: true }),
        fc.double({ min: 0, max: 0.1, noNaN: true }),
        (numTrainTimesteps, schedule, betaStart, betaEnd) => {
          const s = computeNoiseSchedule({
            numTrainTimesteps,
            schedule,
            eta: 0,
            betaStart,
            betaEnd,
          });
          for (const values of Object.values(s)) {
            expect(values.length).toBe(numTrainTimesteps);
            expect(Array.from(values).every(Number.isFinite)).toBe(true);
          }
        },
      ),
    );
  });
});

describe("computeNoiseSchedule — cosine", () => {
  it("cumulative alphas follow the normalized cosine curve", () => {
    const s = computeNoiseSchedule({
      numTrainTimesteps: 100,
      schedule: "cosine",
      eta: 0,
      betaStart: 0.0001,
      betaEnd: 0.02,
    });
    const initial = Math.cos(((0.008 / 1.008) * Math.PI) / 2) ** 2;
    // The final beta is capped; earlier cumulative values follow alpha_bar.
    for (let t = 0; t < 99; t++) {
      const expected = Math.cos(((((t + 1) / 100 + 0.008) / 1.008) * Math.PI) / 2) ** 2 / initial;
      expect(s.alphasCumprod[t]).toBeCloseTo(expected, 12);
    }
    expect(s.betas[99]).toBe(0.999);
  });
  it("alphasCumprod values are in (0,1)", () => {
    const s = computeNoiseSchedule({
      numTrainTimesteps: 100,
      schedule: "cosine",
      eta: 0,
      betaStart: 0.0001,
      betaEnd: 0.02,
    });
    for (let i = 0; i < 100; i++) {
      expect(s.alphasCumprod[i]!).toBeGreaterThan(0);
      expect(s.alphasCumprod[i]!).toBeLessThan(1);
    }
  });
});

describe("addNoise", () => {
  it("mixes signal and noise according to the one-step schedule", () => {
    const s = computeNoiseSchedule({
      numTrainTimesteps: 1,
      schedule: "linear",
      eta: 0,
      betaStart: 0.0001,
      betaEnd: 0.0001,
    });
    const sample = new Float64Array([1, 2, 3]);
    const noise = new Float64Array([10, 10, 10]);
    const out = addNoise(sample, noise, 0, s);
    for (let i = 0; i < sample.length; i++) {
      expect(out[i]).toBeCloseTo(Math.sqrt(0.9999) * (sample[i] ?? 0) + 0.1, 12);
    }
  });

  it("returns the sample unchanged for zero beta", () => {
    const s = computeNoiseSchedule({
      numTrainTimesteps: 1,
      schedule: "linear",
      eta: 0,
      betaStart: 0,
      betaEnd: 0,
    });
    const sample = new Float64Array([1, 2, 3]);
    expect(addNoise(sample, new Float64Array([10, 10, 10]), 0, s)).toEqual(sample);
  });

  it("output length matches input", () => {
    const s = computeNoiseSchedule({
      numTrainTimesteps: 10,
      schedule: "linear",
      eta: 0,
      betaStart: 0.001,
      betaEnd: 0.01,
    });
    const sample = new Float64Array(8);
    const noise = new Float64Array(8);
    expect(addNoise(sample, noise, 5, s).length).toBe(8);
  });
});

describe("ddimTimesteps", () => {
  it("returns correct count", () => {
    const ts = ddimTimesteps(1000, 50);
    expect(ts.length).toBe(50);
  });

  it("first timestep is largest", () => {
    const ts = ddimTimesteps(1000, 10);
    expect(ts[0]!).toBeGreaterThan(ts[ts.length - 1]!);
  });
});

describe("snrAtTimestep", () => {
  it("snr decreases over time for linear schedule", () => {
    const s = computeNoiseSchedule({
      numTrainTimesteps: 100,
      schedule: "linear",
      eta: 0,
      betaStart: 0.001,
      betaEnd: 0.02,
    });
    expect(snrAtTimestep(10, s)).toBeGreaterThan(snrAtTimestep(50, s));
  });
});
