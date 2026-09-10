import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { afterEach, describe, expect, it } from 'vitest';

import { buildConfig } from '@/server/config/env';
import { databaseSurvivesRestart } from '@/server/ops/readiness';
import { ENV_FILES, loadEnvFiles } from '../../scripts/workspaces';

/**
 * What a blank environment variable means, and which file a script reads it from.
 *
 * Both questions were answered differently in different places, and between them they made the
 * documented first run fail. `cp .env.example .env.local`, which three documents tell the owner to
 * do, shipped `JARVIS_DB_DRIVER=`; `dotenv` turns that into the empty string; `z.enum([...])
 * .optional()` accepts `undefined` and not `''`; so `buildConfig` threw while a page was rendering
 * and every page answered 500 with a blank body. Nothing in the suite parsed the file the
 * documents tell people to copy, which is why it survived.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const ENV_EXAMPLE = path.join(REPO_ROOT, '.env.example');

/** A minimal environment that builds. Every case adds one variable to it. */
const base = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({ NODE_ENV: 'development', ...overrides }) as NodeJS.ProcessEnv;

describe('a blank value means unset', () => {
  /**
   * The four that broke, and one that would have broken next.
   *
   * `JARVIS_DB_DRIVER` and `JARVIS_KNOWLEDGE_EMBEDDINGS` are enums, and an enum rejects `''`
   * outright. `PGLITE_DATA_DIR` is worse than a rejection: it was accepted, so the empty string
   * travelled as far as the readiness report as a configured data directory. `GITHUB_API_BASE_URL`
   * and `JARVIS_CREDENTIAL_KEY_VERSION` are here because neither is optional and both would have
   * failed in their own way — an empty API base URL, and `Number('')` failing a `min(1)`.
   */
  const variables = [
    'JARVIS_DB_DRIVER',
    'JARVIS_KNOWLEDGE_EMBEDDINGS',
    'PGLITE_DATA_DIR',
    'GITHUB_API_BASE_URL',
    'JARVIS_CREDENTIAL_KEY_VERSION',
    'JARVIS_DEFAULT_TIME_ZONE',
    'LOG_LEVEL',
    'SESSION_TTL_HOURS',
  ] as const;

  for (const name of variables) {
    it(`treats ${name}= exactly as if it were absent`, () => {
      expect(buildConfig(base({ [name]: '' }))).toEqual(buildConfig(base()));
      /* Whitespace too: an editor that leaves `KEY= ` behind must not be a different outcome. */
      expect(buildConfig(base({ [name]: '   ' }))).toEqual(buildConfig(base()));
    });
  }

  /**
   * Every name the template mentions, not only the ones known to have broken.
   *
   * The failure was never about one variable. It was about a rule — blank is unset — being applied
   * per field, so that the next variable added could forget it. Reading the names out of
   * `.env.example` means a variable added to the template is covered by this test on the day it is
   * added. Names the schema does not know are stripped by `z.object` and compare equal either way,
   * which is the correct answer for them too.
   */
  it('holds for every variable named in .env.example', () => {
    const names = [
      ...new Set(
        readFileSync(ENV_EXAMPLE, 'utf8')
          .split('\n')
          .map((line) => /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
          .filter((name): name is string => name !== undefined),
      ),
    ];
    /* If this ever reads zero names the regex has broken and the sweep proves nothing. */
    expect(names.length).toBeGreaterThan(40);

    const unset = buildConfig(base());
    for (const name of names) {
      expect(() => buildConfig(base({ [name]: '' })), `${name}=`).not.toThrow();
      expect(buildConfig(base({ [name]: '' })), `${name}=`).toEqual(unset);
    }
  });

  /**
   * The test that would have caught it.
   *
   * Not a reconstruction of the file — the file itself, parsed by the same library that parses it
   * for the running application, handed to the same function the application calls.
   */
  it('builds a working configuration from .env.example as shipped', () => {
    const template = parseDotenv(readFileSync(ENV_EXAMPLE));

    const config = buildConfig({ ...template, NODE_ENV: 'development' } as NodeJS.ProcessEnv);

    /* No DATABASE_URL in the template, so a first run is local and embedded. */
    expect(config.database.driver).toBe('pglite');
    expect(config.knowledge.embeddingProvider).toBe('none');
    expect(config.githubApiBaseUrl).toBe('https://api.github.com');
  });
});

describe('an embedded database only reports as durable when it is', () => {
  /*
   * `NODE_ENV=test` because development supplies `.jarvis-data/dev` as a default, and the case
   * worth pinning is the one with no directory at all.
   */
  it('does not call a blank PGLITE_DATA_DIR durable', () => {
    const blank = buildConfig({ NODE_ENV: 'test', PGLITE_DATA_DIR: '' } as NodeJS.ProcessEnv);
    const unset = buildConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);

    expect(blank.database.pgliteDataDir).toBe(unset.database.pgliteDataDir);
    expect(blank.database.pgliteDataDir).toBeNull();
    /*
     * The claim that matters: `server/db/client.ts` opens `new PGlite()` for this configuration —
     * a database in memory — so nothing may tell the owner it survives a restart.
     */
    expect(databaseSurvivesRestart(blank)).toBe(false);

    /*
     * The same claim without `buildConfig` in front of it. Nothing can produce this configuration
     * any more, and that is exactly why it is asserted here: the schema and this check are two
     * independent guards against the same wrong answer, and a test that only reaches one of them
     * would let the other drift back to `!== null` unnoticed.
     */
    const inMemory = { ...blank, database: { ...blank.database, pgliteDataDir: '' } };
    expect(databaseSurvivesRestart(inMemory)).toBe(false);
  });

  it('calls a configured directory durable, and any hosted driver durable', () => {
    const directory = buildConfig({
      NODE_ENV: 'test',
      PGLITE_DATA_DIR: '.jarvis-data/test',
    } as NodeJS.ProcessEnv);
    expect(databaseSurvivesRestart(directory)).toBe(true);

    const hosted = buildConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://jarvis:secret@db.example.com/jarvis',
    } as NodeJS.ProcessEnv);
    expect(databaseSurvivesRestart(hosted)).toBe(true);
  });
});

describe('scripts read the environment file the documents tell people to create', () => {
  const PROBE = ['JARVIS_ENV_PROBE_LOCAL', 'JARVIS_ENV_PROBE_SHARED', 'JARVIS_ENV_PROBE_REAL'];

  afterEach(() => {
    for (const name of PROBE) delete process.env[name];
  });

  it('prefers .env.local, still reads .env, and never overrides a real variable', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'jarvis-env-'));
    writeFileSync(
      path.join(directory, '.env.local'),
      'JARVIS_ENV_PROBE_LOCAL=from-local\nJARVIS_ENV_PROBE_REAL=from-local\n',
    );
    writeFileSync(
      path.join(directory, '.env'),
      'JARVIS_ENV_PROBE_LOCAL=from-env\nJARVIS_ENV_PROBE_SHARED=from-env\nJARVIS_ENV_PROBE_REAL=from-env\n',
    );
    process.env.JARVIS_ENV_PROBE_REAL = 'from-the-shell';

    loadEnvFiles(directory);

    /* `.env.local` is the file `npm run dev` reads, so a script must not disagree with it. */
    expect(process.env.JARVIS_ENV_PROBE_LOCAL).toBe('from-local');
    /* …and `.env` is still read, so an installation that only has one keeps working. */
    expect(process.env.JARVIS_ENV_PROBE_SHARED).toBe('from-env');
    /* A systemd EnvironmentFile or `VAR=… npm run doctor` outranks both files. */
    expect(process.env.JARVIS_ENV_PROBE_REAL).toBe('from-the-shell');
  });

  /**
   * The regression that put this here.
   *
   * `import 'dotenv/config'` reads `.env` and nothing else. With `DATABASE_URL` in `.env.local`,
   * `npm run db:migrate` therefore migrated the local PGlite instead and exited 0 reporting
   * success — a silent wrong target — while `npm run doctor` reported no owner and no OAuth beside
   * an application that was running fine on the same configuration.
   *
   * `jarvis-live.mts` and `worker-supervise.ts` each carry their own copy of the same two-file
   * loop, which is what `loadEnvFiles` should eventually replace.
   */
  it('gives every script that reads configuration both files, through one loader', () => {
    const scripts = path.join(REPO_ROOT, 'scripts');
    const entryPoints = [
      'doctor.ts',
      'migrate.ts',
      'qualify.ts',
      'reasoning-probe.ts',
      'repair-project-name.ts',
      'seed-demo.ts',
      'verify.ts',
      'worker.ts',
      'worker-health.ts',
      'workspaces.ts',
    ];

    for (const file of entryPoints) {
      const source = readFileSync(path.join(scripts, file), 'utf8');
      expect(source, `${file} must load the environment files`).toContain('loadEnvFiles');
    }

    /*
     * And the sweep, so that a script added tomorrow cannot reintroduce it. `vault-key.ts` prints
     * a random value and reads no configuration at all, so it needs no loader — but nothing may
     * go back to reading `.env` alone.
     */
    const everyScript = readdirSync(scripts).filter((file) => file.endsWith('.ts'));
    expect(everyScript.length).toBeGreaterThan(entryPoints.length);
    /* An import statement, not the several comments that name it as the thing that went wrong. */
    const readsDotEnvAlone = /^\s*import\s+['"]dotenv\/config['"]/m;
    for (const file of everyScript) {
      const source = readFileSync(path.join(scripts, file), 'utf8');
      expect(readsDotEnvAlone.test(source), `${file} must not read .env alone`).toBe(false);
    }
  });

  it('reads the more specific file first', () => {
    expect(ENV_FILES).toEqual(['.env.local', '.env']);
  });
});

describe('a command that opens the database gives it back', () => {
  /**
   * The half of the fix nothing else pins.
   *
   * PGlite holds the event loop open until its client is closed, so `npm run doctor` printed its
   * whole report and then never returned — and because the first run against a data directory
   * that does not exist yet does return, the hang only appeared on the second run. The docstring
   * offers that command as a container readiness probe.
   *
   * Reverting the `await closeDatabase()` in `doctor.ts` broke no test at all, and the same
   * omission was still live in `verify.ts --record`, which writes two qualification rows and then
   * hung: measured at 45 seconds and still running. So this is a rule about every script rather
   * than an assertion about the three that were fixed by hand.
   *
   * It reads sources rather than running the commands because running them means a real database
   * and a real hang to wait out; the failure this guards against is a missing call, which is
   * visible in the source.
   */
  it('closes the database in every script that opens one', () => {
    const scripts = path.join(REPO_ROOT, 'scripts');
    const opensDatabase = /\bgetDb\s*\(|\bgetDatabaseHandle\s*\(/;
    const closesDatabase = /\bcloseDatabase\s*\(|\.close\s*\(\)/;

    const everyScript = readdirSync(scripts).filter(
      (file) => file.endsWith('.ts') || file.endsWith('.mts'),
    );
    const opening = everyScript.filter((file) =>
      opensDatabase.test(readFileSync(path.join(scripts, file), 'utf8')),
    );
    /* If this ever finds none, the patterns have drifted and the rule proves nothing. */
    expect(opening.length).toBeGreaterThan(3);

    for (const file of opening) {
      const source = readFileSync(path.join(scripts, file), 'utf8');
      expect(
        closesDatabase.test(source),
        `${file} opens the database, so it must close it: an embedded database holds the process open for ever`,
      ).toBe(true);
    }
  });
});

describe('the workspaces script still runs when it is the one that was run', () => {
  /**
   * The guard, exercised the way the guard fails.
   *
   * `scripts/workspaces.ts` now hosts `loadEnvFiles`, so every other script imports it, so its
   * own `main()` had to be put behind "is this file the entry point?". That question is answered
   * by comparing `process.argv[1]` with `import.meta.url`, and the two are produced differently:
   * Node resolves a module specifier through the real path, the shell hands over whatever it was
   * given. Reached through a symlinked checkout the two disagreed, and `npm run worker:workspaces`
   * then printed nothing and exited 0 — which reads as "no preserved workspaces", not as a command
   * that never ran. A wrong answer, silently, from the command whose only job is to say what is
   * on disk.
   *
   * Run as a real process, because the fault was in how the process was started.
   */
  it('lists workspaces when reached through a symlinked checkout', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'jarvis-link-'));
    const checkout = path.join(directory, 'checkout');
    symlinkSync(REPO_ROOT, checkout);
    const workspaceRoot = path.join(directory, 'workspaces');
    mkdirSync(workspaceRoot);

    const result = spawnSync(
      process.execPath,
      [
        path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(checkout, 'scripts', 'workspaces.ts'),
      ],
      {
        /* tsx resolves the `@/…` aliases from the working directory, so it has to be a checkout. */
        cwd: checkout,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          JARVIS_CONTROL_PLANE_URL: 'https://jarvis.example.com',
          JARVIS_WORKER_TOKEN: 'token-for-a-worker-that-never-connects',
          JARVIS_WORKER_WORKSPACE_ROOT: workspaceRoot,
        },
      },
    );

    expect(result.status, result.stderr || 'no output on stderr').toBe(0);
    expect(result.stdout, 'the entry-point guard answered "no" and main() never ran').toContain(
      workspaceRoot,
    );
  }, 60_000);
});
