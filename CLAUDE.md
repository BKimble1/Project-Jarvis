# Working on Jarvis

## Ground rules

- **Zero runtime dependencies.** Node 22+, `node:` builtins and relative
  imports only. Do not add anything to `package.json` dependencies.
- **No ambient time.** Nothing under `src/` may call `Date.now()`, argless
  `new Date()`, or `setTimeout` for a delay. Take an injected `clock`
  (`src/core/clock.js`) and use `clock.now()`, `clock.sleep(ms)`,
  `clock.timezone()`. Formatting a known epoch with `new Date(ms)` is fine.
- **Everything is injected.** Constructors take an options object. No module
  reaches for a singleton, the network, or `$HOME` on its own.
- **`docs/CONTRACTS.md` is authoritative** for module exports and semantics.
  Change the contract in the same commit as the code, never after.

## Commands

```bash
npm test              # unit + acceptance
npm run test:unit
npm run test:acceptance
npm start             # http://127.0.0.1:8787
npm run usage         # diagnose the real subscription telemetry path
```

Node's test runner in this environment needs globs, not directories:
`node --test "test/unit/*.test.js"`.

## Invariants worth protecting

These are the things that were expensive to get right. Each has a test; if you
break one, fix the code, not the test.

1. **A plan is not a deliverable.** `Orchestrator` never returns to the
   operator after planning. Only a pause/stop, a material question, or a
   non-recoverable blocker ends a run.
2. **One project per request.** Change suggestions revise the current project
   in place (`applyChange`), keeping earlier scope. Never create a second
   project for a change.
3. **Unknown capacity is not zero.** `UsageService` never emits a
   0-utilization window as a stand-in for "no reading". Unknown is
   `status: 'unavailable'` with an explanation and a recovery action.
4. **Never bill the API for a usage reading.** The subscription provider will
   not fall back to `ANTHROPIC_API_KEY`, and never returns or logs a token.
5. **Speak once.** Every speech item has a dedupe key and a persisted
   acknowledgement. A refresh must not replay, and a repeated event must not
   produce a second utterance.
6. **The default dashboard stays small.** Anything new belongs in a drawer or a
   secondary tab unless it is one of the five default-view pieces.
7. **Capacity paces real work.** Scheduler bands must actually change
   `WorkerPool` concurrency and inter-task delay, not just the display.

## Testing style

Assert on values, not on "did not throw". Tests use `FakeClock`/`AutoClock`,
stub providers and scripted executors — no network, no real timers, no real
`$HOME`. Acceptance tests live in `test/acceptance/` and are named for the
requirement they prove (`req5.4 ...`).
