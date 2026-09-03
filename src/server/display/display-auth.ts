import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ForbiddenError, UnauthorizedError } from '@/domain/errors';
import {
  DISPLAY_COOKIE_NAME,
  DISPLAY_TOKEN_PREFIX,
  isDisplayDeviceUsable,
  parseDisplayToken,
  type DisplayDevice,
  type DisplayDeviceCreateInput,
} from '@/domain/display-device';
import type { DisplayDeviceRepository } from '../repositories/factory-types';

/**
 * Display-device credentials.
 *
 * Identical discipline to worker enrolment, and for identical reasons: the secret is generated
 * here, shown once, stored only as a SHA-256 hash, compared in constant time, and checked for
 * revocation on **every** request rather than at pairing. A wallboard hangs on a wall for months;
 * a credential that could not be withdrawn instantly would be a standing invitation.
 *
 * What differs from a worker token is the size of what it unlocks. A worker token can claim work
 * and report state. A display token can fetch one sanitised summary, and there is no display
 * endpoint that changes anything — so there is no display action to escalate into.
 */

export interface IssuedDisplayToken {
  readonly device: DisplayDevice;
  /** Shown exactly once. Never stored, never logged, never returned again. */
  readonly token: string;
}

function hashToken(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Constant-time comparison that also survives a length mismatch. */
function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class DisplayAuth {
  constructor(private readonly devices: DisplayDeviceRepository) {}

  /**
   * Pair a new display.
   *
   * The device id is inside the token so lookup is a primary-key read rather than a scan over
   * every device's hash — the same shape as a worker token, and the reason both can be checked
   * without a timing signal that depends on how many devices exist.
   */
  async pair(input: DisplayDeviceCreateInput): Promise<IssuedDisplayToken> {
    /*
     * The id is generated here rather than by the database, because the id is *part of the token*
     * and the token has to exist before the row that stores its hash. Generating it first makes
     * pairing one insert; letting the database assign it would mean writing a row, reading it
     * back and updating it — three chances for a half-paired device to exist.
     */
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const device = await this.devices.create({
      id,
      name: input.name,
      location: input.location ?? null,
      tokenHash: hashToken(secret),
      tokenPrefix: `${DISPLAY_TOKEN_PREFIX}${id.slice(0, 8)}`,
      scopes: input.scopes,
      rotationSeconds: input.rotationSeconds,
      expiresAt: input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60_000)
        : null,
    });
    return { device, token: `${DISPLAY_TOKEN_PREFIX}${id}.${secret}` };
  }

  /**
   * Authenticate a request from a display.
   *
   * Every failure returns the same unauthorised error with the same message. A display that says
   * "that device was revoked" tells whoever is holding a stale token something they should have
   * to find out some other way.
   */
  async authenticate(
    token: string | null | undefined,
    context: { userAgent?: string | null } = {},
  ): Promise<DisplayDevice> {
    if (!token) throw new UnauthorizedError('This display is not paired.');
    const parsed = parseDisplayToken(token);
    if (!parsed) throw new UnauthorizedError('This display is not paired.');

    const record = await this.devices.findAuthRecord(parsed.deviceId);
    if (!record) throw new UnauthorizedError('This display is not paired.');
    if (!sameHash(record.tokenHash, hashToken(parsed.secret))) {
      throw new UnauthorizedError('This display is not paired.');
    }
    if (!isDisplayDeviceUsable(record, new Date().toISOString())) {
      throw new UnauthorizedError('This display is not paired.');
    }

    const device = await this.devices.findById(parsed.deviceId);
    if (!device) throw new UnauthorizedError('This display is not paired.');
    await this.devices.touch(device.id, context.userAgent ?? null);
    return device;
  }

  async list(): Promise<readonly DisplayDevice[]> {
    return this.devices.list();
  }

  async revoke(id: string, reason: string | null): Promise<DisplayDevice> {
    return this.devices.revoke(id, reason);
  }

  /**
   * Refuse anything that is not a read.
   *
   * Defensive: the display routes are all `GET` and none of them mutates, so this should never
   * fire. It exists because "there are no display write endpoints" is a property that has to stay
   * true as the surface grows, and a runtime assertion is how it stays true rather than how it
   * was true when it was written.
   */
  assertReadOnly(method: string): void {
    if (method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') {
      throw new ForbiddenError('A display can only read. It has no controls at all.');
    }
  }
}

export { DISPLAY_COOKIE_NAME };
