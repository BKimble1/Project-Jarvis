# Roadmap

Phase 1 was the Project Registry and the Portfolio Status Brain: Jarvis knows what exists, what
happened, what is blocked and what deserves attention, and can prove it.

Phase 2 added the ability to _act_ — one mission at a time, planned first, approved by you, and
delivered as a draft pull request that Jarvis will not merge.

## Phase 2 — Mission Control ✅ shipped

One approved mission from plain language to a verified draft pull request or a sourced research
report, with the owner in control at every consequential step. See
[MISSION_CONTROL.md](MISSION_CONTROL.md), [WORKER.md](WORKER.md) and
[MISSION_RULES.md](MISSION_RULES.md).

The constraint Phase 1 carried forward held: the read path is still read-only, and write
capability arrived as a **separate credential in a separate process**, never as a widening of
`GITHUB_READ_TOKEN`.

## Phase 3 — multi-agent orchestration

What it adds: several cooperating agents on one mission, independent review, controlled repair
loops, and reusable project playbooks.

What already exists for it:

| Seam                                                       | Where                          | How Phase 3 uses it                                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mission_runs.attempt`                                     | `src/server/db/schema.ts`      | Several concurrent runs per mission instead of one at a time. Nothing in the schema forbids it; the _product_ does, through `canClaimMission`.               |
| `workers.max_concurrency` and `JARVIS_MISSION_CONCURRENCY` | worker registry, config        | Raising the limit is a configuration change, not a rewrite. The claim is already atomic under contention.                                                    |
| `AgentRuntime`                                             | `src/worker/runtime/types.ts`  | A second agent implementation, or a reviewer with a different model, slots in behind the same five methods. Mission logic imports neither.                   |
| `MissionRunner`                                            | `src/worker/mission-runner.ts` | Already one mission, one workspace, one branch. A reviewer agent gets its own read-only workspace over the same clone.                                       |
| Permission requests                                        | `mission_permission_requests`  | The channel a repair loop would use to ask before widening what it does. Already bound to one request, with no "always allow" to inherit.                    |
| `MissionPlanContent.reviewOnlyDelivery`                    | `src/domain/mission-plan.ts`   | The gate an independent reviewer would assert against, and the reason a high-risk plan can execute at all.                                                   |
| Verification records                                       | `mission_verifications`        | A repair loop needs a baseline to know whether it improved anything. The four honest outcomes — passed, failed, unavailable, skipped — are already distinct. |

Deliberate constraints to carry forward: no automatic merge, no direct default-branch push, no
self-approval, and a **bounded** repair loop — unbounded retry is how an agent turns a small
mistake into a large one.

## Later phases

Voice input, long-term personal memory, document ingestion and retrieval, App Store Connect and
TestFlight status, email/Slack/calendar context, and richer playbooks.

Each of these is a new `SourceProvider` or a new service behind an existing interface. The status
engine, the evidence store and the provenance model do not need to change to accommodate them —
which was the point of building them first.
