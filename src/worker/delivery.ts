import type { VerificationInput } from '@/domain/mission-run';
import type { MissionPlanContent } from '@/domain/mission-plan';
import { redactSecrets } from '@/domain/redaction';
import { summariseVerification } from './verification';

/**
 * GitHub delivery.
 *
 * The interface has exactly four methods, and that is the security boundary: there is no
 * `merge`, no `createRelease`, no `updateRepository`, no `setSecret` and no `createDeployment`
 * for anything — a persuaded agent, a confused worker, a future contributor — to call. A test
 * asserts this at runtime by inspecting the prototype, so adding a fifth write method fails the
 * suite rather than quietly widening what Jarvis can do.
 *
 * The credential this uses is documented as a fine-grained token with **Contents: read and
 * write** (to push a branch) and **Pull requests: read and write** (to open a draft PR) — nothing
 * else. See `docs/WORKER.md`.
 */

export interface DraftPullRequestInput {
  readonly owner: string;
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
}

export interface PullRequestResult {
  readonly number: number;
  readonly url: string;
  readonly draft: boolean;
}

export interface CheckStatus {
  readonly state: 'pending' | 'passing' | 'failing' | 'none';
  readonly summary: string;
  readonly checks: readonly { name: string; conclusion: string | null; url: string | null }[];
}

export interface GitHubDelivery {
  /** Open a draft pull request. `draft: true` is not a parameter the caller chooses. */
  createDraftPullRequest(input: DraftPullRequestInput): Promise<PullRequestResult>;
  /** Update only the title and body of a pull request this mission opened. */
  updatePullRequestBody(owner: string, repo: string, number: number, body: string): Promise<void>;
  /** Read CI status for the mission branch. */
  checkStatus(owner: string, repo: string, ref: string): Promise<CheckStatus>;
  /** Post one comment on the mission's own pull request. */
  comment(owner: string, repo: string, number: number, body: string): Promise<void>;
}

/* ------------------------------------------------------------ real client */

export interface GitHubDeliveryOptions {
  readonly token: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export class GitHubRestDelivery implements GitHubDelivery {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GitHubDeliveryOptions) {
    this.base = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async createDraftPullRequest(input: DraftPullRequestInput): Promise<PullRequestResult> {
    /*
     * `draft: true` is hard-coded. There is no code path in Jarvis that opens a ready-for-review
     * pull request, and no parameter that would let one be requested.
     */
    const response = await this.#request('POST', `/repos/${input.owner}/${input.repo}/pulls`, {
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      draft: true,
      maintainer_can_modify: true,
    });
    const body = (await response.json()) as {
      number: number;
      html_url: string;
      draft?: boolean;
    };
    return { number: body.number, url: body.html_url, draft: body.draft ?? true };
  }

  async updatePullRequestBody(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<void> {
    await this.#request('PATCH', `/repos/${owner}/${repo}/pulls/${number}`, { body });
  }

  async checkStatus(owner: string, repo: string, ref: string): Promise<CheckStatus> {
    const response = await this.#request(
      'GET',
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs`,
    );
    const body = (await response.json()) as {
      check_runs?: {
        name: string;
        status: string;
        conclusion: string | null;
        html_url: string | null;
      }[];
    };
    const runs = body.check_runs ?? [];
    if (runs.length === 0) {
      return { state: 'none', summary: 'No checks have reported yet.', checks: [] };
    }
    const pending = runs.filter((run) => run.status !== 'completed');
    const failing = runs.filter(
      (run) => run.conclusion === 'failure' || run.conclusion === 'timed_out',
    );
    const state: CheckStatus['state'] =
      failing.length > 0 ? 'failing' : pending.length > 0 ? 'pending' : 'passing';
    return {
      state,
      summary:
        state === 'failing'
          ? `${failing.length} check${failing.length === 1 ? '' : 's'} failing.`
          : state === 'pending'
            ? `${pending.length} check${pending.length === 1 ? '' : 's'} still running.`
            : `All ${runs.length} checks passed.`,
      checks: runs.map((run) => ({
        name: run.name,
        conclusion: run.conclusion,
        url: run.html_url,
      })),
    };
  }

  async comment(owner: string, repo: string, number: number, body: string): Promise<void> {
    await this.#request('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
  }

  /**
   * The one place an HTTP call is made, and a **hard** private.
   *
   * `private` in TypeScript is erased: the method still sits on the prototype and anything
   * holding the object can reach it with a cast. That matters here more than almost anywhere
   * else, because this method takes an arbitrary method and path — it is every forbidden
   * operation at once for anyone who can call it. `#request` is not on the prototype at all, so
   * the four-method boundary this class documents is now a property of the runtime rather than
   * of the type checker.
   */
  async #request(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Response> {
    const response = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.options.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'jarvis-worker',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new DeliveryError(
        `GitHub returned ${response.status} for ${method} ${path}: ${redactSecrets(text).slice(0, 300)}`,
        response.status,
      );
    }
    return response;
  }
}

export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }

  /** Maps an HTTP status onto the mission failure taxonomy. */
  get failureCode(): 'github_auth_error' | 'github_rate_limited' | 'github_error' {
    if (this.status === 401 || this.status === 403) return 'github_auth_error';
    if (this.status === 429) return 'github_rate_limited';
    return 'github_error';
  }
}

/* -------------------------------------------------------------- PR body */

export interface PullRequestBodyInput {
  readonly missionId: string;
  readonly missionTitle: string;
  readonly baseUrl: string | null;
  readonly plan: MissionPlanContent | null;
  readonly verifications: readonly VerificationInput[];
  readonly filesChanged: readonly string[];
  readonly openQuestions: readonly string[];
}

/**
 * The pull-request body.
 *
 * Written to be read by a human deciding whether to merge. It states plainly what was verified,
 * what could not be verified here and why, and — every time, in bold — that Jarvis has not merged
 * anything and will not.
 */
export function buildPullRequestBody(input: PullRequestBodyInput): string {
  const summary = summariseVerification(input.verifications);
  const lines: string[] = [];

  lines.push(`## ${input.missionTitle}`);
  lines.push('');
  lines.push(
    input.baseUrl
      ? `Jarvis mission [\`${input.missionId}\`](${input.baseUrl}/missions/${input.missionId})`
      : `Jarvis mission \`${input.missionId}\``,
  );
  lines.push('');

  if (input.plan) {
    lines.push('### Summary');
    lines.push(input.plan.proposedOutcome);
    lines.push('');
    if (input.plan.scope.length > 0) {
      lines.push('### Approved scope');
      for (const item of input.plan.scope) lines.push(`- ${item}`);
      lines.push('');
    }
    if (input.plan.outOfScope.length > 0) {
      lines.push('### Explicitly out of scope');
      for (const item of input.plan.outOfScope) lines.push(`- ${item}`);
      lines.push('');
    }
  }

  if (input.filesChanged.length > 0) {
    lines.push('### Main changes');
    for (const file of input.filesChanged.slice(0, 40)) lines.push(`- \`${file}\``);
    if (input.filesChanged.length > 40) {
      lines.push(`- …and ${input.filesChanged.length - 40} more`);
    }
    lines.push('');
  }

  if (input.plan && input.plan.acceptanceCriteria.length > 0) {
    lines.push('### Acceptance criteria');
    for (const item of input.plan.acceptanceCriteria) lines.push(`- ${item}`);
    lines.push('');
  }

  if (input.plan && input.plan.testsToAddOrUpdate.length > 0) {
    lines.push('### Tests');
    for (const item of input.plan.testsToAddOrUpdate) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push('### Verification');
  lines.push(`${summary.headline}`);
  lines.push('');
  if (input.verifications.length > 0) {
    lines.push('| Command | Result | Detail |');
    lines.push('| --- | --- | --- |');
    for (const result of input.verifications) {
      lines.push(
        `| \`${escapePipes(result.command)}\` | ${outcomeLabel(result)} | ${escapePipes(
          result.reason ?? (result.exitCode === null ? '—' : `exit ${result.exitCode}`),
        )} |`,
      );
    }
    lines.push('');
  }
  if (summary.unavailable > 0) {
    lines.push(
      '> Commands marked **unavailable** could not run on this worker’s platform. They are not claimed to pass — this repository’s own CI is expected to run them.',
    );
    lines.push('');
  }

  lines.push('### CI');
  lines.push('CI status is reported back into Jarvis as it arrives.');
  lines.push('');

  if (input.plan && input.plan.risks.length > 0) {
    lines.push('### Known risks');
    for (const risk of input.plan.risks) {
      lines.push(`- **${risk.severity}** — ${risk.description} _Mitigation: ${risk.mitigation}_`);
    }
    lines.push('');
  }

  const unresolved = [...input.openQuestions, ...(input.plan?.openQuestions ?? [])];
  if (unresolved.length > 0) {
    lines.push('### Unresolved');
    for (const item of unresolved) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push('---');
  lines.push(
    '**This pull request is a draft and has not been merged.** Jarvis does not merge, deploy, publish releases or upload builds. Reviewing and merging is yours to do.',
  );

  return redactSecrets(lines.join('\n'));
}

function outcomeLabel(result: VerificationInput): string {
  switch (result.outcome) {
    case 'passed':
      return '✅ passed';
    case 'failed':
      return result.missionRelated === false ? '⚠️ failed (pre-existing)' : '❌ failed';
    case 'unavailable':
      return '⏭️ unavailable here';
    default:
      return '⏭️ skipped';
  }
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
