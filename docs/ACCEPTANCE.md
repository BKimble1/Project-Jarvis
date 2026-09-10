# Acceptance requirements → implementation → proof

Every row names the code that satisfies the requirement and the test that
proves it. Run everything with `npm test`.

## 1. Keep working after a request

| Requirement | Implementation | Proof |
| --- | --- | --- |
| Carry a request through to completion | `Orchestrator._loop` phase machine, `src/orchestrator/orchestrator.js` | `req1.1` |
| Don't stop after a plan | `_phasePlanning` always falls through to work | `req1.1`, unit "a plan is never the stopping point" |
| Make reasonable choices unprompted | `DeterministicPlanner`, `QuestionGate.isMaterial` | `req1.8`, `test/unit/planner.test.js` |
| Fold change suggestions into the current project | `Orchestrator.applyChange` / `_foldChange` (queued at a task boundary while running) | `req1.3`, `req2.2`, `req6.1` |
| No duplicate projects, no lost scope | scope union in `_foldChange`; one project record | `req1.3`, `req6.1` |
| Ask only when material, one question with a default | `QuestionGate.isMaterial`, `_handleNeedsAnswer` | `req1.7`, `req1.8`, `req1.7b` |
| Save progress, continue independent work, resume on answer | task-level parking + `question.answered` subscription | `req1.7b`, `req6.1` |
| Respect evaluate-only / pause / stop | `evaluationOnly` planning branch, `canRun` gate | `req1.2`, `req1.6`, `req2.5`, `req2.8` |
| Bounded retries on transient failure | `RetryBudget`, `classifyError`, `WorkerPool` crash restart | `req1.4`, `test/unit/retry.test.js` |
| Resume saved work automatically | journal + snapshot `Store`; `server.js` resumes active projects at boot | `req1.11` |
| Say precisely what is needed on a blocker | `_handleTaskError` credential/permission branch | `req1.5`, `req4.4` |
| Continue the backlog, invent nothing | `Backlog.next()` returning null; `Orchestrator.drain` | `req1.9`, `req2.10` |

## 2. Chat is the complete interface

| Requirement | Implementation | Proof |
| --- | --- | --- |
| Describe, change, approve, pause, status, answer, remind — all in chat | `ChatDispatcher`, `src/chat/dispatcher.js` | `req2.1`, `req2.5`, `req2.6`, `req2.10` |
| Resolve "change that" / "the second option" / "continue" | `resolveReference`, `src/chat/reference.js` | `req2.2`, `req2.3`, `req2.4` |
| Ask when genuinely ambiguous | `resolveReference` returns `kind: 'ambiguous'` | `req2.7` |
| Records kept internally; management screens optional | `Store` collections + `app.state()` | `req2.9` |

## 3. Speak plainly and briefly

| Requirement | Implementation | Proof |
| --- | --- | --- |
| First person, one to three short sentences | `ChatDispatcher` replies, `Orchestrator.currentAction` (`oneSentence`, ≤120 chars) | `req3.1`, `req1.10` |
| The same sentence shown and spoken | one event→sentence renderer in `src/voice/speech.js` | `req3.2` |
| Read-aloud on by default, mute and quiet hours respected | `src/voice/policy.js`, `public/modules/speech.js` | `req3.6` |
| Browser activation handled explicitly | `public/modules/speech.js` "Enable voice" affordance | `public/modules/speech.js` |
| Announce completions, blockers, questions; batch minor progress | `SPEAK_ALWAYS`, `batchable`, `flushBatch` | `req3.5`, `req3.7` |
| Never replay after refresh; never speak twice | `dedupeKey` keys + persisted `acknowledge`/`unspoken` | `req3.3`, `req3.4`, `req6.1` |

## 4. Remove dashboard clutter

| Requirement | Implementation | Proof |
| --- | --- | --- |
| Default view is core, action line, chat, mode/health, usage circles | `app.state()` payload; `public/index.html` | `req4.1` |
| Decision card only when action is needed | `state.decision` is null unless a question is open | `req4.2` |
| Deliverables only when they exist | `state.deliverables` | `req4.3` |
| No repeated paragraphs, permanent warnings, empty panels | markup audit of `public/index.html` | `req4.6` |
| Diagnostics, logs, project management in drawers | `app.diagnostics()` + `/api/diagnostics`; drawers hidden by default | `req4.5`, `req4.6` |
| Actionable failures summarized once with a remedy | `blockedReason` reused as the health detail | `req4.4` |

## 5. Make the usage circles real

| Requirement | Implementation | Proof |
| --- | --- | --- |
| Provider measurement | `ClaudeSubscriptionProvider`, OAuth `GET /api/oauth/usage` | `test/unit/telemetry-provider.test.js` |
| Worker report leg | `UsageService.ingestWorkerReport` | `req5.6` |
| Stored capacity survives restart | `capacity/last` snapshot reloaded in the constructor | `req5.5` |
| Dashboard circles: percent, remaining, reset in local tz, freshness | `UsageService.report()`, `public/modules/usage.js` | `req5.1` |
| Labels as the provider reports them | `humanizeWindowKey`, `normalizeUsagePayload` | `req5.1`, unit tests |
| Authenticated mechanisms only; never a paid API key; no leaks | token resolution order, API-key refusal | `req5.9`, unit tests |
| Stale shows last-known + age | `status: 'stale'` with truthful `ageMs` | `req5.2`, `req5.3` |
| Never a reading → "Unavailable" + explanation + recovery | `status: 'unavailable'`, empty windows | `req5.4` |
| Unknown never looks like zero | no 0-utilization stand-in; asserted on the serialized report | `req5.4` |
| Measurements pace real work | `Scheduler` bands + `WorkerPool` gating | `req5.7`, `req5.8` |

## 6. Prove the complete behavior

| Requirement | Proof |
| --- | --- |
| Fresh project through chat, mid-build change, question answered, worker recovery, spoken updates, verified delivery | `req6.1` |
| The same flow over real HTTP with a resumable event stream | `req6.2` |
| No repeated approval stops across a batch | `req6.3` |
| No duplicate projects | `req1.3`, `req2.2`, `req6.1` |
| No lost answers | `req2.6`, `req6.1` |
| No replayed speech | `req3.4`, `req6.1` |
| Usage circles against real provider readings | `npm run usage` — see "Verified against this environment" below |

## Verified against this environment

`npm run usage` walks the real path on the machine Jarvis is running on and
prints what it finds at each hop. In a container where Claude Code credentials
are managed by the host there is no local OAuth token, and the probe reports:

```
1. credential      : NOT FOUND
2. provider        : unavailable (not_authenticated)
3. stored capacity : status=unavailable
4. dashboard view  : 0 circle(s)
                     Unavailable — No Claude subscription OAuth token found.
                     Recovery: Run `claude setup-token` ...
```

That is the specified behaviour, not a gap: with no reading the circles say
"Unavailable" with a recovery action rather than showing a fabricated 0%. On a
machine with `claude setup-token` run (or `CLAUDE_CODE_OAUTH_TOKEN` exported),
the same probe prints live per-window percentages and reset times.
