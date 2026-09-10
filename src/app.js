import path from 'node:path';
import { EventBus } from './core/bus.js';
import { Store } from './core/store.js';
import { systemClock } from './core/clock.js';
import { createLogger } from './core/logger.js';
import { UsageService } from './telemetry/usage.js';
import { ClaudeSubscriptionProvider } from './telemetry/providers/claude-cli.js';
import { Scheduler } from './orchestrator/scheduler.js';
import { WorkerPool } from './workers/pool.js';
import { createEchoExecutor } from './workers/worker.js';
import { QuestionGate } from './orchestrator/question.js';
import { Backlog } from './orchestrator/backlog.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { DeterministicPlanner } from './orchestrator/planner.js';
import { ConversationService } from './chat/conversation.js';
import { ChatDispatcher } from './chat/dispatcher.js';
import { SpeechService } from './voice/speech.js';

const DEFAULT_SETTINGS = {
  mode: 'autonomous',           // autonomous | ask-first | paused
  muted: false,
  voiceEnabled: true,
  quietHours: { start: '22:00', end: '07:00', enabled: false, timezone: null },
};

/**
 * Composition root. Everything is injectable so tests can drive the whole
 * system with a FakeClock, a stub provider and a scripted executor.
 */
export function createApp({
  dataDir = path.join(process.cwd(), 'data'),
  clock = systemClock,
  fetchImpl = globalThis.fetch,
  provider = null,
  executor = null,
  settings: settingsOverride = {},
  poolSize = 4,
  maxConcurrency = 4,
  staleAfterMs = 15 * 60_000,
  logger = createLogger('app'),
} = {}) {
  const bus = new EventBus({ historyLimit: 1000 });
  const store = new Store({ dir: dataDir, clock });

  const stored = store.get('settings', 'app');
  const settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}), ...settingsOverride };
  settings.quietHours = { ...DEFAULT_SETTINGS.quietHours, ...(stored?.quietHours ?? {}), ...(settingsOverride.quietHours ?? {}) };
  store.put('settings', 'app', settings);

  const usageProvider = provider ?? new ClaudeSubscriptionProvider({ clock, fetchImpl, logger: logger.child('provider') });
  const usage = new UsageService({ store, bus, clock, provider: usageProvider, staleAfterMs, logger: logger.child('usage') });

  const scheduler = new Scheduler({ clock, usage, bus, maxConcurrency, logger: logger.child('scheduler') });
  const pool = new WorkerPool({
    clock, bus, scheduler, size: poolSize,
    executor: executor ?? createEchoExecutor({ clock }),
    logger: logger.child('pool'),
  });

  const questions = new QuestionGate({ store, bus, clock });
  const backlog = new Backlog({ store, bus, clock });
  const speech = new SpeechService({ store, bus, clock, settings });
  const conversations = new ConversationService({ store, bus, clock });

  const orchestrator = new Orchestrator({
    store, bus, clock, scheduler, pool, questions, backlog,
    speech, usage, planner: new DeterministicPlanner(), logger: logger.child('orchestrator'),
    settingsProvider: () => store.get('settings', 'app') ?? settings,
  });

  const dispatcher = new ChatDispatcher({
    orchestrator, conversations, questions, backlog, usage, speech, clock, store, bus,
  });

  // Single source of speech: every bus event is offered to the policy exactly
  // once. Speech's own events are skipped so an utterance cannot feed itself.
  bus.on('*', (evt) => {
    if (typeof evt.type === 'string' && evt.type.startsWith('speech.')) return;
    try { speech.consider(evt); } catch (err) { logger.error('speech.consider failed', err?.message); }
  });

  const app = {
    bus, store, clock, settings, usage, scheduler, pool, questions, backlog,
    speech, conversations, orchestrator, dispatcher, logger, dataDir,

    /** Full snapshot the dashboard renders from. */
    state(conversationId = 'default') {
      const projects = store.all('projects').sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      const activeId = conversations.activeProject(conversationId) ?? projects.find((p) => p.status === 'active')?.id ?? projects[0]?.id ?? null;
      const active = activeId ? orchestrator.status(activeId) : null;
      return {
        seq: bus.lastSeq,
        currentAction: orchestrator.currentAction(activeId),
        settings: store.get('settings', 'app'),
        capacity: usage.report(),
        scheduler: scheduler.describe(),
        conversation: {
          id: conversationId,
          turns: conversations.history(conversationId, 100),
        },
        project: active
          ? {
              id: active.project.id,
              title: active.project.title,
              status: active.project.status,
              phase: active.project.phase,
              progress: active.progress,
              blockedReason: active.project.blockedReason ?? null,
              scope: active.project.scope ?? [],
              planRevision: active.project.planRevision ?? 0,
            }
          : null,
        decision: active?.openQuestions?.[0]
          ? {
              questionId: active.openQuestions[0].id,
              text: active.openQuestions[0].text,
              recommendedDefault: active.openQuestions[0].recommendedDefault,
              options: active.openQuestions[0].options ?? [],
            }
          : null,
        deliverables: (active?.deliverables ?? []).map((d) => ({ id: d.id, title: d.title, kind: d.kind, body: d.body })),
        health: healthOf({ usage, pool, orchestrator, store }),
        projects: projects.slice(0, 20).map((p) => ({ id: p.id, title: p.title, status: p.status, phase: p.phase, updatedAt: p.updatedAt })),
      };
    },

    /** Diagnostics live in a drawer, never on the default dashboard. */
    diagnostics() {
      return {
        capacity: usage.report(),
        scheduler: scheduler.describe(),
        pool: pool.stats(),
        counts: {
          projects: store.ids('projects').length,
          tasks: store.ids('tasks').length,
          questions: store.ids('questions').length,
          deliverables: store.ids('deliverables').length,
          backlog: backlog.size(),
        },
        recentEvents: bus.since(Math.max(0, bus.lastSeq - 100)),
      };
    },

    updateSettings(partial) {
      const current = store.get('settings', 'app') ?? DEFAULT_SETTINGS;
      const merged = { ...current, ...partial };
      if (partial.quietHours) merged.quietHours = { ...current.quietHours, ...partial.quietHours };
      store.put('settings', 'app', merged);
      Object.assign(settings, merged);
      speech.setSettings(merged);
      bus.emit('settings.updated', { settings: merged });
      return merged;
    },

    async close() {
      await pool.shutdown();
      store.flush();
    },
  };

  return app;
}

function healthOf({ usage, pool, orchestrator, store }) {
  const capacity = usage.report();
  const blocked = store.find('projects', (p) => p.status === 'blocked');
  let level = 'ok';
  let detail = 'All systems nominal.';
  if (blocked.length > 0) {
    level = 'attention';
    detail = blocked[0].blockedReason ?? 'A project is blocked.';
  } else if (capacity.status === 'unavailable') {
    level = 'degraded';
    detail = 'Subscription usage is unreadable.';
  } else if (capacity.status === 'stale') {
    level = 'degraded';
    detail = 'Usage reading is stale.';
  }
  return { level, detail, inFlight: pool.inFlight, action: orchestrator.currentAction() };
}

export { DEFAULT_SETTINGS };
