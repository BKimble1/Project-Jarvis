# The multi-agent factory — architecture

Phase 2 gave Jarvis one worker taking one approved plan to one draft pull request. Phase 3 turns
that into a small, controlled factory: several agents on one mission, each with a role, a
permission profile, a workspace and a write set, with a deterministic verification gate and an
independent review between the work and the delivery.

This document is the architecture note for that change. `MULTI_AGENT_RULES.md` is the rule
reference; `PLAYBOOKS.md` covers reusable definitions; `OPERATIONS.md` covers running it.

## The shape of a mission

```
   plan (approved) ──▶ task graph (proposed) ──▶ task graph (approved by you)
                                                          │
        ┌─────────────────────────────────────────────────┴──────────────────┐
        │                                                                    │
   read-only research            builder(s)                                  │
   (own clone, no writes)   (own clone, own branch, declared write set)       │
        └──────────────┬───────────────┘                                     │
                       ▼                                                     │
              integration branch  ◀── deterministic git, no model            │
                       ▼                                                     │
              verification  ◀── the repository's own checks, real outcomes   │
                       ▼                                                     │
              independent review  ◀── fresh session, never sees the builder  │
                       ▼                                                     │
        ┌──────────────┴───────────────┐                                     │
   approved                     repair required ──▶ bounded repair round ────┘
        ▼                                            (repair → integrate →
   draft pull request                                 verify → fresh review)
```

Everything above the "approved by you" line is a proposal. Nothing below it starts without it.

## Why a graph and not a list

A mission is not one unit of work, and pretending it is has two costs. It serialises things that
could run at once — reading a repository and reading its issue tracker have nothing to do with
each other — and it makes "what is this agent allowed to do" a property of the mission rather
than of the task. A researcher and a builder need very different permissions, and one permission
set for both is necessarily the wider of the two.

So a mission owns a directed acyclic graph of tasks. Each task has:

| Property               | What it decides                                                              |
| ---------------------- | ---------------------------------------------------------------------------- |
| `role`                 | What kind of agent it is: researcher, builder, verifier, reviewer, repairer… |
| `permissionProfileId`  | The tool ceiling it runs under. Named, never defined by the task.            |
| `declaredWriteSet`     | The paths it may change. Empty means read-only.                              |
| `workspaceRequirement` | None, a read-only clone, its own writable clone, or the integration branch.  |
| `dependsOn`            | What must finish first.                                                      |

`validateTaskGraph` refuses a graph that breaks any of 26 rules before an owner ever sees it —
cycles, a write task with no review after it, a review before its verification, two parallel
writers with overlapping write sets, a task asking for a profile wider than its role's ceiling.

## Permission profiles are ceilings, not grants

A profile is frozen module data (`src/domain/agent-role.ts`), not a database row. A task may
_name_ a profile; it can never define one, and an unknown name throws rather than defaulting to
something permissive.

`evaluateToolUse` applies the profile **first**, and the profile can only ever `deny`. Every rule
Phase 2 already enforced still runs afterwards. So a profile can narrow what an agent may do and
can never widen it, and the phase-2 refusals — no force push, no default-branch write, no
credential read — are unreachable from here by construction.

Each role has two profiles: the one it runs as, and the widest it may ever be given. A researcher
defaults to `readonly_repo` and may be raised to `readonly_repo_web` by a playbook that needs it;
it cannot be raised past that by anything.

## Isolation

No two writing agents ever share a checkout. Each `task_workspace` task gets its own clone under
its own slot and its own `jarvis/…` branch, and it must hold a **write lease** before it starts.
The lease covers the write set _the approved graph declared_, not the one the worker asked for —
a worker cannot widen its own lease by sending a longer list.

The write set is checked twice, with one containment rule shared by both checks:

1. **Before**: two tasks whose write sets overlap cannot run at the same time.
2. **After**: the files that actually changed are compared against the same set. A file outside it
   fails the task with the workspace preserved, and the failure names the offending files.

If those two used different notions of "inside", a task could pass the pre-check and still write
somewhere the owner never approved.

## Integration is deterministic

Merging is where two agents' work can silently destroy each other, and the safe behaviour — stop
and show both sides — is exactly what a model under pressure to finish talks itself out of. So no
model is anywhere near it.

`integrateBranches` merges each finished task branch into the mission integration branch with
`--no-ff --no-edit` and **no strategy option**. `-X ours`, `-X theirs` and `--squash` are refused
by the git wrapper itself. A conflict aborts the merge, leaves both branches exactly as they were,
and reports the conflicting files.

Task branches are pushed under `jarvis/…` as soon as they are committed, which is what makes them
visible to the integrator — which runs in a workspace of its own, possibly on another machine.
The integration branch is pushed too, so the reviewer can read it.

## The review is cold

A reviewer gets a fresh session and a context assembled from evidence: the plan, the acceptance
criteria, the graph shape, the diff it reads from its own clone, the verification outcomes and the
artifacts. It does **not** get the builder's transcript, its summary, its defence of its own work,
or any previous reviewer's verdict — `buildReviewContext` has no parameter through which one could
arrive, so the separation is structural rather than remembered.

What the reviewer returns is a _proposal_. `decideVerdict` reconciles it with what is true:

- **R-RV1** — an approval standing on a failed required check becomes `repair_required`, and the
  failing checks become the blocking finding, so there is something concrete to repair.
- **R-RV2** — a review that files critical findings and then approves is overridden.
- **R-RV4** — a review that blocks with no finding to point at becomes an owner decision, not an
  unexplained stop.

Both the proposed verdict and the override are stored. A model approving work that a required
check had already failed is exactly the evidence an owner needs to judge how much a verdict is
worth.

## Repair is bounded, and a round is a small pipeline

A blocking review may schedule a repair round if one is left. A round is not "try again": it is
repair → re-integrate → re-verify → **fresh** review. Without the middle two the fix never reaches
the integration branch and the next reviewer reads the old diff — or, worse, approves work on a
branch that does not contain the fix.

The repair branch continues the branch it repairs rather than starting beside it, so integrating
the two is a continuation and not a collision.

The bound is enforced in exactly one place (`applyVerdict`) and there is no branch in it that
continues past the limit. When the limit is reached, the reviewed task fails with
`repair_limit_reached` **and the delivery task is failed too** — the review task is marked
succeeded because it did its job, and delivery depends on the review task, so without that
explicit failure a blocked review would have unblocked delivery.

## Capacity

Ceilings are configuration, and the only direction the interface moves them is down.

| Limit              | Default | Absolute ceiling |
| ------------------ | ------- | ---------------- |
| Missions at once   | 2       | 6                |
| Agents at once     | 4       | 12               |
| Agents per mission | 3       | 6                |
| Writers at once    | 1       | 3                |
| Read-only at once  | 3       | 6                |
| Repair rounds      | 2       | 3                |

Every one of these is checked _inside_ the single atomic `UPDATE … FOR UPDATE SKIP LOCKED`
statement that claims a task, so two workers racing produce at most one claim and neither can
exceed a ceiling by winning the race.

Posture — `open`, `draining`, `stopped` — is separate from the limits. Draining lets running work
finish and starts nothing new. Neither posture kills work in progress or deletes a workspace.

## What Jarvis still cannot do

Unchanged from Phase 2, and re-proved by the Phase 3 tests: no merge to a default branch, no force
push, no production deployment, no App Store submission, no public release. Added in Phase 3 and
equally structural: an agent cannot assign itself another role, raise a limit, add a repair
attempt, enable a CI controller, add a repository to an allow-list, install a playbook, create a
display token, approve a plan, approve a graph, approve a TestFlight build, or approve its own
output. In every case the guarantee is that no route exists, not that a route checks a flag.
