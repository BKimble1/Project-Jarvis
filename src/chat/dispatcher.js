import { classify } from './intent.js';
import { resolveReference } from './reference.js';

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
    const intent = classify(clean, ctx);
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
      const capacity = this.usage?.report?.();
      const cap = capacity && capacity.status !== 'unavailable'
        ? ` Capacity looks ${capacity.status}.`
        : '';
      return { projectId: null, ask: null, reply: `Nothing in flight — give me something to build.${cap}` };
    }
    const s = this.orchestrator.status(projectId);
    if (!s) return { projectId: null, ask: null, reply: `I couldn't find that project.` };
    const q = s.openQuestions[0];
    if (q) return { projectId, ask: null, reply: `${s.currentAction} I still need to know: ${q.text}` };
    return {
      projectId,
      ask: null,
      reply: `${s.currentAction} ${s.progress.done} of ${s.progress.total} steps done.`,
    };
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

function titleFrom(goal) {
  const t = String(goal ?? '').replace(/\s+/g, ' ').trim();
  const stripped = t.replace(/^(?:please\s+)?(?:can you\s+)?(?:build|make|create|write|set up)\s+(?:me\s+)?(?:a|an|the)?\s*/i, '');
  return (stripped || t || 'Untitled project').slice(0, 70);
}

function truncate(text, max) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
