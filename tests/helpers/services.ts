import { buildServices, type Services } from '@/server/container';
import type { AppConfig } from '@/server/config/env';
import type { BriefingNarrator } from '@/server/briefing/types';
import { createTestDatabase } from './test-db';
import { testConfig } from './test-config';
import { FakeSourceProvider } from './fake-provider';
import { FakeUrlFetcher } from './fake-url-fetcher';
import type { EmbeddingProvider } from '@/domain/embedding';
import type { AnswerProvider } from '@/server/ask/answer-provider';

/**
 * A fully wired service graph backed by a migrated in-memory PostgreSQL database and a fake
 * source provider — the real code paths, with only the network replaced.
 */
export interface TestHarness {
  readonly services: Services;
  readonly provider: FakeSourceProvider;
  /** Scripted pages for URL ingestion. The real SSRF guard has its own suite. */
  readonly urlFetcher: FakeUrlFetcher;
  readonly config: AppConfig;
  readonly close: () => Promise<void>;
}

export async function createHarness(
  options: {
    config?: AppConfig;
    narrator?: BriefingNarrator;
    clock?: () => Date;
    /**
     * The embedding provider.
     *
     * Omitted means none, which is the production default and is reported as `lexical_only`.
     * A test that wants the semantic channel passes one explicitly, so no test can accidentally
     * assert hybrid behaviour it did not ask for.
     */
    embeddings?: EmbeddingProvider | null;
    /**
     * A scripted answer provider.
     *
     * Omitted means none, which is production's default and yields evidence-only answers. A test
     * that wants the model path supplies one, so no test can accidentally assert model behaviour
     * it did not ask for.
     */
    answerProvider?: AnswerProvider;
  } = {},
): Promise<TestHarness> {
  const { db, close } = await createTestDatabase();
  const config = options.config ?? testConfig();
  const provider = new FakeSourceProvider();
  const urlFetcher = new FakeUrlFetcher();
  const services = buildServices(db, config, {
    provider,
    urlFetcher,
    ...(options.embeddings !== undefined ? { embeddings: options.embeddings } : {}),
    ...(options.answerProvider ? { answerProvider: options.answerProvider } : {}),
    ...(options.narrator ? { narrator: options.narrator } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  return { services, provider, urlFetcher, config, close };
}
