import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDiagnosisContext, writeDiagnosisContext } from "./diagnosis-context.mjs";

const candidate = {
  repository: "githubnext/tsb",
  number: 42,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  policyDigest: "c".repeat(64),
  title: "UNRELATED_PR_PROSE",
  body: "DO_NOT_COPY",
  autoMergeRequest: { secret: "NO" },
};
const planned = {
  state: "diagnose",
  reason: "required-check-failed",
  candidate,
  job: "test",
  effects: [{ type: "diagnose", reason: "failure-exhausted" }],
};
const failure = {
  source: ".github/workflows/ci.yml#test",
  conclusion: "FAILURE",
  fresh: true,
  runId: 123,
  jobId: 456,
  output: "LOG_SECRET",
};

test("preflight context retains the exact blocker and relevant IDs without PR prose or logs", () => {
  const context = buildDiagnosisContext({
    planned,
    notes: ["Required Test failed."],
    runIds: [123, 123],
    evidence: { Test: failure },
  });
  assert.deepEqual(context.candidate, {
    repository: "githubnext/tsb",
    number: 42,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    policyDigest: "c".repeat(64),
  });
  assert.equal(context.reason, "failure-exhausted");
  assert.deepEqual(context.notes, ["Required Test failed."]);
  assert.deepEqual(context.evidence.runIds, [123]);
  assert.deepEqual(
    context.evidence.checks,
    [{ name: "Test", ...failure, output: undefined }].map(({ output, ...metadata }) => metadata),
  );
  assert.equal(context.truncated, false);
  assert.doesNotMatch(
    JSON.stringify(context),
    /UNRELATED_PR_PROSE|DO_NOT_COPY|LOG_SECRET|autoMergeRequest/,
  );
});

test("bounded context prioritizes failures and rejects unsafe evidence IDs", () => {
  const context = buildDiagnosisContext({
    planned: { ...planned, problems: Array(20).fill("p".repeat(400)) },
    notes: Array(20).fill(`\n${"n".repeat(400)}`),
    runIds: [
      0,
      -1,
      "123",
      Number.MAX_SAFE_INTEGER + 1,
      ...Array.from({ length: 20 }, (_, i) => i + 1),
    ],
    evidence: Object.fromEntries([
      ...Array.from({ length: 20 }, (_, i) => [`green${i}`, { ...failure, conclusion: "SUCCESS" }]),
      ["FAILED", { ...failure, runId: "$(command)", jobId: -1 }],
    ]),
  });
  assert.equal(context.truncated, true);
  assert.equal(context.notes.length, 8);
  assert.equal(context.notes[0].length, 256);
  assert.equal(context.problems.length, 8);
  assert.equal(context.evidence.runIds.length, 8);
  assert.equal(context.evidence.checks.length, 12);
  assert.equal(context.evidence.checks[0].name, "FAILED");
  assert.equal(context.evidence.checks[0].jobId, undefined);
  assert.equal(context.evidence.checks[0].runId, undefined);
  assert.doesNotMatch(JSON.stringify(context), /\n/);
  assert.ok(Buffer.byteLength(JSON.stringify(context)) < 16384);
  const unicode = buildDiagnosisContext({
    planned: { ...planned, problems: Array(8).fill("🌍".repeat(400)) },
    notes: Array(8).fill("🌍".repeat(400)),
    evidence: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `${i}${"🌍".repeat(400)}`,
        { ...failure, source: "🌍".repeat(400) },
      ]),
    ),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(unicode)) < 16384);
  assert.ok(unicode.notes.every((note) => Buffer.byteLength(note) <= 256));
  const escaped = "\\".repeat(1000);
  const escapedContext = buildDiagnosisContext({
    planned: { ...planned, reason: escaped, job: escaped, problems: Array(8).fill(escaped) },
    notes: Array(8).fill(escaped),
    evidence: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `${i}${escaped}`,
        { ...failure, source: escaped, conclusion: escaped },
      ]),
    ),
  });
  assert.equal(escapedContext.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(escapedContext)) < 16384);
});

test("routine states have no context; invalid diagnosis identity or reason fails closed", () => {
  assert.equal(buildDiagnosisContext({ planned: { ...planned, state: "attention" } }), null);
  assert.equal(buildDiagnosisContext({ planned: { ...planned, effects: [] } }), null);
  for (const change of [
    { number: "42" },
    { repository: "owner/repo;command" },
    { headSha: "bad" },
    { baseSha: "" },
    { policyDigest: "bad" },
  ]) {
    assert.throws(
      () =>
        buildDiagnosisContext({ planned: { ...planned, candidate: { ...candidate, ...change } } }),
      /identity/,
    );
  }
  assert.throws(
    () =>
      buildDiagnosisContext({
        planned: { ...planned, effects: [{ type: "diagnose", reason: "review" }] },
      }),
    /reason/,
  );
});

test("JSON transport preserves hostile text only as data and rejects missing or oversized context", () => {
  const directory = mkdtempSync(join(tmpdir(), "diagnosis-context-test-"));
  const destination = join(directory, "context.json");
  try {
    const context = buildDiagnosisContext({
      planned,
      notes: ['$(touch /tmp/DO_NOT_RUN) `command` ${process.env.SECRET} "quoted"'],
    });
    writeDiagnosisContext(JSON.stringify(context), destination);
    assert.deepEqual(JSON.parse(readFileSync(destination, "utf8")), context);
    for (const invalid of [
      undefined,
      "",
      "{}",
      " ".repeat(16385),
      JSON.stringify({ ...context, reason: "review" }),
    ]) {
      assert.throws(() => writeDiagnosisContext(invalid, destination));
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("workflow transports evidence through env and keeps diagnosis bounded and read-only", () => {
  const source = readFileSync(
    new URL("../workflows/merge-steward-diagnose.md", import.meta.url),
    "utf8",
  );
  assert.match(source, /context_json: \$\{\{ steps\.validate\.outputs\.context_json \}\}/);
  assert.match(
    source,
    /MERGE_STEWARD_CONTEXT: \$\{\{ needs\.preflight\.outputs\.context_json \}\}/,
  );
  assert.match(source, /run: node \.github\/merge-steward\/diagnosis-context\.mjs --write/);
  assert.doesNotMatch(source.split("# Merge Steward Diagnosis")[1], /\$\{\{/);
  assert.match(source, /max-turns: 12/);
  assert.match(source, /staged: true/);
  assert.doesNotMatch(source, /: write|network:.*all/);
  assert.match(source, /at most three additional targeted REST/);
  assert.match(source, /final two of the 12 model turns/);
});
