# Launching Jarvis

One command starts everything:

```bash
npm run jarvis:live
```

That is the whole procedure. Everything below explains what it does, what it will
refuse to do, and how to run the pieces by hand when you need to.

## What it starts

Jarvis is two long-lived processes and a database:

| Part          | What it is                                                                                           | Started by                                            |
| ------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Control plane | The Next.js app — the dashboard, `/display`, and every API the worker talks to                       | `npm run jarvis:live`                                 |
| Worker        | The long-lived process that runs missions, drives the operating loop, and reads your Claude capacity | `npm run jarvis:live`, once the control plane answers |
| Database      | PGlite, opened inside the control plane; or PostgreSQL if `DATABASE_URL` is set                      | Itself, or your host                                  |

There has never been anything that started both processes, and that is the failure
this command exists to prevent: it is not an error, it is an owner who started the
web app, did not start the worker, and spent a morning wondering why nothing was
happening.

The worker is started **after** the control plane answers `GET /api/health`, so its
first minute is not spent logging connection failures at you.

## Before the first launch

```bash
cp .env.example .env.local
```

Fill in `SESSION_SECRET`, `OWNER_GITHUB_LOGIN` and the OAuth pair — `npm run doctor`
explains anything that is missing.

Then enrol a worker: start the control plane on its own (`npm run dev`), open
**Operations → Workers**, enrol one, and put the token it gives you in `.env.local`
as `JARVIS_WORKER_TOKEN`. It is shown once.

`npm run jarvis:live` reads **both** `.env.local` and `.env`, with `.env.local`
winning. That matters: Next.js reads `.env.local` and every plain-Node script in
this repository reads `.env`, so before this existed an owner who followed the setup
instructions had a control plane that could see its configuration and a worker that
could not.

## Using it from another device

The launcher prints every address on your network. To open Jarvis from a phone, a
tablet or a Raspberry Pi wallboard, set `JARVIS_BASE_URL` to the address you will
actually type:

```
JARVIS_BASE_URL=http://192.168.1.20:3000
```

Leaving it at `localhost` is fine for one machine, and the launcher will say so
rather than refuse — but another device will then be able to _read_ Jarvis and not
change it. The same-origin check refuses a write whose origin is not the base URL,
and it refuses it with a security error that reads like a bug.

Jarvis binds to `0.0.0.0` so your own network can reach it. It does not open a
tunnel and does not touch your firewall. Reaching it from outside your home is a
decision with consequences, and it is not one to arrive at by running a start
script — use a private network such as Tailscale if you want it.

## Stopping

Ctrl-C, or `SIGTERM` to the launcher.

The worker is stopped first and given up to fifteen seconds. Draining means it
finishes the mission in its hands and reports that it finished, so stopping the
control plane at the same moment would take away the endpoint it needs — and a clean
stop would become a mission the control plane still believes is claimed.

Each process is started in its own process group and the group is signalled, because
`npx next dev` is not one process: it is `npm exec`, which spawns a shell, which
spawns node, which spawns the server. Signalling only the top of that chain leaves
the server running while the terminal says it stopped.

## Restarting, and after a reboot

`npm run jarvis:live` again. There is nothing to clean up: an interrupted mission is
picked up by the worker that reclaims it, and a mission whose worker never came back
is reconciled by the control plane.

For a machine that should come back on its own after a power cut, run it under
systemd:

```ini
# /etc/systemd/system/jarvis.service
[Unit]
Description=Jarvis
After=network-online.target

[Service]
Type=simple
User=jarvis
WorkingDirectory=/home/jarvis/Project-Jarvis
ExecStart=/usr/bin/npm run jarvis:live
Restart=always
RestartSec=10
KillSignal=SIGTERM
# Long enough for the worker to finish a mission rather than abandon one.
TimeoutStopSec=900

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now jarvis
journalctl -u jarvis -f      # logs
```

Run it under **the same operating-system account that you signed into Claude Code
with**. The worker authenticates by using that account's stored Claude login; a
service running as a different user has no login to read. On a headless machine
where you cannot sign in interactively, run `claude setup-token` as that user and
put the token in `.env.local` as `CLAUDE_CODE_OAUTH_TOKEN`.

## Checking it

| Question                                        | Command                                 |
| ----------------------------------------------- | --------------------------------------- |
| Is everything configured?                       | `npm run doctor`                        |
| Is the worker healthy, and on which credential? | `npm run worker:health`                 |
| Is the control plane up?                        | `curl http://127.0.0.1:3000/api/health` |
| How much Claude is left?                        | Operations → Claude capacity            |

## Running the pieces by hand

The launcher starts commands that all still work on their own, which is what you
want when something is wrong:

```bash
npm run dev            # control plane only
npm run worker         # worker only, in another terminal
npm run db:migrate     # only for a hosted database; PGlite migrates itself
```

## What it deliberately does not do

- **It does not open the database.** PGlite is embedded in whichever process opens
  it, so a launcher that connected would be a second writer to a single-writer store
  — and the symptom would not be an error, it would be two processes disagreeing.
- **It does not build.** It runs `next dev`, which is the right thing for a machine
  you also edit code on. For a production build, run `npm run build && npm run start`
  and `npm run worker` separately.
- **It does not expose anything publicly.** See _Using it from another device_.
