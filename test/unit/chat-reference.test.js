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

test('missing or malformed ctx resolves nothing rather than throwing', () => {
  // With no ctx at all there is no project to point at, so a pronoun must be
  // refused outright — not silently attached to something.
  for (const ctxValue of [undefined, null, {}, { recentProjects: null, lastOptions: 'nope', openQuestion: undefined }]) {
    const ref = resolveReference('change that', ctxValue);
    assert.equal(ref.kind, 'ambiguous', `expected ambiguous for ctx ${JSON.stringify(ctxValue)}`);
    assert.equal(ref.projectId, null);
    assert.equal(ref.questionId, null);
    assert.equal(ref.optionIndex, null);
  }
  const plain = resolveReference('hello', { recentProjects: null, lastOptions: 'nope' });
  assert.deepEqual(plain, { projectId: null, questionId: null, optionIndex: null, kind: 'none' });

  // A malformed recentProjects list must be skipped entry by entry, not trusted.
  const messy = resolveReference('pause the recipe scraper', ctx({
    activeProjectId: null,
    recentProjects: [null, undefined, { title: 'no id here' }, { id: 'p_recipe', title: 'Recipe scraper' }],
  }));
  assert.equal(messy.projectId, 'p_recipe');
  assert.equal(messy.kind, 'title');
});

/**
 * ADDITIONAL — hardest requirement #2: 0-based option indexing that refuses to
 * guess.
 *
 * "the second option" must mean index 1, every time, for every list length and
 * every phrasing — and anything outside the list must come back null rather
 * than clamped to an end. An off-by-one here answers a decision card with the
 * wrong choice and the build proceeds on it, silently. So this walks every
 * position of every list size 1..5 through every supported phrasing, then
 * checks both edges just past the list.
 */
test('every option phrasing maps to the same 0-based index, and out-of-range never clamps', () => {
  const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];
  const WORDS = ['one', 'two', 'three', 'four', 'five'];

  for (let size = 1; size <= 5; size++) {
    const options = Array.from({ length: size }, (_, i) => `Choice ${i + 1}`);
    const c = ctx({ lastOptions: options });

    for (let n = 1; n <= size; n++) {
      const expected = n - 1;
      const phrasings = [
        `option ${n}`,
        `choice ${n}`,
        `number ${n}`,
        `option ${WORDS[n - 1]}`,
        `the ${ORDINALS[n - 1]}`,
        `the ${ORDINALS[n - 1]} one`,
        `the ${ORDINALS[n - 1]} option`,
        `${ORDINALS[n - 1]} option`,
        `go with the ${ORDINALS[n - 1]}`,
        `${n}`,
        `#${n}`,
      ];
      for (const text of phrasings) {
        const ref = resolveReference(text, c);
        assert.equal(ref.kind, 'option', `not an option pick (size ${size}): ${text}`);
        assert.equal(ref.optionIndex, expected, `off by ${ref.optionIndex - expected} (size ${size}): ${text}`);
      }
    }

    // "the last one" is the final index, never one past it.
    const last = resolveReference('go with the last one', c);
    assert.equal(last.optionIndex, size - 1, `"last" wrong for size ${size}`);
    assert.equal(last.optionIndex, options.length - 1);

    // Both edges just outside the list: refused, not clamped to 0 or size-1.
    for (const text of [`option ${size + 1}`, 'option 0']) {
      const ref = resolveReference(text, c);
      assert.equal(ref.kind, 'ambiguous', `should refuse (size ${size}): ${text}`);
      assert.equal(ref.optionIndex, null, `clamped instead of refusing (size ${size}): ${text}`);
      assert.equal(ref.projectId, null, `guessed a project (size ${size}): ${text}`);
    }
  }
});
