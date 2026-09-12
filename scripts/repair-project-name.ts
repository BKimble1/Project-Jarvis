#!/usr/bin/env tsx
/**
 * Rename a project Jarvis named badly, and the mission it created with it.
 *
 * ## Why this exists rather than "delete it and try again"
 *
 * Because the thing that went wrong produced real records on somebody's account: a project row, a
 * mission, a source, and a private repository on GitHub. Deleting a repository is not something
 * Jarvis has a method for and not something a script should decide to do; deleting a mission
 * throws away whatever it has already done. So this renames, in place, and refuses rather than
 * guesses whenever renaming would collide with something that already exists.
 *
 * ## What it will not do
 *
 * - Delete anything, ever. Not a project, not a mission, not a repository.
 * - Create anything. If you already have a QuickPick project, this stops and tells you; making a
 *   second one is the failure it is repairing, not the repair.
 * - Rename a repository on GitHub. That is a deliberate act with consequences for anything already
 *   cloned, and the provisioning credential here is scoped to create, not to rename. It prints the
 *   exact steps instead, and `--repository` re-points the source row once you have done it.
 * - Rewrite a mission that has already run. A mission with runs against it has history that its
 *   objective explains; changing the objective underneath that history makes the record a lie.
 *
 * ## Usage
 *
 *     npx tsx scripts/repair-project-name.ts --project="Yet" --name="QuickPick"
 *     npx tsx scripts/repair-project-name.ts --project="Yet" --name="QuickPick" --apply
 *     npx tsx scripts/repair-project-name.ts --project="Yet" --name="QuickPick" \
 *       --repository=BKimble1/quickpick --apply
 *
 * Dry run by default: it prints exactly what it would change and changes nothing. `--apply` is the
 * only thing that writes.
 */
import { loadEnvFiles } from './workspaces';
import { readsLikeAConversation } from '@/domain/build-brief';
import type { Mission } from '@/domain/mission';
import type { Project } from '@/domain/project';
import { repositorySlug } from '@/domain/repository-name';
import { getServices } from '@/server/container';
import { closeDatabase } from '@/server/db/client';

/* Before anything reads the environment: `.env.local`, then `.env`. */
loadEnvFiles();

function argValue(name: string): string | null {
  const flag = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(flag));
  return found ? found.slice(flag.length).replace(/^["']|["']$/g, '') : null;
}

const say = (line = ''): void => console.log(line);

async function main(): Promise<void> {
  const target = argValue('project');
  const wanted = argValue('name');
  const repository = argValue('repository');
  const apply = process.argv.includes('--apply');

  if (!target || !wanted) {
    say('Rename a project Jarvis named badly, without deleting or duplicating anything.');
    say();
    say('  --project=<name or id>   the project as it is now, e.g. "Yet"');
    say('  --name=<name>            what it should be called, e.g. "QuickPick"');
    say('  --repository=<owner/repo>  re-point the source row after you rename it on GitHub');
    say('  --apply                  actually write. Without it, nothing changes.');
    process.exitCode = 1;
    return;
  }

  const services = await getServices();
  const project = await findProject(services, target);
  if (!project) {
    say(`No project matches "${target}". Nothing was changed.`);
    process.exitCode = 1;
    return;
  }

  say(`Project     : ${project.name} (${project.id})`);
  say(`Status      : ${project.status}${project.archivedAt ? ', archived' : ''}`);
  say(`Goal        : ${project.goal ?? '(none)'}`);

  /* ------------------------------------------------------------- collisions */

  const collision = await services.projects.findByName(wanted);
  if (collision && collision.id !== project.id) {
    say();
    say(`STOP: a project called "${wanted}" already exists (${collision.id}).`);
    say('Renaming this one onto that name would give you two projects for one product, which is');
    say('the failure being repaired. Decide which is the real one and move the mission across, or');
    say('pick a different name. Nothing was changed.');
    process.exitCode = 1;
    return;
  }

  /* ------------------------------------------------------- the work already done */

  const missions = await services.missionRepo.listByProject(project.id, 50);
  const sources = await services.sources.listByProject(project.id);

  say();
  say(`Missions    : ${missions.length}`);
  const started: Mission[] = [];
  for (const mission of missions) {
    const runs = await services.missionRuns.list(mission.id);
    const active = runs.length > 0;
    if (active) started.push(mission);
    say(
      `  - ${mission.title} [${mission.state}] ${runs.length} run${runs.length === 1 ? '' : 's'}` +
        `${mission.pullRequestUrl ? ` — ${mission.pullRequestUrl}` : ''}`,
    );
  }

  say(`Sources     : ${sources.length}`);
  for (const source of sources) {
    const where = source.github
      ? `${source.github.owner}/${source.github.repo}`
      : (source.externalUrl ?? '(none)');
    say(`  - ${source.kind} ${where}`);
  }

  /* ------------------------------------------------------------- the repository */

  const oldSlug = repositorySlug(project.name);
  const newSlug = repositorySlug(wanted);
  say();
  say(`Repository  : slug would change from "${oldSlug}" to "${newSlug}".`);
  say('This script never renames a repository on GitHub — that is your decision, and a rename');
  say('breaks any existing clone until it is re-pointed. GitHub keeps a redirect from the old');
  say('name, so the safe order is:');
  say(`  1. On GitHub: Settings → Repository name → "${newSlug}" → Rename.`);
  say(`  2. Re-run this with --repository=<owner>/${newSlug} --apply to re-point the source row.`);
  say('Leaving the repository as it is, is also a perfectly good answer. Nothing depends on the');
  say('name matching.');

  /* ------------------------------------------------------------------- the plan */

  const plan: string[] = [`Rename project "${project.name}" → "${wanted}".`];

  const rewritable = missions.filter(
    (mission) => !started.includes(mission) && readsLikeAConversation(mission.rawRequest),
  );
  for (const mission of rewritable) {
    plan.push(`Retitle mission ${mission.id} → "Build the first version of ${wanted}".`);
  }
  if (started.length > 0) {
    plan.push(
      `Leave ${started.length} mission${started.length === 1 ? '' : 's'} alone: ${started
        .map((mission) => mission.title)
        .join(
          ', ',
        )} — ${started.length === 1 ? 'it has' : 'they have'} already run, and their history explains itself in the words they were given.`,
    );
  }
  if (repository) plan.push(`Re-point the GitHub source row to ${repository}.`);

  say();
  say(apply ? 'Applying:' : 'Would change (dry run — pass --apply to write):');
  for (const line of plan) say(`  - ${line}`);

  if (!apply) {
    say();
    say('Nothing was changed.');
    return;
  }

  /* ---------------------------------------------------------------- the writes */

  await services.projects.update(project.id, { name: wanted });

  for (const mission of rewritable) {
    await services.missionRepo.update(mission.id, {
      title: `Build the first version of ${wanted}`,
    });
  }

  if (repository) {
    const [owner, repo] = repository.split('/');
    if (!owner || !repo) {
      say();
      say(`"--repository=${repository}" is not owner/repo. The source row was left alone.`);
    } else {
      const existing = await services.sources.findGithubSource(owner, repo);
      if (existing && existing.projectId !== project.id) {
        say();
        say(`STOP: ${repository} is already connected to another project. Source row left alone.`);
      } else {
        await services.sources.addGithubSource(project.id, { owner, repo });
        say();
        say(`Source row now points at ${repository}.`);
      }
    }
  }

  say();
  say(`Done. "${wanted}" keeps its id, its missions, its history and its repository.`);
  say('Nothing was deleted and nothing new was created.');
}

/** By id when it looks like one, by name otherwise, and case-insensitively as a last try. */
async function findProject(
  services: Awaited<ReturnType<typeof getServices>>,
  target: string,
): Promise<Project | null> {
  const byId = /^[0-9a-f-]{36}$/i.test(target) ? await services.projects.findById(target) : null;
  if (byId) return byId;

  const byName = await services.projects.findByName(target);
  if (byName) return byName;

  const all = await services.projects.listAllForAssessment(true);
  return all.find((project) => project.name.toLowerCase() === target.toLowerCase()) ?? null;
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    /*
     * `--apply` writes, and this script exits by calling `process.exit`. Killing the process over
     * an open embedded database is not the same as closing it, and the one command whose whole
     * purpose is to repair a row is the last place to find that out.
     */
    await closeDatabase();
  }
  process.exit(process.exitCode ?? 0);
}

void run();
