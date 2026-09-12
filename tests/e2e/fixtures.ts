import { expect, test as base, type APIRequestContext } from '@playwright/test';
import type { ProjectType } from '@/domain/enums';
import type { ImportableRepository } from '@/domain/integrations';
import type { Project } from '@/domain/project';

/**
 * Shared end-to-end scaffolding.
 *
 * Sign-in happens through the signed test-auth endpoint rather than the GitHub OAuth dance:
 * `buildConfig` refuses to populate `JARVIS_TEST_AUTH_SECRET` in production, so this route is
 * inert in a real deployment and the suite never needs a real credential.
 */

/** Must match `JARVIS_TEST_AUTH_SECRET` in playwright.config.ts. */
export const TEST_AUTH_SECRET = 'e2e-test-auth-secret-value-0001';

/** The repository the mock GitHub API serves with commits, pull requests and workflow runs. */
export const AURORA = 'test-owner/aurora';

/** A project detail URL: `/projects/<uuid>`. */
export const PROJECT_URL = /\/projects\/[0-9a-f-]{36}$/;

/**
 * Retry a request once, and only when the connection itself failed.
 *
 * ## What this is not
 *
 * It is not a test retry, and it never re-runs an assertion. A response that arrives and says the
 * wrong thing still fails on the first attempt; what is retried is a request the server never
 * answered because the socket was gone before it arrived.
 *
 * ## Why it is needed
 *
 * Node closes an idle keep-alive connection after five seconds. Playwright's request context
 * pools connections and does not retry, so a fixture that acts a few seconds after the last
 * request can pick a connection the server has just closed and see `ECONNRESET` — with no record
 * of the request on the server side at all, because it never got there. Observed twice across ten
 * full runs, both times in a fixture doing cleanup after a browser step.
 *
 * The retry announces itself, so a run that needed it says so rather than looking clean.
 */
async function overTransport<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/ECONNRESET|socket hang up|EPIPE|ECONNABORTED/i.test(message)) throw error;
    console.warn(`[e2e] ${what}: connection reset before the request was answered; retrying once.`);
    return call();
  }
}

export async function signIn(request: APIRequestContext): Promise<void> {
  const response = await overTransport('signing in', () =>
    request.post('/api/auth/test', { headers: { 'x-jarvis-test-secret': TEST_AUTH_SECRET } }),
  );
  expect(response.status(), 'the test-auth endpoint must issue a session').toBe(200);
}

/** One repository-backed project and one kept entirely by hand. */
export interface Scenario {
  readonly aurora: Project;
  readonly manual: Project;
}

/**
 * Every test starts authenticated.
 *
 * `context.request` shares its cookie jar with the browser context, so the session cookie the
 * endpoint sets is the same one the pages are loaded with. A test that needs a signed-out
 * visitor opens a context of its own.
 *
 * `scenario` is set up only for the tests that ask for it and removes its manual project
 * afterwards. The imported `aurora` project deliberately persists: importing is expensive, the
 * import test disconnects it first anyway, and `workers: 1` with `fullyParallel: false` makes the
 * sharing safe. Assertions that could be affected by that accumulation say so where they are.
 */
export const test = base.extend<{ signedIn: void; scenario: Scenario }>({
  signedIn: [
    async ({ context }, use) => {
      await signIn(context.request);
      await use();
    },
    { auto: true },
  ],

  scenario: async ({ page }, use) => {
    const aurora = await ensureRepositoryImported(page.request, AURORA);
    const manual = await createProject(page.request, {
      name: uniqueName('Thesis chapter three'),
      type: 'school',
      goal: 'Submit the revised methodology section.',
    });
    await use({ aurora, manual });
    await deleteProject(page.request, manual.id);
  },
});

export { expect };

/**
 * A name no other project can share.
 *
 * The end-to-end database is file-backed and survives both between runs and between the desktop
 * and iPhone projects. Reusing a fixed name would make the command bar answer "which project did
 * you mean?" — correctly — and the test would be measuring the collision rather than the feature.
 */
export function uniqueName(prefix: string): string {
  return `${prefix} ${Math.random().toString(36).slice(2, 8)}`;
}

export function projectIdFromUrl(url: string): string {
  const id = /\/projects\/([0-9a-f-]{36})/.exec(url)?.[1];
  if (!id) throw new Error(`No project id in ${url}`);
  return id;
}

export async function createProject(
  request: APIRequestContext,
  input: { name: string; type?: ProjectType; goal?: string },
): Promise<Project> {
  const response = await overTransport(`creating ${input.name}`, () =>
    request.post('/api/projects', { data: { type: 'software', ...input } }),
  );
  expect(response.status(), `creating ${input.name}`).toBe(201);
  const body = (await response.json()) as { project: Project };
  return body.project;
}

/** Removes a project outright; archiving would leave it visible to later assertions. */
export async function deleteProject(request: APIRequestContext, id: string): Promise<void> {
  const response = await overTransport(`deleting project ${id}`, () =>
    request.delete(`/api/projects/${id}?mode=delete`),
  );
  expect(response.status(), `deleting project ${id}`).toBe(200);
}

async function repositoryEntry(
  request: APIRequestContext,
  fullName: string,
): Promise<ImportableRepository> {
  const response = await overTransport('listing importable repositories', () =>
    request.get('/api/github/repositories'),
  );
  expect(response.status(), 'the importable repository list must load').toBe(200);
  const body = (await response.json()) as {
    configured: boolean;
    repositories: readonly ImportableRepository[];
  };
  expect(body.configured, 'the mock GitHub credential must be configured').toBe(true);
  const entry = body.repositories.find((repo) => repo.fullName === fullName);
  if (!entry) throw new Error(`${fullName} is not visible to the configured token.`);
  return entry;
}

/**
 * Disconnects a repository from whichever project already imported it.
 *
 * Importing twice is refused as a duplicate — correctly — so without this the import journey
 * could only ever run once against a database that outlives the run.
 */
export async function removeImportedRepository(
  request: APIRequestContext,
  fullName: string,
): Promise<void> {
  const entry = await repositoryEntry(request, fullName);
  if (entry.importedProjectId) await deleteProject(request, entry.importedProjectId);
}

/** Imports the repository unless it is already connected, so each test can run on its own. */
export async function ensureRepositoryImported(
  request: APIRequestContext,
  fullName: string,
): Promise<Project> {
  const entry = await repositoryEntry(request, fullName);
  if (entry.importedProjectId) {
    const existing = await request.get(`/api/projects/${entry.importedProjectId}`);
    expect(existing.status(), `loading the project for ${fullName}`).toBe(200);
    return ((await existing.json()) as { project: Project }).project;
  }

  const imported = await request.post('/api/github/import', {
    data: { owner: entry.owner, repo: entry.repo },
  });
  expect(imported.status(), `importing ${fullName}`).toBe(201);
  const body = (await imported.json()) as { project: Project; outcome: string };
  expect(body.outcome, `the first synchronisation of ${fullName}`).toBe('full');
  return body.project;
}

export interface SyncOutcomeResponse {
  readonly status: string;
  readonly message: string;
  readonly evidenceWritten: number;
}

/**
 * Puts the mock GitHub API into a failure, partial or healthy mode.
 *
 * The control path is a GET, so the mock still refuses every write method — the property that
 * makes an accidental write fail the suite rather than pass unnoticed.
 */
export async function setGithubMode(
  request: APIRequestContext,
  mode: 'healthy' | 'unauthorized' | 'rate_limited' | 'partial',
): Promise<void> {
  const base = process.env.E2E_MOCK_GITHUB_URL ?? 'http://127.0.0.1:3124';
  const response = await request.get(`${base}/__control?mode=${mode}`);
  expect(response.status(), `switching the mock GitHub API to ${mode}`).toBe(200);
}

export async function syncProject(
  request: APIRequestContext,
  projectId: string,
): Promise<SyncOutcomeResponse> {
  const response = await request.post(`/api/projects/${projectId}/sync`);
  expect(response.status(), `synchronising project ${projectId}`).toBe(200);
  return ((await response.json()) as { outcome: SyncOutcomeResponse }).outcome;
}

/** Counts the evidence rows Jarvis holds for a project, read through the API it serves. */
export async function evidenceTitles(
  request: APIRequestContext,
  projectId: string,
): Promise<readonly string[]> {
  const response = await request.get(`/api/projects/${projectId}`);
  expect(response.status(), `loading project ${projectId}`).toBe(200);
  const briefing = await request.get(`/api/projects/${projectId}/briefing`);
  expect(briefing.status(), `briefing for ${projectId}`).toBe(200);
  const body = (await briefing.json()) as {
    briefing: { assessment: { recentlyCompleted: { text: string }[] } };
  };
  return body.briefing.assessment.recentlyCompleted.map((claim) => claim.text);
}
