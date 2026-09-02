# Roadmap

Phase 1 (this repository) is the Project Registry and the Portfolio Status Brain: Jarvis knows what
exists, what happened, what is blocked and what deserves attention, and can prove it.

Later phases add the ability to _act_. The seams are already in place; none of the behaviour is.

## Prompt 2 — mission execution

What it adds: launching Claude Code, running missions against a connected repository, branches and
pull requests, agent sessions and runs, artifacts, approvals and cost tracking.

What already exists for it:

| Seam                                  | Where                                             | How Prompt 2 uses it                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects.id` as a stable join target | `src/server/db/schema.ts`                         | New `missions`, `tasks`, `agent_sessions`, `agent_runs`, `artifacts`, `approvals`, `playbooks`, `costs` tables hang off it. No change to existing tables. |
| Open enumerations                     | `SOURCE_KINDS`, `EVIDENCE_KINDS` stored as `text` | Agent output becomes a new evidence kind through an additive migration.                                                                                   |
| `ActivityLogService`                  | `src/server/repositories/`                        | The audit spine agent runs write into, alongside the existing sync and briefing events.                                                                   |
| `StatusQueryRouter` execution branch  | `src/server/query/router.ts`                      | Already recognises "build a feature" and answers that execution arrives in Prompt 2. That branch becomes mission dispatch.                                |
| `SourceProvider`                      | `src/server/providers/types.ts`                   | A _separate_, explicitly write-capable client would be introduced here — as a deliberate, reviewable addition. Nothing in Phase 1 creates one.            |
| Snapshots and fingerprints            | `src/server/status/`                              | A mission's before/after is a snapshot comparison, which already exists.                                                                                  |

Deliberate constraint carried forward: the read path stays read-only. Any write capability must be
a new, separately configured credential with its own approval flow — never a widening of
`GITHUB_READ_TOKEN`.

## Later phases

Voice input, long-term personal memory, document ingestion and retrieval, App Store Connect and
TestFlight status, email/Slack/calendar context, and richer playbooks.

Each of these is a new `SourceProvider` or a new service behind an existing interface. The status
engine, the evidence store and the provenance model do not need to change to accommodate them —
which was the point of building them first.
