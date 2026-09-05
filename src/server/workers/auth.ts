import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ForbiddenError, UnauthorizedError, ValidationError } from '@/domain/errors';
import type { WorkerRepository } from '@/server/repositories/mission-types';

/**
 * Worker authentication.
 *
 * A worker presents `Authorization: Bearer jarvisw_<workerId>.<secret>`. The control plane splits
 * it, looks the worker up by id, and compares SHA-256 of the secret against the stored hash in
 * constant time. That is the whole mechanism — no signed envelopes, no clock-skew windows, no
 * undocumented header. Rotation replaces the hash; revocation is a row update checked on every
 * single request rather than cached.
 *
 * Worker credentials are deliberately unrelated to owner sessions: a stolen worker token cannot
 * read a project, and a stolen browser cookie cannot claim a mission.
 */

export const WORKER_TOKEN_PREFIX = 'jarvisw_';
const SECRET_BYTES = 32;

export interface ParsedWorkerToken {
  readonly workerId: string;
  readonly secret: string;
}

/** `jarvisw_<uuid>.<base64url secret>` */
export function issueWorkerToken(workerId: string): {
  token: string;
  hash: string;
  prefix: string;
} {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const token = `${WORKER_TOKEN_PREFIX}${workerId}.${secret}`;
  return {
    token,
    hash: hashWorkerSecret(secret),
    /* Shown in the UI so the owner can tell two workers apart; useless on its own. */
    prefix: `${WORKER_TOKEN_PREFIX}${workerId.slice(0, 8)}`,
  };
}

export function hashWorkerSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function parseWorkerToken(raw: string): ParsedWorkerToken | null {
  if (!raw.startsWith(WORKER_TOKEN_PREFIX)) return null;
  const body = raw.slice(WORKER_TOKEN_PREFIX.length);
  const separator = body.indexOf('.');
  if (separator <= 0) return null;
  const workerId = body.slice(0, separator);
  const secret = body.slice(separator + 1);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(workerId)) return null;
  if (secret.length < 20 || secret.length > 200) return null;
  return { workerId, secret };
}

/** Constant-time comparison of two hex digests. */
export function safeHashEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function extractBearer(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/**
 * Authenticate a worker request.
 *
 * Throws `UnauthorizedError` for anything that is not a valid credential and `ForbiddenError`
 * for a credential that *is* valid but belongs to a revoked worker — the distinction matters
 * because only the second one tells the worker to stop retrying and shut down.
 */
export async function authenticateWorker(
  request: Request,
  repository: WorkerRepository,
): Promise<{ workerId: string }> {
  const raw = extractBearer(request);
  if (!raw) throw new UnauthorizedError('A worker credential is required.');

  const parsed = parseWorkerToken(raw);
  if (!parsed) throw new UnauthorizedError('That worker credential is malformed.');

  const record = await repository.findAuthRecord(parsed.workerId);
  if (!record) throw new UnauthorizedError('That worker is not enrolled.');

  if (!safeHashEqual(record.tokenHash, hashWorkerSecret(parsed.secret))) {
    throw new UnauthorizedError('That worker credential is not valid.');
  }
  if (record.revokedAt) {
    throw new ForbiddenError('This worker has been revoked. Stop and remove its credential.');
  }
  return { workerId: record.id };
}

/* ------------------------------------------------------------ idempotency */

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_TTL_HOURS = 24;

export function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get(IDEMPOTENCY_HEADER)?.trim();
  if (!key) {
    throw new ValidationError(
      `This endpoint needs an ${IDEMPOTENCY_HEADER} header so a retry cannot apply twice.`,
    );
  }
  if (key.length < 8 || key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new ValidationError('That idempotency key is not in an acceptable format.');
  }
  return key;
}

/** A stable hash of the request body, so the same key with a different body is a conflict. */
export function hashRequestBody(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value ?? null), 'utf8')
    .digest('hex');
}
