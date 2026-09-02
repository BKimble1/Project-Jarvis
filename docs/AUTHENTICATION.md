# Authentication

Jarvis is a private, single-user product. Authentication answers _who is this_; authorisation
answers _are they the owner_. Both must pass.

## Create the OAuth app

1. **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
   (<https://github.com/settings/developers>).
2. **Application name:** `Jarvis`.
3. **Homepage URL:** your deployment, e.g. `https://jarvis.example.com`.
4. **Authorization callback URL:** `https://jarvis.example.com/api/auth/callback` — it must exactly
   match `JARVIS_BASE_URL` plus that path.
5. Register, then generate a client secret.

For local development, register a second OAuth app with
`http://localhost:3000/api/auth/callback`, so development and production never share a secret.

```
GITHUB_OAUTH_CLIENT_ID=Iv1.xxxxxxxxxxxx
GITHUB_OAUTH_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

The OAuth flow requests only `read:user`. The resulting token is used once, to learn who signed in,
and is then discarded — it is never stored and never used to read repositories.

## Configure the owner

```
OWNER_GITHUB_LOGIN=your-login
OWNER_GITHUB_USER_ID=1234567
```

Find your numeric id:

```bash
curl -s https://api.github.com/users/your-login | grep '"id"'
```

Set **both** if you can. When the id is present it is authoritative, because a GitHub login can be
renamed and the old name can then be claimed by someone else. With both set, the login must match
too.

With neither set, nobody is the owner. In production the application refuses to start; in
development sign-in is disabled and Settings says so.

## The flow

```
/signin
  → GET /api/auth/start          issues a single-use state (hashed, 10-minute expiry, stored server-side)
  → github.com/login/oauth/authorize
  → GET /api/auth/callback       consumes the state, exchanges the code, fetches the identity
      → isOwner(identity)        ← authorisation. Everyone else is rejected here.
      → SessionStore.create()    opaque random token; only its SHA-256 hash is stored
      → Set-Cookie jarvis_session; HttpOnly; SameSite=Lax; Secure (production); Max-Age
  → /dashboard (or the page you were trying to reach)
```

A rejected sign-in returns to `/signin` with a single generic message. It never distinguishes
"wrong account" from "no such account", and it never suggests that access could be requested.

## Sessions

- The cookie carries only an opaque 256-bit random token. Everything about the session lives in the
  `sessions` table, keyed by the token's hash.
- Lifetime is `SESSION_TTL_HOURS` (14 days by default). Expired sessions are rejected on read and
  purged by the scheduled sync.
- Signing out deletes the row, so the cookie is worthless immediately.
- Rotating `SESSION_SECRET`, or deleting rows from `sessions`, signs you out everywhere.

## Where authorisation is enforced

- **Pages:** `src/app/(app)/layout.tsx` calls `requireOwnerPage()` before any child renders, so no
  data is loaded and no HTML is produced for an unauthenticated request.
- **API routes:** every private handler is wrapped in `ownerRoute`, which authenticates, rejects
  cross-origin state-changing requests, validates the body and maps errors safely.
- **Scheduled sync:** `/api/cron/sync` uses a constant-time comparison against `CRON_SECRET`, and is
  closed when that secret is unset.

Client-side route hiding is never used as a security mechanism.

## Test authentication

`POST /api/auth/test` creates a session directly, for Playwright. It exists only when
`JARVIS_TEST_AUTH_SECRET` is set, and `buildConfig` refuses to populate that value when
`NODE_ENV=production` — so the endpoint is inert in a real deployment by construction, not by a
runtime flag that could be flipped.

## Recovery

Locked out because the login changed or the OAuth app was deleted:

1. Update `OWNER_GITHUB_LOGIN` / `OWNER_GITHUB_USER_ID`, or re-create the OAuth app and update the
   client id and secret.
2. Redeploy.

Your data lives in the database and is unaffected by any credential change.
