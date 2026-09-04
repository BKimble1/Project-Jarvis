# Running the factory

How to watch what Jarvis is doing, how to slow it down, and how to put a screen on a wall.

## The operations page

`/operations` answers one question: _what is running, and is that too much?_ It is ordered by
urgency rather than by data model.

1. **Stopped reporting.** Agents still holding a task that have gone quiet. Their workspaces are
   preserved. This is first because it is the only category where the number on the screen may
   already be wrong.
2. **Waiting for you.** Agents that stopped and asked.
3. **Agents.** Everything currently running, with its role, its task and its mission.
4. **Open missions.** With repair rounds used.
5. **Ceilings.** What you allowed, and how much of it is in use.

The page is server-rendered and does not poll. A refresh is always correct, and an operations page
that can show stale numbers will do so at the worst possible moment.

### Slowing Jarvis down

Three controls, all of which only ever reduce:

| Control                    | Effect                                                         |
| -------------------------- | -------------------------------------------------------------- |
| **Finish what is running** | Posture `draining`. Running agents finish; nothing new starts. |
| **Stop starting anything** | Posture `stopped`. Same, but also refuses a claim outright.    |
| **One agent at a time**    | Lowers the global agent ceiling to 1.                          |

None of these kills work in progress or deletes a workspace. Whatever an agent has done stays on
its branch.

Raising a limit is a configuration change made deliberately and restarted into. That asymmetry is
on purpose: the direction that matters under pressure is down, and a control that can go both ways
is a control that can go the wrong way at exactly the wrong moment.

### Configuration

| Variable                             | Default   | Ceiling    |
| ------------------------------------ | --------- | ---------- |
| `JARVIS_MAX_ACTIVE_MISSIONS`         | 2         | 6          |
| `JARVIS_MAX_ACTIVE_AGENT_RUNS`       | 4         | 12         |
| `JARVIS_MAX_RUNS_PER_MISSION`        | 3         | 6          |
| `JARVIS_MAX_PARALLEL_READONLY`       | 3         | 6          |
| `JARVIS_MAX_PARALLEL_WRITERS`        | 1         | 3          |
| `JARVIS_MAX_REPAIR_ROUNDS`           | 2         | 3          |
| `JARVIS_MAX_TASK_RUNTIME_MINUTES`    | 45        | 240        |
| `JARVIS_MAX_MISSION_RUNTIME_MINUTES` | 240       | 720        |
| `JARVIS_MAX_TASK_OUTPUT_TOKENS`      | 600,000   | 4,000,000  |
| `JARVIS_MAX_MISSION_OUTPUT_TOKENS`   | 3,000,000 | 20,000,000 |

A value above the ceiling is clamped, not rejected — a typo in an environment variable should not
stop Jarvis booting, and it should certainly not silently grant more than the ceiling allows.

Jarvis counts **tokens, not money**. It cannot see your bill, and a number in pounds would be a
guess dressed up as a fact.

## Wall displays

A wallboard is a separate identity with less access, not a small owner session.

### Pairing

1. **Settings → Wall displays**, name the device, choose what it may show, pair.
2. The token appears **once**. There is no route that returns it again and no field on the device
   record that could carry it — only a hash is stored, plus a prefix so you can tell two devices
   apart in a list.
3. On the device, open `/display` and type the token. It is exchanged for an `httpOnly` cookie, so
   it is not readable from the page's own JavaScript.

### What a display can and cannot do

It shows counts, mission cards, which roles are working, what needs a person, and what just
finished. It does **not** show a repository name, a branch, a diff, a file path, a transcript, an
artifact body, a pull-request URL, a worker token prefix, or any credential. `GET /api/display` is
the only display-authenticated route in Jarvis; there is no display-authenticated write of any
kind, so approve, pause, stop, message, retry, merge and TestFlight are unreachable rather than
merely hidden.

The payload is assembled from scratch rather than filtered down from the owner's, because a hidden
field is still a field on the wire. `findForbiddenDisplayKeys` scans the finished object before it
is served: a future field named `pullRequestUrl` fails the request rather than reaching a wall.

### Revoking

**Settings → Wall displays → Revoke.** It takes effect on the device's next refresh, without
touching the device. Revoke a display you have lost, sold, or lent to a room you no longer control
— and revoke rather than trying to recover a token, because a token cannot be recovered.

### Setting one up

[WALLBOARD.md](WALLBOARD.md) has the exact steps for an Android tablet and a Raspberry Pi kiosk:
keeping the screen awake, starting full-screen after a reboot, and where the credential lives
(the device's own cookie store, never a script).

### The screen itself

Designed to be read from across a room: large type, high contrast, the numbers that matter
biggest. It refreshes at the device's rotation interval and says how old what you are looking at
is. A failed refresh says so, because a board silently showing five-minute-old work as current is
worse than a blank one — it is trusted.

## External builds

Off by default and inert without deliberate configuration:

| Variable                            | Meaning                                                             |
| ----------------------------------- | ------------------------------------------------------------------- |
| `JARVIS_CI_ENABLED`                 | The master switch.                                                  |
| `JARVIS_CI_GITHUB_TOKEN`            | The controller's **own** credential. It never borrows the worker's. |
| `JARVIS_CI_REPOSITORIES`            | Comma-separated allow-list.                                         |
| `JARVIS_CI_WORKFLOWS`               | Comma-separated allow-list of workflow _files_.                     |
| `JARVIS_CI_REFS`                    | Comma-separated allow-list of refs.                                 |
| `JARVIS_CI_MAX_DISPATCHES_PER_HOUR` | Rate ceiling.                                                       |

Six gates stand between a request and a build, and a seventh for a release. A refusal is a stored
row naming the rule, because a controller that silently drops what it will not do is impossible to
audit.

**Jarvis never holds Apple credentials.** Signing and App Store Connect secrets live in GitHub
Actions secrets that only the workflow can read. An app profile stores the _name_ of a secret and
refuses at its schema to store anything that looks like a value. A workflow starting is not the
same as a build reaching testers, and the receipt says so: the App Store Connect processing stage
is reported as `unknown`, because Jarvis cannot see it.
