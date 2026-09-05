import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { filesOutsideWriteSet } from '@/domain/write-set';
import { changedFilesForScope, git } from '@/worker/git';
import { createSandboxRepo, type SandboxRepo } from '../helpers/sandbox-repo';

/**
 * The write-set boundary against a real git repository.
 *
 * The boundary is only as good as the question it asks git, and the obvious question is wrong.
 * `git status` sees the working tree and the index — so an agent that committed its work would
 * have presented a clean tree, and a check built on `status` alone would have found nothing to
 * object to. The agent is deliberately allowed to run `git commit`; refusing it would break
 * ordinary work. So these run real commits, real renames and real awkward filenames through the
 * real helper, because every one of these failures is a failure of git's output format rather than
 * of the containment logic, and containment is unit-tested elsewhere.
 */

describe('what the write-set check can actually see', () => {
  let sandbox: SandboxRepo;
  let repo: string;
  let options: { cwd: string; credentialToken: null };
  let baseSha: string;

  beforeEach(async () => {
    sandbox = await createSandboxRepo({
      'README.md': '# Sandbox\n',
      'src/allowed.ts': 'export const allowed = 1;\n',
      'secrets/keys.ts': 'export const key = "old";\n',
    });
    const root = await mkdtemp(path.join(tmpdir(), 'jarvis-scope-'));
    repo = path.join(root, 'work');
    await git(['clone', '--quiet', sandbox.remotePath, repo], { cwd: root });
    options = { cwd: repo, credentialToken: null };
    await git(['config', 'user.email', 'test@example.com'], options);
    await git(['config', 'user.name', 'Test'], options);
    baseSha = (await git(['rev-parse', 'HEAD'], options)).stdout.trim();
  });

  afterEach(async () => {
    await rm(path.dirname(repo), { recursive: true, force: true });
    await sandbox.cleanup();
  });

  const commitAll = async (message: string): Promise<void> => {
    await git(['add', '-A'], options);
    await git(['commit', '-m', message], options);
  };

  it('sees a change the agent already committed', async () => {
    await writeFile(path.join(repo, 'secrets/keys.ts'), 'export const key = "new";\n');
    await commitAll('quietly widen my own scope');

    /* The tree is clean, so the naive question finds nothing at all. */
    expect(await changedFilesForScope(options)).toEqual([]);

    const changed = await changedFilesForScope(options, baseSha);
    expect(changed).toContain('secrets/keys.ts');
    expect(filesOutsideWriteSet(['src/'], changed)).toEqual(['secrets/keys.ts']);
  });

  it('sees both ends of a committed rename', async () => {
    await git(['mv', 'src/allowed.ts', 'secrets/allowed.ts'], options).catch(async () => {
      /* `git mv` is not on the worker's allow-list; do it the long way. */
      await writeFile(path.join(repo, 'secrets/allowed.ts'), 'export const allowed = 1;\n');
      await rm(path.join(repo, 'src/allowed.ts'));
    });
    await commitAll('move a file out of scope');

    const changed = await changedFilesForScope(options, baseSha);
    expect(changed).toContain('src/allowed.ts');
    expect(changed).toContain('secrets/allowed.ts');
    /*
     * The point of asking git not to detect renames. Reported as one entry, a rename passes
     * containment whenever the *old* path is inside the write set — so a task could move a file
     * anywhere it liked and the boundary would agree.
     */
    expect(filesOutsideWriteSet(['src/'], changed)).toEqual(['secrets/allowed.ts']);
  });

  it('sees committed and uncommitted work together, without repeating either', async () => {
    await writeFile(path.join(repo, 'secrets/keys.ts'), 'export const key = "new";\n');
    await commitAll('committed');
    await writeFile(path.join(repo, 'secrets/keys.ts'), 'export const key = "newer";\n');
    await writeFile(path.join(repo, 'src/extra.ts'), 'export const extra = 1;\n');

    const changed = await changedFilesForScope(options, baseSha);
    expect(changed.filter((file) => file === 'secrets/keys.ts')).toHaveLength(1);
    expect(new Set(changed)).toEqual(new Set(['secrets/keys.ts', 'src/extra.ts']));
  });

  it('does not mangle a path with a space in it', async () => {
    await writeFile(path.join(repo, 'src/my file.ts'), 'export const spaced = 1;\n');

    /*
     * Without `-z`, git C-quotes this to `"src/my file.ts"`, which fails containment against a
     * write set that legitimately covers it — a boundary that refuses work it should allow gets
     * switched off by whoever is on call.
     */
    const changed = await changedFilesForScope(options, baseSha);
    expect(changed).toContain('src/my file.ts');
    expect(filesOutsideWriteSet(['src/'], changed)).toEqual([]);
  });
});
