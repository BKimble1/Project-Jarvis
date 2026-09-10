import { classify } from './intent.js';
import { resolveReference } from './reference.js';
import { summarizeForSpeech } from '../telemetry/report.js';

/**
 * Turns plain chat into action (acceptance requirement 2). Everything Blake can
 * do — describe work, change direction, approve, pause, ask for status, answer
 * a question, set a reminder — arrives here as a sentence and leaves as a short
 * first-person reply (acceptance requirement 3).
 */
export class ChatDispatcher {
  constructor({ orchestrator, conversations, questions, backlog, usage, speech, clock, store, bus }) {
    this.orchestrator = orchestrator;
    this.conversations = conversations;
    this.questions = questions;
    this.backlog = backlog;
    this.usage = usage;
    this.speech = speech;
    this.clock = clock;
    this.store = store;
    this.bus = bus;
  }

  /** @returns {Promise<{reply:string, intent:object, projectId:string|null, ask:object|null}>} */
  async handle({ conversationId, text }) {
    const clean = String(text ?? '').trim();
    this.conversations.ensure(conversationId);
    this.conversations.append(conversationId, { role: 'user', text: clean });

    const ctx = this.conversations.context(conversationId);
    const manage = detectReminderOp(clean);
    const intent = manage
      ? { kind: 'reminder_manage', confidence: 0.9, payload: manage }
      : reclassify(classify(clean, ctx), clean, ctx);
    const ref = resolveReference(clean, ctx);
    const out = await this._act({ conversationId, text: clean, intent, ref, ctx });

    this.conversations.append(conversationId, {
      role: 'assistant',
      text: out.reply,
      meta: { intent: intent.kind, projectId: out.projectId ?? null },
    });
    return { ...out, intent };
  }

  async _act({ conversationId, text, intent, ref, ctx }) {
    switch (intent.kind) {
      case 'answer': return this._answer(conversationId, text, ctx);
      case 'evaluate_only': return this._start(conversationId, intent, { evaluationOnly: true });
      case 'build': return this._start(conversationId, intent, { evaluationOnly: false });
      case 'change': return this._change(conversationId, text, intent, ref, ctx);
      case 'pause': return this._control(ref, ctx, 'pause');
      case 'stop': return this._control(ref, ctx, 'stop');
      case 'resume': return this._control(ref, ctx, 'resume');
      case 'status': return this._status(ref, ctx);
      case 'reminder': return this._reminder(conversationId, intent, text);
      case 'reminder_manage': return this._manageReminders(conversationId, intent.payload);
      case 'approve': return this._approve(conversationId, ctx);
      case 'question': return this._question(text, ctx);
      default: return this._smalltalk(text, ctx);
    }
  }

  async _start(conversationId, intent, { evaluationOnly }) {
    const goal = intent.payload?.text || intent.payload?.goal || '';
    const project = await this.orchestrator.submit({
      conversationId,
      title: intent.payload?.title || titleFrom(goal),
      goal,
      evaluationOnly,
    });
    this.conversations.bindProject(conversationId, project.id);
    if (project.status === 'paused') {
      return {
        projectId: project.id,
        ask: null,
        reply: `I'm held in paused mode, so I've saved ${project.title} without starting it. Switch to autonomous and I'll run it.`,
      };
    }
    return {
      projectId: project.id,
      ask: null,
      reply: evaluationOnly
        ? `I'm evaluating ${project.title} now — no code until you say go.`
        : `I'm on it: ${project.title}. I'll build, verify and deliver it, and tell you when it's done.`,
    };
  }

  async _change(conversationId, text, intent, ref, ctx) {
    const projectId = ref.projectId ?? ctx.activeProjectId;
    if (!projectId) {
      if (ref.kind === 'ambiguous' && ctx.recentProjects?.length > 1) {
        const options = ctx.recentProjects.slice(0, 3).map((p) => p.title);
        this.conversations.setLastOptions(conversationId, options);
        return { projectId: null, ask: { options }, reply: `Which one should I change — ${options.join(', ')}?` };
      }
      return { projectId: null, ask: null, reply: `I don't have a project in flight to change. Tell me what to build and I'll start.` };
    }
    const change = intent.payload?.text || text;
    const project = await this.orchestrator.applyChange(projectId, change);
    this.conversations.bindProject(conversationId, projectId);
    return { projectId, ask: null, reply: `Folded that into ${project.title} — same project, I'm carrying on.` };
  }

  _control(ref, ctx, action) {
    const projectId = ref.projectId ?? ctx.activeProjectId;
    if (!projectId) return { projectId: null, ask: null, reply: `Nothing is running right now.` };
    const project = this.orchestrator[action](projectId);
    if (!project) return { projectId: null, ask: null, reply: `I couldn't find that project.` };
    const said = { pause: 'Paused', resume: 'Back on it', stop: 'Stopped' }[action];
    return { projectId, ask: null, reply: `${said}: ${project.title}.` };
  }

  _status(ref, ctx) {
    const projectId = ref.projectId ?? ctx.activeProjectId;
    if (!projectId) {
      const note = this._capacityNote();
      return { projectId: null, ask: null, reply: `Nothing in flight — give me something to build.${note ? ` ${note}` : ''}` };
    }
    const s = this.orchestrator.status(projectId);
    if (!s) return { projectId: null, ask: null, reply: `I couldn't find that project.` };
    const q = s.openQuestions[0];
    if (q) return { projectId, ask: null, reply: `${s.currentAction} I still need to know: ${q.text}` };
    return {
      projectId,
      ask: null,
      reply: [`${s.currentAction} ${s.progress.done} of ${s.progress.total} steps done.`, this._capacityNote()]
        .filter(Boolean)
        .join(' '),
    };
  }

  /**
   * A sentence about capacity, but only when it is genuinely worth saying —
   * it changes how fast the work can go, so it belongs in a status answer.
   */
  _capacityNote() {
    if (!this.usage?.report) return null;
    try {
      const report = this.usage.report();
      const note = summarizeForSpeech(report, { previous: this._lastCapacityForStatus ?? null });
      this._lastCapacityForStatus = report;
      return note;
    } catch {
      return null;
    }
  }

  _answer(conversationId, text, ctx) {
    const question = ctx.openQuestion;
    if (!question) return { projectId: ctx.activeProjectId ?? null, ask: null, reply: `Nothing is waiting on an answer from you.` };
    const answered = this.questions.answer(question.id, text);
    return {
      projectId: answered?.projectId ?? ctx.activeProjectId ?? null,
      ask: null,
      reply: `Got it — ${truncate(text, 60)}. Carrying on.`,
    };
  }

  _approve(conversationId, ctx) {
    const question = ctx.openQuestion;
    if (question) {
      this.questions.answer(question.id, question.recommendedDefault ?? 'approved');
      return { projectId: question.projectId, ask: null, reply: `Approved — going with ${truncate(question.recommendedDefault ?? 'the default', 50)}.` };
    }
    return { projectId: ctx.activeProjectId ?? null, ask: null, reply: `Nothing needs approving — I'm carrying on.` };
  }

  _reminder(conversationId, intent, text) {
    const item = this.backlog.add({
      title: intent.payload?.text || text,
      goal: intent.payload?.text || text,
      source: 'reminder',
      authorized: false,
    });
    return { projectId: null, ask: null, reply: `Noted: ${truncate(item.title, 70)}.` };
  }

  /** List, start or drop a reminder — all of it from chat. */
  _manageReminders(conversationId, { action, query }) {
    const held = this.backlog.items().filter((i) => i.status === 'pending');

    if (action === 'list') {
      if (held.length === 0) return { projectId: null, ask: null, reply: `You have no reminders.` };
      const titles = held.map((i) => i.title);
      this.conversations.setLastOptions(conversationId, titles);
      return {
        projectId: null,
        ask: { options: titles },
        reply: `${held.length === 1 ? 'One reminder' : `${held.length} reminders`}: ${titles.join('; ')}.`,
      };
    }

    const target = bestMatch(held, query) ?? (held.length === 1 ? held[0] : null);
    if (!target) {
      return {
        projectId: null,
        ask: null,
        reply: held.length
          ? `Which one — ${held.map((i) => i.title).join(', ')}?`
          : `You have no reminders.`,
      };
    }

    if (action === 'drop') {
      this.backlog.complete(target.id);
      return { projectId: null, ask: null, reply: `Dropped: ${truncate(target.title, 60)}.` };
    }

    this.backlog.authorize(target.id);
    const run = this.orchestrator.drain();
    if (run && typeof run.catch === 'function') run.catch(() => {});
    return { projectId: null, ask: null, reply: `On it: ${truncate(target.title, 60)}.` };
  }

  _question(text, ctx) {
    if (/usage|capacity|limit|quota/i.test(text) && this.usage) {
      const r = this.usage.report();
      if (r.status === 'unavailable') {
        return { projectId: null, ask: null, reply: `I can't read your subscription usage right now — ${r.explanation}` };
      }
      const worst = [...r.windows].sort((a, b) => a.remainingPercent - b.remainingPercent)[0];
      const staleNote = r.status === 'stale' ? ' (last known reading)' : '';
      return {
        projectId: null,
        ask: null,
        reply: worst
          ? `Your ${worst.label} window is ${Math.round(worst.usedPercent)}% used, ${Math.round(worst.remainingPercent)}% left${staleNote}.`
          : `I have no usable capacity reading yet.`,
      };
    }
    return this._status({ projectId: null }, ctx);
  }

  _smalltalk(text, ctx) {
    if (!text) return { projectId: null, ask: null, reply: `I'm here — what should I build?` };
    return { projectId: ctx.activeProjectId ?? null, ask: null, reply: `I'm here. Describe what you want and I'll build it.` };
  }
}

/**
 * An explicit "change it/that" with a plausible referent is a change even when
 * the wording also reads like a fresh brief — otherwise a reference we cannot
 * resolve would silently fork a second project.
 */
function reclassify(intent, text, ctx) {
  if (intent.kind !== 'build') return intent;
  if (!looksLikeChange(text) || !hasReferent(ctx)) return intent;
  return { ...intent, kind: 'change', payload: { ...intent.payload, text, reclassified: 'build->change' } };
}

/** "change that", "update it", "instead of ..." — an edit to existing work. */
function looksLikeChange(text) {
  const t = String(text ?? '').trim();
  return /^(?:change|update|modify|tweak|adjust|revise|rework)\s+(?:it|that|this|the project|the build)\b/i.test(t)
    || /\b(?:instead of|rather than)\b/i.test(t);
}

function hasReferent(ctx) {
  return Boolean(ctx?.activeProjectId) || (ctx?.recentProjects?.length ?? 0) > 0;
}

/** Recognise the three things Blake does with a reminder: see them, start one, drop one. */
function detectReminderOp(text) {
  const t = String(text ?? '').trim();
  if (!/\breminders?\b|\bbacklog\b/i.test(t)) return null;
  if (/^(?:remind me|set a reminder)\b/i.test(t)) return null;              // that is creating one
  if (/^(?:build|make|create|write|set ?up|implement|add|design)\b/i.test(t)) return null; // a brief that merely says "reminders"

  if (/\b(?:cancel|drop|forget|remove|delete|clear)\b/i.test(t)) return { action: 'drop', query: stripReminderWords(t) };
  if (/\b(?:go ahead|start|run|action|approve|pick up|do the|do that|do it)\b/i.test(t)) return { action: 'start', query: stripReminderWords(t) };
  if (/\b(?:list|show|what(?:'s| is| are)?|any|see|read|how many)\b/i.test(t)) return { action: 'list', query: '' };
  return { action: 'list', query: '' };
}

function stripReminderWords(text) {
  return String(text)
    .replace(/\b(?:the|my|that|this|a|an|please|now|reminder|reminders|backlog|item|go ahead with|go ahead|cancel|drop|forget|remove|delete|clear|do|start|run|build|action|approve|pick up)\b/gi, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pick the item sharing the most words with the query; null when nothing matches. */
function bestMatch(items, query) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const title = String(item.title ?? '').toLowerCase();
    const score = words.filter((w) => title.includes(w)).length;
    if (score > bestScore) { best = item; bestScore = score; }
  }
  return bestScore > 0 ? best : null;
}

function titleFrom(goal) {
  const t = String(goal ?? '').replace(/\s+/g, ' ').trim();
  const stripped = t.replace(/^(?:please\s+)?(?:can you\s+)?(?:build|make|create|write|set up)\s+(?:me\s+)?(?:a|an|the)?\s*/i, '');
  return (stripped || t || 'Untitled project').slice(0, 70);
}

function truncate(text, max) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
