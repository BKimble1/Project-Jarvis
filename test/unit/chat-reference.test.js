import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReference } from '../../src/chat/reference.js';

const RECENTS = [
  { id: 'p_recipe', title: 'Recipe scraper', updatedAt: 300 },
  { id: 'p_slack', title: 'Slack standup bot', updatedAt: 200 },
  { id: 'p_photos', title: 'Photo renamer CLI', updatedAt: 100 },
];

const ctx = (over = {}) => ({
  conversationId: 'c1',
  activeProjectId: 'p_active',
  recentProjects: RECENTS,
  openQuestion: null,
  lastOptions: [],
  ...over,
});

test('pronouns resolve to the active project', () => {
  for (const text of ['change that', 'it', 'this', 'the project', 'pause it', 'what about that?']) {
    const ref = resolveReference(text, ctx());
    assert.equal(ref.projectId, 'p_active', `unresolved: ${text}`);
    assert.equal(ref.kind, 'active');
    assert.equal(ref.optionIndex, null);
  }
});

test('continue resolves to the active project', () => {
  for (const text of ['continue', 'keep going', 'carry on', 'resume']) {
    const ref = resolveReference(text, ctx());
    assert.equal(ref.projectId, 'p_active', `unresolved: ${text}`);
    assert.equal(ref.kind, 'active');
  }
});

test('ordinal and numeric option references resolve 0-based against lastOptions', () => {
  const c = ctx({ lastOptions: ['Postgres', 'SQLite', 'Mongo'] });
  const expectations = [
    ['the second option', 1],
    ['option 2', 1],
    ['the first one', 0],
    ['number three', 2],
    ['option two', 1],
    ['the 2nd one', 1],
    ['3', 2],
    ['go with the last one', 2],
  ];
  for (const [text, index] of expectations) {
    const ref = resolveReference(text, c);
    assert.equal(ref.kind, 'option', `not an option reference: ${text}`);
    assert.equal(ref.optionIndex, index, `wrong index for: ${text}`);
  }
});

test('an out-of-range option is ambiguous, not clamped', () => {
  const c = ctx({ lastOptions: ['Postgres', 'SQLite'] });
  for (const text of ['the fifth option', 'option 9', 'option 0']) {
    const ref = resolveReference(text, c);
    assert.equal(ref.optionIndex, null, `should not resolve: ${text}`);
    assert.equal(ref.kind, 'ambiguous');
    assert.equal(ref.projectId, null);
  }
});

test('an option reference with no offered options is ambiguous', () => {
  const ref = resolveReference('option 2', ctx({ lastOptions: [] }));
  assert.equal(ref.kind, 'ambiguous');
  assert.equal(ref.optionIndex, null);
});

test('a title fragment matching exactly one project resolves to that project', () => {
  const cases = [
    ['change the recipe scraper to use TypeScript', 'p_recipe'],
    ['pause the slack standup bot', 'p_slack'],
    ['how is the photo renamer doing?', 'p_photos'],
  ];
  for (const [text, id] of cases) {
    const ref = resolveReference(text, ctx({ activeProjectId: null }));
    assert.equal(ref.projectId, id, `wrong project for: ${text}`);
    assert.equal(ref.kind, 'title');
  }
});

test('a title fragment beats the active project when it names something else', () => {
  const ref = resolveReference('pause the recipe scraper', ctx());
  assert.equal(ref.projectId, 'p_recipe');
  assert.equal(ref.kind, 'title');
});

test('two equally matching titles are ambiguous, never the most recent one', () => {
  const recents = [
    { id: 'p_newer', title: 'Recipe scraper', updatedAt: 900 },
    { id: 'p_older', title: 'Recipe planner', updatedAt: 100 },
  ];
  const ref = resolveReference('change the recipe one', ctx({ activeProjectId: null, recentProjects: recents }));
  assert.equal(ref.kind, 'ambiguous');
  assert.equal(ref.projectId, null);
  assert.notEqual(ref.projectId, 'p_newer');
});

test('a strictly better title match still resolves', () => {
  const recents = [
    { id: 'p_scraper', title: 'Recipe scraper', updatedAt: 100 },
    { id: 'p_planner', title: 'Recipe planner', updatedAt: 900 },
  ];
  const ref = resolveReference('change the recipe scraper', ctx({ activeProjectId: null, recentProjects: recents }));
  assert.equal(ref.projectId, 'p_scraper');
  assert.equal(ref.kind, 'title');
});

test('a pronoun with no active project is ambiguous, never the most recent project', () => {
  for (const text of ['change that', 'it', 'stop it', 'continue']) {
    const ref = resolveReference(text, ctx({ activeProjectId: null }));
    assert.equal(ref.kind, 'ambiguous', `should be ambiguous: ${text}`);
    assert.equal(ref.projectId, null, `must not guess for: ${text}`);
    assert.notEqual(ref.projectId, RECENTS[0].id);
  }
});

test('a new build description is not treated as a reference', () => {
  const ref = resolveReference('build a CLI that renames files', ctx());
  assert.equal(ref.kind, 'none');
  assert.equal(ref.projectId, null);
  assert.equal(ref.optionIndex, null);
});

test('an open question is carried on every resolution', () => {
  const question = { id: 'q_7', projectId: 'p_q', text: 'Which database?', options: ['Postgres', 'SQLite'] };
  const c = ctx({ openQuestion: question, lastOptions: question.options });

  const option = resolveReference('the second option', c);
  assert.equal(option.questionId, 'q_7');
  assert.equal(option.optionIndex, 1);

  const bare = resolveReference('postgres please', ctx({ activeProjectId: null, recentProjects: [], openQuestion: question }));
  assert.equal(bare.kind, 'question');
  assert.equal(bare.questionId, 'q_7');
  assert.equal(bare.projectId, 'p_q');
});

test('the result always has the same four keys', () => {
  const inputs = ['', 'change that', 'option 2', 'the fifth option', 'hello there', null, 42];
  for (const text of inputs) {
    const ref = resolveReference(text, ctx({ lastOptions: ['a', 'b'] }));
    assert.deepEqual(Object.keys(ref).sort(), ['kind', 'optionIndex', 'projectId', 'questionId']);
    assert.equal(typeof ref.kind, 'string');
  }
});

test('missing or malformed ctx never throws', () => {
  assert.equal(resolveReference('change that').kind, 'ambiguous');
  assert.equal(resolveReference('change that', null).kind, 'ambiguous');
  assert.equal(resolveReference('hello', { recentProjects: null, lastOptions: 'nope' }).kind, 'none');
});
