# Jarvis module contracts

Every module is ESM (`.js`, `type: module`), zero runtime npm dependencies, Node >= 22.
Nothing may import a package that is not a `node:` builtin or another file in this repo.
Time comes from an injected `clock` (`src/core/clock.js`) — never call `Date.now()` directly
outside `SystemClock`. Tests use `FakeClock`.

Already implemented (do not modify):
- `src/core/clock.js` — `SystemClock`, `FakeClock{advance(ms), set(ms)}`, `systemClock`
- `src/core/ids.js` — `newId(prefix)`, `dedupeKey(...parts)`
- `src/core/logger.js` — `createLogger(scope, {level, sink})`
- `src/core/bus.js` — `EventBus{on,off,once,emit,since(afterSeq),lastSeq}`; `emit` returns `{seq,type,payload}`
- `src/core/store.js` — `Store{put,patch,get,delete,all,ids,find,flush,compact}` over `(collection, id, value)`

## Shared record shapes (stored via `Store`)

```
Project    { id, title, goal, conversationId, status, phase, evaluationOnly, scope: string[],
             createdAt, updatedAt, planRevision, blockedReason|null, deliverableIds: string[] }
  status: 'active'|'paused'|'stopped'|'blocked'|'delivered'|'evaluated'
  phase:  'planning'|'implementing'|'verifying'|'reviewing'|'repairing'|'delivering'|'idle'
Mission    { id, projectId, summary, acceptance: string[], createdAt }
Plan       { id, projectId, revision, taskIds: string[], rationale, createdAt }
Task       { id, projectId, planId, title, kind, status, attempts, dependsOn: string[],
             blockedByQuestionId|null, result|null, error|null, createdAt, startedAt, finishedAt }
  kind:   'implement'|'verify'|'review'|'repair'|'deliver'
  status: 'pending'|'running'|'done'|'failed'|'blocked'|'cancelled'
Question   { id, projectId, taskId|null, text, recommendedDefault, options: string[],
             status: 'open'|'answered', answer|null, askedAt, answeredAt|null }
Deliverable{ id, projectId, title, kind: 'summary'|'file'|'link', body, createdAt }
```

Collections: `projects`, `missions`, `plans`, `tasks`, `questions`, `deliverables`,
`conversations`, `turns`, `capacity`, `speech`, `backlog`, `settings`.

## Bus event vocabulary (exact strings)

Emitted by orchestrator / workers:
`project.created` `project.updated` `project.phase` `project.blocked` `project.delivered`
`project.paused` `project.resumed` `project.stopped` `project.evaluated` `project.changed`
`plan.revised` `task.started` `task.completed` `task.failed` `task.retrying` `task.blocked`
`question.asked` `question.answered` `worker.started` `worker.crashed` `worker.recovered`
`backlog.picked` `backlog.empty` `action.current` (payload `{text}`)

Emitted by telemetry: `capacity.updated` (payload = the full report), `capacity.unavailable`.
Emitted by chat: `chat.message` (payload `{turn}`).
Emitted by speech: `speech.say` (payload = `SpeechItem`).

Every payload MUST include `projectId` when a project is involved.

---

## A. `src/telemetry/*` — real subscription telemetry (acceptance req. 5)

### `src/telemetry/providers/claude-cli.js`
```js
export function resolveOAuthToken({ env = process.env, fs, home, exec } = {}) -> { token, source } | null
export class ClaudeSubscriptionProvider {
  constructor({ clock, fetchImpl = globalThis.fetch, baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
                tokenResolver = resolveOAuthToken, logger } )
  name = 'claude-subscription'
  async measure() -> Measurement
}
export function normalizeUsagePayload(payload, { clock, measuredAt }) -> CapacityWindow[]
export function humanizeWindowKey(key) -> string   // 'five_hour' -> '5-hour', 'seven_day_opus' -> '7-day (Opus)'
```
`Measurement` = `{ ok: true, source, measuredAt, windows: CapacityWindow[] }`
            or `{ ok: false, source, measuredAt, reason, message, remedy }`
`reason` ∈ `'not_authenticated'|'unauthorized'|'network'|'unsupported'|'malformed'`

`CapacityWindow` = `{ key, label, utilization /*0..1*/, usedPercent /*0..100*/, remainingPercent,
                      resetsAt /*epoch ms|null*/, unit: 'percent', source, measuredAt }`

Rules:
- Authenticate with `Authorization: Bearer <oauth token>` plus
  `anthropic-beta: oauth-2025-04-20`, against `GET {baseUrl}/api/oauth/usage`.
- Token resolution order: `CLAUDE_CODE_OAUTH_TOKEN` env → `$HOME/.claude/.credentials.json`
  (`claudeAiOauth.accessToken`) → macOS keychain via
  `security find-generic-password -s "Claude Code-credentials" -w` (only when `process.platform === 'darwin'`).
- **Never** use `ANTHROPIC_API_KEY` — that would silently bill paid API usage. If only an API key is
  present, return `ok:false, reason:'not_authenticated'` with a remedy naming `claude setup-token`.
- Never log or return the token itself. `measure()` must not throw; it returns `ok:false` instead.
- `normalizeUsagePayload` accepts BOTH `{five_hour:{utilization,resets_at}, ...}` object-of-windows
  and `{windows:[{key|name,utilization,resets_at}]}` array shapes. `utilization` may arrive as
  0..1 or 0..100 — treat > 1 as a percentage. Unknown/aberrant values (null, NaN, negative) cause the
  window to be dropped, never coerced to 0. If no window survives → `reason:'malformed'`.

### `src/telemetry/usage.js`
```js
export class UsageService {
  constructor({ store, bus, clock, provider, staleAfterMs = 15*60_000, logger })
  async refresh() -> Report          // calls provider, persists, emits capacity.updated/unavailable
  ingestWorkerReport(measurement)    // worker-report path; same shape as provider Measurement
  report() -> Report                 // pure read, no I/O
  windowsForScheduling() -> CapacityWindow[]   // [] when unknown
}
```
`Report` = `{ status, measuredAt|null, ageMs|null, timezone, windows: DisplayWindow[],
              explanation|null, recovery|null, lastError|null, staleAfterMs }`
`status` ∈ `'live'|'stale'|'unavailable'`
`DisplayWindow` = CapacityWindow + `{ resetsAtLocal: string|null, freshness: 'live'|'stale' }`

Rules (these are the acceptance criteria — encode them in tests):
- Fresh successful measurement → `status:'live'`, `ageMs` small.
- Measurement older than `staleAfterMs`, or the latest refresh failed but a previous reading exists →
  `status:'stale'` with the **last known** windows and a truthful `ageMs`. Never present it as live.
- Never any valid reading → `status:'unavailable'`, `windows: []`, non-null `explanation` AND
  `recovery`. **Unknown must never render as 0%** — the service must not emit a 0-utilization window
  as a stand-in for "unknown".
- Persist the last good snapshot in `store` collection `capacity` under id `'last'` so it survives
  restart; reload it in the constructor.
- `resetsAtLocal` formatted in `clock.timezone()` via `Intl.DateTimeFormat`.

### `src/telemetry/report.js`
```js
export function summarizeForSpeech(report) -> string|null   // null when nothing worth saying
export function worstRemaining(report) -> number|null       // min remainingPercent across windows, null if unknown
```

## B. `src/orchestrator/*` — the autonomous loop (acceptance req. 1)

### `src/orchestrator/retry.js`
```js
export function classifyError(err) -> 'transient'|'capacity'|'permission'|'credential'|'fatal'
export async function withRetry(fn, { clock, attempts = 3, baseDelayMs = 200, factor = 2, jitter = 0,
                                      onRetry, isRetryable = defaultIsRetryable }) -> result
export class RetryBudget { constructor({ maxAttempts }); consume(key) -> bool; reset(key); attemptsFor(key) }
```
- `withRetry` retries only `transient` and `capacity` classes, sleeps via `clock.sleep`, and rethrows
  the last error once the bounded attempts are spent. `permission`/`credential`/`fatal` never retry.
- `classifyError` inspects `err.code`, `err.status`, `err.message`: `ECONNRESET|ETIMEDOUT|EAI_AGAIN|
  502|503|504|'timeout'|'socket hang up'` → transient; `429|'rate limit'|'capacity'|'overloaded'` →
  capacity; `401|403|'unauthorized'|'forbidden'|'permission'` → permission;
  `'credential'|'not authenticated'|'api key'|'token expired'` → credential; else fatal.

### `src/orchestrator/question.js`
```js
export class QuestionGate {
  constructor({ store, bus, clock })
  ask({ projectId, taskId, text, recommendedDefault, options }) -> Question   // idempotent per (projectId,text)
  answer(questionId, answer) -> Question
  open(projectId) -> Question[]
  isMaterial({ text, recommendedDefault, impact }) -> bool
}
```
- `ask` must refuse duplicates: asking the same `text` for the same project while one is open returns
  the existing question and emits nothing new.
- `answer` emits `question.answered`; the orchestrator listens and resumes.
- `isMaterial` returns false when a `recommendedDefault` exists AND `impact !== 'high'` — routine
  choices get decided, not asked (acceptance req. 1: no repeated routine approval stops).

### `src/orchestrator/backlog.js`
```js
export class Backlog {
  constructor({ store, bus, clock })
  add({ title, goal, source, authorized = true }) -> item
  next() -> item|null            // only `authorized && status==='pending'`, FIFO; emits backlog.picked/backlog.empty
  complete(itemId); size()
}
```
- `next()` returns null when empty and MUST NOT synthesize work (acceptance req. 1: "Do not invent
  endless additional work").

### `src/orchestrator/lifecycle.js`
```js
export const PHASES = ['planning','implementing','verifying','reviewing','repairing','delivering']
export function nextPhase(current, { repairsNeeded }) -> string|'done'
export function isTerminal(status) -> bool
export function canRun(project) -> bool     // false when paused/stopped/blocked/delivered/evaluated
```
- Order: planning → implementing → verifying → reviewing → (repairing → verifying)* → delivering → done.
- `nextPhase('reviewing', {repairsNeeded:true})` → `'repairing'`; `nextPhase('repairing', ...)` → `'verifying'`.

### `src/orchestrator/orchestrator.js`
```js
export class Orchestrator {
  constructor({ store, bus, clock, scheduler, pool, questions, backlog, speech, usage, planner, logger })
  async submit({ conversationId, title, goal, evaluationOnly = false, scope = [] }) -> Project
  async applyChange(projectId, changeText) -> Project    // revises the CURRENT project; never creates a new one
  pause(projectId); resume(projectId); stop(projectId)
  async run(projectId) -> Project        // drives the whole loop to completion; resolves when terminal
  async drain() -> void                  // runs everything runnable + then pulls backlog items
  status(projectId) -> { project, mission, plan, tasks, openQuestions, deliverables, currentAction }
  currentAction() -> string              // ONE short sentence, first person
}
```
Behavioural requirements (each needs a test):
1. `submit()` with `evaluationOnly:false` runs plan → implement → verify → review → (repair) → deliver
   **without any further input**, ending `status:'delivered'` with >= 1 deliverable.
2. `submit()` with `evaluationOnly:true` produces exactly one evaluation deliverable and ends
   `status:'evaluated'` with **zero** implement/verify/review tasks executed.
3. `applyChange()` during an in-flight build mutates the same project: `planRevision` increments, new
   tasks are appended, and `store.all('projects').length` does not grow. Prior agreed scope is kept
   (the new scope array is a superset of the old).
4. A task whose executor throws a transient error is retried up to the bounded limit and then repaired;
   the loop still reaches `delivered`.
5. A task that raises a credential/permission error transitions the project to `status:'blocked'` with
   a `blockedReason` naming precisely what is needed — and the loop stops retrying it.
6. `pause`/`stop` are honoured within one task boundary; `resume` continues from saved state.
7. A material question blocks only its dependent task; independent pending tasks still run. Answering
   it resumes automatically without a new user command.
8. After delivering, `drain()` picks the next authorized backlog item and stops when the backlog is
   empty (emits `backlog.empty`, never invents work).
9. `currentAction()` is always one sentence, first person, present tense, <= 120 chars.

`planner` is an injected object `{ async plan(project, {change}) -> {summary, acceptance:string[], tasks:[{title,kind,dependsOn?}], rationale} }`.
A default deterministic planner lives in `src/orchestrator/planner.js` (same file family) and needs no model access.

### `src/orchestrator/scheduler.js`
```js
export class Scheduler {
  constructor({ clock, usage, bus, maxConcurrency = 4, minConcurrency = 1, logger })
  concurrency() -> number        // derived from usage.windowsForScheduling()
  paceDelayMs() -> number        // inter-task delay
  describe() -> { concurrency, paceDelayMs, basis: 'live'|'stale'|'unknown', worstRemainingPercent|null }
  async gate() -> void           // awaits paceDelayMs via clock.sleep, and blocks while concurrency is 0
}
```
- worstRemaining >= 50% → `maxConcurrency`, no pacing.
- 20–50% → half (rounded up, >= minConcurrency), pace 250ms.
- 5–20% → `minConcurrency`, pace 2000ms.
- < 5% → `minConcurrency`, pace 10000ms.
- unknown (`status:'unavailable'`) → conservative: `min(2, maxConcurrency)`, pace 500ms, `basis:'unknown'`.
- Stale readings are used but reported as `basis:'stale'`.
**This must actually change work concurrency and timing** — the pool asks the scheduler, and a test
proves that a low-capacity report reduces observed peak concurrency.

## C. `src/workers/*` — execution + recovery

### `src/workers/worker.js`
```js
export class Worker {
  constructor({ id, clock, executor, bus, logger })   // executor: async (task, ctx) => result
  async run(task, ctx) -> result   // emits worker.started; throws on failure
  get id()
}
export function createEchoExecutor(opts) -> executor   // deterministic default used in tests/demo
```
### `src/workers/pool.js`
```js
export class WorkerPool {
  constructor({ clock, bus, scheduler, size = 4, executor, maxCrashRestarts = 3, logger })
  async submit(task, ctx) -> result      // honours scheduler.concurrency() and scheduler.gate()
  get peakConcurrency()                  // observed peak, for tests
  get inFlight()
  async shutdown()
  stats() -> { size, inFlight, peakConcurrency, restarts, crashed }
}
```
- A worker that throws a **transient** error is restarted (emit `worker.crashed` then
  `worker.recovered`) up to `maxCrashRestarts`, and the task is retried by the pool.
- The pool must never exceed `scheduler.concurrency()` in-flight tasks; `peakConcurrency` proves it.
- The pool re-reads `scheduler.concurrency()` before each dispatch so capacity changes take effect mid-run.

## D. `src/chat/*` — chat is the complete interface (acceptance req. 2)

### `src/chat/intent.js`
```js
export function classify(text, ctx) -> Intent
```
`Intent` = `{ kind, confidence, payload }`, `kind` ∈
`'build'|'evaluate_only'|'change'|'pause'|'stop'|'resume'|'status'|'answer'|'reminder'|'approve'|'question'|'chitchat'`
- "evaluate only", "don't build yet", "just assess", "review only" → `evaluate_only` (must win over `build`).
- "pause" → pause; "stop"/"cancel"/"abort" → stop; "continue"/"resume"/"keep going" → resume.
- "change that", "instead", "also add", "make it ..." while a project is active → `change`.
- "what's the status", "how's it going", "where are we" → `status`.
- A bare answer while a question is open → `answer` (ctx carries `openQuestion`).
- Never classify as `build` when an explicit stop/pause/evaluate marker is present.

### `src/chat/reference.js`
```js
export function resolveReference(text, ctx) -> { projectId|null, questionId|null, optionIndex|null, kind }
```
`ctx` = `{ conversationId, activeProjectId, recentProjects: [{id,title,updatedAt}], openQuestion, lastOptions: string[] }`
- "change that" / "it" / "this" → `activeProjectId`.
- "the second option" / "option 2" / "the first one" → `optionIndex` (0-based) resolved against `lastOptions`.
- "continue" → `activeProjectId`.
- Names a project by title fragment → that project's id.
- Genuinely ambiguous (two recent projects match equally, no active project) → `{ kind:'ambiguous' }`
  so the caller asks. Do NOT guess in that case.

### `src/chat/conversation.js`
```js
export class ConversationService {
  constructor({ store, bus, clock })
  ensure(conversationId) -> conversation
  append(conversationId, { role, text, meta }) -> turn      // emits chat.message
  history(conversationId, limit) -> turn[]
  bindProject(conversationId, projectId); activeProject(conversationId) -> projectId|null
  setLastOptions(conversationId, options: string[]); lastOptions(conversationId) -> string[]
  context(conversationId) -> ctx    // the ctx object above, ready for classify/resolveReference
}
```

## E. `src/voice/*` — speech (acceptance req. 3)

### `src/voice/policy.js`
```js
export const SPEAK_ALWAYS = ['project.delivered','project.blocked','question.asked','feature.completed']
export function shouldSpeak(event, { settings, clock }) -> { speak: bool, reason, priority }
export function inQuietHours(clock, settings) -> bool
export function batchable(eventType) -> bool
```
- Muted → never speak (except nothing; mute wins).
- Quiet hours (`settings.quietHours = {start:'22:00', end:'07:00', timezone}`) → suppress everything
  except `project.blocked` and `question.asked`. Must handle windows that cross midnight.
- Minor progress (`task.completed`, `task.started`, `project.phase`) is `batchable`.

### `src/voice/speech.js`
```js
export class SpeechService {
  constructor({ store, bus, clock, settings, batchWindowMs = 4000 })
  consider(event) -> SpeechItem|null      // dedupe + policy + batching
  flushBatch() -> SpeechItem|null         // emits the batched summary
  pending() -> SpeechItem[]
  acknowledge(seq)                        // client confirms spoken; persisted so refresh never replays
  unspoken(sinceSeq) -> SpeechItem[]
  setSettings(partial)
}
```
`SpeechItem` = `{ seq, text, priority: 'high'|'normal', at, key }`
- **Never speak the same event twice**: `key` = `dedupeKey(type, projectId, salientId)`; a key already
  spoken (or already queued) is dropped.
- **Never replay old updates after refresh**: `unspoken(sinceSeq)` returns only items newer than the
  client's acknowledged sequence AND not acknowledged; acknowledgements persist in `store`.
- The spoken text must be the SAME concise sentence shown in chat.

## F. `public/*` — dashboard (acceptance req. 4)

Single page, no build step, no CDN. Default view contains ONLY:
animated core; one current-action sentence; chat composer + accessible transcript; compact mode/health
controls; usage circles. A decision card appears only when `openQuestions.length > 0`. Deliverables
appear only when present. Diagnostics/logs/project management live in drawers or secondary tabs.
Usage circles render `status`, per-window percent, remaining, reset time in local tz, freshness age;
`unavailable` renders a dashed grey ring reading "Unavailable" with an expandable explanation +
recovery button — never a 0% ring.

## G. `src/api/routes.js` + `src/server.js` — integration (owned by the lead, do not create)

---

## Testing rules

- `node --test`. Every module gets `test/unit/<name>.test.js`.
- No network in tests: inject `fetchImpl`. No real timers: inject `FakeClock`. No real `$HOME` reads.
- Acceptance tests live in `test/acceptance/` and are named after the requirement they prove.
- Tests must fail for the right reason — assert on values, not on "no throw".
