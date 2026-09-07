import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  AesCredentialVault,
  UnconfiguredCredentialVault,
  safeEquals,
} from '@/server/security/credential-vault';

/**
 * The store that holds other people's access to Blake's mail and calendar.
 *
 * The interesting assertions are the negative ones. Encryption that works is table stakes;
 * encryption that fails *closed* when the ciphertext has been altered, when the key is wrong, or
 * when a value has been moved from one field to another is what makes the store trustworthy.
 */

const key = () => randomBytes(32).toString('base64');
const vault = (over: Partial<{ active: string; previous: string; activeVersion: number }> = {}) =>
  new AesCredentialVault({
    active: over.active ?? key(),
    previous: over.previous ?? null,
    activeVersion: over.activeVersion ?? 1,
  });

describe('sealing a credential', () => {
  it('round-trips through the same key and purpose', () => {
    const v = vault();
    const sealed = v.seal('refresh-token-value', 'connection:abc:refresh');
    expect(v.open(sealed, 'connection:abc:refresh')).toBe('refresh-token-value');
  });

  it('never stores the plaintext anywhere in the sealed record', () => {
    const v = vault();
    const sealed = v.seal('sk-super-secret-value', 'connection:abc:refresh');
    expect(JSON.stringify(sealed)).not.toContain('sk-super-secret-value');
  });

  it('produces different ciphertext each time, so equal values are not linkable', () => {
    const v = vault();
    const a = v.seal('same', 'connection:abc:refresh');
    const b = v.seal('same', 'connection:abc:refresh');
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });

  it('records the key version that sealed it', () => {
    const v = vault({ activeVersion: 3 });
    expect(v.seal('x', 'p').keyVersion).toBe(3);
  });
});

describe('failing closed', () => {
  it('refuses a ciphertext that has been altered', () => {
    const v = vault();
    const sealed = v.seal('refresh-token-value', 'connection:abc:refresh');
    const tampered = { ...sealed, ciphertext: Buffer.from('nonsense').toString('base64') };
    expect(() => v.open(tampered, 'connection:abc:refresh')).toThrow();
  });

  it('refuses a tag that has been altered', () => {
    const v = vault();
    const sealed = v.seal('refresh-token-value', 'connection:abc:refresh');
    const tampered = { ...sealed, tag: Buffer.alloc(16).toString('base64') };
    expect(() => v.open(tampered, 'connection:abc:refresh')).toThrow();
  });

  it('refuses a value moved to a different field or connection', () => {
    /*
     * The property the AAD exists for. A refresh token copied into another row — by a bug or by
     * somebody with write access to the table — must not open there.
     */
    const v = vault();
    const sealed = v.seal('refresh-token-value', 'connection:abc:refresh');
    expect(() => v.open(sealed, 'connection:abc:access')).toThrow();
    expect(() => v.open(sealed, 'connection:xyz:refresh')).toThrow();
  });

  it('refuses a credential sealed with a different key', () => {
    const sealed = vault().seal('refresh-token-value', 'connection:abc:refresh');
    expect(() => vault().open(sealed, 'connection:abc:refresh')).toThrow();
  });

  it('says which key version is missing rather than failing silently', () => {
    const v = vault({ activeVersion: 1 });
    const sealed = v.seal('x', 'p');
    const rotated = { ...sealed, keyVersion: 9 };
    expect(() => v.open(rotated, 'p')).toThrow(/key version 9/);
  });
});

describe('rotating the key', () => {
  it('reads records sealed by the previous key and writes with the current one', () => {
    const oldKey = key();
    const before = new AesCredentialVault({ active: oldKey, previous: null, activeVersion: 1 });
    const sealedOld = before.seal('older-token', 'connection:abc:refresh');

    const after = new AesCredentialVault({ active: key(), previous: oldKey, activeVersion: 2 });
    expect(after.open(sealedOld, 'connection:abc:refresh')).toBe('older-token');
    expect(after.seal('newer-token', 'connection:abc:refresh').keyVersion).toBe(2);
  });
});

describe('a key that is not usable', () => {
  it('refuses a key of the wrong length, and names the variable rather than the value', () => {
    expect(
      () =>
        new AesCredentialVault({
          active: Buffer.alloc(8).toString('base64'),
          previous: null,
          activeVersion: 1,
        }),
    ).toThrow(/JARVIS_CREDENTIAL_KEY must decode to exactly 32 bytes/);
  });

  it('treats no key as a first-class state instead of storing anything', () => {
    const v = new UnconfiguredCredentialVault();
    expect(v.isConfigured()).toBe(false);
    expect(() => v.seal()).toThrow(/will not store a provider credential/);
    expect(() => v.open()).toThrow(/cannot read stored provider credentials/);
  });
});

describe('comparing an OAuth state value', () => {
  it('matches equal values and rejects unequal ones of every length', () => {
    expect(safeEquals('abc123', 'abc123')).toBe(true);
    expect(safeEquals('abc123', 'abc124')).toBe(false);
    expect(safeEquals('abc123', 'abc1234')).toBe(false);
    expect(safeEquals('', '')).toBe(true);
  });
});
