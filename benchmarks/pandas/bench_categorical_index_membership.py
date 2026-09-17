"""
Benchmark: pandas.CategoricalIndex membership & ordering — category membership
("in" on categories), value containment ("in" on the index), and ordered
comparison (via categories.get_loc) over 100k lookups.
Outputs JSON: {"function": "categorical_index_membership", "mean_ms": ..., "iterations": ..., "total_ms": ...}
"""
import json
import time
import pandas as pd

SIZE = 100_000
WARMUP = 5
ITERATIONS = 30

CATS = ["alpha", "beta", "gamma", "delta", "epsilon"]
labels = [CATS[i % len(CATS)] for i in range(SIZE)]
ci = pd.CategoricalIndex(labels, categories=CATS, ordered=True)
loc = ci.categories.get_loc


def run():
    has_count = 0
    contains_count = 0
    cmp_sum = 0
    for i in range(SIZE):
        label = CATS[i % len(CATS)]
        other = CATS[(i + 1) % len(CATS)]
        if label in ci.categories:
            has_count += 1
        if label in ci:
            contains_count += 1
        cmp_sum += loc(label) - loc(other)
    if has_count < 0 or contains_count < 0:
        raise RuntimeError("unreachable")
    return cmp_sum


for _ in range(WARMUP):
    run()

start = time.perf_counter()
for _ in range(ITERATIONS):
    run()
total = (time.perf_counter() - start) * 1000

print(json.dumps({
    "function": "categorical_index_membership",
    "mean_ms": total / ITERATIONS,
    "iterations": ITERATIONS,
    "total_ms": total,
}))
