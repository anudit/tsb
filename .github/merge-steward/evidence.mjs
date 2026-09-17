const CI_WORKFLOW = ".github/workflows/ci.yml";
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const RUNNING = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

function sameRepository(actual, expected) {
  return typeof actual === "string" && actual.toLowerCase() === expected.toLowerCase();
}

async function listAll(api, route, key) {
  const values = [];
  const ids = new Set();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await api(`${route}&per_page=${PAGE_SIZE}&page=${page}`);
    const batch = response[key];
    if (!Array.isArray(batch)) throw new Error(`Invalid ${key} response`);
    for (const item of batch) {
      if (item.id === undefined || ids.has(String(item.id))) {
        throw new Error(`Incomplete or repeated ${key} pagination`);
      }
      ids.add(String(item.id));
      values.push(item);
    }
    if (batch.length < PAGE_SIZE) {
      if (response.total_count > values.length) {
        throw new Error(`Incomplete ${key} pagination`);
      }
      return values;
    }
    if (response.total_count === values.length) return values;
  }
  throw new Error(`Too many ${key} to verify completely`);
}

function currentPullAssociation(run, pull) {
  return (run.pull_requests ?? []).some(
    (associated) =>
      associated.number === pull.number &&
      associated.head?.sha === pull.head.sha &&
      associated.head?.ref === pull.head.ref &&
      associated.base?.ref === pull.base.ref,
  );
}

function relevantRun(run, repository, pull) {
  if (
    run.path !== CI_WORKFLOW ||
    !sameRepository(run.repository?.full_name, repository) ||
    run.head_branch !== pull.head.ref ||
    ![pull.head.sha, pull.merge_commit_sha].filter(Boolean).includes(run.head_sha)
  ) {
    return false;
  }
  if (run.event === "pull_request") {
    return (
      currentPullAssociation(run, pull) &&
      (!pull.head.repo?.full_name ||
        sameRepository(run.head_repository?.full_name, pull.head.repo.full_name))
    );
  }
  // This repository runs push CI only for its own autoloop candidate branches.
  // Its manual CI trigger has no typed candidate contract and is not evidence.
  return (
    run.event === "push" &&
    pull.head.ref.startsWith("autoloop/") &&
    run.head_sha === pull.head.sha &&
    sameRepository(run.head_repository?.full_name, repository) &&
    sameRepository(pull.head.repo?.full_name, repository)
  );
}

function compareNewest(left, right) {
  const associationOrder =
    Number(right.event === "pull_request") - Number(left.event === "pull_request");
  if (associationOrder) return associationOrder;
  const timeOrder = Date.parse(right.created_at) - Date.parse(left.created_at);
  if (timeOrder) return timeOrder;
  return Number(right.id) - Number(left.id);
}

function conclusionOf(item) {
  if (item.status === "completed") return String(item.conclusion ?? "MISSING").toUpperCase();
  if (item.status === "requested") return "QUEUED";
  return String(item.status ?? "MISSING").toUpperCase();
}

function workflowText(response) {
  if (
    response?.type !== "file" ||
    response.encoding !== "base64" ||
    typeof response.content !== "string"
  ) {
    throw new Error("CI workflow contents were not returned as a file");
  }
  return Buffer.from(response.content, "base64").toString("utf8");
}

/** Read Actions evidence without executing or checking out candidate content. */
export async function loadEvidence({ api, repository, pull, policy, readTrustedFile }) {
  const result = { evidence: {}, policyAmbiguity: false, notes: [], runIds: [] };
  const ambiguous = (message) => {
    result.policyAmbiguity = true;
    result.notes.push(message);
  };
  const configuredJobs = policy.jobs.filter(({ source }) => source.startsWith(`${CI_WORKFLOW}#`));
  const byName = new Map();
  const sources = new Set();
  for (const job of configuredJobs) {
    if (
      !job.checkName ||
      !job.source.slice(CI_WORKFLOW.length + 1) ||
      byName.has(job.checkName) ||
      sources.has(job.source)
    ) {
      ambiguous("CI policy job names and sources must identify unique jobs.");
    }
    byName.set(job.checkName, job);
    sources.add(job.source);
  }
  if (
    policy.jobs.some(
      ({ source, necessity }) => necessity === "required" && !source.startsWith(`${CI_WORKFLOW}#`),
    )
  ) {
    ambiguous(
      "A required job uses a workflow that this repository's evidence adapter does not support.",
    );
  }
  if (configuredJobs.length === 0) ambiguous("No CI jobs are configured for verified evidence.");

  let runs;
  try {
    const refs = [...new Set([pull.head.sha, pull.merge_commit_sha].filter(Boolean))];
    const pages = await Promise.all(
      refs.map((sha) =>
        listAll(
          api,
          `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${encodeURIComponent(sha)}`,
          "workflow_runs",
        ),
      ),
    );
    runs = [...new Map(pages.flat().map((run) => [String(run.id), run])).values()];
  } catch {
    ambiguous("CI workflow runs could not be completely verified.");
    return result;
  }
  const run = runs.filter((item) => relevantRun(item, repository, pull)).sort(compareNewest)[0];
  if (!run) {
    result.notes.push(
      "No CI run with verified provenance exists for the current pull request head.",
    );
    return result;
  }
  result.runIds.push(run.id);

  let fresh = true;
  let jobs;
  const [definition, listedJobs] = await Promise.allSettled([
    Promise.all([
      readTrustedFile(CI_WORKFLOW),
      api(`repos/${repository}/contents/${CI_WORKFLOW}?ref=${encodeURIComponent(run.head_sha)}`),
    ]),
    listAll(api, `repos/${repository}/actions/runs/${run.id}/jobs?filter=latest`, "jobs"),
  ]);
  if (definition.status !== "fulfilled") {
    fresh = false;
    ambiguous(
      `CI run ${run.id}'s workflow definition could not be verified against the trusted definition.`,
    );
  } else {
    try {
      if (definition.value[0] !== workflowText(definition.value[1])) {
        fresh = false;
        ambiguous(
          `CI run ${run.id} used a workflow definition different from the trusted definition.`,
        );
      }
    } catch {
      fresh = false;
      ambiguous(`CI run ${run.id}'s workflow definition could not be decoded for verification.`);
    }
  }
  if (listedJobs.status !== "fulfilled") {
    ambiguous(`Jobs for CI run ${run.id} could not be completely verified.`);
    return result;
  }
  jobs = listedJobs.value;
  for (const job of jobs) {
    const configured = byName.get(job.name);
    if (!configured) {
      ambiguous(`CI run ${run.id} contains an unclassified job: ${job.name}.`);
      continue;
    }
    if (
      String(job.run_id) !== String(run.id) ||
      (run.run_attempt && job.run_attempt !== run.run_attempt) ||
      (job.head_sha &&
        ![run.head_sha, pull.head.sha, pull.merge_commit_sha]
          .filter(Boolean)
          .includes(job.head_sha))
    ) {
      ambiguous(`CI job ${job.name} does not belong to the selected candidate run.`);
      continue;
    }
    if (Object.hasOwn(result.evidence, job.name)) {
      result.evidence[job.name].fresh = false;
      ambiguous(`CI run ${run.id} reports more than one job named ${job.name}.`);
      continue;
    }
    result.evidence[job.name] = {
      conclusion: conclusionOf(job),
      completedAt: job.completed_at ?? null,
      startedAt: run.run_started_at ?? run.created_at,
      headSha: pull.head.sha,
      source: configured.source,
      fresh,
    };
    if (job.status === "completed" && !job.conclusion) {
      ambiguous(`Completed CI job ${job.name} has no conclusion.`);
    }
  }
  for (const configured of configuredJobs) {
    if (Object.hasOwn(result.evidence, configured.checkName)) continue;
    if (RUNNING.has(run.status)) {
      result.evidence[configured.checkName] = {
        conclusion: conclusionOf(run),
        completedAt: null,
        startedAt: run.run_started_at ?? run.created_at,
        headSha: pull.head.sha,
        source: configured.source,
        fresh,
      };
    } else if (configured.necessity === "required") {
      ambiguous(`Completed CI run ${run.id} did not report required job ${configured.checkName}.`);
    }
  }
  return result;
}
