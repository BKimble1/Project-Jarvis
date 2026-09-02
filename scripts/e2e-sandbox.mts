#!/usr/bin/env tsx
/**
 * Creates the sandbox repository the end-to-end mission smoke test runs against.
 *
 * A bare git repository under `.jarvis-data/e2e-sandbox`, seeded with a README. It is local, it
 * is recreated from scratch on every run, and **it is the only repository the smoke test can
 * reach**: the worker is started with `JARVIS_WORKER_SANDBOX_REPOS` pointing the mission's
 * repository at this path, so a mission cannot touch anything real even if it tried.
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.cwd(), '.jarvis-data/e2e-sandbox');
const seedPath = path.join(root, 'seed');
export const remotePath = path.join(root, 'remote.git');

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Jarvis Sandbox',
        GIT_AUTHOR_EMAIL: 'sandbox@localhost',
        GIT_COMMITTER_NAME: 'Jarvis Sandbox',
        GIT_COMMITTER_EMAIL: 'sandbox@localhost',
      },
    });
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)),
    );
    child.on('error', reject);
  });
}

async function main(): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(seedPath, { recursive: true });

  await run('git', ['init', '--quiet', '--initial-branch=main', '.'], seedPath);
  await writeFile(
    path.join(seedPath, 'README.md'),
    '# Sandbox\n\nA throwaway repository for Jarvis end-to-end tests.\n',
    'utf8',
  );
  await writeFile(
    path.join(seedPath, 'package.json'),
    `${JSON.stringify(
      {
        name: 'jarvis-e2e-sandbox',
        private: true,
        version: '0.0.0',
        scripts: {
          /* Something real for verification discovery to find, that passes without a toolchain. */
          test: 'node -e "process.exit(0)"',
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await run('git', ['add', '--all'], seedPath);
  await run('git', ['commit', '--quiet', '--message', 'Initial commit'], seedPath);

  await run('git', ['clone', '--bare', '--quiet', seedPath, remotePath], root);
  /* A bare repository refuses a push to its own checked-out branch without this. */
  await run('git', ['config', 'receive.denyCurrentBranch', 'ignore'], remotePath);

  console.log(`e2e sandbox repository ready at ${remotePath}`);
}

await main();
