# Security

Jarvis is a private tool for exactly one person, holding a read credential for repositories that
may be private. It is built to fail closed.

## Single-owner access

- Exactly one identity may sign in, configured as `OWNER_GITHUB_LOGIN` and/or
  `OWNER_GITHUB_USER_ID`. When the numeric id is set it is authoritative, because GitHub logins can
  be renamed and reused.
- A successful GitHub login is **not** sufficient. `isOwner()` (`src/server/auth/owner.ts`) is
  consulted afterwards, and every other account is rejected.
- With no owner configured, nobody is the owner (`no_owner_configured`), and in production the
  application refuses to start at all.
- Rejections are deliberately uninformative: the sign-in screen says only that the account cannot
  access this instance. There is no registration, no "request access", and no hint that a different
  account might succeed.

## Server-side authorisation

- Every private page renders under `src/app/(app)/layout.tsx`, which calls `requireOwnerPage()`
  **before** any data is fetched. Authorisation is never a hidden link.
- Every private API route goes through `ownerRoute` / `ownerRouteWithParams`, which authenticate,
  reject cross-origin writes, validate the body with Zod, and map errors to a safe response.
- Sessions are server-side: the cookie carries only an opaque random token, and its SHA-256 hash is
  the database key. Nothing about the owner is readable from the cookie, and revoking access is a
  row delete. Cookies are `HttpOnly`, `SameSite=Lax`, `Secure` in production, and expire.
- CSRF has two layers: `SameSite=Lax` on the session cookie, and an explicit origin check on every
  state-changing request.

## The GitHub connection is read-only — and provably so

Three independent mechanisms:

1. **The client refuses to write.** `assertReadOnlyRequest` runs inside the fetch used by Octokit
   and throws on any method other than GET or HEAD, _before the request leaves the process_
   (`src/server/providers/github/client.ts`).
2. **The credential is read-only.** The documented token is a fine-grained PAT with read-only
   repository permissions and no write scopes — see [GITHUB_TOKEN.md](GITHUB_TOKEN.md).
3. **The interface has no write operations.** `SourceProvider`
   (`src/server/providers/types.ts`) declares only `fetchSnapshot`, `listAvailableRepositories`,
   `describeRepository` and `checkHealth`. There is no write client anywhere in the codebase for a
   feature to reach for.

The test-suite asserts (1) and (3) directly, and the end-to-end mock GitHub server returns `405`
for any non-GET request, so an accidental write would fail the build rather than pass unnoticed.

The OAuth token used for sign-in requests only `read:user`, is used once to learn who signed in, and
is never stored. It is never used to read repositories.

## Secrets

- `src/server/config/env.ts` is the only module that reads `process.env`. No secret is exposed to
  the browser, and no variable is prefixed `NEXT_PUBLIC_`.
- The Settings screen reports **presence**, never value: the owner login is masked, and no
  credential, prefix or length is rendered.
- Structured logs are redacted twice: by key name (`token`, `secret`, `authorization`, `cookie`,
  `session`, `credential`, …) and by value shape (`ghp_`, `github_pat_`, `sk-ant-`, `Bearer …`,
  `postgres://…`).
- Errors returned to the browser carry a code and a human message — never a stack trace, a provider
  payload or a request header.
- The data export contains projects, evidence, snapshots, sync history and activity. It contains no
  sessions, no OAuth state and no configuration.
- Secrets are never written into evidence, project metadata, activity detail or generated
  briefings. Activity `detail` is a small, redacted record — never a raw API response.

## Scheduled synchronisation

`/api/cron/sync` requires `CRON_SECRET`, compared in constant time, supplied as
`x-jarvis-cron-secret` or a bearer token. **When the secret is unset the endpoint is closed**, not
open — a misconfigured deployment fails safe.

## Server-side request forgery

Owner-supplied URLs (project links) are validated to `http`/`https`, stored as data, and rendered
only as anchors. The server never fetches them. The only outbound hosts are the GitHub API base URL
and, when configured, the Anthropic API.

## Transport and headers

Applied in `next.config.ts` and reinforced in `netlify.toml`:

- A Content-Security-Policy with `default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`
  and a `connect-src` limited to the same origin. No third-party scripts are loaded.
- `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive `Permissions-Policy`, and
  `Cross-Origin-Opener-Policy: same-origin`.
- `robots` metadata marks every page `noindex, nofollow`.

## Fail-closed configuration

In production, `buildConfig` throws rather than degrade when any of these is missing or unsafe:
`JARVIS_BASE_URL` (and it must be https), a `SESSION_SECRET` of at least 32 characters, an owner
identity, GitHub OAuth credentials, and a `DATABASE_URL`. Selecting the embedded PGlite driver in
production is refused outright.

Two capabilities are inert in production by construction rather than by a runtime flag:

- **Demo mode** is ignored unless `JARVIS_ALLOW_DEMO_IN_PRODUCTION` is also set.
- **Test authentication** (`/api/auth/test`) is only enabled when `JARVIS_TEST_AUTH_SECRET` is
  populated, and `buildConfig` refuses to populate it when `NODE_ENV=production`.

## What is sent to the AI narrator

Only normalised project evidence: names, statuses, phases, goals, claim text, and evidence ids with
titles, timestamps and public URLs. Never credentials, never environment variables, never repository
contents, never database rows verbatim. The narrator is given no tools, so it cannot call anything.

## Reporting

This is a single-user personal deployment. If you find a problem, fix it on a branch and run
`npm run verify` before deploying.
