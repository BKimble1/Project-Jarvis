import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '@/worker/git';

/**
 * A local git repository to run missions against.
 *
 * Created fresh under the OS temp directory for each test and deleted afterwards. **No test in
 * this suite ever touches a real repository**: the "remote" is a bare repository on the same
 * disk, so a push is a real `git push` with a real refspec and real refusals, but nothing leaves
 * the machine.
 */

export interface SandboxRepo {
  /** Path to the bare repository the worker pushes to — its `origin`. */
  readonly remotePath: string;
  /** A working clone, used to inspect what a push actually did. */
  readonly inspectPath: string;
  readonly defaultBranch: string;
  readonly root: string;
  branches(): Promise<readonly string[]>;
  fileOnBranch(branch: string, file: string): Promise<string | null>;
  headOf(branch: string): Promise<string | null>;
  cleanup(): Promise<void>;
}

export async function createSandboxRepo(
  files: Record<string, string> = { 'README.md': '# Sandbox\n\nA repository for tests.\n' },
): Promise<SandboxRepo> {
  const root = await mkdtemp(path.join(tmpdir(), 'jarvis-sandbox-'));
  const seedPath = path.join(root, 'seed');
  const remotePath = path.join(root, 'remote.git');
  const inspectPath = path.join(root, 'inspect');

  await git(['clone', '--bare', '--quiet', await createSeed(seedPath, files), remotePath], {
    cwd: root,
  });
  await git(['clone', '--quiet', remotePath, inspectPath], { cwd: root });

  return {
    root,
    remotePath,
    inspectPath,
    defaultBranch: 'main',

    async branches() {
      const result = await git(['branch', '--list', '--format=%(refname:short)'], {
        cwd: remotePath,
      });
      return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    },

    async fileOnBranch(branch: string, file: string) {
      try {
        const result = await git(['show', `${branch}:${file}`], { cwd: remotePath });
        return result.stdout;
      } catch {
        return null;
      }
    },

    async headOf(branch: string) {
      try {
        const result = await git(['rev-parse', branch], { cwd: remotePath });
        return result.stdout.trim();
      } catch {
        return null;
      }
    },

    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function createSeed(seedPath: string, files: Record<string, string>): Promise<string> {
  await git(['init', '--quiet', '--initial-branch=main', seedPath], { cwd: path.dirname(seedPath) })
    /* `git init <path>` is not in the worker's allow-list, so fall back to mkdir + init. */
    .catch(async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(seedPath, { recursive: true });
      await runInit(seedPath);
    });

  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(seedPath, name), content, 'utf8');
  }
  await git(['add', '--all'], { cwd: seedPath });
  await git(['commit', '--quiet', '--message', 'Initial commit'], { cwd: seedPath });
  return seedPath;
}

/** `git init` is deliberately outside the worker's allow-list, so tests shell out directly. */
async function runInit(cwd: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['init', '--quiet', '--initial-branch=main', '.'], {
      cwd,
      stdio: 'ignore',
    });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git init ${code}`))));
    child.on('error', reject);
  });
}
