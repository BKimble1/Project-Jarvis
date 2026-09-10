import { newId } from '../core/ids.js';

const COLLECTION = 'questions';

/**
 * Canonical form used for duplicate detection: case-insensitive, whitespace
 * collapsed, trailing punctuation dropped. "Use Postgres?" and
 * "  use   postgres " are the same question.
 */
export function normalizeQuestionText(text) {
  return String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[?!.\s]+$/, '')
    .toLowerCase();
}

/**
 * The key `ask` de-duplicates on. Normally the normalized text, but text made
 * only of punctuation normalizes to '' — and an empty key would silently merge
 * two genuinely different questions into one, so fall back to the case-folded
 * text in that case.
 */
function dedupeKeyFor(text) {
  const normalized = normalizeQuestionText(text);
  if (normalized) return normalized;
  return String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function hasDefault(recommendedDefault) {
  if (recommendedDefault === null || recommendedDefault === undefined) return false;
  if (typeof recommendedDefault === 'string') return recommendedDefault.trim().length > 0;
  if (Array.isArray(recommendedDefault)) return recommendedDefault.length > 0;
  return true;
}

/**
 * The only place Jarvis is allowed to stop and ask a human something.
 *
 * Two guarantees matter (acceptance req. 1):
 *  - routine choices with a sensible default are decided, not asked
 *    (`isMaterial` === false);
 *  - the same open question is never asked twice (`ask` is idempotent per
 *    project + normalized text and emits nothing on the duplicate path).
 */
export class QuestionGate {
  constructor({ store, bus, clock }) {
    if (!store) throw new TypeError('QuestionGate: store is required');
    if (!bus) throw new TypeError('QuestionGate: bus is required');
    if (!clock) throw new TypeError('QuestionGate: clock is required');
    this.store = store;
    this.bus = bus;
    this.clock = clock;
  }

  /**
   * Ask a question, or return the identical one already open.
   * @returns {object} Question
   */
  ask({ projectId, taskId = null, text, recommendedDefault = null, options = [] } = {}) {
    if (!projectId) throw new TypeError('QuestionGate.ask: projectId is required');
    const clean = String(text ?? '').trim().replace(/\s+/g, ' ');
    if (!clean) throw new TypeError('QuestionGate.ask: text is required');

    const key = dedupeKeyFor(clean);
    const existing = this.open(projectId).find((q) => dedupeKeyFor(q.text) === key);
    if (existing) return existing;

    const question = {
      id: newId('q'),
      projectId,
      taskId: taskId ?? null,
      text: clean,
      recommendedDefault: recommendedDefault ?? null,
      options: Array.isArray(options) ? [...options] : [],
      status: 'open',
      answer: null,
      askedAt: this.clock.now(),
      answeredAt: null,
    };
    this.store.put(COLLECTION, question.id, question);
    this.bus.emit('question.asked', {
      projectId,
      questionId: question.id,
      taskId: question.taskId,
      text: question.text,
      options: question.options,
      recommendedDefault: question.recommendedDefault,
      question,
    });
    return question;
  }

  /**
   * Record an answer and emit `question.answered` so the orchestrator resumes
   * without a new user command. Answering twice is a no-op.
   */
  answer(questionId, answer) {
    const current = this.store.get(COLLECTION, questionId);
    if (!current) throw new Error(`QuestionGate.answer: unknown question ${questionId}`);
    if (current.status === 'answered') return current;

    const updated = this.store.patch(COLLECTION, questionId, {
      status: 'answered',
      answer: answer ?? null,
      answeredAt: this.clock.now(),
    });
    this.bus.emit('question.answered', {
      projectId: updated.projectId,
      questionId: updated.id,
      taskId: updated.taskId,
      answer: updated.answer,
      question: updated,
    });
    return updated;
  }

  get(questionId) { return this.store.get(COLLECTION, questionId); }

  /** Open questions, oldest first. Omit `projectId` for every project. */
  open(projectId) {
    return this.store
      .find(COLLECTION, (q) => q?.status === 'open' && (projectId === undefined || q.projectId === projectId))
      .sort((a, b) => (a.askedAt ?? 0) - (b.askedAt ?? 0));
  }

  /**
   * "Ask only when it materially affects the outcome."
   * false → decide it yourself; true → the human genuinely has to choose.
   */
  isMaterial({ text, recommendedDefault, impact } = {}) {
    if (!String(text ?? '').trim()) return false;
    if (impact === 'high') return true;
    if (hasDefault(recommendedDefault)) return false;
    return true;
  }
}
