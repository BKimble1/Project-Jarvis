# Roadmap

Phase 1 was the Project Registry and the Portfolio Status Brain: Jarvis knows what exists, what
happened, what is blocked and what deserves attention, and can prove it.

Phase 2 added the ability to _act_ — one mission at a time, planned first, approved by you, and
delivered as a draft pull request that Jarvis will not merge.

Phase 3 made that plural, and put a review between the work and the delivery.

## Phase 2 — Mission Control ✅ shipped

One approved mission from plain language to a verified draft pull request or a sourced research
report, with the owner in control at every consequential step. See
[MISSION_CONTROL.md](MISSION_CONTROL.md), [WORKER.md](WORKER.md) and
[MISSION_RULES.md](MISSION_RULES.md).

The constraint Phase 1 carried forward held: the read path is still read-only, and write
capability arrived as a **separate credential in a separate process**, never as a widening of
`GITHUB_READ_TOKEN`.

## Phase 3 — the multi-agent factory ✅ shipped

Several agents on one mission, each with a role, a permission ceiling, an isolated workspace and a
declared write set — approved agent by agent before anything starts. Deterministic integration, a
verification gate, an independent cold-context review, bounded repair rounds, completion receipts,
versioned playbooks, an operations page and a scoped read-only wallboard. See
[MULTI_AGENT_FACTORY.md](MULTI_AGENT_FACTORY.md), [MULTI_AGENT_RULES.md](MULTI_AGENT_RULES.md),
[PLAYBOOKS.md](PLAYBOOKS.md), [OPERATIONS.md](OPERATIONS.md) and
[PHASE_3_HANDOFF.md](PHASE_3_HANDOFF.md).

Every seam Phase 2 left was used, and two needed more than configuration:

- `mission_runs.attempt` carried a one-run-per-attempt uniqueness rule that a task run would have
  broken. Widening the index would have destroyed the guarantee, because PostgreSQL treats NULLs
  as distinct; two _partial_ unique indexes preserved it exactly while admitting task runs.
- `MissionRunner` was left alone rather than extended. `TaskRunner` is a separate object with the
  same client, because a runner that does both a Phase 2 mission and a Phase 3 task is a runner
  that eventually does the wrong one.

The constraints carried forward held, and gained company: no automatic merge, no direct
default-branch push, no self-approval, a bounded repair loop — and now no agent that can widen its
own permissions, raise a limit, install a playbook, or approve anything at all.

**Not yet verified against a live model.** Everything above is proved against a scripted runtime
driving the real orchestration, real git and the real route handlers. See
[PHASE_3_HANDOFF.md](PHASE_3_HANDOFF.md) §2 for exactly what that does and does not establish.

## Later phases

Voice input, long-term personal memory, document ingestion and retrieval, App Store Connect
status, email/Slack/calendar context, and richer playbooks.

Each of these is a new `SourceProvider` or a new service behind an existing interface. The status
engine, the evidence store and the provenance model do not need to change to accommodate them —
which was the point of building them first.
