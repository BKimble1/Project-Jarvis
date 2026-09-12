/**
 * Embeddings — a provider-neutral second retrieval channel.
 *
 * Semantic search is an *optional* improvement on full-text search here, never a dependency. If no
 * provider is configured, or the configured one is failing, lexical retrieval carries on and the
 * system says plainly that it is doing so. A knowledge base that stops working because an external
 * API is down is worse than one that finds slightly less.
 *
 * ## The trap this module exists to close
 *
 * Vectors are stored as `real[]` and scored with an exact dot product in SQL:
 *
 * ```sql
 * select (select sum(a * b) from unnest(embedding, $query) as t(a, b)) as score
 * ```
 *
 * Postgres `unnest` over two arrays of *different* lengths zips to the longer one and pads with
 * NULL, and `sum()` skips NULLs. A 2-dimension query against a 3-dimension stored vector therefore
 * returns a perfectly plausible number rather than an error — measured, not theorised:
 *
 * ```
 * mismatch result: [{"s": 0.6000000238418579}]
 * ```
 *
 * So dimensions are validated on the way in, stored beside every vector, and required to match in
 * every similarity query. A mismatch returns no rows. It never returns a wrong score.
 *
 * ## Why unit vectors
 *
 * Every stored vector is normalised to length 1, which makes cosine similarity exactly the dot
 * product and removes a magnitude division from the hot path. It also means a malformed zero
 * vector is rejected at write time rather than producing a division by zero later.
 */
import { z } from 'zod';

import { ValidationError } from './errors';

/* ---------------------------------------------------------------- provider */

export interface EmbeddingVector {
  /** Unit-normalised. `normaliseVector` is the only supported way to produce one. */
  readonly values: readonly number[];
  readonly dimensions: number;
}

export interface EmbeddingUsage {
  readonly inputTokens: number | null;
  /** Only when the provider reported one. Never computed here and never defaulted to zero. */
  readonly reportedCostUsd: number | null;
}

export interface EmbeddingResult {
  readonly vectors: readonly EmbeddingVector[];
  readonly usage: EmbeddingUsage;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  /**
   * Bumped when the meaning of a vector changes for the same text.
   *
   * Stored on every row, so vectors from two indexing versions are never compared with each other
   * — which would silently rank nonsense highly.
   */
  readonly indexingVersion: string;
  /**
   * The similarity below which a match is not a match.
   *
   * Semantic search has no natural cut-off: a nearest-neighbour query over unit vectors returns
   * the *closest* rows whether or not any of them is close. Without a floor, asking about
   * Kubernetes in a knowledge base that only knows about the office alarm code returns the office
   * alarm code, ranked, with a citation — and the layer above cannot tell that apart from a real
   * hit, because a score is only meaningful against the scale of the model that produced it.
   *
   * So the floor belongs to the provider, which is the only thing that knows its own scale. For
   * the hashed-trigram provider the bands were measured rather than guessed: related text scores
   * 0.26 to 0.68, unrelated text 0.04 to 0.15. A model with a different geometry declares a
   * different number here, and nothing else in the system needs to change.
   */
  readonly minSimilarity: number;
  isConfigured(): boolean;
  /** Embeds a batch. Must return exactly one vector per input, in order. */
  embed(texts: readonly string[]): Promise<EmbeddingResult>;
}

export const EMBEDDING_LIMITS = Object.freeze({
  maxBatch: 64,
  maxCharsPerText: 8_000,
  maxDimensions: 4_096,
  minDimensions: 8,
});

/* --------------------------------------------------------------- validation */

/**
 * Turn raw model output into a stored vector, or refuse it.
 *
 * Refuses rather than repairs. A vector of the wrong length is a provider or configuration
 * mismatch, and silently truncating or padding it would produce a vector that scores against
 * everything and means nothing.
 */
export function normaliseVector(
  values: readonly number[],
  expectedDimensions: number,
): EmbeddingVector {
  if (values.length !== expectedDimensions) {
    throw new ValidationError(
      `The embedding provider returned ${values.length} dimensions where ${expectedDimensions} were expected. Refusing to store it: a mismatched vector scores against everything and means nothing.`,
    );
  }
  if (values.some((value) => !Number.isFinite(value))) {
    throw new ValidationError('The embedding contains a value that is not a finite number.');
  }

  const magnitude = Math.sqrt(values.reduce((total, value) => total + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new ValidationError(
      'The embedding has zero magnitude, so it has no direction and cannot be compared with anything.',
    );
  }

  return {
    values: values.map((value) => value / magnitude),
    dimensions: expectedDimensions,
  };
}

/**
 * Cosine similarity between two unit vectors.
 *
 * Used by the deterministic test provider and by assertions; the production path scores in SQL so
 * the candidate set never has to leave the database. Refuses mismatched dimensions rather than
 * zipping to the shorter one, for exactly the reason the module header describes.
 */
export function cosineSimilarity(left: EmbeddingVector, right: EmbeddingVector): number {
  if (left.dimensions !== right.dimensions) {
    throw new ValidationError(
      `Cannot compare a ${left.dimensions}-dimension vector with a ${right.dimensions}-dimension one.`,
    );
  }
  let total = 0;
  for (let index = 0; index < left.values.length; index += 1) {
    total += (left.values[index] ?? 0) * (right.values[index] ?? 0);
  }
  return total;
}

/* ------------------------------------------------------------------ status */

export const EMBEDDING_STATES = ['pending', 'ready', 'failed', 'stale'] as const;
export type EmbeddingState = (typeof EMBEDDING_STATES)[number];

/**
 * How much of what could be embedded actually is.
 *
 * The numbers the interface needs to say "hybrid ready" or "hybrid degraded" without guessing.
 */
export interface EmbeddingCoverage {
  readonly total: number;
  readonly ready: number;
  readonly pending: number;
  readonly failed: number;
  readonly stale: number;
}

export const EMPTY_COVERAGE: EmbeddingCoverage = Object.freeze({
  total: 0,
  ready: 0,
  pending: 0,
  failed: 0,
  stale: 0,
});

/**
 * The share of embeddable content that is actually embedded.
 *
 * Below `HYBRID_READY_RATIO` the system reports `hybrid_degraded`: semantic results exist but do
 * not cover the corpus, and presenting that as full hybrid retrieval would overstate what a search
 * actually looked at.
 */
export const HYBRID_READY_RATIO = 0.95;

export function coverageRatio(coverage: EmbeddingCoverage): number {
  if (coverage.total === 0) return 1;
  return coverage.ready / coverage.total;
}

/* ------------------------------------------------------------------ schema */

/**
 * The width below which the hashed-trigram provider cannot discriminate.
 *
 * Not a performance tuning knob. At 128 dimensions the measured similarity between *unrelated*
 * sentences exceeded that between related ones, which makes the channel worse than useless: it
 * would return results confidently and they would be wrong.
 */
export const DETERMINISTIC_MIN_DIMENSIONS = 256;

export const embeddingConfigSchema = z.object({
  provider: z.enum(['none', 'anthropic', 'deterministic']).default('none'),
  model: z.string().trim().max(120).default(''),
  dimensions: z
    .number()
    .int()
    .min(EMBEDDING_LIMITS.minDimensions)
    .max(EMBEDDING_LIMITS.maxDimensions)
    .default(256),
});

/**
 * A deterministic embedding provider for tests and for local use without an external service.
 *
 * Hashes token trigrams into a fixed-width bag and normalises it. This is genuinely a *second*
 * retrieval channel — it matches on shared character structure rather than on stemmed tokens, so
 * it finds near-spellings and morphological variants full-text search misses — while being
 * reproducible, free and offline.
 *
 * It is not a language model, and it is not presented as one. Where the interface reports the
 * semantic provider, it names this one honestly.
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'deterministic';
  readonly model = 'jarvis-hashed-trigram';
  readonly indexingVersion = '1.0.0';

  /**
   * The floor, and how it was arrived at.
   *
   * Measured over 153 pairs of unrelated real sentences at several widths:
   *
   * | dimensions | mean | p90  | p99  | max  |
   * |------------|------|------|------|------|
   * | 128        | 0.33 | 0.43 | 0.54 | 0.55 |
   * | 256        | 0.21 | 0.29 | 0.37 | 0.42 |
   * | 512        | 0.14 | 0.23 | 0.31 | 0.35 |
   *
   * Two things follow, and the second was a surprise worth writing down. First, hash collisions
   * at 128 dimensions push unrelated text *above* where genuinely related text sits, so there is
   * no floor at that width that separates them at all — which is why the constructor refuses it.
   * Second, even at 256 the distributions overlap in the middle: a weakly related pair scored
   * 0.26 while unrelated pairs reached 0.42. That is not a defect in the hashing, it is what this
   * measure is: character-shape similarity, not meaning.
   *
   * So the floor is set for **precision rather than recall** — above the highest similarity
   * observed between unrelated sentences, rather than below the lowest related one. The trade is
   * deliberate and asymmetric: a semantic miss costs nothing, because the two lexical channels
   * are still searching the same corpus, while a semantic false positive costs a wrong citation
   * that reads exactly like a right one.
   */
  readonly minSimilarity = 0.45;

  constructor(readonly dimensions: number = 512) {
    if (dimensions < DETERMINISTIC_MIN_DIMENSIONS) {
      throw new ValidationError(
        `The hashed-trigram provider needs at least ${DETERMINISTIC_MIN_DIMENSIONS} dimensions. ` +
          `Below that, hash collisions make unrelated text score higher than related text, so no ` +
          `similarity threshold can tell them apart and the channel would return confident noise.`,
      );
    }
  }

  isConfigured(): boolean {
    return true;
  }

  async embed(texts: readonly string[]): Promise<EmbeddingResult> {
    return {
      vectors: texts.map((text) => this.embedOne(text)),
      /* No provider reported anything, so cost is unknown rather than zero. */
      usage: { inputTokens: null, reportedCostUsd: null },
    };
  }

  private embedOne(text: string): EmbeddingVector {
    const buckets = new Array<number>(this.dimensions).fill(0);
    const normalised = ` ${text.toLowerCase().replace(/\s+/g, ' ').trim()} `;

    for (let index = 0; index + 3 <= normalised.length; index += 1) {
      const gram = normalised.slice(index, index + 3);
      let hash = 2166136261;
      for (let position = 0; position < gram.length; position += 1) {
        hash ^= gram.charCodeAt(position);
        hash = Math.imul(hash, 16777619);
      }
      const bucket = Math.abs(hash) % this.dimensions;
      /* Sub-linear weighting, so one repeated trigram cannot dominate a vector. */
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }

    /*
     * Sub-linear weighting, and a fixed direction for text with no trigrams at all.
     *
     * An empty or whitespace-only chunk gets a constant vector rather than throwing, so one blank
     * passage cannot fail a whole batch. It matches nothing well, which is the correct outcome.
     *
     * Written as a fold rather than `map` plus `every(v => v === 0)`: TypeScript 5.5 infers a type
     * predicate from that equality lambda, narrows the array to `0[]`, and then rejects writing a
     * 1 into it. Counting as we go is clearer anyway.
     */
    let occupied = 0;
    const damped = new Array<number>(this.dimensions).fill(0);
    for (let bucket = 0; bucket < this.dimensions; bucket += 1) {
      const count = buckets[bucket] ?? 0;
      if (count === 0) continue;
      damped[bucket] = 1 + Math.log(count);
      occupied += 1;
    }
    if (occupied === 0) damped[0] = 1;

    return normaliseVector(damped, this.dimensions);
  }
}

/** Batches a list into provider-sized requests without exceeding the per-text char limit. */
export function batchTexts(
  texts: readonly string[],
  maxBatch = EMBEDDING_LIMITS.maxBatch,
): readonly (readonly string[])[] {
  const batches: string[][] = [];
  for (let index = 0; index < texts.length; index += maxBatch) {
    batches.push(
      texts
        .slice(index, index + maxBatch)
        .map((text) => text.slice(0, EMBEDDING_LIMITS.maxCharsPerText)),
    );
  }
  return batches;
}
