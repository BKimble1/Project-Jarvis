import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/app.js';
import { AutoClock, StubProvider, liveMeasurement, failedMeasurement, createScriptedExecutor, silentLogger, recordEvents, settle } from './fakes.js';

/** Build a fully wired app on a throwaway data dir. */
export function makeApp(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-'));
  const clock = overrides.clock ?? new AutoClock();
  const provider = overrides.provider ?? new StubProvider([liveMeasurement(clock)]);
  const executor = overrides.executor ?? createScriptedExecutor();
  const app = createApp({
    dataDir,
    clock,
    provider,
    executor,
    logger: silentLogger(),
    ...overrides.appOptions,
  });
  app.testDataDir = dataDir;
  app.testClock = clock;
  app.testProvider = provider;
  app.cleanup = async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return app;
}


export { AutoClock, StubProvider, liveMeasurement, failedMeasurement, createScriptedExecutor, silentLogger, recordEvents, settle };
