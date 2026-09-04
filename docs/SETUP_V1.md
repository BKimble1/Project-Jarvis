# Setting up Jarvis V1

Nineteen steps, in order. Each one either works or tells you what is wrong; nothing here asks you
to guess. Read [V1_TOPOLOGY.md](V1_TOPOLOGY.md) first if you want to know what you are building.

Every secret below is written as a placeholder. Fill them into your host's environment settings or
into a local `.env` file — and **do not commit a `.env` file**; the repository ignores it for a
reason.

---

## 1. Install the prerequisites

On the machine that will run the worker, and on your own computer if they differ:

- **Node 22** (20 is the minimum; 22 is what Jarvis is built and tested against)
- **git**, on the PATH
- A checkout of this repository, and `npm install` inside it

Check: `node --version` and `git --version` both answer.

## 2. Create the database

Hosted PostgreSQL. Neon and Supabase both have a free tier that is enough for one person.

Set `DATABASE_URL` to the connection string and `JARVIS_DB_DRIVER` to `neon` (Neon's serverless
endpoint) or `pg` (everything else, including Neon's pooled endpoint). Details in
[DATABASE.md](DATABASE.md).

Then apply the schema:

```bash
npm run db:migrate
```

## 3. Start the application

Locally, to see it working before you deploy anything:

```bash
npm run dev            # http://localhost:3000
```

For the real thing, follow [DEPLOY_NETLIFY.md](DEPLOY_NETLIFY.md). You can do that now or after
step 12 — nothing below depends on it being hosted.

## 4. Configure owner sign-in

Jarvis has exactly one account: yours.

1. Create a GitHub OAuth app with the callback `https://<your-site>/api/auth/callback` (or
   `http://localhost:3000/api/auth/callback` for local use).
2. Set `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`.
3. Set `OWNER_GITHUB_USER_ID` to your numeric GitHub id — preferred, because a login can be
   renamed and an id cannot. `OWNER_GITHUB_LOGIN` also works.
4. Set `SESSION_SECRET` to 32+ random characters, and `JARVIS_BASE_URL` to the address you open
   Jarvis at.

Sign in. Nobody else can. See [AUTHENTICATION.md](AUTHENTICATION.md).

## 5. Enrol the worker

In Jarvis: **Workers → Enrol worker**. Give it a name you will recognise.

The token appears **once**. There is no route that returns it again — only a hash is stored, plus
a short prefix so you can tell two workers apart in a list. Copy it now.

## 6. Give the worker its Claude credential

On the **worker machine**, in that machine's environment (a `.env` beside the checkout, a systemd
`EnvironmentFile`, or Docker's `--env-file`):

```bash
JARVIS_CONTROL_PLANE_URL=https://your-jarvis.example.com
JARVIS_WORKER_TOKEN=<the token from step 5>
JARVIS_WORKER_NAME=<the name from step 5>
JARVIS_WORKER_WORKSPACE_ROOT=/home/you/jarvis-workspaces
ANTHROPIC_API_KEY=<your Anthropic API key>
```

Four rules about that key, and they are not stylistic:

- It goes in the **worker's** environment. Not Netlify, not the browser, not a mission
  description, not a chat message, not a repository file, not a log.
- It is the only credential the agent process is given. Everything else is stripped from the
  environment it can read.
- It never reaches GitHub, CI, or a display client.
- If you would rather the control plane not have one at all, leave `ANTHROPIC_API_KEY` unset
  there. Ask then answers from the evidence itself and says so, which is a supported mode.

## 7. Start the worker

```bash
npm run worker
```

It prints its name, its runtime and its workspace root, then starts polling. Leave it running —
`screen`, `tmux`, a systemd unit or Docker; [WORKER.md](WORKER.md) has all four.

Check: **Workers** in Jarvis shows it as connected within a few seconds.

## 8. Give the worker its GitHub read access

Back on the **control plane**: `GITHUB_READ_TOKEN`, a fine-grained personal access token with
**Contents: read-only** and **Metadata: read-only**, scoped to only the repositories you want
Jarvis to watch. Nothing else. See [GITHUB_TOKEN.md](GITHUB_TOKEN.md).

This is what lets Jarvis see commits, pull requests and releases. It cannot write anything.

## 9. Create a sandbox repository

Make a **new, empty, private repository** for this. Something like `you/jarvis-sandbox`, with a
README and nothing else.

Do not use one of your real applications for the first write qualification. The point of the next
few steps is to find out whether Jarvis writes what you expect, and the way to find that out is
somewhere a mistake costs nothing.

## 10. Give the worker its write credential

On the **worker machine**, a second fine-grained token — different from step 8 — scoped to the
sandbox repository only:

```bash
JARVIS_WORKER_GITHUB_TOKEN=<a token scoped to the sandbox repository>
```

Exactly two permissions:

- **Contents: Read and write** — to push the mission branch
- **Pull requests: Read and write** — to open the draft pull request

Do **not** grant Administration, Secrets, Environments, Actions, Workflows, Webhooks, Deployments
or Packages. Jarvis contains no code that could use them, and a token that cannot do a thing is a
better guarantee than a rule saying it will not.

The model never receives this token. Delivery is five methods on one client — three writes, two
reads — and the agent's own environment has the variable removed.

## 11. Run the diagnostics

```bash
npm run doctor
```

Every check, in one pass, with the exact next action for each failure. Read the states carefully:

- **Working** — something actually happened. A query returned, a credential authenticated, a
  worker sent a heartbeat.
- **Configured, not yet proved** — a value is present and nothing has confirmed it works. This is
  the state most often mistaken for readiness.
- **Not configured** / **Failing** — self-explanatory.

It exits non-zero if Jarvis cannot operate, so it can be the last line of a setup script. The same
report is on the Operations page.

## 12. Choose the sandbox in Jarvis

```bash
npm run qualify -- sandbox you/jarvis-sandbox
```

Jarvis will refuse a repository that is not allow-listed. This is also the name it will show you
before any live write.

## 13. Qualify the read-only path

Add the sandbox as a project, then give Jarvis a read-only mission — a `repository_audit` is the
intended one. Approve it and watch it run.

What to check while it does:

- The mission reaches the worker you started, not a queue that never moves.
- The findings are about the sandbox repository and nothing else.
- Progress appears in Mission Control as it happens, not in one lump at the end.
- Cancelling is available and works.

Then record it:

```bash
npm run qualify -- record-live <missionId> read
```

## 14. Qualify Ask

Ask Jarvis a question about the sandbox: _"Where are we on jarvis-sandbox?"_

What to check:

- The answer's citations open, and land on the thing they claim.
- Anything Jarvis does not know is said to be unknown rather than filled in.
- The status comes from the status engine — a document in the knowledge base cannot talk Jarvis
  into a status the evidence does not support.

## 15. Qualify the write path

Give Jarvis a harmless write mission in the sandbox. "Add a CONTRIBUTING.md" is a good first one.

Before it writes anything, Jarvis shows you the repository owner and name, the default branch, the
task goal, the paths it declared it would write, the branch it proposes, the checks it will run
and the delivery it will make. Read that screen. Approving it is the decision.

What you should end with: a **draft** pull request against the sandbox, pointing at the exact
commit that was verified and reviewed. Not merged, not ready for review, and nothing written to
the default branch.

```bash
npm run qualify -- record-live <missionId> write
```

## 16. Connect your real projects

Now, and conservatively. Add them read-only first and let the status engine describe them for a
few days before you give any of them a write mission. `GITHUB_READ_TOKEN` is what governs which
repositories Jarvis can see at all.

## 17. Set up the wallboard

**Settings → Wall displays**, name the device, choose what it may show, pair. The token appears
once.

On the tablet or Pi, open `https://<your-jarvis>/display` and type the token. It is exchanged for
an `httpOnly` cookie, so the page's own JavaScript cannot read it back.

A display can show counts, mission cards, what needs a person and what just finished. It cannot
show a repository name, a branch, a diff, a file path, a transcript, a pull-request URL or any
credential — and there is no display-authenticated write of any kind, so approve, pause, stop and
retry are unreachable rather than hidden.

Kiosk instructions for Android and the Raspberry Pi are in [OPERATIONS.md](OPERATIONS.md). Do not
put the display token in a script you commit.

## 18. Make it start after a reboot

- **Worker on Linux:** the systemd unit in [WORKER.md](WORKER.md). `SIGTERM` drains — the current
  mission finishes and reports honestly before the process exits.
- **Worker in Docker:** `--restart unless-stopped`.
- **Control plane on Netlify:** nothing to do.
- **Control plane self-hosted:** the same systemd pattern, running `npm run start`.

Reboot the worker machine and confirm it reconnects on its own.

## 19. Back it up, and know how to stop

**Everything Jarvis knows is in PostgreSQL.** The worker's disk holds only workspaces, which are
working copies, not records.

- **Backup:** whatever your database provider offers. Neon and Supabase both keep point-in-time
  recovery on their free tiers. Turn it on.
- **Stopping safely:** `Ctrl-C` or `systemctl stop jarvis-worker` drains rather than kills. A
  mission in flight finishes; a mission that cannot finish is preserved with its workspace and
  branch intact, and reported honestly rather than marked failed.
- **Updating:** `git pull && npm install && npm run db:migrate`, then restart the worker and
  redeploy the site. Migrations run before the build on Netlify, so the deployed code never meets
  an older schema.
- **Reclaiming disk:** `npm run worker:workspaces` lists what is preserved and what is in it.
  Nothing is ever deleted automatically.

---

## When something is wrong

`npm run doctor` first. It is built for exactly this and names the next action for every failure.

Then:

- **The worker will not pick anything up** — [WORKER.md](WORKER.md#the-worker-will-not-claim-anything)
- **A mission is stuck** — [WORKER.md](WORKER.md#health-and-recovery)
- **Jarvis will not do something you expected** — Operations → Qualification. The activation lock
  holds capabilities back until a rung is earned, and the page says which rung and why.
