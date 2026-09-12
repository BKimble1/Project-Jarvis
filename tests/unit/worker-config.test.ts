import { describe, expect, it } from 'vitest';

import { buildWorkerConfig } from '@/worker/config';

/**
 * A blank line in the worker's half of `.env.example` means unset.
 *
 * The header of that file says so, for the whole file: "`KEY=` and no `KEY` line at all are the
 * same thing to Jarvis." The control plane's schema was made to keep that promise and this one was
 * not, which mattered because the two halves live in the same file and an owner filling it in from
 * the top has no way to know where one schema stops and the other starts.
 *
 * What it cost, measured before the fix: `JARVIS_WORKER_AUTH_MODE=` and `JARVIS_WORKER_RUNTIME=`
 * threw at boot with "expected one of subscription|api_key", so the worker did not start at all;
 * `JARVIS_WORKER_MODEL=` produced a model named the empty string; `JARVIS_WORKER_GITHUB_API_URL=`
 * replaced a correct default with an empty API base; and `JARVIS_WORKER_GITHUB_TOKEN=` produced a
 * token of `''` beside a diagnostic in the same object saying the token was not set.
 */
describe('a worker environment filled in from the template', () => {
  /* Enough to build a config at all. Everything else is what each case is about. */
  const REQUIRED = {
    JARVIS_CONTROL_PLANE_URL: 'http://localhost:3000',
    JARVIS_WORKER_TOKEN: 'jarvisw_0000.secret',
    JARVIS_WORKER_WORKSPACE_ROOT: '/tmp/jarvis-workspaces',
  };

  const withBlank = (key: string) =>
    buildWorkerConfig({ ...REQUIRED, [key]: '' } as unknown as NodeJS.ProcessEnv);

  it('does not refuse to start over a blank line the template itself ships', () => {
    expect(withBlank('JARVIS_WORKER_AUTH_MODE').authMode).toBe('subscription');
    expect(withBlank('JARVIS_WORKER_RUNTIME').runtime).toBe('claude');
  });

  it('keeps the documented default rather than replacing it with nothing', () => {
    expect(withBlank('JARVIS_WORKER_GITHUB_API_URL').githubApiUrl).toBe('https://api.github.com');
    expect(withBlank('JARVIS_WORKER_NAME').name).toBe('jarvis-worker');
    expect(withBlank('JARVIS_WORKER_MAX_TURNS').maxTurns).toBe(60);
  });

  /*
   * The three-answers case. A blank credential must read as absent everywhere, or the diagnostic
   * and the value disagree and an owner is told the opposite of what the worker is about to do.
   */
  it('reads a blank credential as absent, and says so consistently', () => {
    const config = withBlank('JARVIS_WORKER_GITHUB_TOKEN');
    expect(config.githubToken).toBeNull();
    expect(config.diagnostics.join(' ')).toContain('JARVIS_WORKER_GITHUB_TOKEN');
  });

  it('leaves an unset model unset rather than naming it the empty string', () => {
    expect(withBlank('JARVIS_WORKER_MODEL').model).toBeNull();
  });

  /* And a value that is really there still wins, so the fix removed nothing. */
  it('still reads a value that was actually given', () => {
    const config = buildWorkerConfig({
      ...REQUIRED,
      JARVIS_WORKER_AUTH_MODE: 'api_key',
      ANTHROPIC_API_KEY: 'sk-ant-test-key-value',
      JARVIS_WORKER_NAME: 'macbook',
      JARVIS_WORKER_MAX_TURNS: '120',
    } as unknown as NodeJS.ProcessEnv);
    expect(config.authMode).toBe('api_key');
    expect(config.name).toBe('macbook');
    expect(config.maxTurns).toBe(120);
  });
});
