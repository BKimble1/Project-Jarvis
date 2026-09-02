# Jarvis

> A private, single-user project registry and evidence-based portfolio status brain.

Jarvis knows what projects you have, what has actually happened on them, what is blocked, and
what deserves your attention next — and it can prove every claim it makes.

Open it on your phone or your computer and ask:

- “Where are we?”
- “Where are we on CoreCredit?”
- “What changed?”
- “What needs me?”
- “Which projects are blocked?”
- “What should I focus on?”

Every answer is traceable. Jarvis never invents progress, never fabricates a completion
percentage, and says **Unknown** when the evidence does not support a claim.

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

## Stack

Next.js 15 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS v4 · Zod · Drizzle ORM ·
PostgreSQL (Neon / node-postgres in production, PGlite locally) · Octokit · Anthropic SDK
(optional) · Vitest · Playwright · Netlify.
