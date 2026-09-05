# The Jarvis Worker

The worker is the process that actually runs missions. Jarvis itself cannot: a serverless request
is over in seconds and a mission takes minutes.

It is a plain Node process. It opens no port, accepts no inbound traffic, and holds no state
between missions except the workspaces it deliberately preserves. It runs equally well on a
laptop, in Docker, or on a small VM behind a home router.

**Closing Jarvis in your browser does not stop it.** That is the point.

---

## What it needs

| Credential                   | What it is for                       | Where it lives  |
| ---------------------------- | ------------------------------------ | --------------- |
| `JARVIS_WORKER_TOKEN`        | Proves this process is your worker   | The worker only |
| `ANTHROPIC_API_KEY`          | Running Claude                       | The worker only |
| `JARVIS_WORKER_GITHUB_TOKEN` | Pushing a branch, opening a draft PR | The worker only |

Jarvis never sends any of these to the worker, and the worker never sends any of them back. If
you are ever asked to paste one into a Jarvis field, something is wrong — say no.

---

## 1. Enrol a worker

In Jarvis, go to **Workers → Enrol worker** and give it a name you will recognise (`macbook`,
`home-server`).

The token appears exactly once. Jarvis stores a SHA-256 hash of it and an eight-character prefix,
so it genuinely cannot show it to you again — if you lose it, rotate the token and use the new one.

## 2. Get a GitHub credential

Create a **fine-grained personal access token** at
<https://github.com/settings/personal-access-tokens>:

- **Repository access:** only the repositories you want Jarvis to work in. Not "all repositories".
- **Permissions:**
  - **Contents: Read and write** — needed to push the mission branch.
  - **Pull requests: Read and write** — needed to open the draft pull request.
  - **Metadata: Read-only** — GitHub adds this automatically.

That is the whole list. Do **not** grant Administration, Secrets, Environments, Actions,
Workflows, Webhooks, Deployments or Packages. Jarvis has no code that could use them:
`GitHubDelivery` has four methods — push the mission branch, open a draft PR, update that PR's
body, read check status — and a test fails if a fifth is ever added.

> This is a different token from `GITHUB_READ_TOKEN`, which the Jarvis web app uses for read-only
> synchronisation. Keep them separate: the read token should have no write permission at all.

## 3. Run the worker

### Local (macOS or Linux)

```bash
export JARVIS_CONTROL_PLANE_URL=https://your-jarvis.netlify.app
export JARVIS_WORKER_TOKEN=jarvisw_…
export ANTHROPIC_API_KEY=sk-ant-…
export JARVIS_WORKER_GITHUB_TOKEN=github_pat_…
export JARVIS_WORKER_WORKSPACE_ROOT="$HOME/jarvis-workspaces"

npm run worker
```

Check it first with `npm run worker:health`, which prints configuration, runtime availability and
workspace writability — and reports every credential as present/absent, never as a value.

### Windows (PowerShell)

```powershell
$env:JARVIS_CONTROL_PLANE_URL = "https://your-jarvis.netlify.app"
$env:JARVIS_WORKER_TOKEN      = "jarvisw_…"
$env:ANTHROPIC_API_KEY        = "sk-ant-…"
$env:JARVIS_WORKER_GITHUB_TOKEN = "github_pat_…"
$env:JARVIS_WORKER_WORKSPACE_ROOT = "$env:USERPROFILE\jarvis-workspaces"

npm run worker
```

Git for Windows must be on `PATH`. Everything else is cross-platform: Jarvis clones rather than
using worktrees, partly to avoid Windows symlink and permission differences.

### WSL

Identical to Linux. Keep the workspace root **inside** the WSL filesystem (`~/jarvis-workspaces`)
rather than on `/mnt/c` — cloning and building across the Windows/Linux boundary is slow enough to
make verification time out.

### Docker

```bash
docker build -f docker/worker.Dockerfile -t jarvis-worker .

docker run -d --name jarvis-worker \
  --env-file .env \
  -v jarvis-workspaces:/workspaces \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --memory 4g --pids-limit 512 \
  jarvis-worker
```

Or `docker compose -f docker/compose.worker.yml up --build`.

The container runs as the unprivileged `node` user, drops all capabilities, and mounts the
workspace root as a named volume so preserved work survives a restart — which is what makes
"stopping a mission preserves its work" true across a redeploy too.

**Docker is the recommended way to run a worker.** The agent's tool calls execute as the worker's
own user; a container is the difference between "the agent is confined to a workspace" and "the
agent is confined to a workspace _and_ the OS agrees".

### A persistent Linux server (systemd)

```ini
# /etc/systemd/system/jarvis-worker.service
[Unit]
Description=Jarvis mission worker
After=network-online.target

[Service]
Type=simple
User=jarvis
WorkingDirectory=/opt/jarvis
EnvironmentFile=/etc/jarvis/worker.env
ExecStart=/usr/bin/npm run worker
Restart=always
RestartSec=10
# SIGTERM drains: the current mission finishes and reports honestly before the process exits.
KillSignal=SIGTERM
TimeoutStopSec=900
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/var/lib/jarvis/workspaces

[Install]
WantedBy=multi-user.target
```

`systemctl enable --now jarvis-worker`, then `journalctl -u jarvis-worker -f`.

---

## Configuration

| Variable                           | Default                  | What it does                                                                                    |
| ---------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| `JARVIS_CONTROL_PLANE_URL`         | _(required)_             | The Jarvis deployment this worker reports to                                                    |
| `JARVIS_WORKER_TOKEN`              | _(required)_             | The enrolment token                                                                             |
| `JARVIS_WORKER_NAME`               | `jarvis-worker`          | Shown on the workers page                                                                       |
| `JARVIS_WORKER_WORKSPACE_ROOT`     | `./.jarvis-workspaces`   | Where mission clones live                                                                       |
| `ANTHROPIC_API_KEY`                | —                        | Without it, the worker reports itself unavailable rather than claiming work it cannot do        |
| `JARVIS_WORKER_MODEL`              | the SDK default          | Model override                                                                                  |
| `JARVIS_WORKER_MAX_TURNS`          | `60`                     | Agent turn limit per run                                                                        |
| `JARVIS_WORKER_GITHUB_TOKEN`       | —                        | Without it, read-only and research missions still work; code missions commit locally and say so |
| `JARVIS_WORKER_GITHUB_API_URL`     | `https://api.github.com` | For GitHub Enterprise                                                                           |
| `JARVIS_WORKER_POLL_MS`            | `3000`                   | Idle poll interval                                                                              |
| `JARVIS_WORKER_VERIFY_TIMEOUT_MS`  | `600000`                 | Per-command verification limit                                                                  |
| `JARVIS_WORKER_ACCEPT_INSPECTION`  | `true`                   | Take read-only planning runs                                                                    |
| `JARVIS_WORKER_ACCEPT_EXECUTION`   | `true`                   | Take execution and research runs                                                                |
| `JARVIS_WORKER_ALLOW_WEB_RESEARCH` | `false`                  | Allow web tools on research missions                                                            |
| `JARVIS_WORKER_SANDBOX_REPOS`      | —                        | `owner/repo=<clone url>` pairs; see below                                                       |
| `JARVIS_WORKER_RUNTIME`            | `claude`                 | `scripted` drives the mission path without a model (tests only)                                 |

### Rehearsing safely: `JARVIS_WORKER_SANDBOX_REPOS`

```bash
export JARVIS_WORKER_SANDBOX_REPOS="me/production-app=/home/me/sandbox/app.git"
```

Redirects a repository to somewhere harmless, so you can watch a mission run end to end without
it touching the real thing. A redirected worker says so loudly in its heartbeat and on the workers
page — a rehearsal is never mistaken for the real delivery. This is what the end-to-end smoke test
uses, which is why that test can never reach a real repository.

---

## What the worker will and will not do

**It will:** clone into an isolated workspace, create a `jarvis/<mission-id>-<slug>` branch, make
the approved changes, run the repository's own verification commands, commit, push that one
branch, and open a **draft** pull request.

**It will not**, under any circumstances:

- push to a default branch, force push, or push any ref other than the mission branch;
- merge, rebase, or rewrite history;
- change repository settings, secrets, branch protection or collaborators;
- publish a release, deploy anything, or upload a build;
- read `.env` files, SSH keys or credential stores;
- run `sudo`, or touch any path outside the mission workspace.

These are capability limits in the worker, not instructions to the model. `assertPushAllowed`
inspects the argument vector before `git` is even started, and `evaluateToolUse` decides every
tool call. Repository instructions — `CLAUDE.md`, `AGENTS.md`, a README — are project guidance
from an untrusted source: Jarvis follows them for conventions and never for permissions.

Anything outside the permission set but not forbidden becomes a **permission request** you decide
on, and an approval applies to that one request. There is no "always allow".

---

## Workspaces

One clone per mission at `<workspace root>/<mission-id>/repo`. Never a worktree of your own
checkout — a worktree shares `.git`, and a mistake there would be a mistake in the repository you
actually work in.

Read-only inspection — the run that produces a plan — uses a separate clone at
`<workspace root>/<mission-id>/inspect`. A mission is normally inspected and then executed, so a
shared directory would leave the planning clone sitting in the execution run's way; and keeping
them apart means the work in `repo` is never mixed up with a throwaway read of the repository.

Workspaces are **never deleted automatically**: not on failure, not on a stop, not on restart. If
a mission goes wrong the evidence is still on disk. Clean them up yourself once you are sure you
do not need them:

```bash
ls "$JARVIS_WORKER_WORKSPACE_ROOT"          # one directory per mission
rm -rf "$JARVIS_WORKER_WORKSPACE_ROOT/<mission-id>"
```

A leftover workspace from an earlier attempt is not silently reused either — a retry refuses to
start until you have looked at it and removed it deliberately. The single exception is the
`inspect` clone: re-planning a mission is an ordinary thing to do, so a _clean_ inspection clone
is replaced. Cleanliness is checked against the working tree, not assumed from the read-only
permission mode, and anything that cannot be proven clean is preserved and reported instead.

---

## Health and recovery

`npm run worker:health` (and the container's `HEALTHCHECK`) reports:

- whether the Claude runtime can start, and why not if it cannot;
- whether the workspace root is writable;
- whether the GitHub write credential is configured;
- how many preserved workspaces are on disk.

### The worker stopped reporting

Jarvis marks the **worker** disconnected. It does **not** change the mission: a lost heartbeat is
not evidence of success or failure, and the workspace, branch and any commits are untouched. The
mission shows as "not reporting" with an explanation.

Restart the worker. If the mission had a preserved workspace it can be resumed; otherwise retry it
as a new attempt, which keeps the earlier attempt's record.

### The worker will not claim anything

Check, in order:

1. **Is it connected?** Workers page → last heartbeat.
2. **Is the runtime available?** No `ANTHROPIC_API_KEY` means it declines work rather than
   claiming a mission it cannot run.
3. **Is the workspace root writable?** `npm run worker:health` says.
4. **Is a plan approved?** A queued mission needs an approval for the _current_ plan version.
5. **Is something else already running?** Jarvis runs one mission at a time in this phase.

### A mission is stuck "waiting for permission"

The agent asked for something outside its permission set. Open the mission and decide. It will
wait indefinitely rather than proceed.

### Rotating a credential

- **Worker token:** Workers → Rotate token. The old one stops working immediately; update the
  worker's environment and restart it.
- **Anthropic key:** replace `ANTHROPIC_API_KEY` and restart. Missions in flight fail honestly
  with their workspaces preserved.
- **GitHub write token:** replace `JARVIS_WORKER_GITHUB_TOKEN` and restart. A mission mid-delivery
  fails with `github_auth_error`; its branch and commits are preserved and it can be retried.
- **Revoking a worker** takes effect on its next request. It does not fail the mission it held.

---

## What Prompt 2 does not do

One mission at a time. No multiple agents. No automatic merge, no direct default-branch push, no
production deploy, no TestFlight or App Store upload, no release publishing, no self-approval, no
autonomous repair loop, no recurring missions. Prompt 3 adds multi-agent orchestration,
independent review and controlled repair loops.
