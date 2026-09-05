import { redactSecrets } from '@/domain/redaction';
import type { WorkflowDispatcher } from './controller';

/**
 * The only thing in Jarvis that can start a GitHub Actions workflow.
 *
 * Three methods, chosen the same way the worker's delivery client was: by asking what the
 * feature genuinely needs and then refusing to add a fourth. There is no method here that
 * cancels a run, edits a workflow file, reads or writes a secret, approves a protected
 * environment, or calls an arbitrary endpoint — so none of those is reachable however the caller
 * is persuaded.
 *
 * `declaredSecretNames` is worth stating explicitly: GitHub's secrets API returns **names and
 * timestamps, never values**, which is exactly the amount of knowledge Jarvis wants. It can say
 * "this repository declares `APP_STORE_CONNECT_KEY`" and cannot say what it is.
 *
 * Its credential is separate from the worker's and separate from the read token. It lives only on
 * the control plane, only in this object, and is never echoed into a dispatch input, an event, an
 * artifact or an export.
 */

export interface GithubWorkflowDispatcherOptions {
  readonly token: string;
  readonly apiUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

interface WorkflowRunRow {
  readonly id: number;
  readonly html_url: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly created_at: string;
}

export class GithubWorkflowDispatcher implements WorkflowDispatcher {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GithubWorkflowDispatcherOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /*
   * Hard privates, not TypeScript ones.
   *
   * `private` is erased at runtime, so a `private` method still sits on the prototype and a cast
   * reaches it. `#call` takes an arbitrary path and init — it is every forbidden dispatcher
   * method at once for anyone holding this object — so it has to be genuinely unreachable rather
   * than merely discouraged by the type checker.
   */
  #headers(): Record<string, string> {
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.options.token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'jarvis-ci-controller',
    };
  }

  #url(path: string): string {
    return `${this.options.apiUrl.replace(/\/+$/, '')}${path}`;
  }

  async #call(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20_000);
    try {
      return await this.fetchImpl(this.#url(path), {
        ...init,
        headers: { ...this.#headers(), ...(init.headers as Record<string, string> | undefined) },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Start one allow-listed workflow.
   *
   * The workflow file name and the ref are put in the path by the caller only after
   * `evaluateCiDispatch` has checked both against the allow-lists — this method does no policy of
   * its own, deliberately, so there is exactly one place where that decision lives.
   */
  async dispatch(input: {
    repositoryFullName: string;
    workflowFile: string;
    ref: string;
    inputs: Readonly<Record<string, string>>;
  }): Promise<{ ok: boolean; status: number; detail: string }> {
    const response = await this.#call(
      `/repos/${input.repositoryFullName}/actions/workflows/${encodeURIComponent(input.workflowFile)}/dispatches`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: input.ref, inputs: input.inputs }),
      },
    );
    if (response.status === 204) return { ok: true, status: 204, detail: 'Dispatched.' };
    const text = await response.text().catch(() => '');
    return {
      ok: false,
      status: response.status,
      /* Redacted: a GitHub error body can echo an input back, and inputs come from a mission. */
      detail: redactSecrets(text.slice(0, 400)),
    };
  }

  /** Find the run this dispatch produced. Read-only; cannot cancel or re-run anything. */
  async findRun(input: {
    repositoryFullName: string;
    workflowFile: string;
    ref: string;
    since: string;
  }): Promise<{ id: string; url: string; status: string; conclusion: string | null } | null> {
    const response = await this.#call(
      `/repos/${input.repositoryFullName}/actions/workflows/${encodeURIComponent(input.workflowFile)}/runs?per_page=10`,
    );
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as {
      workflow_runs?: WorkflowRunRow[];
    } | null;
    const since = Date.parse(input.since);
    const run = (body?.workflow_runs ?? []).find(
      (candidate) => Date.parse(candidate.created_at) >= since - 60_000,
    );
    if (!run) return null;
    return {
      id: String(run.id),
      url: run.html_url,
      status: run.status,
      conclusion: run.conclusion,
    };
  }

  /**
   * Which secret *names* a repository declares.
   *
   * GitHub's list-secrets endpoint returns names and timestamps only — there is no value in the
   * response and no endpoint on this client that could fetch one. That is precisely the level of
   * knowledge Jarvis should have about signing material: enough to say "it looks configured",
   * never enough to use it.
   */
  async declaredSecretNames(repositoryFullName: string): Promise<readonly string[]> {
    const response = await this.#call(`/repos/${repositoryFullName}/actions/secrets?per_page=100`);
    if (!response.ok) return [];
    const body = (await response.json().catch(() => null)) as {
      secrets?: { name: string }[];
    } | null;
    return (body?.secrets ?? []).map((secret) => secret.name);
  }
}

/**
 * The methods this client must never grow.
 *
 * Asserted at runtime in the test suite by walking the prototype, the same way Prompt 2 asserts
 * the delivery client has no merge. A list in a comment is a hope; a list a test iterates is a
 * property.
 */
export const FORBIDDEN_DISPATCHER_METHODS: readonly string[] = [
  'cancel',
  'cancelRun',
  'rerun',
  'rerunFailed',
  'deleteRun',
  'createSecret',
  'updateSecret',
  'deleteSecret',
  'getSecret',
  'readSecret',
  'approveDeployment',
  'reviewDeployment',
  'updateWorkflow',
  'enableWorkflow',
  'disableWorkflow',
  'createRelease',
  'merge',
  'mergePullRequest',
  'updateBranchProtection',
  'request',
  'graphql',
];
