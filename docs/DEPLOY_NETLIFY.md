# Deploying to Netlify

## 1. Create a database first

Jarvis needs durable PostgreSQL. A local file-based database is refused in production.

**Netlify DB (Neon)** is the shortest path:

1. In your Netlify site → **Extensions** → install **Netlify DB**, or run `npx netlify db init`.
2. It provisions a Neon database and sets `NETLIFY_DATABASE_URL`.
3. Copy that value into `DATABASE_URL` (Jarvis reads `DATABASE_URL`), and set
   `JARVIS_DB_DRIVER=neon`.

Any hosted PostgreSQL works. With Supabase, RDS or a Neon **pooled** endpoint, use
`JARVIS_DB_DRIVER=pg` instead. See [DATABASE.md](DATABASE.md).

## 2. Create the GitHub OAuth app

[AUTHENTICATION.md](AUTHENTICATION.md) has the details. The callback URL must be
`https://<your-site>/api/auth/callback` — the production domain, not a deploy preview.

## 3. Create the read-only repository token

[GITHUB_TOKEN.md](GITHUB_TOKEN.md). Grant read-only permissions to only the repositories you
intend Jarvis to watch.

## 4. Connect the repository

New site → import from Git. Netlify reads `netlify.toml`, so the build command, publish directory
and the Next.js plugin are already configured:

```toml
[build]
  command = "npm run db:migrate && npm run build"
  publish = ".next"
```

Migrations run **before** the build, so the deployed code never meets an older schema.

## 5. Environment variables

Site configuration → **Environment variables**. Mark every secret as such and scope it to
_Builds_ and _Functions_.

| Variable                     | Required    | Notes                                                                 |
| ---------------------------- | ----------- | --------------------------------------------------------------------- |
| `JARVIS_BASE_URL`            | ✅          | `https://your-site.netlify.app` or your custom domain. Must be https. |
| `SESSION_SECRET`             | ✅          | 32+ random characters. Rotating it signs you out.                     |
| `OWNER_GITHUB_LOGIN`         | ✅¹         | Your GitHub login.                                                    |
| `OWNER_GITHUB_USER_ID`       | ✅¹         | Your numeric GitHub id. Preferred — logins can be renamed.            |
| `GITHUB_OAUTH_CLIENT_ID`     | ✅          | From the OAuth app.                                                   |
| `GITHUB_OAUTH_CLIENT_SECRET` | ✅          | From the OAuth app.                                                   |
| `DATABASE_URL`               | ✅          | Hosted PostgreSQL connection string.                                  |
| `JARVIS_DB_DRIVER`           | recommended | `neon` or `pg`. Inferred from the URL when unset.                     |
| `GITHUB_READ_TOKEN`          | optional    | Read-only fine-grained PAT. Without it, only manual projects work.    |
| `ANTHROPIC_API_KEY`          | optional    | Enables AI narration. Jarvis is fully usable without it.              |
| `JARVIS_AI_MODEL`            | optional    | Defaults to `claude-opus-5`.                                          |
| `CRON_SECRET`                | recommended | 16+ characters. Scheduled synchronisation is **disabled** without it. |
| `LOG_LEVEL`                  | optional    | `info` by default.                                                    |

¹ At least one of the two owner variables is required; setting both is strongest.

The build **fails deliberately** if a required production variable is missing. That is the
fail-closed behaviour working: a half-configured Jarvis would be a private tool with no lock on the
door.

## 6. Scheduled synchronisation

`netlify.toml` registers `netlify/functions/scheduled-sync.mts` on a two-hourly schedule. It holds
no logic: it calls `POST /api/cron/sync` with `CRON_SECRET`, so scheduled and manual synchronisation
take exactly the same code path.

Change the cadence by editing the schedule:

```toml
[functions."scheduled-sync"]
  schedule = "0 */2 * * *"
```

Without `CRON_SECRET`, the endpoint returns 403 and the function logs that it was skipped.

## 7. Deploy and check

1. Trigger a deploy. The build log should show the migrations applying.
2. Visit the site — you should land on `/signin`.
3. Sign in with the owner account. Any other account is rejected.
4. Open **Settings** and confirm: owner configured, GitHub connection healthy, scheduled sync
   enabled, database driver as expected, demo mode off.
5. Import a repository and confirm the first synchronisation reports full or partial honestly.

## 8. Install it on your phone

Open the site in Safari on iOS → Share → **Add to Home Screen**. On Android, Chrome offers
**Install app**. The manifest and service worker are already served; the app opens standalone, and
the shell still renders offline with a clear "you are offline" page.

## Operational notes

**Function duration.** `/api/sync/all` and `/api/cron/sync` declare `maxDuration = 60`. With many
repositories, prefer the scheduled sync over a single manual "synchronise all".

**Rate limits.** Every synchronisation records GitHub's remaining quota, visible on the project's
synchronisation history and on Settings. A rate-limited sync fails safely, keeps prior data and
marks it stale.

**Rollback.** Netlify's "publish deploy" reverts code instantly. Database migrations are additive by
design; a rollback of code does not require a rollback of schema.

**Logs.** Function logs are single-line JSON with secrets redacted, so they can be pasted into an
issue without leaking a credential.

## Troubleshooting

| Symptom                                            | Cause                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Build fails on `ConfigurationError`                | A required production variable is missing. The message names it.                           |
| `PGlite is a local development and test database…` | `DATABASE_URL` is unset or `JARVIS_DB_DRIVER=pglite` leaked into production.               |
| Sign-in redirects back with `not_authorised`       | The signed-in account does not match the configured owner.                                 |
| Sign-in fails with `expired`                       | The OAuth state expired (10 minutes) or the callback URL does not match `JARVIS_BASE_URL`. |
| Scheduled sync never runs                          | `CRON_SECRET` is unset, or `JARVIS_BASE_URL` is not set for the function.                  |
| Import lists nothing                               | The fine-grained token has no repositories selected.                                       |
