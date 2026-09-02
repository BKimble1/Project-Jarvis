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

- A **nonce-based** Content-Security-Policy, emitted per request by `src/middleware.ts`:
  `script-src 'self' 'nonce-…' 'strict-dynamic'`, with `default-src 'self'`,
  `frame-ancestors 'none'`, `object-src 'none'` and a `connect-src` limited to the same origin.
  There is no blanket `'unsafe-inline'` for scripts — the one inline script Jarvis emits (the
  pre-paint theme switch) carries the nonce. `style-src` keeps `'unsafe-inline'` because the
  framework inlines critical CSS without a nonce; an injected stylesheet is a far smaller risk
  than injected script. No third-party scripts are loaded at all.
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

## Mission Control (Phase 2)

Phase 2 introduced two credentials that can change things, and a class of input that did not exist
before: repository content read by an agent. Both are covered in detail in
[THREAT_MODEL.md](THREAT_MODEL.md), which is written to be falsifiable — nearly every mitigation
names the test that proves it.

The short version:

- **The worker holds its own credentials.** Jarvis never sends the Anthropic key or the GitHub
  write token to anything, and neither appears in a mission prompt, an event, an artifact, a
  transcript or an export.
- **The GitHub write credential is narrow by documentation and by code.** Contents and Pull
  requests, read and write, on selected repositories — and `GitHubDelivery` has no method that
  could merge, release, deploy, or change a setting or a secret.
- **Push safety is a pure function over the argument vector**, evaluated before `git` starts:
  no default-branch push, no force, no `--mirror`/`--all`/`--tags`/`--delete`, no forcing or
  deleting refspec, no ref other than the mission branch.
- **Repository content is untrusted input.** A `CLAUDE.md` is project guidance from an untrusted
  source; it never becomes permission. The precedence order is stated in the system prompt _and_
  enforced by `evaluateToolUse`, which runs whatever the model believes.
- **Worker requests are authenticated with a bearer token** whose SHA-256 hash is all Jarvis
  stores, checked in constant time, revocable immediately, and required to carry an
  `Idempotency-Key` on anything that changes state.
- **A worker's claims are never taken at face value.** It says "run X"; the control plane looks X
  up, checks it belongs to that worker and is still the mission's active run, and only then acts.
- **A lost heartbeat changes nothing.** It marks the _worker_ disconnected. A crash never produces
  a false `completed`, and never a false `failed` either — the work on disk may be fine.

## Reporting

This is a single-user personal deployment. If you find a problem, fix it on a branch and run
`npm run verify` before deploying.
