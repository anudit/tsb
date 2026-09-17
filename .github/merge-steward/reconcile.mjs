import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadEvidence } from "./evidence.mjs";
import { plan, projectPolicy } from "./planner.mjs";

const POLICY_PATH = ".github/merge-steward.yml";
const DIAGNOSIS = "merge-steward-diagnose.lock.yml";
export const digest = (text) => createHash("sha256").update(text).digest("hex");
export const exceptionTitle = (key) => `Merge Steward Diagnosis / ${digest(key)}`;

function command(name, args, input) {
  return execFileSync(name, args, { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
}

export function githubApi(route, body) {
  const args = ["api", "--method", body === undefined ? "GET" : "POST", route];
  if (body !== undefined) args.push("--input", "-");
  const text = command("gh", args, body === undefined ? undefined : JSON.stringify(body));
  return text ? JSON.parse(text) : null;
}

export async function pages(api, route, field) {
  const all = [];
  for (let page = 1; page <= 100; page++) {
    const value = await api(`${route}${route.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const items = field ? value[field] : value;
    if (!Array.isArray(items)) throw new Error(`Invalid paginated response: ${route}`);
    all.push(...items);
    if (items.length < 100) return all;
  }
  throw new Error(`Pagination limit reached: ${route}`);
}

function yaml(text) {
  return JSON.parse(
    command(
      "ruby",
      [
        "-ryaml",
        "-rjson",
        "-e",
        "puts JSON.generate(YAML.safe_load(STDIN.read, permitted_classes: [], aliases: false))",
      ],
      text,
    ),
  );
}

function latestChange(path) {
  return command("git", ["log", "-1", "--format=%cI", "--", path]);
}

export function policyInventory(config, workflows) {
  const sources = new Set(Object.values(config.jobs).map((job) => job.source));
  const missing = [];
  for (const [path, definition] of Object.entries(workflows)) {
    for (const job of Object.keys(definition.jobs ?? {})) {
      if (!sources.has(`${path}#${job}`)) missing.push(`${path}#${job}`);
    }
    if (path.endsWith(".md") && !sources.has(`${path}#agent`)) missing.push(`${path}#agent`);
  }
  return missing;
}

export function changesAutomation(files) {
  return files.some((file) =>
    [file.filename, file.previous_filename].some(
      (path) =>
        typeof path === "string" &&
        (/^\.github\/(workflows|actions|aw|merge-steward)\//.test(path) ||
          /^\.github\/merge-steward\.(yml|schema\.json)$/.test(path)),
    ),
  );
}

function trustedConfig() {
  const text = readFileSync(POLICY_PATH, "utf8");
  const config = yaml(text);
  const policy = projectPolicy(config);
  const workflows = {};
  for (const name of readdirSync(".github/workflows")) {
    if (!/\.(yml|yaml|md)$/.test(name) || name.endsWith(".lock.yml")) continue;
    const path = `.github/workflows/${name}`;
    const contents = readFileSync(path, "utf8");
    workflows[path] = yaml(name.endsWith(".md") ? contents.split(/^---\s*$/m)[1] : contents);
  }
  return {
    policy,
    policyDigest: digest(text),
    trustedSha: command("git", ["rev-parse", "HEAD"]),
    unclassified: policyInventory(config, workflows),
    revisions: {
      policyChangedAt: latestChange(POLICY_PATH),
      workflows: Object.fromEntries(
        policy.jobs.map(({ source }) => [source, latestChange(source.split("#")[0])]),
      ),
    },
  };
}

export async function resolvePullRequests({ api, repository, event, eventName, defaultBranch }) {
  if (event.pull_request)
    return [{ number: event.pull_request.number, head: event.pull_request.head.sha }];
  if (event.inputs?.pull_request_number) {
    if (!/^[1-9][0-9]*$/.test(event.inputs.pull_request_number))
      throw new Error("Invalid pull request number");
    return [
      {
        number: Number(event.inputs.pull_request_number),
        head: event.inputs.expected_head_sha ?? "",
      },
    ];
  }
  if (eventName === "workflow_run") {
    const run = event.workflow_run;
    if (run?.name !== "CI" || run.repository?.full_name !== repository) return [];
    if (run.pull_requests?.length)
      return run.pull_requests.map((pull) => ({ number: pull.number, head: pull.head.sha }));
    const pulls = await pages(
      api,
      `repos/${repository}/pulls?state=open&base=${encodeURIComponent(defaultBranch)}`,
    );
    return pulls
      .filter((pull) => pull.head.sha === run.head_sha || pull.merge_commit_sha === run.head_sha)
      .map((pull) => ({ number: pull.number, head: pull.head.sha }));
  }
  if (eventName === "schedule" || eventName === "workflow_dispatch") {
    const pulls = await pages(
      api,
      `repos/${repository}/pulls?state=open&base=${encodeURIComponent(defaultBranch)}`,
    );
    return pulls.map((pull) => ({ number: pull.number, head: pull.head.sha }));
  }
  return [];
}

export function sameIdentity(left, right) {
  const strings = ["repository", "headSha", "baseSha", "policyDigest"];
  const valid = (value) =>
    value !== null &&
    typeof value === "object" &&
    Number.isSafeInteger(value.number) &&
    value.number > 0 &&
    strings.every((key) => typeof value[key] === "string" && value[key].trim().length > 0);
  return (
    valid(left) && valid(right) && ["number", ...strings].every((key) => left[key] === right[key])
  );
}

export async function executePlan({ planned, reload, dispatch, enabled }) {
  if (!enabled || planned.operationMode !== "orchestrate") return [];
  const results = [];
  for (const effect of planned.effects) {
    const current = await reload();
    if (
      !sameIdentity(planned.candidate, current.candidate) ||
      !current.effects.some((item) => item.type === effect.type && item.key === effect.key)
    ) {
      results.push({
        type: effect.type,
        outcome: "noop",
        reason: "candidate-or-readiness-changed",
      });
      continue;
    }
    if (effect.type === "diagnose") await dispatch(effect, current.candidate);
    else throw new Error(`Effect adapter is not installed: ${effect.type}`);
    results.push({ type: effect.type, outcome: "requested", key: effect.key });
  }
  return results;
}

export async function diagnosisRuns(api, repository) {
  return pages(
    api,
    `repos/${repository}/actions/workflows/${DIAGNOSIS}/runs?event=workflow_dispatch`,
    "workflow_runs",
  );
}

export function diagnosisIsFirst(runs, key, runId) {
  const matching = runs.filter((run) => run.display_title === exceptionTitle(key));
  return (
    matching.some((run) => String(run.id) === String(runId)) &&
    !matching.some((run) => Number(run.id) < Number(runId))
  );
}

async function snapshot({
  api,
  repository,
  number,
  expectedHead,
  trusted,
  defaultBranch,
  ignoreHistory = false,
}) {
  const pull = await api(`repos/${repository}/pulls/${number}`);
  const base = await api(`repos/${repository}/branches/${encodeURIComponent(defaultBranch)}`);
  const reviews = await pages(api, `repos/${repository}/pulls/${number}/reviews`);
  const latestReviews = new Map();
  for (const review of reviews) {
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state))
      latestReviews.set(review.user.login, review);
  }
  const candidate = {
    repository,
    number: pull.number,
    state: pull.state.toUpperCase(),
    isDraft: pull.draft,
    headSha: pull.head.sha,
    baseSha: base.commit.sha,
    policyDigest: trusted.policyDigest,
    approvals: [...latestReviews.values()].filter(
      (review) => review.state === "APPROVED" && review.commit_id === pull.head.sha,
    ).length,
    unresolvedThreads: trusted.policy.requireResolvedThreads ? Number.MAX_SAFE_INTEGER : 0,
    labels: pull.labels.map((label) => label.name),
    mergeable: pull.mergeable === true,
    nativeRequirementsSatisfied: pull.mergeable_state === "clean" && base.protected === true,
    autoMergeRequest: pull.auto_merge,
  };
  if (pull.base.ref !== defaultBranch || pull.base.repo.full_name !== repository)
    candidate.state = "OUT_OF_SCOPE";
  const loaded =
    candidate.state === "OPEN" && !candidate.isDraft
      ? await loadEvidence({
          api,
          repository,
          pull,
          policy: trusted.policy,
          readTrustedFile: (path) => readFileSync(path, "utf8"),
        })
      : { evidence: {}, policyAmbiguity: false, notes: [] };
  let maintainerReviewRequired = trusted.unclassified.length > 0;
  if (candidate.state === "OPEN" && !candidate.isDraft) {
    const files = await pages(api, `repos/${repository}/pulls/${number}/files`);
    if (files.length !== pull.changed_files) {
      loaded.policyAmbiguity = true;
      loaded.notes.push("The complete changed-file inventory could not be verified.");
    }
    if (changesAutomation(files)) {
      maintainerReviewRequired = true;
      loaded.notes.push("Automation definition changes require maintainer review.");
    }
    if ([...latestReviews.values()].some((review) => review.state === "CHANGES_REQUESTED")) {
      candidate.labels.push("needs-review");
      loaded.notes.push("A reviewer has requested changes.");
    }
  }
  const input = {
    candidate,
    event: { expectedHeadSha: expectedHead, policyDigest: trusted.policyDigest },
    policy: trusted.policy,
    evidence: loaded.evidence,
    revisions: trusted.revisions,
    handledExceptionKeys: [],
    maintainerReviewRequired,
    policyAmbiguity: Boolean(loaded.policyAmbiguity),
    unknownBlockingFailure: false,
  };
  let planned = plan(input);
  if (!ignoreHistory && planned.proposedEffects.some((effect) => effect.type === "diagnose")) {
    const runs = await diagnosisRuns(api, repository);
    input.handledExceptionKeys = planned.proposedEffects
      .filter((effect) => runs.some((run) => run.display_title === exceptionTitle(effect.key)))
      .map((effect) => effect.key);
    planned = plan(input);
  }
  return {
    ...planned,
    notes: [...(loaded.notes ?? []), ...trusted.unclassified],
    trustedSha: base.commit.sha,
  };
}

async function main() {
  const api = githubApi;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? ""))
    throw new Error("Missing or invalid repository");
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const repositoryInfo = await api(`repos/${repository}`);
  const defaultBranch = repositoryInfo.default_branch;
  if (defaultBranch !== "main")
    throw new Error("Review the installation before changing its default branch scope");
  const trusted = trustedConfig();
  if (process.argv.includes("--resolve")) {
    const pulls = await resolvePullRequests({
      api,
      repository,
      event,
      eventName: process.env.GITHUB_EVENT_NAME,
      defaultBranch,
    });
    if (pulls.length > 256) throw new Error("Too many PRs for a single Actions matrix");
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `matrix=${JSON.stringify({ include: pulls })}\ncount=${pulls.length}\n`,
    );
    return;
  }
  const preflight = process.argv.includes("--preflight");
  const number = process.env.PR_NUMBER ?? event.inputs?.pull_request_number;
  const expectedHead = process.env.EXPECTED_HEAD_SHA ?? event.inputs?.expected_head_sha;
  if (!/^[1-9][0-9]*$/.test(number ?? "")) throw new Error("Invalid pull request number");
  if (expectedHead && !/^[a-f0-9]{40}$/.test(expectedHead))
    throw new Error("Invalid expected head SHA");
  const reload = () =>
    snapshot({
      api,
      repository,
      number: Number(number),
      expectedHead,
      trusted,
      defaultBranch,
      ignoreHistory: preflight,
    });
  const planned = await reload();
  if (preflight) {
    const inputs = event.inputs ?? {};
    const effect = planned.effects.find(
      (item) => item.type === "diagnose" && item.reason === inputs.reason,
    );
    const valid =
      effect &&
      digest(effect.key) === inputs.exception_key &&
      planned.candidate.headSha === inputs.expected_head_sha &&
      planned.candidate.baseSha === inputs.expected_base_sha &&
      planned.candidate.policyDigest === inputs.expected_policy_digest &&
      planned.trustedSha === trusted.trustedSha &&
      process.env.GITHUB_REF === `refs/heads/${defaultBranch}` &&
      diagnosisIsFirst(await diagnosisRuns(api, repository), effect.key, process.env.GITHUB_RUN_ID);
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `should_run=${Boolean(valid)}\nobserved_head_sha=${planned.candidate.headSha}\n`,
    );
    return;
  }
  const enabled = process.env.MERGE_STEWARD_APPLY === "true" && !process.argv.includes("--observe");
  const outcomes = await executePlan({
    planned,
    enabled,
    reload: async () => {
      const current = await reload();
      if (current.trustedSha !== trusted.trustedSha) return { ...current, effects: [] };
      return current;
    },
    dispatch: (effect, candidate) =>
      api(`repos/${repository}/actions/workflows/${DIAGNOSIS}/dispatches`, {
        ref: defaultBranch,
        inputs: {
          pull_request_number: String(candidate.number),
          expected_head_sha: candidate.headSha,
          expected_base_sha: candidate.baseSha,
          expected_policy_digest: candidate.policyDigest,
          exception_key: digest(effect.key),
          reason: effect.reason,
        },
      }),
  });
  const report = { ...planned, outcomes, applyEnabled: enabled };
  const summary = [
    "# Merge Steward",
    "",
    `PR #${number} · head \`${planned.candidate.headSha}\``,
    "",
    `**${planned.state}**: ${planned.reason}`,
    "",
    `Policy: \`${trusted.policyDigest}\``,
    "",
    "```json",
    JSON.stringify(report, null, 2),
    "```",
    "",
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
