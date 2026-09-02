import type { AppConfig } from '@/server/config/env';

/**
 * Single-owner authorisation.
 *
 * Jarvis is a private tool for exactly one person. A successful GitHub login proves *who* someone
 * is; this function decides whether that person is the owner. Everyone else is rejected, and the
 * rejection is deliberately uninformative — a stranger learns nothing about who the owner is.
 */
export interface GithubIdentity {
  readonly login: string;
  readonly id: number | string;
  readonly name?: string | null;
  readonly avatarUrl?: string | null;
}

export interface OwnershipDecision {
  readonly allowed: boolean;
  readonly reason:
    'ok' | 'no_owner_configured' | 'login_mismatch' | 'id_mismatch' | 'missing_identity';
}

export function isOwner(identity: GithubIdentity | null, config: AppConfig): OwnershipDecision {
  if (!identity || !identity.login) return { allowed: false, reason: 'missing_identity' };

  const expectedLogin = config.owner.githubLogin;
  const expectedId = config.owner.githubUserId;

  /* Fail closed: with no configured owner, nobody is the owner. */
  if (!expectedLogin && !expectedId) return { allowed: false, reason: 'no_owner_configured' };

  /* When an id is configured it is authoritative: logins can be renamed and reused, ids cannot. */
  if (expectedId) {
    if (String(identity.id) !== expectedId) return { allowed: false, reason: 'id_mismatch' };
    if (expectedLogin && identity.login.toLowerCase() !== expectedLogin) {
      return { allowed: false, reason: 'login_mismatch' };
    }
    return { allowed: true, reason: 'ok' };
  }

  if (identity.login.toLowerCase() !== expectedLogin)
    return { allowed: false, reason: 'login_mismatch' };
  return { allowed: true, reason: 'ok' };
}
