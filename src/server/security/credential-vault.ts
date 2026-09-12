import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConfigurationError } from '@/domain/errors';

/**
 * Where provider credentials live at rest.
 *
 * ## Why not a column
 *
 * Because a refresh token in a text column is a refresh token in every database backup, every
 * `pg_dump` somebody pastes into a chat window, every screenshot of a table, and every debugging
 * session that does `select * from connections`. Encrypting at the boundary means the value only
 * exists in plaintext inside the process that is about to send it to the provider.
 *
 * ## Authenticated, and bound to where it came from
 *
 * AES-256-GCM, so ciphertext that has been altered fails to open rather than decrypting into
 * something. The `aad` argument is the other half: a sealed value carries the identity of the row
 * and field it belongs to, so a ciphertext copied from one connection's refresh token into
 * another's — by a bug, a bad migration, or somebody with write access to the table — will not
 * open. Confidentiality without binding would leave the store shuffleable.
 *
 * ## Its own key, versioned
 *
 * Separate from `SESSION_SECRET` on purpose: those two have different blast radii and different
 * rotation schedules, and one value used for both means rotating either one logs everybody out or
 * destroys every stored credential. Each record remembers the key version that sealed it, so a
 * rotation can decrypt old records with the previous key while writing new ones with the current.
 *
 * ## What it deliberately does not do
 *
 * Log. Not the key, not the plaintext, not the ciphertext, and not a "key loaded" line carrying a
 * fingerprint — every one of those has been the way a secret reached a log file. Failures throw
 * with a message that names the *field*, never the value.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface SealedCredential {
  readonly algorithm: typeof ALGORITHM;
  /** Which key sealed this. Lets a rotation read old records without rewriting them all at once. */
  readonly keyVersion: number;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

export interface CredentialVault {
  /** False when no key is configured. Connecting a provider is refused rather than stored badly. */
  isConfigured(): boolean;
  readonly activeKeyVersion: number;
  seal(plaintext: string, aad: string): SealedCredential;
  open(sealed: SealedCredential, aad: string): string;
}

interface VaultKey {
  readonly version: number;
  readonly material: Buffer;
}

function decodeKey(value: string, name: string): Buffer {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value.trim(), 'base64');
  } catch {
    throw new ConfigurationError(`${name} is not valid base64.`);
  }
  if (decoded.length !== KEY_BYTES) {
    /* The length is stated; the value never is. */
    throw new ConfigurationError(
      `${name} must decode to exactly ${KEY_BYTES} bytes (got ${decoded.length}). Generate one with: npm run vault:key`,
    );
  }
  return decoded;
}

export interface VaultKeyConfig {
  readonly active: string | null;
  readonly previous: string | null;
  readonly activeVersion: number;
}

/**
 * The vault that actually encrypts.
 *
 * Constructed from configuration rather than reading the environment itself, so a test can supply
 * a key without one existing anywhere on disk and production has exactly one place where the key
 * is read.
 */
export class AesCredentialVault implements CredentialVault {
  private readonly keys: readonly VaultKey[];
  readonly activeKeyVersion: number;

  constructor(config: VaultKeyConfig) {
    const keys: VaultKey[] = [];
    if (config.active) {
      keys.push({
        version: config.activeVersion,
        material: decodeKey(config.active, 'JARVIS_CREDENTIAL_KEY'),
      });
    }
    if (config.previous) {
      keys.push({
        version: config.activeVersion - 1,
        material: decodeKey(config.previous, 'JARVIS_CREDENTIAL_KEY_PREVIOUS'),
      });
    }
    this.keys = keys;
    this.activeKeyVersion = config.activeVersion;
  }

  isConfigured(): boolean {
    return this.keys.some((key) => key.version === this.activeKeyVersion);
  }

  seal(plaintext: string, aad: string): SealedCredential {
    const key = this.keyFor(this.activeKeyVersion);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key.material, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      algorithm: ALGORITHM,
      keyVersion: key.version,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  open(sealed: SealedCredential, aad: string): string {
    if (sealed.algorithm !== ALGORITHM) {
      throw new ConfigurationError(
        'This stored credential uses an algorithm Jarvis does not read.',
      );
    }
    const key = this.keyFor(sealed.keyVersion);
    const decipher = createDecipheriv(ALGORITHM, key.material, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    /*
     * A wrong key, a tampered ciphertext, or a value moved between fields all land here as a
     * throw from `final()`. None of them is distinguishable from the others, which is correct:
     * telling a caller *which* kind of failure it was is how a padding oracle starts.
     */
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  private keyFor(version: number): VaultKey {
    const found = this.keys.find((key) => key.version === version);
    if (!found) {
      throw new ConfigurationError(
        this.keys.length === 0
          ? 'No credential encryption key is configured, so Jarvis cannot read or store provider credentials. See docs/PERSONAL_ASSISTANT_SETUP.md.'
          : `This credential was sealed with key version ${version}, which is not configured. Restore JARVIS_CREDENTIAL_KEY_PREVIOUS or reconnect the provider.`,
      );
    }
    return found;
  }
}

/**
 * The vault when no key is configured.
 *
 * Every operation throws. It exists so that "unconfigured" is a first-class state the connection
 * screen can report honestly, rather than a null check that some path forgets and a plaintext
 * token that reaches the database because of it.
 */
export class UnconfiguredCredentialVault implements CredentialVault {
  readonly activeKeyVersion = 0;

  isConfigured(): boolean {
    return false;
  }

  seal(): never {
    throw new ConfigurationError(
      'No credential encryption key is configured, so Jarvis will not store a provider credential. Set JARVIS_CREDENTIAL_KEY — see docs/PERSONAL_ASSISTANT_SETUP.md.',
    );
  }

  open(): never {
    throw new ConfigurationError(
      'No credential encryption key is configured, so Jarvis cannot read stored provider credentials.',
    );
  }
}

/** Constant-time comparison for OAuth `state`, so a compare cannot be timed. */
export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
