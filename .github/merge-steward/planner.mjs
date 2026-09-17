const PENDING = new Set(["EXPECTED", "PENDING", "QUEUED", "IN_PROGRESS", "WAITING"]);
const FAILURE = new Set(["ACTION_REQUIRED", "CANCELLED", "ERROR", "FAILURE", "STALE", "TIMED_OUT"]);
const NON_SUCCESS = new Set(["NEUTRAL", "SKIPPED"]);
const NECESSITIES = new Set(["required", "conditional", "advisory", "diagnostic"]);
const INVALIDATIONS = new Set([
  "any-head-change",
  "any-base-change",
  "workflow-change",
  "policy-change",
]);

function presentString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function candidateIdentity(candidate) {
  return {
    repository: candidate.repository,
    number: candidate.number,
    headSha: candidate.headSha,
    baseSha: candidate.baseSha,
    policyDigest: candidate.policyDigest,
  };
}

function validIdentity(candidate) {
  return (
    candidate &&
    presentString(candidate.repository) &&
    Number.isSafeInteger(candidate.number) &&
    candidate.number > 0 &&
    presentString(candidate.headSha) &&
    presentString(candidate.baseSha) &&
    presentString(candidate.policyDigest)
  );
}

function effect(candidate, type, subject, details = {}) {
  const identity = candidateIdentity(candidate);
  return {
    type,
    ...details,
    identity,
    key: [...Object.values(identity), type, subject].join(":"),
  };
}

function result(state, reason, candidate, policy, proposedEffects = [], details = {}) {
  return {
    state,
    reason,
    candidate,
    operationMode: policy.operationMode,
    effects: policy.operationMode === "orchestrate" ? proposedEffects : [],
    proposedEffects,
    ...details,
  };
}

function diagnose(input, reason, resultReason = reason, details = {}) {
  const { candidate, policy } = input;
  const proposed = effect(candidate, "diagnose", reason, { reason, ...details });
  if ((input.handledExceptionKeys ?? []).includes(proposed.key)) {
    return result("noop", "exception-already-handled", candidate, policy, [], details);
  }
  return result("diagnose", resultReason, candidate, policy, [proposed], details);
}

function policyProblems(policy) {
  const problems = [...(policy.unsupported ?? [])];
  if (!["observe", "orchestrate"].includes(policy.operationMode)) problems.push("operation-mode");
  if (!["off", "opt-in", "on"].includes(policy.autoMerge)) problems.push("auto-merge-mode");
  if (!["merge", "squash", "rebase"].includes(policy.mergeMethod)) problems.push("merge-method");
  if (typeof policy.requireNonDraft !== "boolean") problems.push("draft-policy");
  if (!Number.isSafeInteger(policy.requiredApprovals) || policy.requiredApprovals < 0) {
    problems.push("review-policy");
  }
  if (typeof policy.requireResolvedThreads !== "boolean") problems.push("thread-policy");
  if (!Array.isArray(policy.jobs) || policy.jobs.length === 0) return [...problems, "missing-jobs"];

  const names = new Set();
  const ids = new Set();
  const sources = new Set();
  for (const job of policy.jobs) {
    if (!job || !presentString(job.id) || ids.has(job.id)) {
      problems.push("job-identity");
      continue;
    }
    ids.add(job.id);
    if (!NECESSITIES.has(job.necessity)) problems.push(`${job.id}:necessity`);
    // CI remains owned by its existing PR triggers. Adding a dispatch adapter
    // requires an explicitly reviewed implementation, including its budget.
    if (job.dispatch !== undefined) problems.push(`${job.id}:worker-dispatch-unsupported`);
    if (job.necessity === "conditional") problems.push(`${job.id}:conditions-unsupported`);
    if (job.necessity !== "required") continue;
    if (!presentString(job.checkName) || names.has(job.checkName))
      problems.push(`${job.id}:check-name`);
    if (!presentString(job.source) || sources.has(job.source)) problems.push(`${job.id}:source`);
    names.add(job.checkName);
    sources.add(job.source);
    if (job.when !== undefined) problems.push(`${job.id}:conditions-unsupported`);
    if (job.freshnessSubject !== "every-head") problems.push(`${job.id}:freshness-unsupported`);
    if (job.freshnessTtlMinutes !== undefined) problems.push(`${job.id}:ttl-unsupported`);
    if (
      !Array.isArray(job.invalidatedBy) ||
      job.invalidatedBy.length === 0 ||
      job.invalidatedBy.some((invalidation) => !INVALIDATIONS.has(invalidation))
    ) {
      problems.push(`${job.id}:invalidation-unsupported`);
    }
    if (job.phase !== "on-change") problems.push(`${job.id}:phase-unsupported`);
    if (job.approvalMode !== "never") problems.push(`${job.id}:approval-unsupported`);
    if (job.automaticRetries !== 0) problems.push(`${job.id}:automatic-retries-unsupported`);
    if (typeof job.diagnose !== "boolean") problems.push(`${job.id}:diagnosis-policy`);
  }
  if (!policy.jobs.some((job) => job?.necessity === "required"))
    problems.push("missing-required-jobs");
  return problems;
}

function timestamp(value) {
  return presentString(value) ? Date.parse(value) : Number.NaN;
}

function evidenceIsFresh(job, evidence, candidate, revisions, conclusion) {
  // `fresh` is the runtime's assertion that this is the latest attempt from the
  // configured GitHub Actions source, checked against the trusted definition.
  // It is deliberately opt-in: a status context with the same name is not proof.
  if (
    evidence?.fresh !== true ||
    evidence.headSha !== candidate.headSha ||
    evidence.source !== job.source ||
    !revisions
  )
    return false;

  const startedAt = timestamp(evidence.startedAt);
  if (!Number.isFinite(startedAt)) return false;
  if (!PENDING.has(conclusion)) {
    const completedAt = timestamp(evidence.completedAt);
    if (!Number.isFinite(completedAt) || completedAt < startedAt) return false;
  }
  if (job.invalidatedBy.includes("any-base-change") && evidence.baseSha !== candidate.baseSha) {
    return false;
  }
  for (const changedAt of [
    ...(job.invalidatedBy.includes("policy-change") ? [revisions.policyChangedAt] : []),
    ...(job.invalidatedBy.includes("workflow-change") ? [revisions.workflows?.[job.source]] : []),
  ]) {
    const changed = timestamp(changedAt);
    if (!Number.isFinite(changed) || startedAt < changed) return false;
  }
  return true;
}

/** Pure planner. All GitHub trust checks, timestamps and dedupe state are inputs. */
export function plan(input) {
  const { candidate, event = {}, policy } = input;
  if (!validIdentity(candidate)) {
    return result("attention", "invalid-candidate-identity", candidate, policy);
  }
  if (event.expectedHeadSha && event.expectedHeadSha !== candidate.headSha) {
    return result("noop", "stale-event", candidate, policy);
  }
  if (event.expectedBaseSha && event.expectedBaseSha !== candidate.baseSha) {
    return result("noop", "stale-base", candidate, policy);
  }
  if (event.policyDigest && event.policyDigest !== candidate.policyDigest) {
    return result("noop", "stale-policy", candidate, policy);
  }
  if (event.duplicate) return result("noop", "duplicate-event", candidate, policy);
  if (candidate.state !== "OPEN") return result("noop", "pull-request-not-open", candidate, policy);
  if (!Array.isArray(candidate.labels))
    return result("waiting", "pause-state-unknown", candidate, policy);
  if (candidate.labels.some((label) => label === "mq:pause" || label === "mq:paused")) {
    return result("waiting", "pull-request-paused", candidate, policy);
  }
  if (candidate.labels.includes("needs-review")) {
    return result("waiting", "human-review-required", candidate, policy);
  }
  if (typeof candidate.isDraft !== "boolean")
    return result("waiting", "draft-state-unknown", candidate, policy);
  if (policy.requireNonDraft && candidate.isDraft)
    return result("waiting", "draft-pull-request", candidate, policy);

  const problems = policyProblems(policy);
  if (input.policyAmbiguity || problems.length > 0) {
    return diagnose(input, "policy-ambiguity", "policy-ambiguity", { problems });
  }
  if (!Number.isSafeInteger(candidate.approvals) || candidate.approvals < policy.requiredApprovals)
    return result("waiting", "missing-review-approval", candidate, policy);
  if (
    policy.requireResolvedThreads &&
    (!Number.isSafeInteger(candidate.unresolvedThreads) || candidate.unresolvedThreads !== 0)
  )
    return result("waiting", "unresolved-review-thread", candidate, policy);
  if (input.unknownBlockingFailure) return diagnose(input, "unknown-failure");

  const missing = [];
  const pending = [];
  const failed = [];
  const nonSuccess = [];
  for (const job of policy.jobs.filter((job) => job.necessity === "required")) {
    const evidence = input.evidence?.[job.checkName];
    const conclusion = String(evidence?.conclusion ?? "MISSING").toUpperCase();
    if (!evidenceIsFresh(job, evidence, candidate, input.revisions, conclusion)) missing.push(job);
    else if (conclusion === "SUCCESS") continue;
    else if (PENDING.has(conclusion)) pending.push(job);
    else if (FAILURE.has(conclusion)) failed.push(job);
    else if (NON_SUCCESS.has(conclusion)) nonSuccess.push(job);
    else missing.push(job);
  }
  if (failed.length > 0) {
    const details = { failed: failed.map(({ id }) => id) };
    const diagnosable = failed.find((job) => job.diagnose);
    if (diagnosable) {
      return diagnose(input, "failure-exhausted", "required-check-failed", {
        ...details,
        job: diagnosable.id,
      });
    }
    return result("attention", "required-check-failed", candidate, policy, [], details);
  }
  if (pending.length > 0) {
    return result("waiting", "required-check-running", candidate, policy, [], {
      pending: pending.map(({ id }) => id),
    });
  }
  if (nonSuccess.length > 0) {
    return result("attention", "required-check-not-successful", candidate, policy, [], {
      nonSuccess: nonSuccess.map(({ id }) => id),
    });
  }
  if (missing.length > 0) {
    return result("waiting", "required-check-not-reported", candidate, policy, [], {
      missing: missing.map(({ id }) => id),
    });
  }

  if (candidate.mergeable === false)
    return result("attention", "merge-conflict", candidate, policy);
  if (candidate.mergeable !== true)
    return result("waiting", "mergeability-unknown", candidate, policy);
  if (candidate.nativeRequirementsSatisfied !== true) {
    return result("waiting", "native-requirements-unsatisfied", candidate, policy);
  }
  if (
    policy.autoMerge === "off" ||
    (policy.autoMerge === "opt-in" && !candidate.labels.includes("mq:auto-merge"))
  ) {
    return result("ready", "all-requirements-satisfied", candidate, policy);
  }
  // Native auto-merge is a separate, guarded handoff. The runtime must repeat
  // this plan with a freshly loaded candidate immediately before its API call.
  if (candidate.isDraft) return result("waiting", "draft-pull-request", candidate, policy);
  if (candidate.autoMergeRequest)
    return result("noop", "auto-merge-already-enabled", candidate, policy);
  if (candidate.autoMergeRequest !== null)
    return result("waiting", "native-auto-merge-state-unknown", candidate, policy);
  return result("auto-merge", "all-requirements-satisfied", candidate, policy, [
    effect(candidate, "auto-merge", policy.mergeMethod, { method: policy.mergeMethod }),
  ]);
}

/** Project the reviewed YAML without silently accepting unsupported semantics. */
export function projectPolicy(config) {
  const defaults = config.defaults ?? {};
  const readiness = config.readiness ?? {};
  const unsupported = [];
  if (config.version !== 1) unsupported.push("configuration-version");
  if (defaults.base_strategy !== "on-conflict") unsupported.push("base-strategy-unsupported");
  if ((readiness.dependencies ?? "require-merged") !== "ignore")
    unsupported.push("dependencies-unsupported");
  return {
    operationMode: defaults.operation_mode ?? "observe",
    autoMerge: defaults.auto_merge,
    mergeMethod: defaults.merge_method ?? "squash",
    requireNonDraft: readiness.require_non_draft ?? true,
    requiredApprovals: readiness.required_approvals ?? 1,
    requireResolvedThreads: readiness.require_resolved_threads ?? true,
    unsupported,
    jobs: Object.entries(config.jobs ?? {}).map(([id, job]) => ({
      id,
      checkName: job.check_name,
      source: job.source,
      provides: job.provides,
      necessity: job.necessity?.level,
      when: job.necessity?.when,
      freshnessSubject: job.freshness?.subject,
      freshnessTtlMinutes: job.freshness?.ttl_minutes,
      invalidatedBy: job.freshness?.invalidated_by,
      prerequisites: job.prerequisites ?? [],
      cost: job.cost?.tier,
      phase: job.phase ?? "on-change",
      approvalMode: job.approval?.mode,
      dispatch: job.dispatch,
      automaticRetries: job.failure?.automatic_retries ?? defaults.max_automatic_retries ?? 0,
      diagnose: job.failure?.diagnose ?? true,
    })),
  };
}
