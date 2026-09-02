# Jarvis

> A private, single-user project registry and evidence-based portfolio status brain.

Jarvis knows what projects you have, what has actually happened on them, what is blocked, and
what deserves your attention next — and it can prove every claim it makes.

Since Phase 2 it can also **take one approved mission from plain language to a verified draft
pull request** — planning first, and stopping wherever you want to be asked.

Open it on your phone or your computer and ask:

- “Where are we?”
- “Where are we on CoreCredit?”
- “What changed?”
- “What needs me?”
- “What is running?”
- “Which plans need approval?”

…or tell it what to do:

- “Add invoice scanning to OffRent.”
- “Investigate why this repository does not compile.”
- “Research whether this app idea already exists.”
- “Pause the OffRent mission.”

Every answer is traceable. Jarvis never invents progress, never fabricates a completion
percentage, and says **Unknown** when the evidence does not support a claim. Nothing runs until
you approve a specific version of a specific plan, and nothing is ever merged.

---

## What this phase includes

**Phase 1 — the Project Registry and the Status Brain.**

| Capability                   | Detail                                                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Universal project model      | iOS apps, websites, repositories, businesses, product ideas, research, coursework, career and engineering work, documents, personal initiatives — with or without code. |
| Evidence and provenance      | Every claim is labelled **Verified**, **Manual**, **Inferred** or **Unknown**, and links to the commit, pull request or workflow run behind it.                         |
| Read-only GitHub integration | Repository metadata, commits, pull requests, issues, workflow runs, checks, releases and deployments. Write access is impossible by construction.                       |
| Deterministic status engine  | Named, individually tested rules derive status, blockers, attention and recommendations.                                                                                |
| Optional AI narration        | Improves wording only. Jarvis is fully usable with no AI key, and rejects any narration that invents work.                                                              |
| Historical snapshots         | “What changed” compares meaningful state, not timestamps.                                                                                                               |
| Jarvis command bar           | Deterministic routing for the questions above, with project-name resolution and disambiguation.                                                                         |
| Installable PWA              | Mobile-first, light and dark, offline-aware shell.                                                                                                                      |

### Deliberately not included yet

Mission execution, launching Claude Code, repository writes, branches or pull requests, agents and
agent coordination, code generation, TestFlight or App Store uploads, voice, long-term memory,
document ingestion, email/Slack/calendar, social, financial or billing features, multi-user
organisations, a marketplace, terminal access and a browser IDE.

**The GitHub connection is strictly read-only.** See [docs/SECURITY.md](docs/SECURITY.md) for how
that is enforced and verified rather than merely promised.

---

## Quick start

```bash
npm install
npm run dev               # http://localhost:3000
```

That is the whole setup. With no credentials configured, Jarvis runs on an embedded PostgreSQL
(PGlite) that migrates itself on first use and persists in `.jarvis-data/dev`, and uses the
deterministic narrator. `npm run db:migrate` is only needed for a hosted database.

To see it populated, turn on the clearly-labelled demo data:

```bash
JARVIS_DEMO_MODE=true npm run db:seed:demo
JARVIS_DEMO_MODE=true npm run dev
```

Demo mode never activates by itself in production.

Full instructions: [Local setup](docs/SETUP_LOCAL.md) · [Windows setup](docs/SETUP_WINDOWS.md) ·
[Netlify deployment](docs/DEPLOY_NETLIFY.md).

---

## Verification

One command runs everything, in order, and stops at the first failure:

```bash
npm run verify
```

Format check → lint → type check → unit tests → integration tests → production build → end-to-end
smoke tests.

In an environment without a browser, use `npm run verify:ci` to run the same gate without the
Playwright step. Nothing is weakened to make the gate pass; see [docs/TESTING.md](docs/TESTING.md).

---

## Documentation

| Document                                                              | What it covers                                                         |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [Architecture](docs/ARCHITECTURE.md)                                  | Layering, module boundaries, data flow, extension points for Prompt 2. |
| [Status rules](docs/STATUS_RULES.md)                                  | Every deterministic rule, by id, with its provenance.                  |
| [Security](docs/SECURITY.md)                                          | Single-owner auth, read-only GitHub, secret handling, threat notes.    |
| [GitHub token](docs/GITHUB_TOKEN.md)                                  | Exactly which fine-grained read permissions to grant.                  |
| [Authentication](docs/AUTHENTICATION.md)                              | OAuth app setup and session behaviour.                                 |
| [Database](docs/DATABASE.md)                                          | Schema, migrations, drivers, indexes, retention.                       |
| [Local setup](docs/SETUP_LOCAL.md) · [Windows](docs/SETUP_WINDOWS.md) | Development environments.                                              |
| [Netlify deployment](docs/DEPLOY_NETLIFY.md)                          | Build, environment, scheduled synchronisation.                         |
| [Testing](docs/TESTING.md)                                            | What is tested, and how to add to it.                                  |
| [Implementation plan](docs/IMPLEMENTATION_PLAN.md)                    | The plan this phase was built to.                                      |
| [Roadmap](docs/ROADMAP.md)                                            | What Prompt 2 adds, and the seams already left for it.                 |

---

## Mission Control (Phase 2)

Jarvis can now act, under a deliberately narrow set of permissions.

| Capability               | Detail                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Universal mission intake | Type what you want done. Jarvis shows what it understood — project, type, risk and why — before anything is created.                                                             |
| Clarification            | Only questions that change the work get asked, at most three at a time. "Let Jarvis decide" is recorded as an **assumption**, never as your decision.                            |
| Read-only planning       | A worker clones the repository with every mutating tool denied, reads it, and produces a versioned plan with scope, risks, tests, verification commands and acceptance criteria. |
| Plan approval            | You approve one specific version. Editing the plan revokes the approval. A worker re-checks it at claim time.                                                                    |
| One Claude worker        | A separate long-lived process running the official Claude Agent SDK. Closing this page does not stop it.                                                                         |
| Live monitoring          | Pause, resume, message and stop, with the whole timeline. A message that widens the approved scope pauses for a revised plan instead of quietly doing it.                        |
| Draft pull requests      | A `jarvis/<mission-id>` branch, real verification results, and a **draft** PR. Jarvis never merges.                                                                              |
| Research missions        | A sourced report attached to the project, with no branch and no code change.                                                                                                     |

**What it will never do:** push to a default branch, force push, merge, publish a release, deploy,
upload a build, change repository settings or secrets, or approve its own plan. These are
capability limits in the worker, not instructions to a model — see
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) and [docs/MISSION_RULES.md](docs/MISSION_RULES.md).

Setting up a worker: [docs/WORKER.md](docs/WORKER.md).

## Known limitations

Stated plainly, because a tool built around not overstating what it knows should not overstate
what it is.

- **Writes are limited to a branch and a draft pull request.** Jarvis cannot merge, deploy,
  publish, or change repository settings — and the _synchronisation_ path is still read-only by
  construction. See [SECURITY.md](docs/SECURITY.md) and [THREAT_MODEL.md](docs/THREAT_MODEL.md).
- **One mission at a time, and it needs a worker.** Without a connected worker Jarvis can still
  plan — from its own project record, labelled **Inferred** and saying plainly that nothing was
  inspected — but it cannot execute. Multiple agents arrive in Phase 3.
- **Risk classification is pattern-based.** It is a first filter, not the last line of defence:
  the capability limits are. It can be wrong in both directions, which is why you approve the plan.
- **GitHub is the only connected source.** App Store Connect, Netlify, Linear and the rest are not
  integrated, so claims like "waiting for Apple review" stay **Manual** until they are.
- **Synchronisation is pull-based.** There are no webhooks: evidence can lag by up to the
  scheduled cadence (two hours by default). Jarvis shows how old its evidence is rather than
  implying it is live.
- **History is bounded.** Each synchronisation reads a limited window (90 days by default) and a
  capped number of rows per category, so a very old repository is summarised, not fully archived.
- **Partial permissions produce partial answers.** A token without Actions access makes build
  health **Unknown**, not "fine". That is deliberate, but it does mean the answer is thinner.
- **Rate limits are real.** Synchronising a large portfolio at once can exhaust GitHub's quota;
  the failure is safe — prior data is kept and marked stale — but it stays stale until the next run.
- **Search covers project fields, not evidence.** You can search names, goals, descriptions and
  tags; there is no full-text search across commits or issues.
- **One user.** There are no roles, sharing or collaboration, and none are planned for this phase.
- **The AI narrator only rewords.** Without a key, or when its output is rejected, the briefing is
  the deterministic one. It is never the difference between knowing something and not.
- **The local database is single-process.** PGlite is for development and tests; production needs
  a hosted PostgreSQL.

Everything above is a consequence of a deliberate decision, and each one is visible in the
interface rather than hidden behind confident prose.

## Stack

Next.js 15 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS v4 · Zod · Drizzle ORM ·
PostgreSQL (Neon / node-postgres in production, PGlite locally) · Octokit · Anthropic SDK
(optional) · Vitest · Playwright · Netlify.
