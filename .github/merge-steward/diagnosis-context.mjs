import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const REASONS = new Set(["failure-exhausted", "unknown-failure", "policy-ambiguity"]);
const CONTEXT_PATH = "/tmp/gh-aw/merge-steward-context.json";
const MAX_BYTES = 16384;

function identity(candidate) {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(candidate?.repository ?? "") ||
    candidate.repository.length > 200 ||
    !Number.isSafeInteger(candidate.number) ||
    candidate.number < 1 ||
    !/^[a-f0-9]{40}$/.test(candidate.headSha ?? "") ||
    !/^[a-f0-9]{40}$/.test(candidate.baseSha ?? "") ||
    !/^[a-f0-9]{64}$/.test(candidate.policyDigest ?? "")
  )
    throw new Error("Invalid diagnosis candidate identity");
  const { repository, number, headSha, baseSha, policyDigest } = candidate;
  return { repository, number, headSha, baseSha, policyDigest };
}

/** Metadata only: never copy PR prose, log output, or arbitrary candidate fields. */
export function buildDiagnosisContext({ planned, notes = [], runIds = [], evidence = {} }) {
  const effect = planned.effects?.find((item) => item.type === "diagnose");
  if (planned.state !== "diagnose" || !effect) return null;
  if (!REASONS.has(effect.reason)) throw new Error("Unsupported diagnosis reason");
  let truncated = false;
  const text = (value, limit = 256) => {
    if (typeof value !== "string") return "";
    const clean = Array.from(value, (character) => {
      const code = character.codePointAt(0);
      return code < 32 || code === 127 ? " " : character;
    }).join("");
    if (Buffer.byteLength(clean, "utf8") <= limit) return clean;
    truncated = true;
    return Buffer.from(clean, "utf8")
      .subarray(0, limit)
      .toString("utf8")
      .replace(/\ufffd$/, "");
  };
  const bounded = (items, limit = 8) => {
    if (items.length > limit) truncated = true;
    return items.slice(0, limit);
  };
  const validId = (value) => Number.isSafeInteger(value) && value > 0;
  const checks = Object.entries(evidence)
    .filter(([, item]) => item && typeof item === "object")
    // Surface failures and uncertain evidence before successful checks.
    .sort(
      ([, left], [, right]) =>
        Number(left.conclusion === "SUCCESS") - Number(right.conclusion === "SUCCESS"),
    );
  const context = {
    schemaVersion: 1,
    candidate: identity(planned.candidate),
    reason: effect.reason,
    planReason: text(planned.reason),
    job: text(planned.job, 160) || null,
    notes: bounded(notes).map((note) => text(note)),
    problems: bounded(planned.problems ?? []).map((problem) => text(problem)),
    evidence: {
      runIds: bounded([...new Set(runIds.filter(validId))]),
      checks: bounded(checks, 12).map(([name, item]) => ({
        name: text(name, 160),
        source: text(item.source, 200),
        conclusion: text(item.conclusion, 32),
        fresh: item.fresh === true,
        ...(validId(item.runId) ? { runId: item.runId } : {}),
        ...(validId(item.jobId) ? { jobId: item.jobId } : {}),
      })),
    },
  };
  // JSON escaping can enlarge even byte-bounded strings; drop lowest-priority
  // check summaries until the transport budget also holds for adversarial text.
  while (
    context.evidence.checks.length > 0 &&
    Buffer.byteLength(JSON.stringify(context), "utf8") > MAX_BYTES - 32
  ) {
    context.evidence.checks.pop();
    truncated = true;
  }
  return { ...context, truncated };
}

/** Job outputs enter through an environment variable, never shell interpolation. */
export function writeDiagnosisContext(serialized, destination = CONTEXT_PATH) {
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_BYTES)
    throw new Error("Missing or oversized diagnosis context");
  const context = JSON.parse(serialized);
  if (context.schemaVersion !== 1 || !REASONS.has(context.reason))
    throw new Error("Invalid diagnosis context");
  identity(context.candidate);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(context, null, 2), { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== "--write") throw new Error("Expected --write");
  writeDiagnosisContext(process.env.MERGE_STEWARD_CONTEXT);
}
