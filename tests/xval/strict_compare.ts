/**
 * Strict, type-preserving comparison for scenario 7.
 *
 * `helpers.ts`'s shared `assertMatchesSnapshot` keys index/column labels by
 * `String(label)` on both the actual and expected sides, which makes numeric
 * label `1` indistinguishable from string label `"1"`. Scenario 7's
 * completion contract requires numeric-versus-string label types to be
 * preserved, so this module re-implements the label comparison with the
 * decoded label's original JS type intact, while reusing the same value
 * tolerance semantics (1e-10 float tolerance, NaN/null/undefined snapshot
 * missing-value encoding) as the shared helper.
 *
 * This does not replace `assertMatchesSnapshot`; it is only used by the
 * scenario 7 executor tests, where label-type-aware comparison matters.
 *
 * @module
 */

import { expect } from "bun:test";
import { DataFrame, Series } from "tsb";
import type { Label, Scalar } from "tsb";
import type { SnapshotIndex, SnapshotStep, TsbResult } from "./helpers.ts";

const FLOAT_TOLERANCE = 1e-10;

type EncodedNaN = { readonly kind: "NaN" };
type JsonValue = null | boolean | number | string | EncodedNaN | readonly JsonValue[];

function isEncodedNaN(value: JsonValue): value is EncodedNaN {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "kind" in value &&
    value.kind === "NaN"
  );
}

/** Decode a snapshot label into its original JS type (number, string, boolean, or null). */
function decodeLabel(value: JsonValue): Label {
  if (isEncodedNaN(value)) {
    return null;
  }
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  return null;
}

/**
 * Assert two labels are the *same value and the same JS type* — numeric `1`
 * must not equal string `"1"`.
 */
function assertLabelStrictlyEqual(actual: Label, expected: Label, context: string): void {
  expect(typeof actual, `${context} (label type)`).toBe(typeof expected);
  expect(actual, context).toBe(expected);
}

function assertJsonEqual(actual: JsonValue, expected: JsonValue, context: string): void {
  if (isEncodedNaN(actual) && isEncodedNaN(expected)) {
    return;
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    expect(Array.isArray(actual), context).toBe(true);
    expect(Array.isArray(expected), context).toBe(true);
    if (!(Array.isArray(actual) && Array.isArray(expected))) {
      return;
    }
    expect(actual.length, context).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      assertJsonEqual(actual[i] ?? null, expected[i] ?? null, `${context}.${i}`);
    }
    return;
  }
  if (typeof actual === "number" && typeof expected === "number") {
    expect(Math.abs(actual - expected), context).toBeLessThanOrEqual(FLOAT_TOLERANCE);
    return;
  }
  expect(actual, context).toEqual(expected);
}

function encodeRuntimeScalar(value: Scalar): JsonValue {
  if (value === null || value === undefined || (typeof value === "number" && Number.isNaN(value))) {
    return { kind: "NaN" };
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  // TimedeltaLike: the only remaining Scalar variant, identified structurally.
  return value.totalMs;
}

function expectIndex(index: SnapshotIndex | undefined): SnapshotIndex {
  if (index === undefined) {
    throw new Error("Snapshot is missing index metadata");
  }
  return index;
}

function isMatrix(data: SnapshotStep["data"]): data is readonly (readonly JsonValue[])[] {
  return Array.isArray(data) && (data.length === 0 || Array.isArray(data[0]));
}

function isVector(data: SnapshotStep["data"]): data is readonly JsonValue[] {
  return Array.isArray(data) && (data.length === 0 || !Array.isArray(data[0]));
}

function expectMatrix(step: SnapshotStep): readonly (readonly JsonValue[])[] {
  if (!isMatrix(step.data)) {
    throw new Error(`STEP ${step.step}: expected matrix data`);
  }
  return step.data;
}

function expectVector(step: SnapshotStep): readonly JsonValue[] {
  if (!isVector(step.data)) {
    throw new Error(`STEP ${step.step}: expected vector data`);
  }
  return step.data;
}

/**
 * Assert `actual` matches `step`'s value, missing-value, shape, and
 * ordered-label data with strict label-type preservation (numeric label `1`
 * is distinct from string label `"1"`).
 */
export function assertMatchesSnapshotStrict(actual: TsbResult, step: SnapshotStep): void {
  if (step.kind === "dataframe") {
    if (!(actual instanceof DataFrame)) {
      throw new Error(`STEP ${step.step}: expected a DataFrame result`);
    }
    assertDataFrameStrict(actual, step);
    return;
  }
  if (step.kind === "series") {
    if (!(actual instanceof Series)) {
      throw new Error(`STEP ${step.step}: expected a Series result`);
    }
    assertSeriesStrict(actual, step);
    return;
  }
  if (actual instanceof DataFrame || actual instanceof Series) {
    throw new Error(`STEP ${step.step}: expected a scalar result`);
  }
  assertJsonEqual(encodeRuntimeScalar(actual), step.value ?? null, `STEP ${step.step} scalar`);
}

function assertDataFrameStrict(actual: DataFrame, step: SnapshotStep): void {
  const expectedRows = expectMatrix(step);
  const expectedColumnLabels = expectIndex(step.columns).values.map((value) => decodeLabel(value));
  const expectedRowLabels = expectIndex(step.index).values.map((value) => decodeLabel(value));

  expect([...actual.shape], `STEP ${step.step} shape`).toEqual([...(step.shape ?? [])]);

  const actualColumnLabels = actual.columns.values;
  expect(actualColumnLabels.length, `STEP ${step.step} column count`).toBe(
    expectedColumnLabels.length,
  );
  for (let i = 0; i < expectedColumnLabels.length; i++) {
    assertLabelStrictlyEqual(
      actualColumnLabels[i] ?? null,
      expectedColumnLabels[i] ?? null,
      `STEP ${step.step} column label [${i}]`,
    );
  }

  const actualRowLabels = actual.index.values;
  expect(actualRowLabels.length, `STEP ${step.step} row count`).toBe(expectedRowLabels.length);
  for (let i = 0; i < expectedRowLabels.length; i++) {
    assertLabelStrictlyEqual(
      actualRowLabels[i] ?? null,
      expectedRowLabels[i] ?? null,
      `STEP ${step.step} row label [${i}]`,
    );
  }

  const actualRows = actual.toArray();
  expect(actualRows.length, `STEP ${step.step} row data count`).toBe(expectedRows.length);
  for (let row = 0; row < expectedRows.length; row++) {
    const actualRow = actualRows[row];
    const expectedRow = expectedRows[row];
    expect(actualRow?.length, `STEP ${step.step} row ${row} length`).toBe(expectedRow?.length);
    for (let col = 0; col < expectedColumnLabels.length; col++) {
      assertJsonEqual(
        encodeRuntimeScalar(actualRow?.[col] ?? null),
        expectedRow?.[col] ?? null,
        `STEP ${step.step} [${row}, ${col}]`,
      );
    }
  }
  expect(Object.keys(step.dtypes ?? {}).length, `STEP ${step.step} dtypes count`).toBe(
    expectedColumnLabels.length,
  );
}

function assertSeriesStrict(actual: Series<Scalar>, step: SnapshotStep): void {
  const expectedValues = expectVector(step);
  const expectedRowLabels = expectIndex(step.index).values.map((value) => decodeLabel(value));

  expect([...actual.shape], `STEP ${step.step} shape`).toEqual([...(step.shape ?? [])]);

  const actualRowLabels = actual.index.values;
  expect(actualRowLabels.length, `STEP ${step.step} row count`).toBe(expectedRowLabels.length);
  for (let i = 0; i < expectedRowLabels.length; i++) {
    assertLabelStrictlyEqual(
      actualRowLabels[i] ?? null,
      expectedRowLabels[i] ?? null,
      `STEP ${step.step} row label [${i}]`,
    );
  }

  expect(actual.values.length, `STEP ${step.step} value count`).toBe(expectedValues.length);
  for (let pos = 0; pos < expectedValues.length; pos++) {
    assertJsonEqual(
      encodeRuntimeScalar(actual.values[pos] ?? null),
      expectedValues[pos] ?? null,
      `STEP ${step.step} [${pos}]`,
    );
  }
  expect(step.dtype, `STEP ${step.step} dtype defined`).toBeDefined();
}
