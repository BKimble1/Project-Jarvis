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

Owner-supplied URLs on a project are validated to `http`/`https`, stored as data, and rendered only
as anchors. The server never fetches those.

Since Phase 4B there is one place the server *does* fetch an owner-supplied URL — importing a web
page into knowledge — and it is treated as a security boundary rather than as a feature:

- `http`/`https` only. Every other scheme is refused, `file:` and `gopher:` included.
- Embedded credentials (`https://user:pass@host`) are refused outright.
- The hostname is resolved and **every returned address** is checked, not just the first. Blocked:
  loopback, link-local, private ranges, carrier-grade NAT, the cloud metadata address, multicast
  and reserved space — in IPv4, IPv6, and IPv4-mapped IPv6 form.
- IPv4 is canonicalised with `inet_aton` semantics, so decimal, octal, hex and short forms all
  resolve to the same address before it is checked. `0x7f.1`, `2130706433` and `127.1` are all
  loopback and all refused.
- DNS is **pinned**: the approved address is the one connected to, via Node's `lookup` option. A
  name that resolves differently between the check and the connection cannot be used to slip past.
- **Every redirect destination is re-validated** against all of the above. A public URL that
  redirects to `169.254.169.254` is refused at the hop, not followed.
- Redirect count, response size, content type and total time are all capped.
- No application cookie or authorization header is ever forwarded. There is no authenticated
  crawling.
- The final URL actually fetched is recorded as provenance, so a citation names where the content
  came from rather than where it was requested from.
- The allow-list of hosts comes from configuration and never from a request.

There is deliberately **no endpoint that fetches an arbitrary URL and returns its body**. The only
caller is ingestion, which stores what it read.

## Knowledge and memory (Phase 4B)

- **Every knowledge write is owner-only**, through `ownerRoute`, which authenticates on the server
  and rejects cross-origin writes before the handler runs.
- **Authorisation happens before ranking**, inside the same SQL statement that scores. Nothing
  retrieves across projects and filters afterwards, so no intermediate — a log line, a cache, a
  slow-query sample — ever holds a row the caller was not allowed to see.
- **Audience ceilings are fixed in code.** A wallboard may see `public` and nothing else; an agent
  may see `internal`; neither can be raised by any request field. `buildScopeFilter` clamps down
  and never up.
- **An agent's inference never becomes memory on its own.** A mission may propose; only the owner
  approves, and the proposer is refused even if it presents as the owner (checked on identity, not
  only on actor kind).
- **Uploads are verified against their bytes.** The declared content type and the extension must
  agree, and the parsers then check the file's actual signature — so renaming a ZIP to `.md` is
  refused rather than stored as searchable prose. Nothing unpacks an archive. No client-supplied
  storage path exists.
- **Retrieved text is data, never authority.** `Evidence` has no field through which a document
  could grant a tool, change a scope or approve anything — not filtered, absent. The text is
  returned intact rather than scrubbed, because a document may legitimately discuss prompt
  injection and an attacker can always rephrase; the guarantee is structural.
- **Forgetting destroys.** Statement, detail, excerpts, tags, source reference and every embedding
  go. What remains is a receipt saying a deletion happened and where content was removed from —
  never what it said.

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

## Several agents (Phase 3)

Everything above still holds. What changes is that a mission may now run several agents, so a few
more things need to be true:

- **A permission profile is a ceiling, never a grant.** Profiles are frozen module data. A task
  may name one; it can never define one, and an unknown name throws rather than defaulting to
  something permissive. `evaluateToolUse` applies the profile first and it can only ever `deny`,
  so every rule from Phase 2 still runs afterwards.
- **An agent cannot widen its own scope.** Not its role, not its profile, not its write set, not a
  concurrency limit, not a repair budget, not an allow-list, not a playbook, not a display token,
  not an approval of any kind. In each case the guarantee is that no worker-authenticated route
  exists — not that a route checks a flag.
- **Two writing agents never share a checkout.** Each gets its own clone and its own branch, and
  must hold a write lease covering the paths the _approved graph_ declared.
- **The write set is enforced twice**, by one shared containment rule: at the tool call, and again
  against the diff that really happened. A violation preserves the workspace and names the files.
- **Merging is deterministic and has no override.** No model, no strategy option, no force. A
  conflict aborts with both sides intact.
- **A reviewer cannot be handed the builder's argument.** There is no field on a review assignment
  that could carry a transcript, and a fresh reviewer after a repair is never told what the
  previous one concluded.
- **A review cannot approve over a red required check.** Deterministic policy overrides it, records
  what the reviewer actually proposed, and turns the failing checks into the repair scope.
- **A wall display is a separate, weaker identity.** Its own credential, its own revocation, a
  payload built from scratch rather than filtered, and no write route of any kind.
- **The CI controller has its own credential or it does nothing.** It never borrows the worker's,
  and a TestFlight approval is bound to one exact commit.
- **Jarvis never holds an Apple credential.** Signing and App Store Connect secrets stay in GitHub
  Actions secrets that only the workflow can read; an app profile stores the _name_ of a secret and
  its schema refuses anything shaped like a value.

## Reporting

This is a single-user personal deployment. If you find a problem, fix it on a branch and run
`npm run verify` before deploying.
