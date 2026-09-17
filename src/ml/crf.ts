/**
 * Conditional Random Field (CRF) for sequence labeling.
 *
 * Implements a linear-chain CRF with the Viterbi algorithm for decoding,
 * the forward algorithm for computing partition functions, and
 * log-likelihood computation for training.
 *
 * @module
 */

/** CRF model parameters. */
export interface CRFParams {
  /** Emission scores [seqLen x numTags]. */
  emissionScores: Float64Array;
  /** Transition scores [numTags x numTags] (from -> to). */
  transitionScores: Float64Array;
  /** Start transition scores [numTags]. */
  startScores: Float64Array;
  /** End transition scores [numTags]. */
  endScores: Float64Array;
  numTags: number;
  seqLen: number;
}

/** Viterbi decoding result. */
export interface ViterbiResult {
  /** Best tag sequence. */
  tags: number[];
  /** Score of the best sequence. */
  score: number;
}

/** Viterbi algorithm for CRF decoding. */
export function viterbiDecode(params: CRFParams): ViterbiResult {
  const { numTags, seqLen, emissionScores, transitionScores, startScores, endScores } = params;

  // viterbi[t][tag] = best score ending at (t, tag)
  const viterbi: Float64Array[] = [];
  const backpointer: Int32Array[] = [];

  // Init: t=0
  const v0 = new Float64Array(numTags);
  const bp0 = new Int32Array(numTags).fill(-1);
  for (let j = 0; j < numTags; j++) {
    v0[j] =
      (startScores[j] ?? Number.NEGATIVE_INFINITY) +
      (emissionScores[j] ?? Number.NEGATIVE_INFINITY);
  }
  viterbi.push(v0);
  backpointer.push(bp0);

  for (let t = 1; t < seqLen; t++) {
    const vt = new Float64Array(numTags);
    const bpt = new Int32Array(numTags);
    const vprev = viterbi[t - 1]!;
    for (let j = 0; j < numTags; j++) {
      let bestScore = Number.NEGATIVE_INFINITY;
      let bestPrev = 0;
      for (let i = 0; i < numTags; i++) {
        const score =
          (vprev[i] ?? Number.NEGATIVE_INFINITY) +
          (transitionScores[i * numTags + j] ?? Number.NEGATIVE_INFINITY);
        if (score > bestScore) {
          bestScore = score;
          bestPrev = i;
        }
      }
      vt[j] = bestScore + (emissionScores[t * numTags + j] ?? Number.NEGATIVE_INFINITY);
      bpt[j] = bestPrev;
    }
    viterbi.push(vt);
    backpointer.push(bpt);
  }

  // Add end scores
  const vlast = viterbi[seqLen - 1]!;
  let bestFinalScore = Number.NEGATIVE_INFINITY;
  let bestFinalTag = 0;
  for (let j = 0; j < numTags; j++) {
    const s = (vlast[j] ?? Number.NEGATIVE_INFINITY) + (endScores[j] ?? 0);
    if (s > bestFinalScore) {
      bestFinalScore = s;
      bestFinalTag = j;
    }
  }

  // Backtrack
  const tags = new Array<number>(seqLen);
  tags[seqLen - 1] = bestFinalTag;
  for (let t = seqLen - 1; t > 0; t--) {
    tags[t - 1] = backpointer[t]![tags[t]!] ?? 0;
  }

  return { tags, score: bestFinalScore };
}

/** Forward algorithm: compute log partition function log Z. */
export function forwardLogZ(params: CRFParams): number {
  const { numTags, seqLen, emissionScores, transitionScores, startScores, endScores } = params;

  // alpha[tag] = log sum of scores for all paths ending at (t, tag)
  let alpha = new Float64Array(numTags);
  for (let j = 0; j < numTags; j++) {
    alpha[j] =
      (startScores[j] ?? Number.NEGATIVE_INFINITY) +
      (emissionScores[j] ?? Number.NEGATIVE_INFINITY);
  }

  for (let t = 1; t < seqLen; t++) {
    const newAlpha = new Float64Array(numTags);
    for (let j = 0; j < numTags; j++) {
      const scores = new Float64Array(numTags);
      for (let i = 0; i < numTags; i++) {
        scores[i] =
          (alpha[i] ?? Number.NEGATIVE_INFINITY) +
          (transitionScores[i * numTags + j] ?? Number.NEGATIVE_INFINITY);
      }
      newAlpha[j] =
        logSumExp(scores) + (emissionScores[t * numTags + j] ?? Number.NEGATIVE_INFINITY);
    }
    alpha = newAlpha;
  }

  // Add end scores
  const final = new Float64Array(numTags);
  for (let j = 0; j < numTags; j++) {
    final[j] = (alpha[j] ?? Number.NEGATIVE_INFINITY) + (endScores[j] ?? 0);
  }
  return logSumExp(final);
}

/** Compute score of a given tag sequence. */
export function sequenceScore(params: CRFParams, tags: number[]): number {
  const { numTags, emissionScores, transitionScores, startScores, endScores } = params;
  let score = startScores[tags[0] ?? 0] ?? Number.NEGATIVE_INFINITY;
  score += emissionScores[tags[0] ?? 0] ?? Number.NEGATIVE_INFINITY;
  for (let t = 1; t < tags.length; t++) {
    const prev = tags[t - 1] ?? 0;
    const curr = tags[t] ?? 0;
    score += transitionScores[prev * numTags + curr] ?? Number.NEGATIVE_INFINITY;
    score += emissionScores[t * numTags + curr] ?? Number.NEGATIVE_INFINITY;
  }
  score += endScores[tags[tags.length - 1] ?? 0] ?? 0;
  return score;
}

/** CRF negative log-likelihood for a given tag sequence. */
export function crfNegLogLikelihood(params: CRFParams, tags: number[]): number {
  const goldScore = sequenceScore(params, tags);
  const logZ = forwardLogZ(params);
  return logZ - goldScore;
}

/** Log-sum-exp (numerically stable). */
export function logSumExp(values: Float64Array): number {
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i++)
    max = Math.max(max, values[i] ?? Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(max)) return Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += Math.exp((values[i] ?? Number.NEGATIVE_INFINITY) - max);
  }
  return max + Math.log(sum);
}
