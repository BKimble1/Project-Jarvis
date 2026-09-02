import type {
  CheckStatus,
  DraftPullRequestInput,
  GitHubDelivery,
  PullRequestResult,
} from '@/worker/delivery';
import { DeliveryError } from '@/worker/delivery';

/**
 * A GitHub delivery that records rather than calls.
 *
 * It implements exactly the same four-method interface as the real one, which is the point: a
 * test that passes here is exercising the same call sites, and the interface still offers nothing
 * that could merge, deploy or publish.
 */
export class FakeDelivery implements GitHubDelivery {
  readonly created: DraftPullRequestInput[] = [];
  readonly bodyUpdates: { number: number; body: string }[] = [];
  readonly comments: { number: number; body: string }[] = [];
  private nextNumber = 1;

  constructor(
    private readonly options: {
      /** Fail the next PR creation with this status, to exercise the failure path. */
      failWithStatus?: number;
      checks?: CheckStatus;
    } = {},
  ) {}

  async createDraftPullRequest(input: DraftPullRequestInput): Promise<PullRequestResult> {
    if (this.options.failWithStatus) {
      throw new DeliveryError(
        `GitHub returned ${this.options.failWithStatus}`,
        this.options.failWithStatus,
      );
    }
    this.created.push(input);
    const number = this.nextNumber++;
    return {
      number,
      url: `https://github.test/${input.owner}/${input.repo}/pull/${number}`,
      draft: true,
    };
  }

  async updatePullRequestBody(
    _owner: string,
    _repo: string,
    number: number,
    body: string,
  ): Promise<void> {
    this.bodyUpdates.push({ number, body });
  }

  async checkStatus(): Promise<CheckStatus> {
    return (
      this.options.checks ?? {
        state: 'pending',
        summary: '1 check still running.',
        checks: [{ name: 'build', conclusion: null, url: null }],
      }
    );
  }

  async comment(_owner: string, _repo: string, number: number, body: string): Promise<void> {
    this.comments.push({ number, body });
  }
}
