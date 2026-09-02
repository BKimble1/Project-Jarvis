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

export async function signIn(request: APIRequestContext): Promise<void> {
  const response = await request.post('/api/auth/test', {
    headers: { 'x-jarvis-test-secret': TEST_AUTH_SECRET },
  });
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
 * `scenario` is set up only for the tests that ask for it, and removes its manual project
 * afterwards, so no test has to inherit state from the one before it.
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
  const response = await request.post('/api/projects', {
    data: { type: 'software', ...input },
  });
  expect(response.status(), `creating ${input.name}`).toBe(201);
  const body = (await response.json()) as { project: Project };
  return body.project;
}

/** Removes a project outright; archiving would leave it visible to later assertions. */
export async function deleteProject(request: APIRequestContext, id: string): Promise<void> {
  const response = await request.delete(`/api/projects/${id}?mode=delete`);
  expect(response.status(), `deleting project ${id}`).toBe(200);
}

async function repositoryEntry(
  request: APIRequestContext,
  fullName: string,
): Promise<ImportableRepository> {
  const response = await request.get('/api/github/repositories');
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

export async function syncProject(
  request: APIRequestContext,
  projectId: string,
): Promise<SyncOutcomeResponse> {
  const response = await request.post(`/api/projects/${projectId}/sync`);
  expect(response.status(), `synchronising project ${projectId}`).toBe(200);
  return ((await response.json()) as { outcome: SyncOutcomeResponse }).outcome;
}
