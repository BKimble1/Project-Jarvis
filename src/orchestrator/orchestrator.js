import { newId } from '../core/ids.js';
import { createLogger } from '../core/logger.js';
import { canRun, isTerminal, nextPhase } from './lifecycle.js';
import { classifyError, RetryBudget } from './retry.js';
import { DeterministicPlanner } from './planner.js';

const MAX_REPAIR_ROUNDS = 3;
const LOOP_GUARD = 400;

/**
 * The autonomous loop (acceptance requirement 1).
 *
 * Once work is submitted, Jarvis plans, implements, verifies, reviews, repairs
 * and delivers on its own. It stops only for the three legitimate reasons:
 * an explicit pause/stop, a genuinely material question, or a non-recoverable
 * blocker that needs the operator (credentials, permissions).
 */
export class Orchestrator {
  constructor({
    store, bus, clock, scheduler, pool, questions, backlog,
    speech = null, usage = null, planner = new DeterministicPlanner(),
    settingsProvider = () => ({ mode: 'autonomous' }),
    logger = createLogger('orchestrator'), maxTaskAttempts = 3,
  }) {
    this.store = store;
    this.bus = bus;
    this.clock = clock;
    this.scheduler = scheduler;
    this.pool = pool;
    this.questions = questions;
    this.backlog = backlog;
    // Speech is driven by a bus subscription wired in the server so that every
    // announcement has exactly one source; kept here for callers that want it.
    this.speech = speech;
    this.usage = usage;
    this.planner = planner;
    this.settingsProvider = settingsProvider;
    this.log = logger;
    this.maxTaskAttempts = maxTaskAttempts;

    this._runs = new Map();
    this._changeQueue = new Map();
    this._repairRounds = new Map();
    this._retries = new RetryBudget({ maxAttempts: maxTaskAttempts });
    this._action = 'I am idle and ready for the next request.';

    this.bus.on('question.answered', (evt) => {
      const projectId = evt.payload?.projectId;
      const questionId = evt.payload?.question?.id ?? evt.payload?.questionId;
      if (!projectId || !questionId) return;
      const answer = evt.payload?.question?.answer ?? evt.payload?.answer;
      this._unblockTasksFor(projectId, questionId, answer);
      const project = this._project(projectId);
      if (project?.planApprovalQuestionId === questionId) {
        this._patchProject(projectId, { planApprovalQuestionId: null });
        if (isDeclined(answer)) { this.pause(projectId); return; }
      }
      // Resume automatically — the operator answered, they should not have to
      // also say "continue".
      const p = this.run(projectId);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    });
  }

  // ---------------------------------------------------------------- intake

  /** Create a project and start driving it immediately. */
  async submit({ conversationId = null, title, goal, evaluationOnly = false, scope = [], autostart = true, source = 'chat' }) {
    const now = this.clock.now();
    const project = {
      id: newId('prj'),
      title: (title || firstSentence(goal) || 'Untitled project').slice(0, 120),
      goal: goal ?? title ?? '',
      conversationId,
      status: 'active',
      phase: 'planning',
      evaluationOnly: Boolean(evaluationOnly),
      scope: [...scope],
      source,
      createdAt: now,
      updatedAt: now,
      planRevision: 0,
      repairRounds: 0,
      blockedReason: null,
      deliverableIds: [],
    };
    const mode = this._mode();
    if (mode === 'paused') {
      // The operator has Jarvis held: record the work, start nothing.
      project.status = 'paused';
    }
    this.store.put('projects', project.id, project);
    this.bus.emit('project.created', { projectId: project.id, project });
    this._setAction(project.evaluationOnly
      ? `I am evaluating ${project.title}.`
      : `I am planning ${project.title}.`, project.id);

    if (autostart && project.status === 'active') {
      const p = this.run(project.id);
      if (p && typeof p.catch === 'function') p.catch((err) => this.log.error('run failed', err?.message));
    }
    return project;
  }

  /**
   * Fold a change suggestion into the CURRENT project. Never creates a second
   * project and never drops previously agreed scope.
   */
  async applyChange(projectId, changeText) {
    const project = this._project(projectId);
    if (!project) throw new Error(`Unknown project ${projectId}`);
    if (project.status === 'stopped') throw new Error('That project was stopped; start a new one to continue.');

    if (this._runs.has(projectId)) {
      // A build is in flight: queue it so the loop folds it in at the next
      // task boundary rather than mutating state underneath a running phase.
      const queue = this._changeQueue.get(projectId) ?? [];
      queue.push(changeText);
      this._changeQueue.set(projectId, queue);
      this.bus.emit('project.changed', { projectId, change: changeText, queued: true });
      this._setAction(`I am folding your change into ${project.title}.`, projectId);
      return this._project(projectId);
    }

    const updated = await this._foldChange(project, changeText);
    const p = this.run(projectId);
    if (p && typeof p.catch === 'function') p.catch(() => {});
    return updated;
  }

  async _foldChange(project, changeText) {
    const revision = await this.planner.plan(project, { change: changeText });
    const plan = this._latestPlan(project.id);
    const taskIds = [];
    const keyMap = new Map();

    for (const spec of revision.tasks) {
      const task = this._createTask(project, plan?.id ?? null, spec, keyMap);
      taskIds.push(task.id);
    }

    const mergedScope = unique([...(project.scope ?? []), ...(revision.scope ?? [])]);
    const newPlan = {
      id: newId('pln'),
      projectId: project.id,
      revision: (project.planRevision ?? 0) + 1,
      taskIds: [...(plan?.taskIds ?? []), ...taskIds],
      rationale: revision.rationale,
      change: changeText,
      createdAt: this.clock.now(),
    };
    this.store.put('plans', newPlan.id, newPlan);
    for (const id of taskIds) this.store.patch('tasks', id, { planId: newPlan.id });

    const updated = this._patchProject(project.id, {
      planRevision: newPlan.revision,
      scope: mergedScope,
      status: project.status === 'delivered' || project.status === 'evaluated' ? 'active' : project.status,
      phase: 'implementing',
      blockedReason: null,
    });
    this.bus.emit('plan.revised', { projectId: project.id, plan: newPlan, change: changeText });
    this.bus.emit('project.changed', { projectId: project.id, change: changeText, queued: false, planRevision: newPlan.revision });
    this._setAction(`I am updating ${project.title} with your change.`, project.id);
    return updated;
  }

  // ------------------------------------------------------------- controls

  pause(projectId) {
    const current = this._project(projectId);
    // Pausing something already finished is meaningless; don't rewrite history.
    if (!current || isTerminal(current.status)) return current;
    const p = this._patchProject(projectId, { status: 'paused' });
    if (p) {
      this.bus.emit('project.paused', { projectId, project: p });
      this._setAction(`I paused ${p.title}.`, projectId);
    }
    return p;
  }

  resume(projectId) {
    const project = this._project(projectId);
    if (!project) return null;
    const patch = { status: 'active' };
    if (project.phase === 'idle') patch.phase = 'planning';
    if (project.status === 'blocked') patch.blockedReason = null;
    const p = this._patchProject(projectId, patch);
    this.bus.emit('project.resumed', { projectId, project: p });
    const run = this.run(projectId);
    if (run && typeof run.catch === 'function') run.catch(() => {});
    return p;
  }

  stop(projectId) {
    const current = this._project(projectId);
    if (!current || current.status === 'stopped') return current;
    const p = this._patchProject(projectId, { status: 'stopped' });
    if (p) {
      this.bus.emit('project.stopped', { projectId, project: p });
      this._setAction(`I stopped ${p.title}.`, projectId);
    }
    return p;
  }

  // ------------------------------------------------------------------ run

  /** Drive a project to a terminal state. Idempotent: concurrent calls share one loop. */
  run(projectId) {
    const existing = this._runs.get(projectId);
    if (existing) return existing;
    const promise = this._loop(projectId).finally(() => this._runs.delete(projectId));
    this._runs.set(projectId, promise);
    return promise;
  }

  /** Run everything runnable, then work the authorized backlog until it is empty. */
  async drain({ maxItems = 25 } = {}) {
    const done = [];
    for (const project of this.store.all('projects')) {
      if (canRun(project)) done.push(await this.run(project.id));
    }
    for (let i = 0; i < maxItems; i++) {
      const item = this.backlog.next();
      if (!item) break;
      const project = await this.submit({
        conversationId: item.conversationId ?? null,
        title: item.title,
        goal: item.goal ?? item.title,
        source: item.source ?? 'backlog',
        autostart: false,
      });
      this.store.patch('backlog', item.id, { projectId: project.id });
      done.push(await this.run(project.id));
      this.backlog.complete(item.id);
    }
    return done;
  }

  async _loop(projectId) {
    for (let guard = 0; guard < LOOP_GUARD; guard++) {
      await this._drainChangeQueue(projectId);
      const project = this._project(projectId);
      if (!project) return null;
      if (!canRun(project)) return project;
      if (this._awaitingPlanApproval(project)) return project;

      let outcome;
      switch (project.phase) {
        case 'planning': outcome = await this._phasePlanning(project); break;
        case 'implementing': outcome = await this._phaseTasks(project, ['implement']); break;
        case 'verifying': outcome = await this._phaseTasks(project, ['verify']); break;
        case 'reviewing': outcome = await this._phaseTasks(project, ['review']); break;
        case 'repairing': outcome = await this._phaseRepair(project); break;
        case 'delivering': outcome = await this._phaseDeliver(project); break;
        default: return this._project(projectId);
      }

      if (outcome.halt) return this._project(projectId);
      if (outcome.phase) this._setPhase(projectId, outcome.phase);
    }
    this.log.warn(`loop guard tripped for ${projectId}`);
    return this._project(projectId);
  }

  async _drainChangeQueue(projectId) {
    const queue = this._changeQueue.get(projectId);
    if (!queue?.length) return;
    this._changeQueue.delete(projectId);
    for (const change of queue) {
      const project = this._project(projectId);
      if (!project) return;
      await this._foldChange(project, change);
    }
  }

  // --------------------------------------------------------------- phases

  async _phasePlanning(project) {
    this._setAction(project.evaluationOnly
      ? `I am evaluating ${project.title}.`
      : `I am planning ${project.title}.`, project.id);

    const result = await this.planner.plan(project);
    const mission = {
      id: newId('msn'),
      projectId: project.id,
      summary: result.summary,
      acceptance: result.acceptance ?? [],
      createdAt: this.clock.now(),
    };
    this.store.put('missions', mission.id, mission);

    const planId = newId('pln');
    const keyMap = new Map();
    const taskIds = [];
    for (const spec of result.tasks) {
      const task = this._createTask(project, planId, spec, keyMap);
      taskIds.push(task.id);
    }
    const plan = {
      id: planId,
      projectId: project.id,
      revision: 1,
      taskIds,
      rationale: result.rationale,
      createdAt: this.clock.now(),
    };
    this.store.put('plans', planId, plan);
    this._patchProject(project.id, {
      planRevision: 1,
      scope: unique([...(project.scope ?? []), ...(result.scope ?? [])]),
    });
    this.bus.emit('plan.revised', { projectId: project.id, plan });

    if (project.evaluationOnly) return { phase: 'delivering' };

    if (this._mode() === 'ask-first') {
      // The operator asked to see the plan before anything is built. This is a
      // deliberate setting, not a routine approval stop.
      const scope = (this._project(project.id).scope ?? []).join(', ');
      const question = this.questions.ask({
        projectId: project.id,
        taskId: null,
        text: `I plan to build ${scope || project.title}. Shall I go ahead?`,
        recommendedDefault: 'yes',
        options: ['yes', 'change the plan'],
      });
      this._patchProject(project.id, { planApprovalQuestionId: question.id });
      this._setPhase(project.id, 'implementing');
      this._setAction(`I am waiting for you to okay the plan for ${project.title}.`, project.id);
      return { halt: true };
    }

    // A plan is not a deliverable. Keep going.
    return { phase: 'implementing' };
  }

  async _phaseTasks(project, kinds) {
    const label = { implement: 'building', verify: 'verifying', review: 'reviewing' }[kinds[0]] ?? 'working on';
    this._setAction(`I am ${label} ${project.title}.`, project.id);

    let repairsNeeded = false;
    let sawWork = false;

    for (let round = 0; round < LOOP_GUARD; round++) {
      const current = this._project(project.id);
      if (!current || !canRun(current)) return { halt: true };

      const runnable = this._runnableTasks(project.id, kinds);
      if (runnable.length === 0) break;
      sawWork = true;

      const results = await Promise.all(runnable.map((task) => this._executeTask(current, task)));
      for (const r of results) {
        if (r.blockedProject) return { halt: true };
        if (r.repairsNeeded) repairsNeeded = true;
      }
      if (this._changeQueue.get(project.id)?.length) return { phase: this._project(project.id).phase };
    }

    const all = this._tasks(project.id);
    const pending = all.filter((t) => kinds.includes(t.kind) && (t.status === 'pending' || t.status === 'running'));
    const parked = pending.filter((t) => t.status === 'pending' && t.blockedByQuestionId);
    if (all.some((t) => t.status === 'failed' || t.needsRepair)) repairsNeeded = true;

    // A failure anywhere in this phase goes to repair, whichever phase found it.
    if (repairsNeeded) return { phase: 'repairing' };

    if (parked.length > 0 && this._runnableTasks(project.id, ['implement', 'verify', 'review', 'repair']).length === 0) {
      // Waiting on a genuinely material answer. Progress is saved; the
      // question.answered handler resumes this loop automatically.
      this._setAction(`I am waiting on your answer about ${project.title}.`, project.id);
      return { halt: true };
    }

    if (!sawWork) {
      // Nothing in this phase could run. Fall back to whichever phase still
      // holds runnable work rather than spinning between phases.
      if (all.some((t) => t.kind === 'repair' && t.status === 'pending')) return { phase: 'repairing' };
      if (all.some((t) => t.kind === 'implement' && t.status === 'pending')) return { phase: 'implementing' };
      if (pending.length > 0 && parked.length === 0) {
        return this._block(project.id,
          `I cannot finish ${project.title}: ${pending.length} step(s) depend on work that never completed. Tell me how you want to proceed.`);
      }
    }

    const current = this._project(project.id);
    const phase = nextPhase(current.phase, { repairsNeeded: false });
    return { phase: phase === 'done' ? 'delivering' : phase };
  }

  async _phaseRepair(project) {
    const rounds = (this._project(project.id)?.repairRounds ?? 0) + 1;
    this._repairRounds.set(project.id, rounds);
    this._patchProject(project.id, { repairRounds: rounds });

    if (rounds > MAX_REPAIR_ROUNDS) {
      return this._block(project.id,
        `I could not get ${project.title} passing after ${MAX_REPAIR_ROUNDS} repair rounds. I need you to look at the failing step with me.`);
    }

    this._setAction(`I am repairing ${project.title}.`, project.id);
    const broken = this._tasks(project.id).filter((t) => t.status === 'failed' || t.needsRepair);
    const plan = this._latestPlan(project.id);
    const keyMap = new Map();

    for (const task of broken) {
      const repair = this._createTask(project, plan?.id ?? null, {
        key: `repair:${task.id}`,
        title: `Repair ${task.title}`,
        kind: 'repair',
        dependsOn: [],
        meta: { repairs: task.id, reason: task.error ?? task.result?.reason ?? 'verification failure' },
      }, keyMap);
      if (task.kind === 'verify' || task.kind === 'review') {
        // A check that failed must be re-run after the repair, not discarded.
        this.store.patch('tasks', task.id, {
          status: 'pending', error: null, result: null, needsRepair: false,
          startedAt: null, finishedAt: null, dependsOn: unique([...(task.dependsOn ?? []), repair.id]),
        });
      } else {
        this.store.patch('tasks', task.id, { status: 'cancelled', needsRepair: false, repairedBy: repair.id });
      }
      if (plan) this.store.patch('plans', plan.id, { taskIds: unique([...(plan.taskIds ?? []), repair.id]) });
    }

    for (let round = 0; round < LOOP_GUARD; round++) {
      const runnable = this._runnableTasks(project.id, ['repair']);
      if (runnable.length === 0) break;
      const current = this._project(project.id);
      if (!current || !canRun(current)) return { halt: true };
      const results = await Promise.all(runnable.map((task) => this._executeTask(current, task)));
      if (results.some((r) => r.blockedProject)) return { halt: true };
      if (results.some((r) => r.repairsNeeded)) {
        // The repair itself failed. Don't spin: escalate on the next round.
        break;
      }
    }

    // Repaired work has to be re-proven, so completed checks are reset.
    for (const task of this._tasks(project.id)) {
      if ((task.kind === 'verify' || task.kind === 'review') && task.status === 'done') {
        this.store.patch('tasks', task.id, { status: 'pending', error: null, result: null, needsRepair: false, startedAt: null, finishedAt: null });
      }
    }
    return { phase: 'verifying' };
  }

  async _phaseDeliver(project) {
    this._setAction(`I am delivering ${project.title}.`, project.id);

    const runnable = this._runnableTasks(project.id, ['deliver']);
    for (const task of runnable) {
      const r = await this._executeTask(project, task);
      if (r.blockedProject) return { halt: true };
    }

    const tasks = this._tasks(project.id);
    const outputs = tasks.filter((t) => t.status === 'done' && t.result).map((t) => `${t.title}: ${describeResult(t.result)}`);
    const mission = this.store.find('missions', (m) => m.projectId === project.id).at(-1);
    const evaluation = project.evaluationOnly;

    const deliverable = {
      id: newId('dlv'),
      projectId: project.id,
      title: evaluation ? `Evaluation: ${project.title}` : project.title,
      kind: 'summary',
      body: [
        evaluation ? `Evaluation of ${project.title}.` : `${project.title} is built and verified.`,
        mission?.summary ? `Scope: ${(project.scope ?? []).join(', ') || mission.summary}` : '',
        outputs.length ? `Work completed:\n- ${outputs.join('\n- ')}` : '',
        mission?.acceptance?.length ? `Acceptance:\n- ${mission.acceptance.join('\n- ')}` : '',
      ].filter(Boolean).join('\n\n'),
      createdAt: this.clock.now(),
    };
    this.store.put('deliverables', deliverable.id, deliverable);

    const updated = this._patchProject(project.id, {
      status: evaluation ? 'evaluated' : 'delivered',
      phase: 'idle',
      deliverableIds: unique([...(project.deliverableIds ?? []), deliverable.id]),
    });
    this.bus.emit(evaluation ? 'project.evaluated' : 'project.delivered', {
      projectId: project.id, project: updated, deliverable,
    });
    this._setAction(evaluation
      ? `I finished evaluating ${project.title}.`
      : `I delivered ${project.title}.`, project.id);
    return { halt: true };
  }

  // ------------------------------------------------------------ execution

  async _executeTask(project, task) {
    this.store.patch('tasks', task.id, { status: 'running', startedAt: this.clock.now() });
    this.bus.emit('task.started', { projectId: project.id, taskId: task.id, task: this._task(task.id) });

    const ctx = {
      project: this._project(project.id),
      scope: project.scope ?? [],
      answers: this._answers(project.id),
      attempt: (task.attempts ?? 0) + 1,
      clock: this.clock,
      usage: this.usage,
    };

    try {
      const result = await this.pool.submit(this._task(task.id), ctx);

      if (result && result.needsAnswer) {
        return this._handleNeedsAnswer(project, task, result);
      }

      const failedCheck = result && result.ok === false;
      this.store.patch('tasks', task.id, {
        status: failedCheck ? 'failed' : 'done',
        result,
        error: failedCheck ? (result.reason ?? 'check failed') : null,
        needsRepair: Boolean(failedCheck),
        finishedAt: this.clock.now(),
      });
      this._retries.reset(task.id);

      if (failedCheck) {
        this.bus.emit('task.failed', { projectId: project.id, taskId: task.id, reason: result.reason ?? 'check failed', willRepair: true });
        return { repairsNeeded: true };
      }
      this.bus.emit('task.completed', { projectId: project.id, taskId: task.id, task: this._task(task.id), title: task.title });
      if (task.kind === 'implement') {
        this.bus.emit('feature.completed', { projectId: project.id, taskId: task.id, title: task.title });
      }
      return { ok: true };
    } catch (err) {
      return this._handleTaskError(project, task, err);
    }
  }

  _handleNeedsAnswer(project, task, result) {
    const spec = result.needsAnswer;
    if (!this.questions.isMaterial(spec)) {
      // Routine choice: decide it and keep moving. No approval stop.
      const answer = spec.recommendedDefault;
      this.store.patch('tasks', task.id, {
        status: 'done',
        result: { ...result, autoDecided: true, answer },
        finishedAt: this.clock.now(),
      });
      this.bus.emit('task.completed', { projectId: project.id, taskId: task.id, autoDecided: true, title: task.title });
      return { ok: true };
    }
    const question = this.questions.ask({
      projectId: project.id,
      taskId: task.id,
      text: spec.text,
      recommendedDefault: spec.recommendedDefault,
      options: spec.options ?? [],
    });
    this.store.patch('tasks', task.id, { status: 'pending', blockedByQuestionId: question.id, startedAt: null });
    this.bus.emit('task.blocked', { projectId: project.id, taskId: task.id, questionId: question.id });
    return { parked: true };
  }

  _handleTaskError(project, task, err) {
    const kind = classifyError(err);
    const attempts = (this._task(task.id)?.attempts ?? 0) + 1;
    this.store.patch('tasks', task.id, { attempts, error: err?.message ?? String(err) });

    if (kind === 'credential' || kind === 'permission') {
      const what = kind === 'credential'
        ? `I need working credentials: ${err?.message ?? 'authentication failed'}.`
        : `I need permission: ${err?.message ?? 'the action was refused'}.`;
      this.store.patch('tasks', task.id, { status: 'blocked', finishedAt: this.clock.now() });
      this._block(project.id, `${what} Give me that and I will pick ${project.title} straight back up.`);
      return { blockedProject: true };
    }

    const retryable = kind === 'transient' || kind === 'capacity';
    if (retryable && this._retries.consume(task.id)) {
      this.store.patch('tasks', task.id, { status: 'pending', startedAt: null });
      this.bus.emit('task.retrying', { projectId: project.id, taskId: task.id, attempt: attempts, reason: kind });
      return { retried: true };
    }

    this.store.patch('tasks', task.id, { status: 'failed', needsRepair: true, finishedAt: this.clock.now() });
    this._retries.reset(task.id);
    this.bus.emit('task.failed', { projectId: project.id, taskId: task.id, reason: err?.message ?? String(err), willRepair: true });
    return { repairsNeeded: true };
  }

  _block(projectId, reason) {
    const project = this._patchProject(projectId, { status: 'blocked', blockedReason: reason });
    this.bus.emit('project.blocked', { projectId, project, reason });
    this._setAction(reason.length <= 120 ? reason : `${reason.slice(0, 117)}…`, projectId);
    return { halt: true, blockedProject: true };
  }

  // ---------------------------------------------------------------- state

  status(projectId) {
    const project = this._project(projectId);
    if (!project) return null;
    const tasks = this._tasks(projectId);
    return {
      project,
      mission: this.store.find('missions', (m) => m.projectId === projectId).at(-1) ?? null,
      plan: this._latestPlan(projectId),
      tasks,
      openQuestions: this.questions.open(projectId),
      deliverables: this.store.find('deliverables', (d) => d.projectId === projectId),
      progress: progressOf(tasks),
      currentAction: this.currentAction(projectId),
    };
  }

  currentAction(projectId) {
    if (projectId) {
      const project = this._project(projectId);
      if (project && this._actionProjectId === projectId) return this._action;
      if (project) return describeProject(project);
    }
    return this._action;
  }

  _setAction(text, projectId = null) {
    const sentence = oneSentence(text);
    if (sentence === this._action && projectId === this._actionProjectId) return;
    this._action = sentence;
    this._actionProjectId = projectId;
    this.bus.emit('action.current', { text: sentence, projectId });
  }

  // ------------------------------------------------------------- internals

  _mode() {
    try { return this.settingsProvider()?.mode ?? 'autonomous'; }
    catch { return 'autonomous'; }
  }

  _awaitingPlanApproval(project) {
    const id = project.planApprovalQuestionId;
    if (!id) return false;
    return this.store.get('questions', id)?.status === 'open';
  }

  _project(id) { return this.store.get('projects', id); }
  _task(id) { return this.store.get('tasks', id); }
  _tasks(projectId) { return this.store.find('tasks', (t) => t.projectId === projectId); }

  _latestPlan(projectId) {
    const plans = this.store.find('plans', (p) => p.projectId === projectId);
    return plans.sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0)).at(-1) ?? null;
  }

  _answers(projectId) {
    const out = {};
    for (const q of this.store.find('questions', (q) => q.projectId === projectId)) {
      if (q.status === 'answered') out[q.id] = q.answer;
    }
    return out;
  }

  _patchProject(id, partial) {
    const current = this._project(id);
    if (!current) return null;
    const updated = this.store.patch('projects', id, { ...partial, updatedAt: this.clock.now() });
    this.bus.emit('project.updated', { projectId: id, project: updated });
    return updated;
  }

  _setPhase(projectId, phase) {
    const project = this._project(projectId);
    if (!project || project.phase === phase) return;
    this.store.patch('projects', projectId, { phase, updatedAt: this.clock.now() });
    this.bus.emit('project.phase', { projectId, phase });
  }

  _createTask(project, planId, spec, keyMap) {
    const task = {
      id: newId('tsk'),
      projectId: project.id,
      planId,
      key: spec.key ?? null,
      title: spec.title,
      kind: spec.kind,
      status: 'pending',
      attempts: 0,
      dependsOn: (spec.dependsOn ?? []).map((k) => keyMap.get(k) ?? k),
      blockedByQuestionId: null,
      needsRepair: false,
      meta: spec.meta ?? {},
      result: null,
      error: null,
      createdAt: this.clock.now(),
      startedAt: null,
      finishedAt: null,
    };
    if (spec.key) keyMap.set(spec.key, task.id);
    this.store.put('tasks', task.id, task);
    return task;
  }

  _runnableTasks(projectId, kinds) {
    const tasks = this._tasks(projectId);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return tasks.filter((t) => {
      if (!kinds.includes(t.kind)) return false;
      if (t.status !== 'pending') return false;
      if (t.blockedByQuestionId) {
        const q = this.store.get('questions', t.blockedByQuestionId);
        if (q && q.status === 'open') return false;
      }
      return (t.dependsOn ?? []).every((dep) => {
        const d = byId.get(dep);
        return !d || d.status === 'done' || d.status === 'cancelled';
      });
    });
  }

  _unblockTasksFor(projectId, questionId, answer) {
    for (const task of this._tasks(projectId)) {
      if (task.blockedByQuestionId === questionId) {
        this.store.patch('tasks', task.id, {
          blockedByQuestionId: null,
          status: task.status === 'blocked' ? 'pending' : task.status,
          meta: { ...(task.meta ?? {}), answer },
        });
      }
    }
  }
}

// ------------------------------------------------------------------ helpers

function progressOf(tasks) {
  const total = tasks.filter((t) => t.status !== 'cancelled').length;
  const done = tasks.filter((t) => t.status === 'done').length;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

function describeProject(project) {
  switch (project.status) {
    case 'blocked': return oneSentence(project.blockedReason ?? `I am blocked on ${project.title}.`);
    case 'paused': return oneSentence(`I paused ${project.title}.`);
    case 'stopped': return oneSentence(`I stopped ${project.title}.`);
    case 'delivered': return oneSentence(`I delivered ${project.title}.`);
    case 'evaluated': return oneSentence(`I finished evaluating ${project.title}.`);
    default: return oneSentence(`I am working on ${project.title}.`);
  }
}

function describeResult(result) {
  if (result == null) return 'done';
  if (typeof result === 'string') return result.slice(0, 120);
  if (result.output) return String(result.output).slice(0, 120);
  if (result.summary) return String(result.summary).slice(0, 120);
  return 'done';
}

function oneSentence(text, max = 120) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const first = t.split(/(?<=[.!?])\s/)[0] ?? t;
  if (first.length <= max) return first;
  return `${first.slice(0, max - 1)}…`;
}

function firstSentence(text) {
  return oneSentence(text ?? '', 80);
}

function isDeclined(answer) {
  return /^\s*(?:no\b|nope\b|don'?t\b|stop\b|wait\b|hold\b|not yet\b|change the plan\b)/i.test(String(answer ?? ''));
}

function unique(list) {
  return [...new Set(list.filter((x) => x != null))];
}

export { oneSentence, progressOf };
