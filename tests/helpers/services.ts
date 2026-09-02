import { buildServices, type Services } from '@/server/container';
import type { AppConfig } from '@/server/config/env';
import type { BriefingNarrator } from '@/server/briefing/types';
import { createTestDatabase } from './test-db';
import { testConfig } from './test-config';
import { FakeSourceProvider } from './fake-provider';

/**
 * A fully wired service graph backed by a migrated in-memory PostgreSQL database and a fake
 * source provider — the real code paths, with only the network replaced.
 */
export interface TestHarness {
  readonly services: Services;
  readonly provider: FakeSourceProvider;
  readonly config: AppConfig;
  readonly close: () => Promise<void>;
}

export async function createHarness(
  options: {
    config?: AppConfig;
    narrator?: BriefingNarrator;
    clock?: () => Date;
  } = {},
): Promise<TestHarness> {
  const { db, close } = await createTestDatabase();
  const config = options.config ?? testConfig();
  const provider = new FakeSourceProvider();
  const services = buildServices(db, config, {
    provider,
    ...(options.narrator ? { narrator: options.narrator } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  return { services, provider, config, close };
}
