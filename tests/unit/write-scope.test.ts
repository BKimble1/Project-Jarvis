import { describe, expect, it } from 'vitest';

import {
  WHOLE_REPOSITORY,
  autonomousWriteScopeVerdict,
  filesOutsideWriteSet,
  intersectWriteSet,
  isWholeRepository,
  scopeChangeDelta,
} from '@/domain/write-set';
import { deriveWriteSet } from '@/domain/task-decomposition';
import { evaluateCommand, writeTargetsInCommand } from '@/worker/policy';
import type { MissionPlanContent } from '@/domain/mission-plan';
import type { PolicyContext } from '@/worker/policy';

/**
 * Who is allowed to write where, and whether anything can widen that.
 *
 * The defect these exist for: `deriveWriteSet` falls back to the whole repository when a plan
 * named no path-like areas, and the deterministic planner's only `affectedAreas` entry is the
 * sentence "To be confirmed by inspection before any change is made." That sentence is not a
 * path, so every deterministically planned write mission was granted the entire repository — and
 * with `.` in the set, every downstream check passes everything. The control was on, and it
 * covered nothing.
 */

function plan(overrides: Partial<MissionPlanContent> = {}): MissionPlanContent {
  return {
    summary: 'Improve the readme',
    approach: 'Rewrite the intro',
    scope: ['Rewrite the intro'],
    outOfScope: [],
    affectedAreas: [],
    assumptions: [],
    openQuestions: [],
    risks: [],
    verification: [],
    estimatedComplexity: 'small',
    ...overrides,
  } as unknown as MissionPlanContent;
}

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    workspaceRoot: '/work/m1/repo',
    declaredWriteSet: ['src/app'],
    readOnly: false,
    doNotTouch: [],
    ...overrides,
  } as unknown as PolicyContext;
}

describe('the write set a plan produces', () => {
  it('still widens to the whole repository when a plan names no paths', () => {
    /*
     * Asserted rather than fixed, because it is the honest reading of a plan that named nothing —
     * and the approval screen already says so in words. What must not happen is Jarvis acting on
     * it while nobody is watching, which is the next test.
     */
    expect(deriveWriteSet(plan())).toEqual([WHOLE_REPOSITORY]);
    expect(
      deriveWriteSet(
        plan({ affectedAreas: ['To be confirmed by inspection before any change is made.'] }),
      ),
    ).toEqual([WHOLE_REPOSITORY]);
  });

  it('uses the areas a plan did name', () => {
    expect(deriveWriteSet(plan({ affectedAreas: ['src/app/**', 'docs/'] }))).toEqual([
      'docs',
      'src/app',
    ]);
  });
});

describe('whether a write set may run unattended', () => {
  it('refuses the whole repository when nobody is watching', () => {
    const verdict = autonomousWriteScopeVerdict({ writeSet: ['.'], unattended: true });
    expect(verdict.allowed).toBe(false);
    expect(verdict.rule).toBe('W-SCOPE01');
    expect(verdict.reason).toMatch(/will not do unattended/);
  });

  it('allows the whole repository when a person approved it', () => {
    /*
     * The line is about who is watching, not about what the string may contain. An owner reading
     * "Anywhere in the repository" on an approval screen has been told the truth and may decide
     * that is fine — several built-in playbooks declare exactly that.
     */
    expect(autonomousWriteScopeVerdict({ writeSet: ['.'], unattended: false }).allowed).toBe(true);
  });

  it('allows a named scope unattended, and leaves read-only work alone', () => {
    expect(autonomousWriteScopeVerdict({ writeSet: ['src/app'], unattended: true }).allowed).toBe(
      true,
    );
    /* An empty set is "writes nowhere", which is not the same as "writes everywhere". */
    expect(autonomousWriteScopeVerdict({ writeSet: [], unattended: true }).allowed).toBe(true);
  });

  it('is not fooled by a differently spelled whole repository', () => {
    for (const spelling of ['.', './', '/', '*', '**', 'src/../']) {
      expect(isWholeRepository([spelling]), spelling).toBe(true);
      expect(
        autonomousWriteScopeVerdict({ writeSet: [spelling, 'src/app'], unattended: true }).allowed,
        spelling,
      ).toBe(false);
    }
  });
});

describe('the write set applied to the shell', () => {
  it('names the destination of the forms whose destination is unmistakable', () => {
    expect(writeTargetsInCommand('sed -i "s/a/b/" src/app/page.tsx')).toEqual(['src/app/page.tsx']);
    expect(writeTargetsInCommand('echo hi > docs/notes.md')).toEqual(['docs/notes.md']);
    expect(writeTargetsInCommand('cat x >> src/other/file.ts')).toEqual(['src/other/file.ts']);
    expect(writeTargetsInCommand('mv src/a.ts src/b.ts')).toEqual(['src/a.ts', 'src/b.ts']);
    expect(writeTargetsInCommand('touch src/new.ts')).toEqual(['src/new.ts']);
  });

  it('names nothing for the forms whose destination it cannot know', () => {
    /*
     * The important half. `npm install` writes a lockfile and a directory tree; guessing at that
     * and refusing it would stop ordinary work with a scope error nobody can act on. Those are
     * left to the git diff taken before anything is committed.
     */
    expect(writeTargetsInCommand('npm install')).toEqual([]);
    expect(writeTargetsInCommand('git commit -m "x"')).toEqual([]);
    expect(writeTargetsInCommand('npm run build')).toEqual([]);
  });

  it('refuses a shell write outside the declared set', () => {
    /*
     * The evasion this closes: `Write` and `Edit` were checked and `Bash` was not, so a builder
     * that wanted to change a file outside its scope only had to reach for `sed -i` instead of
     * `Edit`. Nothing about the model's situation makes that deliberate — it is a different tool
     * for the same job — which is exactly why the boundary has to be the same for both.
     */
    expect(evaluateCommand('sed -i "s/a/b/" src/app/page.tsx', context()).verdict).toBe('allow');

    const denied = evaluateCommand('sed -i "s/a/b/" src/server/auth/session.ts', context());
    expect(denied.verdict).toBe('deny');
    expect(denied.verdict === 'deny' ? denied.rule : '').toBe('P-SCOPE02');
  });

  it('leaves the shell alone when the owner approved the whole repository', () => {
    /* Otherwise every command in a legitimately whole-repository task would be refused. */
    expect(
      evaluateCommand(
        'sed -i "s/a/b/" src/server/auth/session.ts',
        context({ declaredWriteSet: ['.'] }),
      ).verdict,
    ).toBe('allow');
  });
});

describe('asking for more scope rather than taking it', () => {
  it('reports only what is genuinely new', () => {
    expect(scopeChangeDelta(['src/app'], ['src/app/page.tsx'])).toEqual([]);
    expect(scopeChangeDelta(['src/app'], ['src/server/db.ts'])).toEqual(['src/server/db.ts']);
    /* Nothing is new when everything is already granted. */
    expect(scopeChangeDelta(['.'], ['anything/at/all.ts'])).toEqual([]);
  });
});

describe('the containment rule the checks share', () => {
  it('does not treat a segment prefix as containment', () => {
    expect(filesOutsideWriteSet(['src/app'], ['src/application/x.ts'])).toEqual([
      'src/application/x.ts',
    ]);
  });

  it('refuses a path that differs only by case, rather than guessing the filesystem', () => {
    /*
     * Strict on purpose. On a case-insensitive filesystem `SRC/x.ts` and `src/x.ts` are the same
     * file, and on a case-sensitive one they are not — so matching case-insensitively would allow
     * a genuinely different directory on Linux. Denying is wrong only in the direction that asks
     * the task to spell its own write set the way it declared it.
     */
    expect(filesOutsideWriteSet(['src/app'], ['SRC/app/page.tsx'])).toEqual(['SRC/app/page.tsx']);
  });

  it('normalises traversal before comparing, so a path cannot climb out', () => {
    expect(filesOutsideWriteSet(['src/app'], ['src/app/../server/db.ts'])).toEqual([
      'src/app/../server/db.ts',
    ]);
    expect(filesOutsideWriteSet(['src'], ['src/app/../server/db.ts'])).toEqual([]);
  });
});

describe('the escalation a repair round could grant itself', () => {
  it('keeps a repair inside what the builder was allowed', async () => {
    const { intersectWriteSet } = await import('@/domain/write-set');

    /* Findings that name files inside the builder's scope narrow it, which is the point. */
    expect(intersectWriteSet(['src/app', 'docs'], ['src/app/page.tsx'])).toEqual([
      'src/app/page.tsx',
    ]);

    /*
     * The escalation. `finding.file` is written by the reviewing agent, so a single finding naming
     * `.` — or `*`, or `/` — used to promote the repairer from a narrow scope to the whole
     * repository. It now cannot widen anything.
     */
    for (const crafted of ['.', '*', '/', '**']) {
      expect(intersectWriteSet(['src/app'], [crafted]), crafted).toEqual(['src/app']);
    }
    expect(intersectWriteSet(['src/app'], ['src/server/auth/session.ts'])).toEqual(['src/app']);
  });

  it('falls back to the builder set rather than to nothing', () => {
    /* A repair that may write nowhere cannot repair anything. */
    expect(intersectWriteSet(['src/app'], [])).toEqual(['src/app']);
  });
});

describe('the files every build rewrites', () => {
  it('lets a lockfile through without widening anything else', async () => {
    const { isGeneratedAllowance, GENERATED_PATH_ALLOWANCE } = await import('@/domain/write-set');

    /*
     * The first thing a genuinely narrow write set breaks is honest work: a builder runs the
     * repository's own install step, the root lockfile changes, and the task fails for doing what
     * it was asked to do. An owner who watched that twice would turn the control off.
     */
    expect(filesOutsideWriteSet(['src/app'], ['package-lock.json'])).toEqual([]);
    expect(isGeneratedAllowance('package-lock.json')).toBe(true);

    /* A list, not a wildcard: only the root file, and only these names. */
    expect(isGeneratedAllowance('vendor/package-lock.json')).toBe(false);
    expect(filesOutsideWriteSet(['src/app'], ['src/server/db.ts'])).toEqual(['src/server/db.ts']);
    expect(GENERATED_PATH_ALLOWANCE).not.toContain('.');
  });
});
