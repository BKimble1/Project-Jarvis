import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/domain/errors';
import { ControlPlaneError } from '@/worker/client';
import { DeliveryError } from '@/worker/delivery';
import { GitError } from '@/worker/git';
import { classifyFailure } from '@/worker/mission-runner';
import { isRetryable, readErrorSignals } from '@/worker/runtime/claude-agent-sdk';
import { WorkspaceError } from '@/worker/workspace';

/**
 * What a failure *is*, ahead of what it says.
 *
 * Both of the worker's classifiers used to read `error.message` and nothing else. That retried an
 * Anthropic 403 because the word "timeout" appeared somewhere in its body — a permanent refusal,
 * re-sent until the mission ran out of attempts — and gave up on a 529, the API saying it is
 * overloaded and to come back, because its text named no phrase the classifier knew. On the
 * mission side the same reading filed the worker's own git allow-list refusal as "a git operation
 * failed", and answered every control-plane failure with `worker_lost` however precisely the
 * control plane had said what was wrong.
 *
 * These tests pin the order rather than the individual answers: status, then code, then class,
 * and prose only when the error carries none of them.
 */

/** An API error as the SDK surfaces one: a status, and a message that argues with it. */
const http = (status: number, message: string): Error =>
  Object.assign(new Error(message), { status });

/** A socket failure as Node raises one: a code, and a message that never repeats it. */
const network = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

describe('isRetryable', () => {
  it('refuses to retry a permanent status whatever the message says', () => {
    /* The defect verbatim: a 403 is a decision, and no word in its body reopens it. */
    expect(isRetryable(http(403, 'Request timeout while validating the credential'))).toBe(false);
    expect(isRetryable(http(401, 'overloaded: invalid x-api-key'))).toBe(false);
    expect(isRetryable(http(404, 'rate limit information unavailable for this model'))).toBe(false);
    expect(isRetryable(http(400, 'the request timeout field is not a number'))).toBe(false);
  });

  it('retries a transient status whatever the message says', () => {
    expect(isRetryable(http(429, 'too many requests for this account'))).toBe(true);
    /* 529 is Anthropic's own "overloaded", and is above the floor rather than in any list. */
    expect(isRetryable(http(529, 'the stream ended before it began'))).toBe(true);
    expect(isRetryable(http(500, 'unexpected'))).toBe(true);
    expect(isRetryable(http(503, 'unexpected'))).toBe(true);
    expect(isRetryable(http(408, 'the server gave up waiting'))).toBe(true);
  });

  it('finds a status wherever the SDK hangs it', () => {
    expect(isRetryable(new Error('agent failed', { cause: http(529, 'nothing familiar') }))).toBe(
      true,
    );
    expect(isRetryable(Object.assign(new Error('failed'), { response: { status: 502 } }))).toBe(
      true,
    );
    /* And a nested permanent status is still permanent, however the wrapper phrases it. */
    expect(
      isRetryable(new Error('the request timed out somewhere', { cause: http(403, 'denied') })),
    ).toBe(false);
  });

  it('retries a connection that never reached a server', () => {
    /* Undici words a reset connection as "socket hang up", so only the code says what happened. */
    expect(isRetryable(network('ECONNRESET', 'socket hang up'))).toBe(true);
    expect(isRetryable(network('EAI_AGAIN', 'getaddrinfo failed'))).toBe(true);
    expect(isRetryable(network('UND_ERR_CONNECT_TIMEOUT', 'fetch failed'))).toBe(true);
  });

  it('reads a status the subprocess could only put in the sentence', () => {
    /*
     * The likeliest way the structured reading is wrong: it is not there. The SDK runs `claude` in
     * a subprocess and an API failure inside it arrives as the line the CLI printed, status and
     * all, on an ordinary `Error`. Reading only the adjectives around that number is the original
     * defect intact — this is the 403 that says "timeout", one layer further out.
     */
    expect(
      isRetryable(
        new Error(
          'API Error: 403 {"type":"error","error":{"message":"request timeout while validating the credential"}}',
        ),
      ),
    ).toBe(false);
    expect(isRetryable(new Error('API Error: 400 invalid_request_error: rate limit field'))).toBe(
      false,
    );
    /* And the other half of it: a 5xx that happens to use none of the four known phrases. */
    expect(isRetryable(new Error('API Error: 500 Internal Server Error'))).toBe(true);
    expect(isRetryable(new Error('Claude Code process exited with code 1: API Error: 529'))).toBe(
      true,
    );
    expect(isRetryable(new Error('Request failed with status code 503'))).toBe(true);

    /* A number with nothing introducing it as a status is just a number. */
    expect(isRetryable(new Error('the model returned 404 candidate patches'))).toBe(false);
    expect(isRetryable(new Error('rate limit reached for claude-opus-4'))).toBe(true);
  });

  it('still reads the message when the error carries nothing structured', () => {
    /* A failure crossing the `claude` subprocess boundary can be a sentence and nothing more. */
    expect(isRetryable(new Error('API error: Overloaded'))).toBe(true);
    expect(isRetryable(new Error('rate limit reached for claude-opus-4'))).toBe(true);
    expect(isRetryable('read ECONNRESET')).toBe(true);
    expect(isRetryable(new Error('the model returned an invalid response'))).toBe(false);
  });

  it('does not mistake a code it cannot interpret for a refusal', () => {
    /* An unknown code says where the failure came from, not whether it will happen again. */
    expect(isRetryable(network('ERR_SOMETHING_NEW', 'the API is overloaded'))).toBe(true);
  });

  it('does not read a number that is not a verdict as one', () => {
    /*
     * `ControlPlaneError` uses status 0 for "nothing answered", and a subprocess killed by a
     * signal exits with 128 plus the signal number. Read as HTTP statuses both would say "a
     * server answered, and not with a 5xx" — the opposite of what each means, and it would take
     * the message rules out of the decision as well.
     */
    expect(readErrorSignals(new ControlPlaneError('unreachable', 0, 'network_error')).status).toBe(
      null,
    );
    expect(readErrorSignals(Object.assign(new Error('killed'), { status: 143 })).status).toBe(null);
    expect(
      readErrorSignals(Object.assign(new Error('done'), { response: { status: 200 } })).status,
    ).toBe(null);

    /* So the message still decides, exactly as it would if the number were not there at all. */
    expect(
      isRetryable(Object.assign(new Error('claude exited: request timeout'), { status: 137 })),
    ).toBe(true);
  });
});

describe('classifyFailure', () => {
  it('files a git failure from its class, not from the word "git"', () => {
    const failure = new GitError('the remote end hung up unexpectedly', {
      code: 128,
      stdout: '',
      stderr: 'fatal: the remote end hung up unexpectedly',
    });
    expect(classifyFailure(failure)).toBe('git_error');

    /* And an error that merely quotes a git command line is not a git failure. */
    expect(classifyFailure(new Error('the agent could not run git status in the workspace'))).toBe(
      'agent_error',
    );
  });

  it("reads the control plane's own code instead of answering worker_lost to everything", () => {
    expect(
      classifyFailure(
        new ControlPlaneError('That run is no longer the mission’s active run.', 409, 'conflict'),
      ),
    ).toBe('plan_superseded');
    expect(
      classifyFailure(
        new ControlPlaneError(
          'That plan describes something Jarvis will not do.',
          403,
          'forbidden',
        ),
      ),
    ).toBe('policy_violation');

    /* A control plane that could not be reached is still the worker dropping out of contact. */
    expect(
      classifyFailure(
        new ControlPlaneError('The control plane could not be reached.', 0, 'network_error'),
      ),
    ).toBe('worker_lost');
    /* As is any code this worker build has never heard of. */
    expect(classifyFailure(new ControlPlaneError('Something new.', 500, 'quota_exhausted'))).toBe(
      'worker_lost',
    );
  });

  it('lets an explicit code beat the prose around it', () => {
    /* The worker's git allow-list refusing an operation before any git ran. */
    expect(classifyFailure(new ValidationError('git rebase is not available to the worker.'))).toBe(
      'policy_violation',
    );
    /* Prose alone would call this one a timeout; the code says the run was superseded. */
    expect(
      classifyFailure(Object.assign(new Error('the run hit its time limit'), { code: 'conflict' })),
    ).toBe('plan_superseded');

    /*
     * The code is read off an unknown error, so it can be any string — including one an object
     * literal would answer from its prototype. A miss has to miss.
     */
    expect(classifyFailure(Object.assign(new Error('odd'), { code: 'toString' }))).toBe(
      'agent_error',
    );
    expect(classifyFailure(Object.assign(new Error('odd'), { code: 'constructor' }))).toBe(
      'agent_error',
    );
  });

  it('keeps the classifications that were already right', () => {
    expect(classifyFailure(new WorkspaceError('clone failed', 'clone_failed'))).toBe('git_error');
    expect(classifyFailure(new WorkspaceError('uncommitted changes', 'dirty_workspace'))).toBe(
      'workspace_error',
    );
    expect(classifyFailure(new DeliveryError('GitHub returned 401 for POST /pulls', 401))).toBe(
      'github_auth_error',
    );
    expect(classifyFailure(new DeliveryError('GitHub returned 429 for POST /pulls', 429))).toBe(
      'github_rate_limited',
    );
    expect(classifyFailure(new Error('The run exceeded its time limit.'))).toBe('timeout');
    expect(classifyFailure(new Error('That tool is not allowed on this mission.'))).toBe(
      'policy_violation',
    );
    expect(classifyFailure(new Error('The model returned an invalid response.'))).toBe(
      'agent_error',
    );
  });
});
