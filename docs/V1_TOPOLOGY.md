# The V1 topology

There is exactly one supported way to run Jarvis V1. This page is it.

Jarvis already contains several deployment ideas — a Netlify site, a Docker image, a systemd
unit, a local development server — and they are not alternatives to each other. They are the
pieces of the one arrangement below. Anything that looks like a second deployment system is a
piece of this one seen on its own.

## The five roles

Five things have to happen somewhere. On a small setup, three of them can be the same machine.

| Role                | What it does                                                | Where it runs                                   |
| ------------------- | ----------------------------------------------------------- | ----------------------------------------------- |
| **Web app**         | The whole interface, every API route, the scheduled sync    | Netlify (or any Node host running `next start`) |
| **Database**        | Everything Jarvis knows. All state lives here and only here | Hosted PostgreSQL — Neon, Supabase, RDS         |
| **Worker**          | Runs Claude, clones repositories, verifies, opens draft PRs | A machine that stays on: laptop, mini PC, VPS   |
| **Git operations**  | Cloning, branching, committing, pushing                     | The worker. Never the web app                   |
| **Browser display** | The wallboard at `/display`                                 | An Android tablet or a Raspberry Pi in Chromium |

The tablet and the Pi run **no agent and no worker**. They open a URL. That is the whole of their
involvement, and it is why a £30 device is enough.

## Why the worker is not on Netlify

Netlify runs functions with a request timeout. A mission is not a request: it clones a
repository, runs a model for minutes, runs a test suite, commits, pushes and opens a pull
request, and it must survive the browser tab being closed. Nothing about that fits in a
serverless invocation, and pretending otherwise would produce a system that works in a demo and
fails on the first real mission.

So the control plane is serverless and the worker is not. The Netlify deployment **never runs an
agent** — it holds the record, serves the interface, and hands work to a worker that polls it.

This is also why the split is a security boundary and not only an operational one. The
Anthropic key the worker uses and the GitHub token it pushes with live on the worker's machine
and are never set on Netlify. A leak of the web app's environment does not yield the ability to
write to your repositories.

## The one-machine version

If you have a computer that stays on, everything except the database can run on it:

```
your machine                          the internet
┌────────────────────────────┐        ┌──────────────────────┐
│ next start        :3000    │───────▶│ Neon / Supabase      │
│ npm run worker             │        │ (PostgreSQL)         │
└────────────────────────────┘        └──────────────────────┘
        ▲                                        ▲
        │ http://<lan-ip>:3000                   │
   phone, tablet, Pi                     the same database
```

The worker still talks to the control plane over HTTP, on `JARVIS_WORKER_CONTROL_PLANE_URL`,
even when both are on the same machine. There is no in-process shortcut, deliberately: the
boundary that keeps credentials apart is the same boundary in both arrangements, so a setup that
grows from one machine to two changes an address and nothing else.

## The hosted version

```
Netlify                     Neon                   your worker machine
┌──────────────────┐   ┌──────────────┐   ┌─────────────────────────────┐
│ web app          │──▶│ PostgreSQL   │◀──│                             │
│ scheduled sync   │   └──────────────┘   │ npm run worker              │
│                  │◀───────────────────  │  · ANTHROPIC_API_KEY        │
│ no agent         │   polls for work     │  · JARVIS_WORKER_GITHUB_...  │
│ no Claude key    │                      │  · clones, commits, pushes  │
│ no write token   │                      └─────────────────────────────┘
└──────────────────┘
        ▲
        │ https://your-site
  phone, tablet, Pi
```

The worker needs **outbound** HTTPS only. It listens on no port, holds no inbound state, and runs
perfectly behind a home router with no port forwarding — which is the point of making it poll
rather than be called.

## Where each credential lives

Read this as an access-control diagram, not a checklist. Every row is somewhere a credential is
allowed to be, and everywhere else is somewhere it must not be.

| Credential                   | Web app | Worker | CI  | Display | Model context |
| ---------------------------- | :-----: | :----: | :-: | :-----: | :-----------: |
| `SESSION_SECRET`             |   ✅    |   —    |  —  |    —    |       —       |
| `DATABASE_URL`               |   ✅    |   —    |  —  |    —    |       —       |
| `GITHUB_OAUTH_CLIENT_SECRET` |   ✅    |   —    |  —  |    —    |       —       |
| `GITHUB_READ_TOKEN`          |   ✅    |   —    |  —  |    —    |       —       |
| `CRON_SECRET`                |   ✅    |   —    |  —  |    —    |       —       |
| `ANTHROPIC_API_KEY` (Ask)    |   ✅    |   —    |  —  |    —    |       —       |
| `ANTHROPIC_API_KEY` (worker) |    —    |   ✅   |  —  |    —    |      ✅¹      |
| `JARVIS_WORKER_TOKEN`        |    —    |   ✅   |  —  |    —    |       —       |
| `JARVIS_WORKER_GITHUB_TOKEN` |    —    |   ✅   |  —  |    —    |       —       |
| Display token                |    —    |   —    |  —  |   ✅    |       —       |

¹ The **only** credential that reaches the model, because the agent cannot work without it. Every
other variable is stripped from the environment handed to the agent process — by name for the ones
Jarvis defines, and by shape for the ones it cannot know the names of. See `src/worker/child-env.ts`.

The Ask key and the worker key are the same _kind_ of credential set in two places. They can be
the same key; they do not have to be, and keeping them separate means a compromised control plane
cannot spend the worker's budget.

## What runs on a schedule, and where

Netlify's scheduler calls one function every two hours, which calls `/api/cron/sync` with
`CRON_SECRET`. Without that secret the endpoint is closed, so a misconfigured deployment fails
safe rather than exposing an unauthenticated trigger.

That run refreshes evidence, produces briefings, releases missions whose worker never came back,
and purges expired sessions. It runs no agent and makes no GitHub write. Whether it may use a
model to _narrate_ a briefing is decided by the activation lock; when it may not, the briefing is
still produced deterministically and says so.

## What this topology deliberately does not include

- **A second worker framework.** There is one worker, one protocol, one set of roles.
- **Agents on Netlify.** No route starts a model that writes.
- **A worker that listens.** It polls; nothing can call it.
- **A Claude key on the display, in CI, or in the browser.** Not hidden from them — absent.
- **A database on the worker.** All state is in PostgreSQL, which is what makes restart recovery
  a property of the system rather than a hope.

## Related

- [SETUP_V1.md](SETUP_V1.md) — the ordered steps to build exactly this.
- [DEPLOY_NETLIFY.md](DEPLOY_NETLIFY.md) — the control plane in detail.
- [WORKER.md](WORKER.md) — the worker in detail.
- [DATABASE.md](DATABASE.md) — drivers, migrations, backups.
- [QUALIFICATION.md](QUALIFICATION.md) — how a deployment earns the right to act.
