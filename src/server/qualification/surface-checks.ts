import {
  FORBIDDEN_DISPATCHER_METHODS,
  GithubWorkflowDispatcher,
} from '@/server/ci/github-dispatcher';
import { GitHubRestDelivery } from '@/worker/delivery';

/**
 * Assertions about what the code can actually do, made against the code.
 *
 * Every claim here could have been written as a sentence in a document. Documents drift; a walk
 * over a prototype does not. These functions are called by the qualification service *and* by the
 * test suite, so the same assertion that gates activation also fails `npm test` the moment
 * somebody adds a method that widens the boundary.
 *
 * `FORBIDDEN_DISPATCHER_METHODS` carried a comment claiming it was asserted at runtime. It was
 * not — nothing imported it. This module is that assertion.
 */

export interface SurfaceVerdict {
  readonly ok: boolean;
  readonly detail: string;
  readonly evidence: Readonly<Record<string, string>>;
}

/**
 * The delivery client's complete permitted surface.
 *
 * Named positively rather than as a deny-list, because a deny-list only catches the dangerous
 * methods somebody thought of. Anything not on this list is a finding, whatever it is called.
 */
export const ALLOWED_DELIVERY_METHODS: readonly string[] = [
  'constructor',
  'createDraftPullRequest',
  'updatePullRequestBody',
  /*
   * A read, added deliberately. Delivery calls it before it creates, so a worker restarted
   * between pushing its branch and opening its pull request adopts the existing one rather than
   * opening a second for the same commit. It widens nothing: the writes are still the three
   * below, and the credential's scopes are unchanged.
   */
  'findOpenPullRequest',
  'checkStatus',
  'comment',
];

/** Names that must never appear on the delivery client, whatever else changes. */
export const FORBIDDEN_DELIVERY_METHODS: readonly string[] = [
  'merge',
  'mergePullRequest',
  'squashMerge',
  'createRelease',
  'publishRelease',
  'createDeployment',
  'setSecret',
  'createSecret',
  'updateSecret',
  'updateRepository',
  'deleteRepository',
  'updateBranchProtection',
  'forcePush',
  'deleteBranch',
  'markReadyForReview',
  'enableAutoMerge',
  'approvePullRequest',
  'submitReview',
  'dispatchWorkflow',
  'request',
  'graphql',
];

function methodNames(prototype: object): readonly string[] {
  const names = new Set<string>();
  let current: object | null = prototype;
  while (current && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) names.add(name);
    current = Object.getPrototypeOf(current) as object | null;
  }
  return [...names].sort();
}

/**
 * Delivery is still limited to pushing a branch and opening a draft pull request.
 *
 * Checks both directions. A forbidden method appearing is the obvious failure; a method appearing
 * that is on neither list is the *interesting* one, because that is what a widening looks like
 * before anybody has thought to add its name to a deny-list.
 */
export function checkDeliveryRestricted(): SurfaceVerdict {
  const names = methodNames(GitHubRestDelivery.prototype);

  const forbidden = names.filter((name) => FORBIDDEN_DELIVERY_METHODS.includes(name));
  if (forbidden.length > 0) {
    return {
      ok: false,
      detail: `The delivery client has gained methods it must never have: ${forbidden.join(', ')}.`,
      evidence: { forbidden: forbidden.join(', ') },
    };
  }

  const unexpected = names.filter((name) => !ALLOWED_DELIVERY_METHODS.includes(name));
  if (unexpected.length > 0) {
    return {
      ok: false,
      detail: `The delivery client has methods on neither the allowed nor the forbidden list: ${unexpected.join(', ')}. Read the diff before qualifying.`,
      evidence: { unexpected: unexpected.join(', ') },
    };
  }

  const exposed = names.filter((name) => name !== 'constructor');
  return {
    ok: true,
    detail: `Delivery exposes ${exposed.length} methods, all on the allowed list. It cannot merge, release, deploy or change a setting.`,
    evidence: { methods: exposed.join(', ') },
  };
}

/**
 * The CI dispatcher has not grown a method that could cancel, rerun, approve or read a secret.
 *
 * `request` and `graphql` are on the forbidden list on purpose: an escape hatch that can issue an
 * arbitrary API call is every one of the other forbidden methods at once.
 */
export function checkDispatcherRestricted(): SurfaceVerdict {
  const names = methodNames(GithubWorkflowDispatcher.prototype);
  const forbidden = names.filter((name) => FORBIDDEN_DISPATCHER_METHODS.includes(name));

  if (forbidden.length > 0) {
    return {
      ok: false,
      detail: `The CI dispatcher has gained methods it must never have: ${forbidden.join(', ')}.`,
      evidence: { forbidden: forbidden.join(', ') },
    };
  }

  const exposed = names.filter((name) => name !== 'constructor');
  return {
    ok: true,
    detail: `The CI dispatcher exposes ${exposed.length} methods and none of the ${FORBIDDEN_DISPATCHER_METHODS.length} forbidden ones.`,
    evidence: { methods: exposed.join(', ') },
  };
}

/** The display-authenticated routes, and the only methods each may answer. */
export const DISPLAY_ROUTE_INVENTORY: readonly {
  readonly path: string;
  readonly allowed: readonly string[];
}[] = [
  { path: 'src/app/api/display/route.ts', allowed: ['GET'] },
  { path: 'src/app/api/display/session/route.ts', allowed: ['POST', 'DELETE'] },
];

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/**
 * The display surface, enumerated.
 *
 * `/api/display` answers `GET` and nothing else. `/api/display/session` answers `POST` and
 * `DELETE`, which begin and end a display's *own* session and change nothing about any project,
 * mission or setting.
 *
 * This verifies the two known modules. It cannot, by itself, prove that no *third*
 * display-authenticated route exists — a runtime check has no view of the source tree once the
 * application is built. That half is proved by a test that scans the repository for callers of
 * `displays.authenticate`, and the detail below says so rather than implying more than it did.
 */
export async function checkDisplayReadOnly(): Promise<SurfaceVerdict> {
  const modules: Record<string, unknown>[] = [
    (await import('@/app/api/display/route')) as unknown as Record<string, unknown>,
    (await import('@/app/api/display/session/route')) as unknown as Record<string, unknown>,
  ];

  const found: string[] = [];
  for (const [index, entry] of DISPLAY_ROUTE_INVENTORY.entries()) {
    const routeModule = modules[index] ?? {};
    const exported = HTTP_METHODS.filter((method) => typeof routeModule[method] === 'function');
    const extra = exported.filter((method) => !entry.allowed.includes(method));
    if (extra.length > 0) {
      return {
        ok: false,
        detail: `${entry.path} answers ${extra.join(', ')}, which is more than a wallboard may do.`,
        evidence: { route: entry.path, unexpected: extra.join(', ') },
      };
    }
    found.push(`${entry.path}: ${exported.join('+')}`);
  }

  return {
    ok: true,
    detail:
      'The two display-authenticated routes answer only the methods they are meant to: a read, and starting or ending the display’s own session. That no third such route exists is asserted by the test suite, which scans for callers.',
    evidence: { routes: found.join('; ') },
  };
}
