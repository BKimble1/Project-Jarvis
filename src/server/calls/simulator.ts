import {
  assertCallAllowed,
  assertScriptSpeakable,
  interpretCallResponse,
  maskNumber,
  type CallPermission,
  type CallResponse,
  type CallScript,
} from '@/domain/call-bridge';

/**
 * Placing a call, without a telephone.
 *
 * ## Why a simulator rather than a mock
 *
 * A mock proves the code compiles. This runs the whole path — the permission checks, the credential
 * scan, the script, the response — and records exactly what would have been dialled and said, so a
 * test can assert on the *behaviour* rather than on the fact that a function was called. The only
 * thing missing is a provider, and the whole point of the design is that the provider is the least
 * interesting part.
 *
 * ## Why it is not conditional
 *
 * Every call goes through a `CallProvider`, and the simulator is one. There is no "if in test"
 * branch anywhere in the bridge, so the code a real provider would run is exactly the code these
 * tests run — which is what makes "implemented but not live-tested" an honest claim rather than a
 * hopeful one.
 */

export interface PlacedCall {
  /** Masked. See `maskNumber` — a call log is exactly what ends up in a bug report. */
  readonly to: string;
  readonly script: CallScript;
  readonly at: string;
}

export interface CallProvider {
  readonly name: string;
  /** Dial, read the script, and return whatever the person did. */
  place(input: { readonly to: string; readonly script: CallScript }): Promise<CallResponse>;
}

/**
 * A provider that dials nothing and answers however it was told to.
 *
 * `answers` is consumed in order; when it runs out every further call goes unanswered, which is
 * the honest default — a phone that nobody picks up is far more common than one that does.
 */
export class CallSimulator implements CallProvider {
  readonly name = 'simulator';
  readonly placed: PlacedCall[] = [];

  constructor(
    private readonly answers: { digits?: string; speech?: string }[] = [],
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async place(input: { to: string; script: CallScript }): Promise<CallResponse> {
    this.placed.push({
      to: maskNumber(input.to),
      script: input.script,
      at: this.clock().toISOString(),
    });
    const answer = this.answers.shift();
    if (!answer) return { kind: 'no_answer' };
    return interpretCallResponse(
      {
        ...(answer.digits === undefined ? {} : { digits: answer.digits }),
        ...(answer.speech === undefined ? {} : { speech: answer.speech }),
      },
      input.script,
    );
  }
}

export interface CallBridgeDeps {
  readonly provider: CallProvider | null;
  readonly clock?: () => Date;
}

/**
 * The one way a call is placed.
 *
 * Two refusals before anything dials, in this order: may Jarvis call at all right now, and does
 * this script contain anything it must never read aloud. The second exists because a script's
 * situation sentence is assembled from mission titles and failure messages — text that came from a
 * repository, which is somewhere other people write.
 */
export class CallBridge {
  private readonly clock: () => Date;

  constructor(private readonly deps: CallBridgeDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  get configured(): boolean {
    return this.deps.provider !== null;
  }

  async call(input: {
    readonly permission: CallPermission;
    readonly script: CallScript;
  }): Promise<{ readonly response: CallResponse; readonly at: string }> {
    assertCallAllowed({ ...input.permission, providerConfigured: this.configured });
    assertScriptSpeakable(input.script);

    const provider = this.deps.provider;
    /* Unreachable: `assertCallAllowed` refuses an unconfigured bridge. Narrowed for the compiler. */
    if (!provider) throw new Error('No calling provider.');

    const response = await provider.place({ to: input.permission.to, script: input.script });
    return { response, at: this.clock().toISOString() };
  }
}
