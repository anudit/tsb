import assert from "node:assert/strict";
import test from "node:test";
import { loadEvidence } from "./evidence.mjs";

const repository = "githubnext/tsb";
const source = ".github/workflows/ci.yml#test";
const workflow = "name: CI\njobs:\n  test:\n    name: Test & Lint\n";
const policy = {
  jobs: [{ id: "test", checkName: "Test & Lint", source, necessity: "required" }],
};
const pull = {
  number: 42,
  head: { sha: "head", ref: "autoloop/example", repo: { full_name: repository } },
  base: { ref: "main" },
  merge_commit_sha: "merge",
};

function run(overrides = {}) {
  return {
    id: 10,
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    head_sha: pull.head.sha,
    head_branch: pull.head.ref,
    status: "completed",
    conclusion: "success",
    created_at: "2026-09-17T10:00:00Z",
    run_started_at: "2026-09-17T10:00:10Z",
    run_attempt: 1,
    pull_requests: [{ number: 42, head: pull.head, base: pull.base }],
    ...overrides,
  };
}

function job(overrides = {}) {
  return {
    id: 100,
    run_id: 10,
    run_attempt: 1,
    head_sha: "head",
    name: "Test & Lint",
    status: "completed",
    conclusion: "success",
    started_at: "2026-09-17T10:00:15Z",
    completed_at: "2026-09-17T10:01:00Z",
    ...overrides,
  };
}

function mock({
  runs = [run()],
  jobs = [job()],
  candidateWorkflow = workflow,
  routeOverride,
} = {}) {
  const calls = [];
  const api = async (route) => {
    calls.push(route);
    if (routeOverride) {
      const overridden = await routeOverride(route);
      if (overridden !== undefined) return overridden;
    }
    const url = new URL(route, "https://api.github.com/");
    const page = Number(url.searchParams.get("page") ?? 1);
    assert.equal(url.searchParams.get("per_page") ?? "100", "100");
    if (url.pathname.endsWith("/runs")) {
      const matches = runs.filter((item) => item.head_sha === url.searchParams.get("head_sha"));
      return {
        total_count: matches.length,
        workflow_runs: matches.slice((page - 1) * 100, page * 100),
      };
    }
    if (url.pathname.endsWith("/jobs")) {
      assert.equal(url.searchParams.get("filter"), "latest");
      const id = Number(url.pathname.split("/").at(-2));
      const matches = jobs.filter((item) => item.run_id === id);
      return { total_count: matches.length, jobs: matches.slice((page - 1) * 100, page * 100) };
    }
    if (url.pathname.endsWith("/contents/.github/workflows/ci.yml")) {
      return {
        type: "file",
        encoding: "base64",
        content: Buffer.from(candidateWorkflow).toString("base64"),
      };
    }
    assert.fail(`Unexpected API route: ${route}`);
  };
  return { api, calls };
}

async function load(options = {}, inputs = {}) {
  const { api, calls } = mock(options);
  const result = await loadEvidence({
    api,
    repository,
    pull,
    policy,
    readTrustedFile: async () => workflow,
    ...inputs,
  });
  return { ...result, calls };
}

test("accepts Actions jobs from the current PR's exact trusted CI workflow", async () => {
  const actual = await load();
  assert.equal(actual.policyAmbiguity, false);
  assert.deepEqual(actual.runIds, [10]);
  assert.deepEqual(actual.evidence["Test & Lint"], {
    conclusion: "SUCCESS",
    completedAt: "2026-09-17T10:01:00Z",
    startedAt: "2026-09-17T10:00:10Z",
    headSha: "head",
    source,
    fresh: true,
  });
  assert(
    actual.calls.every((route) => !route.includes("check-runs") && !route.includes("statuses")),
  );
});

for (const [name, changes] of [
  ["another workflow with the same check name", { path: ".github/workflows/spoof.yml" }],
  ["a different workflow repository", { repository: { full_name: "elsewhere/tsb" } }],
  ["a different head branch", { head_branch: "other" }],
  [
    "a different PR association",
    { pull_requests: [{ number: 9, head: pull.head, base: pull.base }] },
  ],
  [
    "an outdated PR association",
    { pull_requests: [{ number: 42, head: { ...pull.head, sha: "old" }, base: pull.base }] },
  ],
  [
    "a different base branch",
    { pull_requests: [{ number: 42, head: pull.head, base: { ref: "other" } }] },
  ],
  ["an unassociated PR run", { pull_requests: [] }],
  ["a mismatched PR head repository", { head_repository: { full_name: "elsewhere/tsb" } }],
  ["an untyped manual dispatch", { event: "workflow_dispatch" }],
  ["a privileged pull_request_target run", { event: "pull_request_target" }],
]) {
  test(`does not accept ${name}`, async () => {
    const actual = await load({ runs: [run(changes)] });
    assert.deepEqual(actual.evidence, {});
    assert.deepEqual(actual.runIds, []);
  });
}

test("filters stale heads even when an API response includes them", async () => {
  const actual = await load({
    routeOverride: (route) =>
      route.includes("/runs?")
        ? { total_count: 1, workflow_runs: [run({ head_sha: "old" })] }
        : undefined,
  });
  assert.deepEqual(actual.evidence, {});
});

test("accepts the current synthetic merge SHA through its current PR association", async () => {
  const actual = await load({
    runs: [run({ head_sha: "merge" })],
    jobs: [job({ head_sha: "merge" })],
  });
  assert.equal(actual.evidence["Test & Lint"].headSha, "head");
  assert.equal(actual.evidence["Test & Lint"].fresh, true);
  assert(actual.calls.some((route) => route.endsWith("ci.yml?ref=merge")));
});

test("accepts same-repository autoloop push CI when no associated PR run exists", async () => {
  const actual = await load({ runs: [run({ event: "push", pull_requests: [] })] });
  assert.equal(actual.evidence["Test & Lint"].conclusion, "SUCCESS");
});

test("does not accept push evidence from a fork or an ordinary feature branch", async () => {
  for (const candidatePull of [
    { ...pull, head: { ...pull.head, repo: { full_name: "fork/tsb" } } },
    { ...pull, head: { ...pull.head, ref: "feature" } },
  ]) {
    const actual = await load(
      { runs: [run({ event: "push", head_branch: candidatePull.head.ref })] },
      { pull: candidatePull },
    );
    assert.deepEqual(actual.evidence, {});
  }
});

test("prefers the PR run to a newer successful push run", async () => {
  const actual = await load({
    runs: [run(), run({ id: 11, event: "push", created_at: "2026-09-17T11:00:00Z" })],
    jobs: [job({ conclusion: "failure" }), job({ id: 101, run_id: 11 })],
  });
  assert.deepEqual(actual.runIds, [10]);
  assert.equal(actual.evidence["Test & Lint"].conclusion, "FAILURE");
});

test("a newer pending PR run supersedes older successful evidence", async () => {
  const actual = await load({
    runs: [
      run(),
      run({ id: 11, status: "queued", conclusion: null, created_at: "2026-09-17T11:00:00Z" }),
    ],
  });
  assert.deepEqual(actual.runIds, [11]);
  assert.equal(actual.policyAmbiguity, false);
  assert.equal(actual.evidence["Test & Lint"].conclusion, "QUEUED");
});

test("uses the larger run ID when creation times tie", async () => {
  const actual = await load({
    runs: [run(), run({ id: 11 })],
    jobs: [job(), job({ id: 101, run_id: 11, conclusion: "cancelled" })],
  });
  assert.deepEqual(actual.runIds, [11]);
  assert.equal(actual.evidence["Test & Lint"].conclusion, "CANCELLED");
});

test("reads every workflow-run page before choosing the newest relevant run", async () => {
  const runs = Array.from({ length: 100 }, (_, index) =>
    run({ id: index + 100, path: ".github/workflows/other.yml" }),
  );
  runs.push(run());
  const actual = await load({ runs });
  assert.equal(actual.evidence["Test & Lint"].conclusion, "SUCCESS");
  assert(actual.calls.some((route) => route.includes("head_sha=head") && route.endsWith("page=2")));
});

test("reads every job page and detects an unknown job on a later page", async () => {
  const extraJobs = Array.from({ length: 100 }, (_, index) =>
    job({ id: index + 200, name: `Known ${index}` }),
  );
  const extraPolicy = extraJobs.map((item, index) => ({
    id: `job-${index}`,
    checkName: item.name,
    source: `.github/workflows/ci.yml#job-${index}`,
    necessity: "advisory",
  }));
  const actual = await load(
    { jobs: [...extraJobs, job({ id: 300, name: "Unexpected" })] },
    { policy: { jobs: [...policy.jobs, ...extraPolicy] } },
  );
  assert.equal(actual.policyAmbiguity, true);
  assert(actual.notes.some((note) => note.includes("Unexpected")));
  assert(actual.calls.some((route) => route.includes("/jobs?") && route.endsWith("page=2")));
});

test("fails closed when a workflow-run page is incomplete", async () => {
  const actual = await load({
    routeOverride: (route) =>
      route.includes("/runs?") ? { total_count: 2, workflow_runs: [run()] } : undefined,
  });
  assert.equal(actual.policyAmbiguity, true);
  assert.deepEqual(actual.evidence, {});
});

test("rejects malformed or repeated pagination instead of accepting partial success", async () => {
  for (const response of [
    { workflow_runs: null },
    { workflow_runs: [run(), run()] },
    { workflow_runs: [{ ...run(), id: undefined }] },
  ]) {
    const actual = await load({
      routeOverride: (route) => (route.includes("/runs?") ? response : undefined),
    });
    assert.equal(actual.policyAmbiguity, true);
    assert.deepEqual(actual.evidence, {});
  }
});

test("stops on the API's filtered-result limit and requires complete evidence", async () => {
  const runs = Array.from({ length: 1001 }, (_, index) =>
    run({ id: index + 100, path: ".github/workflows/other.yml" }),
  );
  const actual = await load({ runs });
  assert.equal(actual.policyAmbiguity, true);
  assert.deepEqual(actual.evidence, {});
  assert.equal(actual.calls.filter((route) => route.includes("head_sha=head")).length, 10);
});

test("does not request another page after an exact full final page", async () => {
  const runs = Array.from({ length: 99 }, (_, index) =>
    run({ id: index + 100, path: ".github/workflows/other.yml" }),
  );
  runs.push(run());
  const actual = await load({ runs });
  assert.equal(actual.evidence["Test & Lint"].conclusion, "SUCCESS");
  assert(!actual.calls.some((route) => route.endsWith("page=2")));
});

test("selecting evidence is independent of API result order", async () => {
  const success = run();
  const pending = run({
    id: 11,
    status: "in_progress",
    conclusion: null,
    created_at: "2026-09-17T11:00:00Z",
  });
  const push = run({ id: 12, event: "push", created_at: "2026-09-17T12:00:00Z" });
  for (const runs of [
    [success, pending, push],
    [success, push, pending],
    [pending, success, push],
    [pending, push, success],
    [push, success, pending],
    [push, pending, success],
  ]) {
    const actual = await load({ runs, jobs: [job(), job({ id: 102, run_id: 12 })] });
    assert.deepEqual(actual.runIds, [11]);
    assert.equal(actual.evidence["Test & Lint"].conclusion, "IN_PROGRESS");
  }
});

test("fails closed when job pagination cannot be verified", async () => {
  const actual = await load({
    routeOverride: (route) =>
      route.includes("/jobs?") ? { total_count: 2, jobs: [job()] } : undefined,
  });
  assert.equal(actual.policyAmbiguity, true);
  assert.deepEqual(actual.evidence, {});
});

test("marks evidence stale and requires attention when candidate CI differs from trusted CI", async () => {
  const actual = await load({ candidateWorkflow: "name: CI\njobs:\n  test:\n    run: true\n" });
  assert.equal(actual.policyAmbiguity, true);
  assert.equal(actual.evidence["Test & Lint"].fresh, false);
  assert(actual.notes.some((note) => note.includes("different from the trusted")));
});

test("does not accept evidence if either workflow definition cannot be read", async () => {
  const cases = [
    [
      {
        routeOverride: (route) => {
          if (route.includes("/contents/")) throw new Error("Unavailable");
        },
      },
      {},
    ],
    [
      {},
      {
        readTrustedFile: async () => {
          throw new Error("Unavailable");
        },
      },
    ],
    [
      { routeOverride: (route) => (route.includes("/contents/") ? { type: "dir" } : undefined) },
      {},
    ],
  ];
  for (const [options, inputs] of cases) {
    const actual = await load(options, inputs);
    assert.equal(actual.policyAmbiguity, true);
    assert.equal(actual.evidence["Test & Lint"].fresh, false);
  }
});

test("blocks unclassified and duplicate jobs even when required jobs succeeded", async () => {
  for (const extra of [job({ id: 101, name: "New CI gate" }), job({ id: 101 })]) {
    const actual = await load({ jobs: [job(), extra] });
    assert.equal(actual.policyAmbiguity, true);
  }
});

test("rejects jobs from another run, head, or rerun attempt", async () => {
  for (const changes of [{ run_id: 99 }, { head_sha: "old" }, { run_attempt: 2 }]) {
    const actual = await load({
      routeOverride: (route) =>
        route.includes("/jobs?") ? { total_count: 1, jobs: [job(changes)] } : undefined,
    });
    assert.equal(actual.policyAmbiguity, true);
    assert.deepEqual(actual.evidence, {});
  }
});

for (const [status, conclusion, expected] of [
  ["in_progress", "success", "IN_PROGRESS"],
  ["queued", null, "QUEUED"],
  ["requested", null, "QUEUED"],
  ["waiting", null, "WAITING"],
  ["completed", "cancelled", "CANCELLED"],
  ["completed", "skipped", "SKIPPED"],
  ["completed", "neutral", "NEUTRAL"],
  ["completed", "timed_out", "TIMED_OUT"],
]) {
  test(`normalizes ${status}/${conclusion} without treating unfinished jobs as successful`, async () => {
    const actual = await load({ jobs: [job({ status, conclusion })] });
    assert.equal(actual.evidence["Test & Lint"].conclusion, expected);
  });
}

test("completed runs missing required jobs require attention instead of waiting forever", async () => {
  const actual = await load({ jobs: [] });
  assert.equal(actual.policyAmbiguity, true);
  assert(actual.notes.some((note) => note.includes("did not report required job")));
});

test("a missing advisory job does not invalidate successful required work", async () => {
  const actual = await load(
    {},
    {
      policy: {
        jobs: [
          ...policy.jobs,
          {
            id: "advisory",
            checkName: "Optional",
            source: ".github/workflows/ci.yml#advisory",
            necessity: "advisory",
          },
        ],
      },
    },
  );
  assert.equal(actual.policyAmbiguity, false);
  assert.equal(actual.evidence["Test & Lint"].conclusion, "SUCCESS");
});

test("completed jobs without a conclusion require attention", async () => {
  const actual = await load({ jobs: [job({ conclusion: null })] });
  assert.equal(actual.policyAmbiguity, true);
  assert.equal(actual.evidence["Test & Lint"].conclusion, "MISSING");
});

test("ambiguous policy job mappings fail closed", async () => {
  for (const jobs of [
    [],
    [policy.jobs[0], { ...policy.jobs[0], id: "duplicate" }],
    [{ ...policy.jobs[0], source: ".github/workflows/ci.yml#" }],
    [{ ...policy.jobs[0], source: ".github/workflows/unsupported.yml#test" }],
  ]) {
    const actual = await load({}, { policy: { jobs } });
    assert.equal(actual.policyAmbiguity, true);
  }
});
