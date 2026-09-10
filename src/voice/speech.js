import { dedupeKey } from '../core/ids.js';
import { createLogger } from '../core/logger.js';
import { batchable, inQuietHours, renderSentence, shouldSpeak } from './policy.js';

const COLLECTION = 'speech';
const META_ID = '__meta';
const KEYS_ID = '__keys';

/**
 * The single mouth of the system (acceptance requirement 3).
 *
 * Three invariants, each proved in `test/unit/voice-speech.test.js`:
 *
 *  1. **Never say the same thing twice.** Every considered event collapses to a
 *     dedupe key (`type | projectId | salient id`). A key that has been spoken
 *     — or is already sitting in the batch buffer — is dropped, and the key set
 *     is persisted, so this holds across a flush and across a restart.
 *  2. **Never replay after a refresh.** Items carry a monotonic `seq`. A client
 *     acknowledges up to a seq; the high-water mark is written to the store, so
 *     a brand new `SpeechService` over the same store offers nothing old.
 *  3. **Batch the small stuff.** Minor progress accumulates and leaves as ONE
 *     sentence on `flushBatch()`; deliveries, blockers and questions never wait.
 */
export class SpeechService {
  constructor({
    store, bus = null, clock, settings = {}, batchWindowMs = 4000,
    maxItems = 500, maxKeys = 2000, logger = createLogger('speech'),
  } = {}) {
    if (!store) throw new TypeError('SpeechService: store is required');
    if (!clock) throw new TypeError('SpeechService: clock is required');

    this.store = store;
    this.bus = bus;
    this.clock = clock;
    this.batchWindowMs = Math.max(0, Number(batchWindowMs) || 0);
    this.maxItems = Math.max(1, maxItems);
    this.maxKeys = Math.max(1, maxKeys);
    this.log = logger;
    this.settings = cloneSettings(settings);

    this._batch = [];
    this._batchStartedAt = null;

    const records = [];
    for (const id of store.ids(COLLECTION)) {
      if (id.startsWith('__')) continue;
      const rec = store.get(COLLECTION, id);
      if (rec && Number.isFinite(rec.seq)) records.push(rec);
    }
    records.sort((a, b) => a.seq - b.seq);
    this._items = records.map(toItem);

    const meta = store.get(COLLECTION, META_ID) ?? {};
    this._seq = Math.max(Number(meta.seq) || 0, this._items.at(-1)?.seq ?? 0);
    this._ackSeq = Math.max(0, Number(meta.ackSeq) || 0);
    this._batchCount = Math.max(0, Number(meta.batchCount) || 0);
    this._keys = new Set(asArray(store.get(COLLECTION, KEYS_ID)?.keys));
  }

  // ---------------------------------------------------------------- intake

  /**
   * Offer a bus event to the policy.
   * @returns {object|null} the SpeechItem that was spoken now, or null when the
   *   event was suppressed, deduped, or parked in the batch.
   */
  consider(event) {
    const type = typeof event?.type === 'string' ? event.type : null;
    // Our own utterances must never feed back in.
    if (!type || type.startsWith('speech.')) return null;

    const payload = (event.payload && typeof event.payload === 'object') ? event.payload : event;
    const decision = shouldSpeak({ type, payload }, { settings: this.settings, clock: this.clock });
    if (!decision.speak) return null;

    const projectId = payload.projectId ?? payload.project?.id ?? null;
    const key = dedupeKey(type, projectId, salientId(type, payload));
    if (this._keys.has(key)) return null;

    const text = renderSentence({ type, payload }, { projectTitle: this.projectTitle(projectId) });
    if (!text) return null;

    if (batchable(type)) {
      this._rollBatchIfStale();
      if (this._batch.length === 0) this._batchStartedAt = this.clock.now();
      this._batch.push({ type, projectId, key, text, at: this.clock.now() });
      // Reserve the key immediately: a repeat of this event, before or after the
      // flush, must not queue a second time.
      this._keys.add(key);
      return null;
    }

    return this._emit({ text, priority: decision.priority, key, projectId });
  }

  /**
   * Collapse everything buffered into one sentence and say it.
   * @returns {object|null} the summary SpeechItem, or null when there was
   *   nothing buffered or speech is currently suppressed.
   */
  flushBatch() {
    if (this._batch.length === 0) return null;
    const entries = this._batch;
    this._batch = [];
    this._batchStartedAt = null;

    // Mute and quiet hours are re-checked at speaking time — a batch collected
    // before bedtime is not allowed to go off after it.
    if (this.settings.muted || this.settings.voiceEnabled === false) return null;
    if (inQuietHours(this.clock, this.settings)) return null;

    const summary = this._summarize(entries);
    if (!summary) return null;
    this._batchCount += 1;
    const key = summary.key ?? dedupeKey('speech.batch', summary.projectId ?? '', String(this._batchCount));
    return this._emit({ text: summary.text, priority: 'normal', key, projectId: summary.projectId });
  }

  /** Items the client has not acknowledged yet, oldest first. */
  pending() {
    return this.unspoken(0);
  }

  /**
   * What a (re)connecting client still needs to say: strictly newer than both
   * its own cursor and the persisted acknowledgement high-water mark.
   */
  unspoken(sinceSeq = 0) {
    const floor = Math.max(Number(sinceSeq) || 0, this._ackSeq);
    return this._items.filter((i) => i.seq > floor).map((i) => ({ ...i }));
  }

  /** The client spoke everything up to and including `seq`. Persisted. */
  acknowledge(seq) {
    const n = Number(seq);
    if (!Number.isFinite(n) || n <= this._ackSeq) return this._ackSeq;
    this._ackSeq = Math.min(n, this._seq);
    this._persistMeta();
    return this._ackSeq;
  }

  setSettings(partial = {}) {
    const next = { ...this.settings, ...partial };
    if (partial.quietHours) next.quietHours = { ...(this.settings.quietHours ?? {}), ...partial.quietHours };
    this.settings = next;
    return this.settings;
  }

  // ------------------------------------------------------------ inspection

  /** Everything ever spoken that is still retained, oldest first. */
  history(limit = 50) {
    return this._items.slice(-Math.max(0, limit)).map((i) => ({ ...i }));
  }

  get lastSeq() { return this._seq; }
  get acknowledgedSeq() { return this._ackSeq; }
  batchSize() { return this._batch.length; }

  projectTitle(projectId) {
    if (!projectId) return null;
    return this.store.get('projects', projectId)?.title ?? null;
  }

  // -------------------------------------------------------------- internals

  /** One sentence for a whole window of minor progress. */
  _summarize(entries) {
    const completed = entries.filter((e) => e.type === 'task.completed');
    if (completed.length === 1) {
      const only = completed[0];
      return { text: only.text, key: only.key, projectId: only.projectId };
    }
    if (completed.length > 1) {
      const projects = uniq(completed.map((e) => e.projectId));
      if (projects.length === 1) {
        const title = this.projectTitle(projects[0]);
        return {
          text: title
            ? `I finished ${completed.length} tasks on ${title}.`
            : `I finished ${completed.length} tasks.`,
          projectId: projects[0],
        };
      }
      return { text: `I finished ${completed.length} tasks across ${projects.length} projects.`, projectId: null };
    }

    // No completions: a phase change is the next most informative thing.
    const phases = entries.filter((e) => e.type === 'project.phase');
    if (phases.length > 0) {
      const last = phases.at(-1);
      return { text: last.text, key: last.key, projectId: last.projectId };
    }

    // Only starts. Never speak "I started X" on its own — say what is in hand.
    const projects = uniq(entries.map((e) => e.projectId));
    if (projects.length === 1) {
      const title = this.projectTitle(projects[0]);
      return { text: title ? `I am working on ${title}.` : 'I am working on your project.', projectId: projects[0] };
    }
    return { text: `I am working on ${projects.length} projects.`, projectId: null };
  }

  /** A batch older than the window is spoken before a new one starts. */
  _rollBatchIfStale() {
    if (this._batch.length === 0 || this._batchStartedAt === null) return;
    if (this.clock.now() - this._batchStartedAt < this.batchWindowMs) return;
    this.flushBatch();
  }

  _emit({ text, priority, key, projectId = null }) {
    const seq = ++this._seq;
    const item = { seq, text, priority, at: this.clock.now(), key };
    this._items.push(item);
    this._keys.add(key);
    this.store.put(COLLECTION, `sp_${seq}`, { ...item, projectId });
    this._trimItems();
    this._persistKeys();
    this._persistMeta();
    try { this.bus?.emit?.('speech.say', { ...item }); }
    catch (err) { this.log?.error?.('speech.say emit failed', err?.message); }
    return { ...item };
  }

  _trimItems() {
    while (this._items.length > this.maxItems) {
      const dropped = this._items.shift();
      this.store.delete(COLLECTION, `sp_${dropped.seq}`);
    }
  }

  _persistKeys() {
    const keys = [...this._keys];
    if (keys.length > this.maxKeys) {
      const kept = keys.slice(keys.length - this.maxKeys);
      this._keys = new Set(kept);
      this.store.put(COLLECTION, KEYS_ID, { keys: kept });
      return;
    }
    this.store.put(COLLECTION, KEYS_ID, { keys });
  }

  _persistMeta() {
    this.store.put(COLLECTION, META_ID, { seq: this._seq, ackSeq: this._ackSeq, batchCount: this._batchCount });
  }
}

/**
 * The part of the payload that makes this event distinct. Deliberately NOT the
 * deliverable id for a delivery: one project is delivered once, however many
 * times the event is re-broadcast.
 */
export function salientId(type, payload = {}) {
  const p = payload ?? {};
  switch (type) {
    case 'question.asked':
    case 'question.answered':
      return p.questionId ?? p.question?.id ?? p.text ?? '';
    case 'task.started':
    case 'task.completed':
    case 'task.failed':
    case 'task.blocked':
    case 'feature.completed':
      return p.taskId ?? p.task?.id ?? p.title ?? '';
    case 'project.delivered':
      return p.project?.status ?? 'delivered';
    case 'project.evaluated':
      return p.project?.status ?? 'evaluated';
    case 'project.blocked':
      return p.reason ?? p.project?.blockedReason ?? 'blocked';
    case 'project.phase':
      return p.phase ?? '';
    case 'chat.message':
      return p.turn?.id ?? p.turn?.at ?? p.turn?.text ?? '';
    default:
      return p.id ?? p.taskId ?? p.questionId ?? '';
  }
}

function toItem(rec) {
  return { seq: rec.seq, text: rec.text, priority: rec.priority, at: rec.at, key: rec.key };
}

function cloneSettings(settings) {
  const s = { ...(settings ?? {}) };
  if (s.quietHours) s.quietHours = { ...s.quietHours };
  return s;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function uniq(list) {
  return [...new Set(list)];
}

export { renderSentence };
