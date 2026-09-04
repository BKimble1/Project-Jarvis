# Backup, restart and recovery

Everything Jarvis knows is in PostgreSQL. Nothing else is a record.

That is worth being precise about, because it is what makes recovery simple. The worker's disk
holds mission workspaces — clones, branches, uncommitted edits — and those are working copies, not
records: valuable while a mission is in flight, replaceable afterwards. The control plane holds no
state at all beyond what it reads from the database on each request. So a database you can restore
is a Jarvis you can restore.

## What survives a restart, and why

| Restarted    | What happens                                                           |
| ------------ | ---------------------------------------------------------------------- |
| **Web app**  | Nothing is lost. It holds no state between requests.                   |
| **Worker**   | It reconnects and picks its mission back up, from the preserved clone. |
| **Both**     | Both of the above.                                                     |
| **Database** | Whatever the last backup holds. This is the one that matters.          |

A restarted worker is handed back the run it still holds, through the same call that hands out a
first claim, and continues it — reusing the workspace on disk rather than starting again. It does
not re-run an agent whose work is already committed, does not open a second draft pull request for
a commit that already has one, and does not resume a mission you asked to stop. Those are
properties of the code with tests behind them (`tests/integration/worker-runner.test.ts`), not
hopes about the process.

What a restart never does is invent a result. A mission whose worker vanished is left where it
was, marked stalled, with its workspace intact — because the work on disk is very likely fine, and
a `failed` invented for a process that was merely restarted throws away a run that is about to
resume. The one exception is a mission you had already asked to stop: that is completed as
stopped, because you decided its ending and a restart is not a reason to overrule you.

## Stopping safely

```bash
# Worker, foreground
Ctrl-C

# Worker, systemd
sudo systemctl stop jarvis-worker
```

`SIGTERM` **drains**: the current mission finishes and reports honestly before the process exits.
It does not kill an agent mid-edit.

If you need to stop faster than a mission can finish, stop the mission first from Mission Control
and let the worker confirm it. A mission stopped that way keeps its workspace and its branch —
nothing is deleted.

## Backups

Use your database provider's own point-in-time recovery. Neon and Supabase both include it, and a
managed PITR window is better than any `pg_dump` cron you would write, because it does not depend
on a machine you also have to keep running.

Once it is on, tell Jarvis:

```bash
JARVIS_BACKUP_CONFIGURED=true
JARVIS_BACKUP_TARGET=neon-pitr          # a LABEL, never a connection string
JARVIS_BACKUP_RESTORE_TESTED_AT=        # set after the drill below
```

`JARVIS_BACKUP_TARGET` is a label because it is displayed, logged and exported. A connection
string in that variable would be a credential in every one of those places.

If you would rather take your own dumps:

```bash
pg_dump "$DATABASE_URL" --format=custom --file=jarvis-$(date +%F).dump
```

Keep them somewhere that is not the machine running Jarvis.

## The restore drill

Qualification will not accept "backups are configured" as evidence of anything. A backup nobody
has restored is a belief, and the qualification check says `unavailable` until a restore has
actually happened. This is the drill it means:

1. **Restore into a scratch database.** Not over the live one. A new Neon branch, a new Supabase
   project, or a local PostgreSQL — anywhere that is not production.

   ```bash
   createdb jarvis_restore_test
   pg_restore --dbname=jarvis_restore_test jarvis-2026-01-01.dump
   ```

2. **Point a Jarvis at it** and check the schema is current:

   ```bash
   DATABASE_URL=postgres://…/jarvis_restore_test npm run db:migrate
   DATABASE_URL=postgres://…/jarvis_restore_test npm run doctor
   ```

   `doctor` should report every migration applied and the database answering. It will report the
   worker and GitHub checks as unconfigured, which is correct — this is a copy of the records, not
   a second live deployment, and you should not point a worker at it.

3. **Look at what came back.** Start the app against the scratch database and confirm your
   projects are there, your missions have their history, and the knowledge base still has its
   documents and memories.

4. **Throw the scratch database away**, and record the drill:

   ```bash
   npm run qualify -- attest recovery "Restored the 2026-01-01 dump into a scratch database; 4 projects, 31 missions and 12 documents present."
   ```

   Write what you actually saw. The attestation is a sentence you are signing, and a vague one is
   worth nothing later when you are trying to remember whether the backup was ever real.

5. Set `JARVIS_BACKUP_RESTORE_TESTED_AT` to today's date.

Do this again after any change to how the database is hosted, and at least once a year otherwise.

## Reclaiming disk on the worker

Mission workspaces are never deleted automatically. That is deliberate — the changes in a stopped
or failed mission's workspace are the only copy of work nobody has reviewed — but it means a
long-lived worker accumulates clones.

```bash
npm run worker:workspaces                                # what is on disk, and what is in it
npm run worker:workspaces -- remove <missionId>          # remove one, if it is clean
npm run worker:workspaces -- remove <missionId> --force  # remove it, discarding uncommitted work
```

`remove` refuses a workspace with uncommitted changes unless you pass `--force`, and refuses
anything that is not directly inside the configured workspace root.

## Updating

```bash
git pull
npm install
npm run db:migrate
```

Then restart the worker and redeploy the site. On Netlify, migrations run before the build, so the
deployed code never meets an older schema. Run them in that order locally too: schema first, then
the code that expects it.

If the new release changes the worker protocol's major version, the control plane refuses work to
the old worker with a message naming both versions, rather than letting two builds disagree about
what a report means. Update the worker and start it again.

## Related

- [DATABASE.md](DATABASE.md) — drivers, migrations, what each table is for.
- [WORKER.md](WORKER.md#health-and-recovery) — diagnosing a worker that will not pick up work.
- [QUALIFICATION.md](QUALIFICATION.md) — what an attestation is and why it is not a checkbox.
