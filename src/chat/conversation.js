import { newId } from '../core/ids.js';

/**
 * The chat side of the system's memory (acceptance requirement 2).
 *
 * Every turn is persisted, so a refresh or a restart shows the same transcript;
 * every turn is announced on the bus as `chat.message`, so the dashboard and the
 * speech policy see it once and only once. The service also assembles the `ctx`
 * object that `classify()` and `resolveReference()` consume, which is what lets
 * a two-word message like "the second one" mean something concrete.
 *
 * Turns carry a per-conversation `index` as well as a timestamp: under a fake
 * clock several turns share the same millisecond, and transcript order must
 * still be exact.
 */

const CONVERSATIONS = 'conversations';
const TURNS = 'turns';
const PROJECTS = 'projects';
const QUESTIONS = 'questions';

const ROLES = new Set(['user', 'assistant', 'system', 'tool']);
const DEFAULT_HISTORY = 50;
const RECENT_PROJECTS = 8;

export class ConversationService {
  constructor({ store, bus, clock } = {}) {
    if (!store) throw new TypeError('ConversationService: store is required');
    if (!bus) throw new TypeError('ConversationService: bus is required');
    if (!clock) throw new TypeError('ConversationService: clock is required');
    this.store = store;
    this.bus = bus;
    this.clock = clock;
  }

  /** Create the conversation if it is new; always returns the current record. */
  ensure(conversationId) {
    const id = normalizeId(conversationId);
    const existing = this.store.get(CONVERSATIONS, id);
    if (existing) return copyConversation(existing);
    const now = this.clock.now();
    const conversation = {
      id,
      createdAt: now,
      updatedAt: now,
      projectId: null,
      projectIds: [],
      lastOptions: [],
      turnCount: 0,
      lastTurnAt: null,
    };
    this.store.put(CONVERSATIONS, id, conversation);
    return copyConversation(conversation);
  }

  /**
   * Append one turn and announce it.
   * @returns {{id:string, conversationId:string, index:number, role:string, text:string, meta:object, at:number}}
   */
  append(conversationId, { role = 'user', text = '', meta = {} } = {}) {
    const id = normalizeId(conversationId);
    const conversation = this.ensure(id);
    if (!ROLES.has(role)) {
      throw new TypeError(`ConversationService.append: unknown role '${role}'`);
    }
    const index = (conversation.turnCount ?? 0) + 1;
    const turn = {
      id: newId('turn'),
      conversationId: id,
      index,
      role,
      text: String(text ?? '').trim(),
      meta: meta && typeof meta === 'object' ? { ...meta } : {},
      at: this.clock.now(),
    };
    this.store.put(TURNS, turn.id, turn);
    this.store.patch(CONVERSATIONS, id, {
      turnCount: index,
      lastTurnAt: turn.at,
      updatedAt: turn.at,
    });
    const projectId = turn.meta.projectId ?? conversation.projectId ?? null;
    this.bus.emit('chat.message', { turn: copyTurn(turn), conversationId: id, projectId });
    return copyTurn(turn);
  }

  /** The most recent `limit` turns, oldest first. */
  history(conversationId, limit = DEFAULT_HISTORY) {
    const id = normalizeId(conversationId);
    const requested = Number(limit);
    const count = Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_HISTORY;
    if (count <= 0) return [];
    const turns = this.store
      .find(TURNS, (t) => t && t.conversationId === id)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0) || (a.at ?? 0) - (b.at ?? 0));
    return turns.slice(-count).map(copyTurn);
  }

  /** Point the conversation at the project it is currently about. */
  bindProject(conversationId, projectId) {
    const id = normalizeId(conversationId);
    const conversation = this.ensure(id);
    if (!projectId) throw new TypeError('ConversationService.bindProject: projectId is required');
    const history = (conversation.projectIds ?? []).filter((p) => p !== projectId);
    history.push(projectId);
    const updated = {
      ...conversation,
      projectId,
      projectIds: history.slice(-10),
      updatedAt: this.clock.now(),
    };
    this.store.put(CONVERSATIONS, id, updated);
    return copyConversation(updated);
  }

  activeProject(conversationId) {
    const conversation = this.store.get(CONVERSATIONS, normalizeId(conversationId));
    return conversation?.projectId ?? null;
  }

  /** Remember the choices we just offered, so "the second one" can be resolved. */
  setLastOptions(conversationId, options) {
    const id = normalizeId(conversationId);
    this.ensure(id);
    const list = (Array.isArray(options) ? options : [])
      .map((o) => String(o ?? '').trim())
      .filter(Boolean);
    this.store.patch(CONVERSATIONS, id, { lastOptions: list, updatedAt: this.clock.now() });
    return [...list];
  }

  lastOptions(conversationId) {
    const conversation = this.store.get(CONVERSATIONS, normalizeId(conversationId));
    return [...(conversation?.lastOptions ?? [])];
  }

  /**
   * Everything `classify()` and `resolveReference()` need to read a short
   * message correctly.
   */
  context(conversationId) {
    const id = normalizeId(conversationId);
    const conversation = this.store.get(CONVERSATIONS, id) ?? this.ensure(id);
    const activeProjectId = conversation.projectId ?? null;

    const recentProjects = this.store
      .all(PROJECTS)
      .filter((p) => p && p.id)
      .map((p) => ({ id: p.id, title: p.title ?? '', updatedAt: p.updatedAt ?? p.createdAt ?? 0 }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, RECENT_PROJECTS);

    const openQuestion = this._openQuestion(activeProjectId);
    const stored = conversation.lastOptions ?? [];
    // Falling back to the open question's options means a decision card can be
    // answered with "the second one" without anyone having to mirror the list.
    const lastOptions = stored.length ? [...stored] : [...(openQuestion?.options ?? [])];

    return {
      conversationId: id,
      activeProjectId,
      recentProjects,
      openQuestion,
      lastOptions,
      recentTurns: this.history(id, 5),
      turnCount: conversation.turnCount ?? 0,
    };
  }

  _openQuestion(activeProjectId) {
    const open = this.store.find(QUESTIONS, (q) => q && q.status === 'open');
    if (!open.length) return null;
    const scoped = activeProjectId ? open.filter((q) => q.projectId === activeProjectId) : [];
    const pool = scoped.length ? scoped : open;
    const chosen = pool.reduce((best, q) => (best === null || (q.askedAt ?? 0) >= (best.askedAt ?? 0) ? q : best), null);
    return chosen ? { ...chosen, options: [...(chosen.options ?? [])] } : null;
  }
}

function copyConversation(conversation) {
  return {
    ...conversation,
    projectIds: [...(conversation.projectIds ?? [])],
    lastOptions: [...(conversation.lastOptions ?? [])],
  };
}

/** Callers get their own copy — the store's records stay immutable from outside. */
function copyTurn(turn) {
  return { ...turn, meta: { ...(turn.meta ?? {}) } };
}

function normalizeId(conversationId) {
  const id = String(conversationId ?? '').trim();
  if (!id) throw new TypeError('ConversationService: conversationId is required');
  return id;
}
