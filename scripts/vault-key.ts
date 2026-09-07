import { randomBytes } from 'node:crypto';

/**
 * Generate a credential encryption key.
 *
 * Prints one value and nothing else — no banner, no timestamp, no "generated key:" prefix — so it
 * can be piped straight into a file without a shell dance, and so nothing decorative ends up in a
 * terminal scrollback that gets pasted somewhere. The key is never written to disk here; where it
 * goes is the owner's decision, documented in docs/PERSONAL_ASSISTANT_SETUP.md.
 */
process.stdout.write(`${randomBytes(32).toString('base64')}\n`);
