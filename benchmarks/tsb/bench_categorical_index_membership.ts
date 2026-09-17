/**
 * Benchmark: CategoricalIndex membership & ordering — hasCategory, contains,
 * and compareLabels (on an ordered index) over 100k lookups.
 * Outputs JSON: {"function": "categorical_index_membership", "mean_ms": ..., "iterations": ..., "total_ms": ...}
 */
import { CategoricalIndex } from "../../src/index.ts";

const SIZE = 100_000;
const WARMUP = 5;
const ITERATIONS = 30;

const CATS = ["alpha", "beta", "gamma", "delta", "epsilon"];
const labels = Array.from({ length: SIZE }, (_, i) => CATS[i % CATS.length]);
const ci = CategoricalIndex.fromArray(labels, { categories: CATS, ordered: true });

function run(): void {
  let hasCount = 0;
  let containsCount = 0;
  let cmpSum = 0;
  for (let i = 0; i < SIZE; i++) {
    const label = CATS[i % CATS.length];
    if (ci.hasCategory(label)) hasCount++;
    if (ci.contains(label)) containsCount++;
    cmpSum += ci.compareLabels(label, CATS[(i + 1) % CATS.length]);
  }
  if (hasCount < 0 || containsCount < 0 || cmpSum === Number.NaN) {
    throw new Error("unreachable");
  }
}

for (let i = 0; i < WARMUP; i++) {
  run();
}

const start = performance.now();
for (let i = 0; i < ITERATIONS; i++) {
  run();
}
const total = performance.now() - start;

console.log(
  JSON.stringify({
    function: "categorical_index_membership",
    mean_ms: total / ITERATIONS,
    iterations: ITERATIONS,
    total_ms: total,
  }),
);
