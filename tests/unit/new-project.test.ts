import { describe, expect, it } from 'vitest';

import { describesNewProject, deriveProjectName, UNNAMED } from '@/domain/new-project';
import { isRepositorySlug, repositorySlug } from '@/domain/repository-name';

/**
 * The guard in front of the one irreversible thing Jarvis can do.
 *
 * Creating a repository is the only outward-visible act in this codebase that reverting a commit
 * cannot undo — only the owner can delete one. So the tests that matter most here are the negative
 * ones: the sentences that must *not* reach it. Being too cautious costs a clarifying question.
 */

describe('recognising a request for something that does not exist yet', () => {
  it('accepts a sentence that says to make a named kind of thing', () => {
    for (const asking of [
      'Build me a simple rent tracker app.',
      'Make a small invoicing app for my landlord business',
      'Create a dashboard',
      'scaffold a CLI tool called wrenchy',
      'spin up a website for the studio',
    ]) {
      expect(describesNewProject(asking), asking).toBe(true);
    }
  });

  it('refuses work inside something that already exists', () => {
    /*
     * The failure this exists to prevent. "Fix the login bug", typed when no project matched, must
     * not become a project called "login bug" with a repository behind it.
     */
    for (const asking of [
      'Fix the login bug',
      'Add invoice scanning to OffRent',
      'Refactor the payment module',
      'Audit Holograph read-only.',
      'Build a new endpoint in the existing project',
      'Make a simple version.',
      'update the dependencies',
    ]) {
      expect(describesNewProject(asking), asking).toBe(false);
    }
  });

  it('refuses a question about building rather than an instruction to build', () => {
    for (const asking of [
      'Is this app worth building?',
      'Should I build a rent tracker app?',
      'I have an idea for an app.',
    ]) {
      /*
       * These are already stopped one layer up — `interpretMessage` reads them as ideas and the
       * conversation service never asks this question about them. Checked anyway, because a guard
       * that only works because something else caught it first is a guard that stops working the
       * day the thing in front of it changes.
       */
      expect(describesNewProject(asking), asking).toBe(false);
    }
  });
});

describe('naming the thing', () => {
  it('takes the descriptive middle of the sentence', () => {
    expect(deriveProjectName('Build me a simple rent tracker app.')).toBe('Rent Tracker');
    expect(deriveProjectName('Make a small invoicing app')).toBe('Invoicing');
  });

  it('prefers a name the owner actually said', () => {
    expect(deriveProjectName('scaffold a CLI tool called wrenchy')).toBe('Wrenchy');
    expect(deriveProjectName('build an app named Holograph')).toBe('Holograph');
  });

  it('stops at the clause rather than swallowing the whole sentence', () => {
    expect(deriveProjectName('Create a dashboard for CoreCredit')).toBe('Dashboard');
    expect(deriveProjectName('build an app that tracks rent')).not.toContain('That');
  });

  it('says it does not know rather than inventing something confident', () => {
    expect(deriveProjectName('build something')).toBe('New project');
    expect(deriveProjectName('')).toBe('New project');
    /* Evaluative words refer to a thing; they do not name it. */
    expect(deriveProjectName('go ahead with the best idea')).toBe('New project');
    /*
     * And the fallback is a named export, because prose has to be able to recognise it. "I have
     * not judged whether New project is worth building" reads as a project called New project;
     * `ConversationService` says "that" instead when the name is this one.
     */
    expect(deriveProjectName('build something')).toBe(UNNAMED);
  });

  /**
   * The sentence that named a project "Yet".
   *
   * "Re-evaluate my QuickPick idea … Do not build anything yet." produced a project called Yet, a
   * private repository called `yet`, and a mission to re-evaluate something. All of it came from
   * mining a sentence about the *request* for the name of the *product*: the last clause is an
   * instruction not to build, and the only word left in it after the fillers was "yet".
   */
  it('does not take a name out of a sentence telling it what not to do', () => {
    expect(
      deriveProjectName(
        'Re-evaluate my QuickPick idea using Claude: two choices, one randomly selected with a ' +
          'clean animation. Give your assessment and the smallest useful V1. Do not build anything yet.',
      ),
    ).toBe('QuickPick');

    for (const message of [
      'Have another look at LedgerLite. Do not build anything yet.',
      'What do you make of my StudySprint idea? Do not create anything yet.',
      'Think about my rent tracker app. Do not build it yet.',
      "Assess the invoicing tool. Don't start building.",
    ]) {
      expect(deriveProjectName(message), message).not.toMatch(/\b(?:Yet|Anything|Building)\b/);
    }
  });

  it('keeps the name the owner gave a thing, across re-evaluations and follow-ups', () => {
    /* The same product, said four ways. All four have to reach the same project. */
    for (const message of [
      'I have an idea for a tiny app called QuickPick that lets someone enter two choices.',
      'Re-evaluate my QuickPick idea using Claude. Do not build anything yet.',
      'What do you think of QuickPick now?',
      'Take another pass at the QuickPick app.',
    ]) {
      expect(deriveProjectName(message), message).toBe('QuickPick');
    }
  });

  it("reads a name in a possessive frame, and keeps the owner's casing", () => {
    expect(deriveProjectName('Have a look at my LedgerLite idea')).toBe('LedgerLite');
    expect(deriveProjectName('what about the rent tracker app')).toBe('Rent Tracker');
    expect(deriveProjectName('assess our invoicing tool')).toBe('Invoicing');
  });

  it('does not mistake a tool the owner mentioned for the thing being built', () => {
    /* "using Claude" says how to think about it, not what to call it. */
    expect(deriveProjectName('Evaluate my StudySprint idea using Claude')).toBe('StudySprint');
    /* And a client named after a dashboard is still a dashboard. */
    expect(deriveProjectName('Create a dashboard for CoreCredit')).toBe('Dashboard');
  });
});

describe('turning a name into something GitHub will take', () => {
  it('lower-cases, because GitHub compares repository names case-insensitively', () => {
    /* Two lookups for the same repository must not disagree about whether it exists. */
    expect(repositorySlug('RentTracker')).toBe('renttracker');
  });

  it('replaces everything GitHub would have replaced itself', () => {
    expect(repositorySlug('Rent Tracker')).toBe('rent-tracker');
    expect(repositorySlug("Blake's Invoicing App!")).toBe('blakes-invoicing-app');
    expect(repositorySlug('a  b')).toBe('a-b');
  });

  it('never returns something git or GitHub would reject', () => {
    for (const input of ['', '   ', '...', '.git', '---', '!!!']) {
      const slug = repositorySlug(input);
      expect(slug.length, input).toBeGreaterThan(0);
      expect(slug, input).not.toMatch(/^[-._]|[-._]$/);
      expect(slug, input).toMatch(/^[a-z0-9._-]+$/);
    }
  });

  it('is idempotent, so slugging a stored name does not change it', () => {
    for (const input of ['Rent Tracker', 'holograph', 'core-credit', 'a.b_c']) {
      expect(repositorySlug(repositorySlug(input)), input).toBe(repositorySlug(input));
      expect(isRepositorySlug(repositorySlug(input)), input).toBe(true);
    }
  });

  it('stays inside the length GitHub accepts', () => {
    expect(repositorySlug('x'.repeat(400)).length).toBeLessThanOrEqual(100);
  });
});
