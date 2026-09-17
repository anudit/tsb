import assert from "node:assert/strict";
import test from "node:test";
import { plan, projectPolicy } from "./planner.mjs";

const candidate = {
  repository: "githubnext/tsb",
  number: 42,
  state: "OPEN",
  labels: [],
  isDraft: false,
  headSha: "head",
  baseSha: "base",
  policyDigest: "policy",
  approvals: 0,
  unresolvedThreads: 0,
  autoMergeRequest: null,
  mergeable: true,
  nativeRequirementsSatisfied: true,
};

const requiredJob = {
  id: "test",
  checkName: "Test",
  source: ".github/workflows/ci.yml#test",
  provides: ["tests"],
  necessity: "required",
  freshnessSubject: "every-head",
  invalidatedBy: ["any-head-change", "workflow-change", "policy-change"],
  prerequisites: [],
  cost: "low",
  phase: "on-change",
  approvalMode: "never",
  automaticRetries: 0,
  diagnose: true,
};

const successfulEvidence = {
  conclusion: "SUCCESS",
  fresh: true,
  headSha: candidate.headSha,
  source: requiredJob.source,
  startedAt: "2026-09-03T10:00:00Z",
  completedAt: "2026-09-03T10:05:00Z",
};

const base = {
  candidate,
  event: {
    expectedHeadSha: "head",
    expectedBaseSha: "base",
    policyDigest: "policy",
    duplicate: false,
  },
  policy: {
    operationMode: "orchestrate",
    autoMerge: "off",
    mergeMethod: "squash",
    requireNonDraft: true,
    requiredApprovals: 0,
    requireResolvedThreads: false,
    jobs: [requiredJob],
  },
  evidence: { Test: successfulEvidence },
  revisions: {
    policyChangedAt: "2026-09-03T09:00:00Z",
    workflows: { [requiredJob.source]: "2026-09-03T09:00:00Z" },
  },
  handledExceptionKeys: [],
  policyAmbiguity: false,
  unknownBlockingFailure: false,
};

function input(changes = {}) {
  return {
    ...structuredClone(base),
    ...changes,
    candidate: { ...candidate, ...changes.candidate },
    policy: { ...base.policy, ...changes.policy },
    event: changes.event === undefined ? structuredClone(base.event) : changes.event,
  };
}

function evidence(changes = {}) {
  return { Test: { ...successfulEvidence, ...changes } };
}

const cases = [
  ["green candidate remains manually mergeable", {}, "ready", "all-requirements-satisfied"],
  ["stale head event", { event: { expectedHeadSha: "old" } }, "noop", "stale-event"],
  ["stale base event", { event: { expectedBaseSha: "old" } }, "noop", "stale-base"],
  ["stale policy event", { event: { policyDigest: "old" } }, "noop", "stale-policy"],
  ["duplicate event", { event: { duplicate: true } }, "noop", "duplicate-event"],
  ["closed PR", { candidate: { state: "CLOSED" } }, "noop", "pull-request-not-open"],
  ["merged PR", { candidate: { state: "MERGED" } }, "noop", "pull-request-not-open"],
  ["draft PR", { candidate: { isDraft: true } }, "waiting", "draft-pull-request"],
  ["unknown draft state", { candidate: { isDraft: undefined } }, "waiting", "draft-state-unknown"],
  ["missing labels", { candidate: { labels: undefined } }, "waiting", "pause-state-unknown"],
  ["pause label", { candidate: { labels: ["mq:pause"] } }, "waiting", "pull-request-paused"],
  ["paused label", { candidate: { labels: ["mq:paused"] } }, "waiting", "pull-request-paused"],
  [
    "human review label",
    { candidate: { labels: ["needs-review"] } },
    "waiting",
    "human-review-required",
  ],
  ["review missing", { policy: { requiredApprovals: 1 } }, "waiting", "missing-review-approval"],
  [
    "review state unknown",
    { candidate: { approvals: undefined } },
    "waiting",
    "missing-review-approval",
  ],
  [
    "thread unresolved",
    { policy: { requireResolvedThreads: true }, candidate: { unresolvedThreads: 1 } },
    "waiting",
    "unresolved-review-thread",
  ],
  [
    "thread state unknown",
    { policy: { requireResolvedThreads: true }, candidate: { unresolvedThreads: undefined } },
    "waiting",
    "unresolved-review-thread",
  ],
  ["missing evidence", { evidence: {} }, "waiting", "required-check-not-reported"],
  ["evidence collection absent", { evidence: undefined }, "waiting", "required-check-not-reported"],
  ["unknown failure", { unknownBlockingFailure: true }, "diagnose", "unknown-failure"],
  ["unclassified new job", { policyAmbiguity: true }, "diagnose", "policy-ambiguity"],
  [
    "known failure without diagnosis",
    {
      evidence: evidence({ conclusion: "FAILURE" }),
      policy: { jobs: [{ ...requiredJob, diagnose: false }] },
    },
    "attention",
    "required-check-failed",
  ],
  [
    "satisfied reviews",
    { policy: { requiredApprovals: 1, requireResolvedThreads: true }, candidate: { approvals: 1 } },
    "ready",
    "all-requirements-satisfied",
  ],
];

for (const [name, changes, state, reason] of cases) {
  test(name, () => {
    const actual = plan(input(changes));
    assert.equal(actual.state, state);
    assert.equal(actual.reason, reason);
    assert.ok(actual.effects.every((item) => item.type === "diagnose"));
  });
}

for (const conclusion of ["EXPECTED", "PENDING", "QUEUED", "IN_PROGRESS", "WAITING"]) {
  test(`${conclusion} is a normal wait without model activation`, () => {
    const actual = plan(input({ evidence: evidence({ conclusion, completedAt: undefined }) }));
    assert.equal(actual.state, "waiting");
    assert.equal(actual.reason, "required-check-running");
    assert.deepEqual(actual.proposedEffects, []);
    assert.deepEqual(actual.pending, ["test"]);
  });
}

for (const conclusion of [
  "ACTION_REQUIRED",
  "CANCELLED",
  "ERROR",
  "FAILURE",
  "STALE",
  "TIMED_OUT",
]) {
  test(`${conclusion} on fresh required evidence requests bounded diagnosis`, () => {
    const actual = plan(input({ evidence: evidence({ conclusion }) }));
    assert.equal(actual.state, "diagnose");
    assert.equal(actual.reason, "required-check-failed");
    assert.equal(actual.effects[0].reason, "failure-exhausted");
    assert.equal(actual.effects[0].job, "test");
    assert.deepEqual(actual.failed, ["test"]);
  });
}

for (const conclusion of ["NEUTRAL", "SKIPPED"]) {
  test(`${conclusion} never satisfies a required check`, () => {
    const actual = plan(input({ policy: { autoMerge: "on" }, evidence: evidence({ conclusion }) }));
    assert.equal(actual.state, "attention");
    assert.equal(actual.reason, "required-check-not-successful");
    assert.deepEqual(actual.nonSuccess, ["test"]);
    assert.deepEqual(actual.proposedEffects, []);
  });
}

for (const conclusion of [undefined, null, "", "COMPLETED", "BOGUS"]) {
  test(`unnormalized or unknown conclusion ${String(conclusion)} cannot pass`, () => {
    const actual = plan(input({ policy: { autoMerge: "on" }, evidence: evidence({ conclusion }) }));
    assert.equal(actual.state, "waiting");
    assert.equal(actual.reason, "required-check-not-reported");
    assert.deepEqual(actual.proposedEffects, []);
  });
}

test("normalized lowercase conclusion is supported", () => {
  assert.equal(plan(input({ evidence: evidence({ conclusion: "success" }) })).state, "ready");
});

const staleEvidence = [
  ["runtime did not validate trust", { fresh: undefined }],
  ["runtime rejected trust", { fresh: false }],
  ["truthy value cannot replace validation", { fresh: "true" }],
  ["previous head", { headSha: "previous-head" }],
  ["head identity absent", { headSha: undefined }],
  ["different workflow", { source: ".github/workflows/untrusted.yml#test" }],
  ["source identity absent", { source: undefined }],
  ["run began before policy", { startedAt: "2026-09-03T08:59:59Z" }],
  ["run time unavailable", { startedAt: undefined }],
  ["run time invalid", { startedAt: "invalid" }],
  ["completion missing", { completedAt: undefined }],
  ["completion invalid", { completedAt: "invalid" }],
  ["completion predates start", { completedAt: "2026-09-03T09:59:59Z" }],
];
for (const [name, changes] of staleEvidence) {
  test(`${name} invalidates otherwise green evidence`, () => {
    const actual = plan(input({ policy: { autoMerge: "on" }, evidence: evidence(changes) }));
    assert.equal(actual.state, "waiting");
    assert.equal(actual.reason, "required-check-not-reported");
    assert.deepEqual(actual.proposedEffects, []);
  });
}

for (const revisions of [
  undefined,
  {},
  { ...base.revisions, policyChangedAt: undefined },
  { ...base.revisions, policyChangedAt: "invalid" },
  { ...base.revisions, policyChangedAt: "2026-09-03T10:01:00Z" },
  { ...base.revisions, workflows: undefined },
  { ...base.revisions, workflows: {} },
  { ...base.revisions, workflows: { [requiredJob.source]: "invalid" } },
  { ...base.revisions, workflows: { [requiredJob.source]: "2026-09-03T10:01:00Z" } },
]) {
  test(`unknown or changed revisions fail closed: ${JSON.stringify(revisions)}`, () => {
    const actual = plan(input({ revisions }));
    assert.equal(actual.reason, "required-check-not-reported");
  });
}

test("matching trusted revision time is accepted", () => {
  const actual = plan(
    input({
      revisions: {
        policyChangedAt: successfulEvidence.startedAt,
        workflows: { [requiredJob.source]: successfulEvidence.startedAt },
      },
    }),
  );
  assert.equal(actual.state, "ready");
});

test("a run started before policy change remains stale even if it finished afterwards", () => {
  const actual = plan(
    input({
      revisions: { ...base.revisions, policyChangedAt: "2026-09-03T10:02:00Z" },
    }),
  );
  assert.equal(actual.state, "waiting");
});

test("only declared base invalidation affects current-head evidence", () => {
  const changes = { candidate: { baseSha: "new-base" }, event: {} };
  assert.equal(plan(input(changes)).state, "ready");
  const policy = {
    jobs: [{ ...requiredJob, invalidatedBy: [...requiredJob.invalidatedBy, "any-base-change"] }],
  };
  assert.equal(plan(input({ ...changes, policy })).state, "waiting");
  assert.equal(
    plan(input({ ...changes, policy, evidence: evidence({ baseSha: "base" }) })).state,
    "waiting",
  );
  assert.equal(
    plan(input({ ...changes, policy, evidence: evidence({ baseSha: "new-base" }) })).state,
    "ready",
  );
});

test("undeclared revision changes do not invalidate exact-head evidence", () => {
  const actual = plan(
    input({
      policy: { jobs: [{ ...requiredJob, invalidatedBy: ["any-head-change"] }] },
      revisions: {},
    }),
  );
  assert.equal(actual.state, "ready");
});

for (const [key, value] of [
  ["repository", ""],
  ["number", 0],
  ["number", 1.5],
  ["number", "42"],
  ["headSha", undefined],
  ["baseSha", ""],
  ["policyDigest", " "],
]) {
  test(`invalid candidate ${key}=${String(value)} cannot produce an effect`, () => {
    const actual = plan(input({ candidate: { [key]: value }, policyAmbiguity: true }));
    assert.equal(actual.state, "attention");
    assert.equal(actual.reason, "invalid-candidate-identity");
    assert.deepEqual(actual.proposedEffects, []);
  });
}

test("missing candidate identity fails without building a partial key", () => {
  const actual = plan({ ...input(), candidate: undefined });
  assert.equal(actual.reason, "invalid-candidate-identity");
});

for (const policyChanges of [
  { operationMode: "live" },
  { autoMerge: "yes" },
  { mergeMethod: "fast-forward" },
  { requireNonDraft: undefined },
  { requiredApprovals: -1 },
  { requiredApprovals: 0.5 },
  { requireResolvedThreads: undefined },
  { unsupported: ["unreviewed-policy"] },
  { jobs: undefined },
  { jobs: [] },
  { jobs: [null] },
  { jobs: [{ ...requiredJob, necessity: "advisory" }] },
]) {
  test(`unsupported policy cannot permit merging: ${JSON.stringify(policyChanges)}`, () => {
    const actual = plan(input({ policy: policyChanges }));
    assert.equal(actual.reason, "policy-ambiguity");
    assert.equal(actual.state, "diagnose");
    assert.ok(actual.problems.length > 0);
  });
}

for (const jobChanges of [
  { id: undefined },
  { necessity: "unclassified" },
  { necessity: "conditional" },
  { when: { labels: ["run-tests"] } },
  { checkName: undefined },
  { source: undefined },
  { freshnessSubject: "same-diff" },
  { freshnessSubject: "once-per-pr" },
  { freshnessSubject: "latest-base" },
  { freshnessSubject: "before-merge" },
  { freshnessSubject: "merge-group" },
  { freshnessTtlMinutes: 30 },
  { invalidatedBy: undefined },
  { invalidatedBy: [] },
  { invalidatedBy: ["relevant-head-change"] },
  { invalidatedBy: ["relevant-base-change"] },
  { invalidatedBy: ["manual"] },
  { phase: "post-merge" },
  { phase: "after-review" },
  { phase: "after-cheap-checks" },
  { phase: "final-candidate" },
  { approvalMode: "always" },
  { approvalMode: "untrusted-only" },
  { automaticRetries: 1 },
  { diagnose: "yes" },
  { dispatch: {} },
  { dispatch: { workflow: "ci.yml" } },
]) {
  test(`unsupported required job fails closed: ${JSON.stringify(jobChanges)}`, () => {
    const actual = plan(
      input({ policy: { autoMerge: "on", jobs: [{ ...requiredJob, ...jobChanges }] } }),
    );
    assert.equal(actual.reason, "policy-ambiguity");
    assert.ok(actual.problems.length > 0);
    assert.ok(actual.effects.every((item) => item.type === "diagnose"));
  });
}

for (const secondJob of [
  requiredJob,
  { ...requiredJob, id: "duplicate-name", source: ".github/workflows/ci.yml#other" },
  { ...requiredJob, id: "duplicate-source", checkName: "Other" },
]) {
  test(`ambiguous duplicate job identity is rejected: ${secondJob.id}`, () => {
    const actual = plan(input({ policy: { jobs: [requiredJob, secondJob] } }));
    assert.equal(actual.reason, "policy-ambiguity");
  });
}

test("advisory and diagnostic evidence cannot affect readiness or request workers", () => {
  const advisory = {
    ...requiredJob,
    id: "advisory",
    necessity: "advisory",
    checkName: "Benchmark",
    freshnessSubject: "same-diff",
    phase: "post-merge",
  };
  const diagnostic = {
    ...advisory,
    id: "diagnostic",
    necessity: "diagnostic",
    checkName: "Diagnosis",
  };
  const actual = plan(
    input({
      policy: { jobs: [requiredJob, advisory, diagnostic] },
      evidence: {
        ...base.evidence,
        Benchmark: { conclusion: "FAILURE" },
        Diagnosis: { conclusion: "FAILURE" },
      },
    }),
  );
  assert.equal(actual.state, "ready");
  assert.deepEqual(actual.effects, []);
  const forbiddenDispatch = plan(
    input({ policy: { jobs: [requiredJob, { ...advisory, dispatch: {} }] } }),
  );
  assert.equal(forbiddenDispatch.reason, "policy-ambiguity");
});

test("all required checks must pass and failed prerequisites never dispatch downstream work", () => {
  const build = {
    ...requiredJob,
    id: "build",
    checkName: "Build",
    source: ".github/workflows/ci.yml#build",
    prerequisites: ["tests"],
  };
  const revisions = {
    ...base.revisions,
    workflows: { ...base.revisions.workflows, [build.source]: base.revisions.policyChangedAt },
  };
  const policy = { jobs: [requiredJob, build] };
  const waiting = plan(input({ policy, revisions }));
  assert.deepEqual(waiting.missing, ["build"]);
  const failed = plan(input({ policy, revisions, evidence: evidence({ conclusion: "FAILURE" }) }));
  assert.equal(failed.state, "diagnose");
  assert.ok(failed.proposedEffects.every((item) => item.type !== "dispatch"));
  const green = plan(
    input({
      policy,
      revisions,
      evidence: { ...base.evidence, Build: { ...successfulEvidence, source: build.source } },
    }),
  );
  assert.equal(green.state, "ready");
});

test("a non-diagnosable failure does not mask a diagnosable required failure", () => {
  const second = {
    ...requiredJob,
    id: "second",
    checkName: "Second",
    source: ".github/workflows/ci.yml#second",
  };
  const actual = plan(
    input({
      policy: { jobs: [{ ...requiredJob, diagnose: false }, second] },
      revisions: {
        ...base.revisions,
        workflows: { ...base.revisions.workflows, [second.source]: base.revisions.policyChangedAt },
      },
      evidence: {
        ...evidence({ conclusion: "FAILURE" }),
        Second: { ...successfulEvidence, source: second.source, conclusion: "FAILURE" },
      },
    }),
  );
  assert.equal(actual.effects[0].job, "second");
  assert.deepEqual(actual.failed, ["test", "second"]);
});

for (const changes of [
  { evidence: evidence({ conclusion: "FAILURE" }) },
  { unknownBlockingFailure: true },
  { policyAmbiguity: true },
]) {
  test(`exception deduplication is durable: ${JSON.stringify(changes)}`, () => {
    const first = plan(input(changes));
    const second = plan(input({ ...changes, handledExceptionKeys: [first.effects[0].key] }));
    assert.equal(second.state, "noop");
    assert.equal(second.reason, "exception-already-handled");
    assert.deepEqual(second.effects, []);
    const newHead = plan(
      input({
        ...changes,
        candidate: { headSha: "new-head" },
        event: {},
        evidence: evidence({ headSha: "new-head", conclusion: "FAILURE" }),
        handledExceptionKeys: [first.effects[0].key],
      }),
    );
    assert.equal(newHead.state, "diagnose");
    assert.notEqual(newHead.effects[0].key, first.effects[0].key);
  });
}

test("dedupe input may be empty or unavailable without crashing", () => {
  assert.equal(
    plan(input({ policyAmbiguity: true, handledExceptionKeys: undefined })).state,
    "diagnose",
  );
});

for (const changes of [
  { policy: { autoMerge: "on" } },
  { evidence: evidence({ conclusion: "FAILURE" }) },
  { unknownBlockingFailure: true },
  { policyAmbiguity: true },
  {},
]) {
  test(`observation suppresses every effect: ${JSON.stringify(changes)}`, () => {
    const actual = plan(
      input({ ...changes, policy: { ...changes.policy, operationMode: "observe" } }),
    );
    assert.deepEqual(actual.effects, []);
  });
}

for (const label of ["mq:pause", "mq:paused", "needs-review"]) {
  test(`${label} suppresses merge and diagnosis even for ambiguity or failures`, () => {
    for (const changes of [
      {},
      { policyAmbiguity: true },
      { evidence: evidence({ conclusion: "FAILURE" }) },
    ]) {
      const actual = plan(
        input({ ...changes, candidate: { labels: [label] }, policy: { autoMerge: "on" } }),
      );
      assert.equal(actual.state, "waiting");
      assert.deepEqual(actual.proposedEffects, []);
    }
  });
}

const autoMergeCases = [
  ["authorized", {}, "auto-merge", "all-requirements-satisfied"],
  [
    "existing request",
    { autoMergeRequest: { enabledAt: "yesterday" } },
    "noop",
    "auto-merge-already-enabled",
  ],
  [
    "unknown request",
    { autoMergeRequest: undefined },
    "waiting",
    "native-auto-merge-state-unknown",
  ],
  ["conflict", { mergeable: false }, "attention", "merge-conflict"],
  ["unknown mergeability", { mergeable: undefined }, "waiting", "mergeability-unknown"],
  ["unnormalized mergeability", { mergeable: "MERGEABLE" }, "waiting", "mergeability-unknown"],
  [
    "native rules not satisfied",
    { nativeRequirementsSatisfied: false },
    "waiting",
    "native-requirements-unsatisfied",
  ],
  [
    "native rules unknown",
    { nativeRequirementsSatisfied: undefined },
    "waiting",
    "native-requirements-unsatisfied",
  ],
];
for (const mode of ["off", "opt-in"]) {
  for (const [name, changes, state, reason] of [
    ["native requirements satisfied", {}, "ready", "all-requirements-satisfied"],
    ["merge conflict", { mergeable: false }, "attention", "merge-conflict"],
    ["unknown mergeability", { mergeable: undefined }, "waiting", "mergeability-unknown"],
    [
      "native blocker",
      { nativeRequirementsSatisfied: false },
      "waiting",
      "native-requirements-unsatisfied",
    ],
    [
      "unknown native rules",
      { nativeRequirementsSatisfied: undefined },
      "waiting",
      "native-requirements-unsatisfied",
    ],
  ]) {
    test(`manual readiness with auto merge ${mode}: ${name}`, () => {
      const actual = plan(input({ policy: { autoMerge: mode }, candidate: changes }));
      assert.equal(actual.state, state);
      assert.equal(actual.reason, reason);
      assert.deepEqual(actual.proposedEffects, []);
      assert.deepEqual(actual.effects, []);
    });
  }
}

for (const [name, changes, state, reason] of autoMergeCases) {
  test(`auto merge: ${name}`, () => {
    const actual = plan(input({ policy: { autoMerge: "on" }, candidate: changes }));
    assert.equal(actual.state, state);
    assert.equal(actual.reason, reason);
    assert.equal(actual.effects.length, state === "auto-merge" ? 1 : 0);
  });
}

test("draft cannot auto merge even when manual readiness allows drafts", () => {
  const actual = plan(
    input({ policy: { autoMerge: "on", requireNonDraft: false }, candidate: { isDraft: true } }),
  );
  assert.equal(actual.reason, "draft-pull-request");
  assert.deepEqual(actual.effects, []);
});

test("routine draft wait takes precedence over inventory ambiguity without diagnosis", () => {
  const actual = plan(input({ candidate: { isDraft: true }, policyAmbiguity: true }));
  assert.equal(actual.reason, "draft-pull-request");
  assert.deepEqual(actual.proposedEffects, []);
});

test("opt-in requires the exact human-owned label", () => {
  for (const labels of [[], ["auto-merge"], ["mq:auto-merge-ish"]]) {
    const actual = plan(input({ policy: { autoMerge: "opt-in" }, candidate: { labels } }));
    assert.equal(actual.state, "ready");
    assert.deepEqual(actual.effects, []);
  }
  const actual = plan(
    input({ policy: { autoMerge: "opt-in" }, candidate: { labels: ["mq:auto-merge"] } }),
  );
  assert.equal(actual.state, "auto-merge");
});

test("auto merge off never produces a merge effect, even with opt-in label", () => {
  const actual = plan(input({ candidate: { labels: ["mq:auto-merge"] } }));
  assert.equal(actual.state, "ready");
  assert.deepEqual(actual.effects, []);
});

test("effect carries full identity for final deterministic runtime revalidation", () => {
  const actual = plan(input({ policy: { autoMerge: "on" } }));
  assert.deepEqual(actual.effects[0], {
    type: "auto-merge",
    method: "squash",
    identity: {
      repository: "githubnext/tsb",
      number: 42,
      headSha: "head",
      baseSha: "base",
      policyDigest: "policy",
    },
    key: "githubnext/tsb:42:head:base:policy:auto-merge:squash",
  });
  for (const changes of [
    { candidate: { headSha: "new-head" } },
    { candidate: { baseSha: "new-base" } },
    { candidate: { policyDigest: "new-policy" } },
  ]) {
    assert.deepEqual(plan(input({ ...changes, policy: { autoMerge: "on" } })).effects, []);
  }
});

test("planner is deterministic and does not mutate its inputs", () => {
  const fixture = input({ evidence: evidence({ conclusion: "FAILURE" }) });
  const original = structuredClone(fixture);
  assert.deepEqual(plan(fixture), plan(fixture));
  assert.deepEqual(fixture, original);
});

const config = {
  version: 1,
  defaults: {
    operation_mode: "orchestrate",
    auto_merge: "on",
    merge_method: "squash",
    base_strategy: "on-conflict",
    max_parallel_cost: "medium",
    max_automatic_retries: 0,
  },
  readiness: {
    require_non_draft: true,
    required_approvals: 0,
    require_resolved_threads: false,
    dependencies: "ignore",
  },
  jobs: {
    test: {
      source: requiredJob.source,
      check_name: requiredJob.checkName,
      provides: ["tests"],
      necessity: { level: "required" },
      freshness: { subject: "every-head", invalidated_by: requiredJob.invalidatedBy },
      approval: { mode: "never" },
      cost: { tier: "low" },
      phase: "on-change",
      failure: { automatic_retries: 0, diagnose: true },
    },
  },
};

test("projected current policy supports only reviewed capabilities", () => {
  const policy = projectPolicy(config);
  const actual = plan(input({ policy }));
  assert.equal(actual.state, "auto-merge");
  assert.deepEqual(policy.unsupported, []);
  assert.equal(policy.jobs[0].freshnessSubject, "every-head");
  assert.equal(policy.jobs[0].phase, "on-change");
  assert.equal(policy.jobs[0].approvalMode, "never");
});

test("configuration projection preserves unsupported semantics for fail-closed evaluation", () => {
  const expanded = structuredClone(config);
  expanded.version = 2;
  expanded.defaults.base_strategy = "always-current";
  expanded.readiness.dependencies = "require-merged";
  expanded.jobs.test.necessity = { level: "conditional", when: { paths: ["src/**"] } };
  expanded.jobs.test.freshness = {
    subject: "same-diff",
    invalidated_by: ["relevant-head-change"],
    ttl_minutes: 30,
  };
  expanded.jobs.test.dispatch = { workflow: "ci.yml" };
  expanded.jobs.test.prerequisites = ["human-review"];
  const policy = projectPolicy(expanded);
  assert.equal(policy.jobs[0].when.paths[0], "src/**");
  assert.equal(policy.jobs[0].freshnessTtlMinutes, 30);
  assert.equal(policy.jobs[0].dispatch.workflow, "ci.yml");
  assert.deepEqual(policy.jobs[0].prerequisites, ["human-review"]);
  assert.equal(plan(input({ policy })).reason, "policy-ambiguity");
});

test("projection defaults remain conservative", () => {
  const minimal = structuredClone(config);
  minimal.defaults = Object.fromEntries(
    Object.entries(minimal.defaults).filter(
      ([key]) => !["operation_mode", "merge_method", "max_automatic_retries"].includes(key),
    ),
  );
  minimal.jobs.test = Object.fromEntries(
    Object.entries(minimal.jobs.test).filter(([key]) => !["phase", "failure"].includes(key)),
  );
  const policy = projectPolicy(minimal);
  assert.equal(policy.operationMode, "observe");
  assert.equal(policy.mergeMethod, "squash");
  assert.equal(policy.jobs[0].phase, "on-change");
  assert.equal(policy.jobs[0].automaticRetries, 0);
  assert.equal(policy.jobs[0].diagnose, true);
  assert.deepEqual(plan(input({ policy })).effects, []);
});

test("missing configuration sections fail closed instead of silently becoming ready", () => {
  for (const value of [{}, { jobs: { unclassified: {} } }, { ...config, readiness: undefined }]) {
    const policy = projectPolicy(value);
    assert.equal(plan(input({ policy })).reason, "policy-ambiguity");
  }
});
