# Local setup (macOS / Linux)

For Windows, see [SETUP_WINDOWS.md](SETUP_WINDOWS.md).

## Requirements

- Node.js 20.11 or newer (22 LTS recommended — it is what CI and Netlify use)
- npm 10 or newer
- Git

No database server is required for local development: Jarvis uses PGlite, an embedded PostgreSQL,
and runs the very same migrations it runs in production.

## 1. Install

```bash
git clone <your-fork-url> Project-Jarvis
cd Project-Jarvis
npm install
```

## 2. Configure

```bash
cp .env.example .env.local
```

For a first run you can leave everything blank — Jarvis starts with an embedded database, the
deterministic narrator, and sign-in disabled. To sign in locally you need at minimum:

```bash
JARVIS_BASE_URL=http://localhost:3000
SESSION_SECRET=<32+ random characters>
OWNER_GITHUB_LOGIN=<your github login>
GITHUB_OAUTH_CLIENT_ID=<from your OAuth app>
GITHUB_OAUTH_CLIENT_SECRET=<from your OAuth app>
```

Generate a session secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Create the OAuth app as described in [AUTHENTICATION.md](AUTHENTICATION.md), with the callback URL
`http://localhost:3000/api/auth/callback`.

To connect repositories, add a read-only fine-grained token as described in
[GITHUB_TOKEN.md](GITHUB_TOKEN.md):

```bash
GITHUB_READ_TOKEN=github_pat_...
```

To enable AI narration (entirely optional):

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

## 3. Run

```bash
npm run dev
```

Open http://localhost:3000.

The embedded PostgreSQL migrates itself the first time the server touches it, so there is no
separate setup step. `npm run db:migrate` is only needed when `DATABASE_URL` points at a hosted
database.

## 4. Demo data (optional)

To see every screen populated without connecting anything:

```bash
JARVIS_DEMO_MODE=true npm run db:seed:demo
JARVIS_DEMO_MODE=true npm run dev
```

The seed creates four clearly fictional projects that exercise the interesting states: an active
repository-backed project with a failing build and a decision blocker, a manual coursework project,
a project whose synchronisation is failing, and a paused project. A banner across the top of the
app makes demo mode impossible to mistake for real data.

Demo data is only seeded into an empty database, and demo mode never activates by itself in
production.

## 5. Where the local database lives

Development stores the embedded database in `.jarvis-data/dev`, so it survives restarts.
`.jarvis-data/` is git-ignored. Point it elsewhere, or make it in-memory for a throwaway session:

```bash
PGLITE_DATA_DIR=.jarvis-data/scratch
```

Deleting the directory resets everything; the next start migrates a fresh database.

## 6. Verify

```bash
npm run verify           # everything, including end-to-end tests
npm run verify:ci        # everything except the browser tests
```

Individual steps:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run test:unit
npm run test:integration
npm run test:e2e         # needs a Chromium install: npm run test:e2e:install
```

## Working against a real PostgreSQL locally

If you would rather develop against the same driver as production:

```bash
docker run --name jarvis-pg -e POSTGRES_PASSWORD=jarvis -p 5432:5432 -d postgres:16
```

```bash
DATABASE_URL=postgres://postgres:jarvis@localhost:5432/postgres
JARVIS_DB_DRIVER=pg
```

Then `npm run db:migrate` again.

## Changing the schema

```bash
# edit src/server/db/schema.ts
npm run db:generate      # writes a new drizzle/NNNN_*.sql
npm run db:migrate       # applies it
```

Commit both the schema change and the generated SQL. Migrations are applied identically by every
driver, so a change proven locally behaves the same on Netlify.

## Troubleshooting

| Symptom                                            | Cause and fix                                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ConfigurationError: SESSION_SECRET…`              | You set `NODE_ENV=production` locally. Development supplies safe defaults; production does not.                                                                                |
| Sign-in button missing                             | `GITHUB_OAUTH_CLIENT_ID`/`SECRET` are unset.                                                                                                                                   |
| “That account cannot access this Jarvis instance.” | `OWNER_GITHUB_LOGIN` does not match the account you signed in with.                                                                                                            |
| Import page shows no repositories                  | `GITHUB_READ_TOKEN` is unset, or the token was not granted access to any repository.                                                                                           |
| Data disappears on restart                         | PGlite is in-memory unless `PGLITE_DATA_DIR` is set.                                                                                                                           |
| Missions plan but never run                        | No worker is connected. Jarvis can still plan from its own project record — labelled **Inferred**, saying so plainly — but only a worker executes. See [WORKER.md](WORKER.md). |
| The worker connects but claims nothing             | Check `npm run worker:health`. Most often `ANTHROPIC_API_KEY` is unset, so the worker declines work rather than claiming a mission it cannot run.                              |
| "The plan has not been approved"                   | Approve the **current** version. Editing a plan creates a new version and revokes the old approval, deliberately.                                                              |
| A mission is stuck "waiting for permission"        | The agent asked for something outside its permission set. Open the mission and decide; it waits rather than proceeding.                                                        |

## Running a worker locally

```bash
# In Jarvis: Workers → Enrol worker → copy the token (shown once).
export JARVIS_CONTROL_PLANE_URL=http://localhost:3000
export JARVIS_WORKER_TOKEN=jarvisw_…
export ANTHROPIC_API_KEY=sk-ant-…
export JARVIS_WORKER_GITHUB_TOKEN=github_pat_…   # Contents + Pull requests, read and write
export JARVIS_WORKER_WORKSPACE_ROOT="$HOME/jarvis-workspaces"

npm run worker:health    # check first — reports presence, never values
npm run worker
```

Full setup, including Windows, WSL, Docker and systemd, is in [WORKER.md](WORKER.md).

To rehearse a mission without touching a real repository, point it somewhere harmless:

```bash
export JARVIS_WORKER_SANDBOX_REPOS="me/my-app=/home/me/sandbox/my-app.git"
```

A redirected worker says so on the workers page, so a rehearsal is never mistaken for the real
delivery.
