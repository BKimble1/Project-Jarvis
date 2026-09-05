import { createHash } from 'node:crypto';
import { ForbiddenError, NotFoundError, ValidationError } from '@/domain/errors';
import {
  playbookMaterialContent,
  validatePlaybook,
  type PlaybookDefinition,
  type Playbook,
  type PlaybookVersion,
} from '@/domain/playbook';
import type { PlaybookRepository } from '../repositories/factory-types';
import { BUILT_IN_PLAYBOOKS } from './built-in';

/**
 * Installing, versioning and seeding playbooks.
 *
 * The rule this service exists to enforce is the one from §18 that is easy to state and easy to
 * lose: *an agent may recommend a playbook; it may never install, modify or activate one.* There
 * is no worker-authenticated route into any method here — every entry point is owner-session
 * only — and `install` re-validates the definition rather than trusting whatever produced it.
 *
 * Seeding is idempotent by fingerprint: restarting Jarvis does not add a version, and editing a
 * built-in produces version *n+1* rather than mutating what a running mission is following.
 */

export interface PlaybookServiceDeps {
  readonly playbooks: PlaybookRepository;
  readonly clock?: () => Date;
}

function fingerprint(definition: PlaybookDefinition): string {
  return createHash('sha256').update(playbookMaterialContent(definition)).digest('hex');
}

export class PlaybookService {
  /** One seed per process, remembered as the promise so concurrent readers share it. */
  private seeding: Promise<void> | null = null;

  constructor(private readonly deps: PlaybookServiceDeps) {}

  /**
   * Make sure the built-ins exist before anyone reads the list.
   *
   * Seeding is on the read path rather than at server startup, and that is a deliberate second
   * choice: `instrumentation.ts` is the natural home for it, but Next.js builds that file for the
   * edge runtime as well as for Node, and following the import into the database client breaks the
   * build. Doing it here costs one guarded pass per process, is idempotent by fingerprint, and
   * keeps the database out of the bundler's graph entirely.
   *
   * A failure is swallowed. A database that is not ready is not a reason for the playbooks page to
   * 500 — `seedBuiltIns` logs what it rejected, and the next read tries again.
   */
  private async ensureSeeded(): Promise<void> {
    this.seeding ??= this.seedBuiltIns().then(
      () => undefined,
      () => {
        /* Allow a later read to retry rather than caching the failure forever. */
        this.seeding = null;
      },
    );
    await this.seeding;
  }

  /**
   * Put the built-ins in place.
   *
   * Called on boot. A definition that fails its own validator is skipped loudly rather than
   * installed: shipping a playbook Jarvis would refuse to run is a bug worth seeing, and
   * installing it anyway would mean the validator is advisory.
   */
  async seedBuiltIns(): Promise<{
    installed: number;
    unchanged: number;
    rejected: readonly string[];
  }> {
    let installed = 0;
    let unchanged = 0;
    const rejected: string[] = [];

    for (const definition of BUILT_IN_PLAYBOOKS) {
      const check = validatePlaybook(definition);
      if (!check.ok) {
        rejected.push(`${definition.key}: ${check.violations.map((v) => v.rule).join(', ')}`);
        continue;
      }
      const result = await this.deps.playbooks.install({
        definition,
        fingerprint: fingerprint(definition),
        builtIn: true,
        createdBy: 'system',
        note: 'Shipped with Jarvis.',
      });
      if (result.created) installed += 1;
      else unchanged += 1;
    }
    return { installed, unchanged, rejected };
  }

  async list(): Promise<readonly (Playbook & { definition: PlaybookDefinition })[]> {
    await this.ensureSeeded();
    return this.deps.playbooks.list();
  }

  async listVersions(key: string): Promise<readonly PlaybookVersion[]> {
    return this.deps.playbooks.listVersions(key);
  }

  async preview(key: string, version?: number): Promise<PlaybookVersion> {
    await this.ensureSeeded();
    const found = version
      ? await this.deps.playbooks.version(key, version)
      : await this.deps.playbooks.latestVersion(key);
    if (!found) throw new NotFoundError('Playbook version');
    return found;
  }

  /**
   * Install or update a playbook from an owner.
   *
   * Re-validated here rather than at the route so every caller gets the check — including a test
   * that reaches the service directly, which is exactly the caller most likely to be the one that
   * would otherwise slip something past.
   */
  async install(
    definition: PlaybookDefinition,
    createdBy: string,
    note?: string | null,
  ): Promise<{ playbook: Playbook; version: PlaybookVersion; created: boolean }> {
    const check = validatePlaybook(definition);
    if (!check.ok) {
      throw new ValidationError('Jarvis will not install a playbook it would refuse to run.', {
        violations: check.violations.slice(0, 8),
      });
    }
    return this.deps.playbooks.install({
      definition,
      fingerprint: fingerprint(definition),
      builtIn: false,
      createdBy,
      note: note ?? null,
    });
  }

  async setEnabled(key: string, enabled: boolean): Promise<Playbook> {
    const existing = await this.deps.playbooks.findByKey(key);
    if (!existing) throw new NotFoundError('Playbook');
    return this.deps.playbooks.setEnabled(key, enabled);
  }

  /** A running mission follows a pinned version, so a disabled playbook stops *new* runs only. */
  async requireRunnable(key: string, version: number): Promise<PlaybookVersion> {
    const playbook = await this.deps.playbooks.findByKey(key);
    if (!playbook) throw new NotFoundError('Playbook');
    if (!playbook.enabled) throw new ForbiddenError('That playbook is switched off.');
    const found = await this.deps.playbooks.version(key, version);
    if (!found) throw new NotFoundError('Playbook version');
    return found;
  }

  /** Exportable, so a playbook can be reviewed, kept in git or moved between instances. */
  async export(key: string): Promise<{ definition: PlaybookDefinition; version: number }> {
    const latest = await this.deps.playbooks.latestVersion(key);
    if (!latest) throw new NotFoundError('Playbook');
    return { definition: latest.definition, version: latest.version };
  }
}
