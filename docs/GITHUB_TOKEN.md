# The read-only GitHub token

Jarvis reads repositories with a **fine-grained personal access token** that has no write
permissions at all. This is the credential named `GITHUB_READ_TOKEN`, and it is entirely separate
from the OAuth app used for sign-in.

## Create it

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**
   (<https://github.com/settings/personal-access-tokens/new>).
2. **Token name:** `jarvis-read-only`.
3. **Expiration:** choose a date you will actually renew. 90 days is a reasonable default; Jarvis
   reports a revoked or expired credential clearly rather than silently showing stale data.
4. **Resource owner:** your account (or the organisation that owns the repositories).
5. **Repository access:** choose **Only select repositories** and pick exactly the repositories you
   want Jarvis to watch. Do not grant "All repositories" — deliberate selection is the point.
6. **Repository permissions** — set these to **Read-only**, and nothing else:

| Permission        | Why Jarvis needs it                                                           | Without it                                |
| ----------------- | ----------------------------------------------------------------------------- | ----------------------------------------- |
| **Metadata**      | Mandatory. Repository name, visibility, default branch, language, last push.  | Nothing works; synchronisation fails.     |
| **Contents**      | Recent commits.                                                               | Commit history is unknown.                |
| **Pull requests** | Open and recently merged pull requests.                                       | Completed and in-flight work is unknown.  |
| **Issues**        | Open and recently closed issues.                                              | Issue panel reports it could not be read. |
| **Actions**       | Workflow runs — this is what makes "the build is failing" a _verified_ claim. | Build health is unknown.                  |
| **Checks**        | Check results on the latest commit.                                           | Check detail is unavailable.              |
| **Deployments**   | Deployments and their statuses, where you use them.                           | Deployment panel is hidden.               |

7. **Do not grant any write, admin or delete permission**, and no account permissions.
8. Generate the token and copy it once — GitHub will not show it again.

## Install it

Local development, in `.env.local`:

```
GITHUB_READ_TOKEN=github_pat_xxxxxxxxxxxxxxxxxxxxxxxx
```

Netlify: Site configuration → Environment variables → add `GITHUB_READ_TOKEN`, marked as a secret,
scoped to Builds and Functions.

Restart, then open **Settings** in Jarvis. It should report _Connected with read-only access_ along
with your remaining API quota. It reports only that the token is configured — never any part of
its value.

## What Jarvis does with it

- Only `GET` requests. `assertReadOnlyRequest` throws on any other method before the request leaves
  the process, so even a future coding mistake cannot write.
- Only the endpoints needed for the panels you see: repository metadata, commits, pull requests,
  issues, workflow runs, check runs, releases, deployments and their latest statuses.
- Bounded: each category is limited by both a row count and a time window
  (`JARVIS_SYNC_*` in `.env.example`), so one synchronisation can never walk years of history.
- The token is used server-side only. It is never sent to the browser, never logged (the logger
  redacts `github_pat_` and `ghp_` patterns), and never included in an export.

## Partial permissions are a normal state

If you grant fewer permissions than the table above, Jarvis degrades honestly rather than failing:
the synchronisation is reported as **partial**, the unreadable categories are listed on the project
page, and the corresponding claims become **Unknown** rather than silently empty. Only Metadata is
mandatory.

## Renewing or revoking

- **Renewing:** create a new token, replace the environment variable, redeploy. Nothing else
  changes; evidence already collected is untouched.
- **Revoking:** delete the token on GitHub. Jarvis's next synchronisation fails with _“GitHub
  rejected the credential”_, the affected projects are marked **Sync failing**, and the last
  verified data stays on screen — clearly labelled as last-known-good, never presented as current.

## The worker's write credential is a different token

Everything above is about `GITHUB_READ_TOKEN`, which the Jarvis web app uses to _read_. Since
Phase 2 there is a second, separate credential — `JARVIS_WORKER_GITHUB_TOKEN` — which lives only
on the worker machine and can write.

Keep them apart, deliberately:

|             | `GITHUB_READ_TOKEN`                         | `JARVIS_WORKER_GITHUB_TOKEN`                                                      |
| ----------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| Lives on    | The Netlify deployment                      | The worker machine only                                                           |
| Permissions | Read-only, several categories               | **Contents: read and write**, **Pull requests: read and write**, and nothing else |
| Used for    | Synchronising evidence                      | Pushing the mission branch, opening the draft PR                                  |
| Enforced by | `assertReadOnlyRequest` refuses any non-GET | `assertPushAllowed` and a four-method delivery interface                          |

Widening the read token is never the answer to a worker permission problem. If the worker cannot
push, the fix is on the worker's own token. Full setup: [WORKER.md](WORKER.md).

## Organisation repositories

For repositories owned by an organisation, an owner may need to approve fine-grained token access
(Organisation settings → Personal access tokens). Until it is approved, those repositories will not
appear on the import screen.

## GitHub Enterprise Server

Set `GITHUB_API_BASE_URL` to your instance's API root (for example
`https://github.example.com/api/v3`). Everything else is unchanged.
