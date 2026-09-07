# Connecting Jarvis to your mail, calendar and apps

What is built, what you can authorize, and — stated plainly, because it is the part
that saves you an evening — what Apple does not allow at all.

Everything here is optional. Jarvis runs exactly as it did without any of it.

---

## Read this first: what is actually implemented

|                                           | Status          | What exists today                                                       |
| ----------------------------------------- | --------------- | ----------------------------------------------------------------------- |
| **Credential vault**                      | **Built**       | AES-256-GCM at rest, its own key, versioned for rotation.               |
| **Connections screen**                    | **Built**       | `/connections` — status, capabilities, last sync, failures, disconnect. |
| **Microsoft sign-in**                     | **Built**       | OAuth authorization code + PKCE, read scopes, refresh rotation.         |
| **Microsoft mail/calendar/tasks reading** | **Not built**   | Authorization works; nothing fetches or displays the data yet.          |
| **App Store Connect**                     | **Not built**   | Catalogued, no API client written.                                      |
| **iCloud Calendar**                       | **Unsupported** | Apple publishes no CalDAV endpoint. See below.                          |
| **Apple Reminders**                       | **Unsupported** | Apple publishes no server API at all. See below.                        |

Connecting Microsoft today stores a valid authorization and shows it on the
Connections screen. It does **not** yet put your mail or calendar into a briefing —
that is the next piece of work, and the screen does not pretend otherwise.

---

## 1. Generate the credential encryption key

Jarvis refuses to store a provider credential without one. Not "warns" — refuses.

```bash
npm run vault:key
```

That prints one base64 line and stores nothing. Put it in `.env.local`:

```
JARVIS_CREDENTIAL_KEY=<the line it printed>
```

Deliberately **not** the same value as `SESSION_SECRET`. They have different blast
radii and different rotation schedules; sharing one means rotating it either signs
you out of everything or destroys every stored credential.

**Rotating later.** Move the current value to `JARVIS_CREDENTIAL_KEY_PREVIOUS`, put
the new one in `JARVIS_CREDENTIAL_KEY`, and increment
`JARVIS_CREDENTIAL_KEY_VERSION`. Records sealed with the old key stay readable while
new ones are written with the new key. Remove the previous key once every provider
has been reconnected or re-synchronised.

**If you lose the key**, stored credentials cannot be decrypted. Nothing else is
lost — reconnect each provider and Jarvis seals fresh ones.

---

## 2. Microsoft — Outlook mail, Calendar and To Do

### Register the application

1. Go to <https://portal.azure.com> → **App registrations** → **New registration**.
2. Name it anything (`Jarvis`).
3. **Supported account types**: _Accounts in any organizational directory and
   personal Microsoft accounts_. This is the `AzureADandPersonalMicrosoftAccount`
   audience, and it is what lets one registration accept both your personal account
   and an eligible work or school account.
4. **Redirect URI**: platform **Web**, and exactly:

   ```
   http://localhost:3000/api/connections/microsoft/callback
   ```

   Use `localhost`, not `[::1]` — Microsoft does not support the IPv6 loopback
   address. If your WSL setup resolves `localhost` to IPv6, use `127.0.0.1`
   consistently in both `JARVIS_BASE_URL` and the redirect URI.

   If you run Jarvis on a different port, register that URI too.

5. Copy the **Application (client) ID**.
6. **Certificates & secrets** → **New client secret** → copy the **Value**
   (not the Secret ID). It is shown once.

### Configure it

```
MICROSOFT_CLIENT_ID=<application (client) id>
MICROSOFT_CLIENT_SECRET=<the secret value>
```

### The permissions Jarvis asks for

You are **not** asked to pre-configure API permissions in Azure. Jarvis requests
them at sign-in, and the consent screen shows you exactly this list:

| Scope               | Why                                                   |
| ------------------- | ----------------------------------------------------- |
| `openid`, `profile` | Sign-in.                                              |
| `offline_access`    | Keep working without re-authorizing daily.            |
| `User.Read`         | Show which account this is on the Connections screen. |
| `Mail.Read`         | Recent, unread and flagged mail.                      |
| `Calendars.Read`    | Your schedule.                                        |
| `Tasks.Read`        | Microsoft To Do tasks and due dates.                  |

**`Mail.Send` is not requested, and will not be.** Jarvis may draft an email for you
to look at; sending as you is a separate decision, not something acquired as a side
effect of wanting your calendar. A test asserts its absence, along with the absence
of anything directory-wide, tenant-wide, files, Teams or contacts.

Creating calendar events and tasks needs `Calendars.ReadWrite`, `Tasks.ReadWrite`
and `Mail.ReadWrite`. Those are a **separate, later grant** — Microsoft's incremental
consent means asking for them does not disturb the read grant. Nothing requests them
yet.

### Connect

Start Jarvis, open **Connections**, press **Connect** on Microsoft. You are sent to
Microsoft, you sign in, and you come back to the Connections screen.

### Verify it without exposing anything

The Connections screen shows the account address, which scopes were actually granted
(possibly fewer than were asked for), when it last synchronised, and any failure.
Nothing on that screen, and nothing in any API response, contains a token — there is
a test asserting that too.

### Disconnect and revoke

**Disconnect** on the Connections screen removes the stored credentials from your
database immediately. That is the part Jarvis can guarantee.

To revoke Microsoft's own record of the grant, go to
<https://myaccount.microsoft.com/privacy> → **Apps and services** and remove Jarvis.
Pressing a button in Jarvis does not reach into your Microsoft account.

---

## 3. Apple — what is possible and what is not

This section is the reason the Connections screen has an **Unsupported** status
rather than calling everything "not connected". These are not things you can fix in
settings.

### Sign in with Apple grants none of this

It is an identity mechanism. It returns a name and an email address. It never grants
access to iCloud Calendar, Mail, Contacts or Reminders — not with extra scopes, not
with an entitlement, not by any route.

### Apple Reminders — Unsupported

There is no public server-side API. Four independent reasons, all checked:

- Apple's public OAuth data-sharing API has no Reminders scope.
- EventKit is an on-device framework for Apple platforms. This deployment is Windows
  with a WSL worker; there is no device for it to run on.
- CloudKit reaches a developer's _own_ container, not Apple's.
- iCloud for Windows syncs Reminders into Outlook but publishes no SDK, no IPC
  surface and no documented file format a local application could read.

Jarvis does not reverse-engineer private endpoints, so this stays Unsupported.

**The future bridge, if you want it.** The honest route is an Apple device pushing
reminders _to_ Jarvis. An iPhone Shortcut on an automation trigger, posting JSON to a
local endpoint:

```
POST /api/bridge/apple-reminders
{ "reminders": [ { "id": "...", "title": "...", "due": "2026-09-08T19:00:00Z",
                   "completed": false, "list": "Reminders" } ] }
```

**Nothing on the Jarvis side is built.** That endpoint does not exist yet. The shape
is written down so that building it later does not require redesigning anything, and
the Connections screen will keep saying Unsupported until it does exist.

### iCloud Calendar — Unsupported (deferred, not refused)

A split verdict worth stating precisely.

Apple **does** sanction third-party access: its app-specific-password article names
"mail, contacts, and calendars stored in iCloud" as what third-party apps sign in to
reach, and it publishes an article on accessing iCloud Calendar from third-party apps.

Apple **does not** publish the endpoint. Unlike iCloud Mail — where exact IMAP and
SMTP hostnames and ports are documented — there is no published CalDAV server
address, discovery path or contract. Implementing this would mean hard-coding an
address Apple has never committed to, which works until it silently does not.

Use the Microsoft calendar connection instead.

### iCloud Mail — officially possible, not built

The one Apple data type with a complete published specification: IMAP and SMTP server
settings are documented, authenticated with an app-specific password
(<https://support.apple.com/en-us/102525>).

Jarvis does not implement it. It is listed here so you know it is _available_ rather
than impossible, unlike the two above. It is not on the Connections screen, because a
row there would imply a button.

**If it is ever built:** it will use an app-specific password from
<https://account.apple.com> → Sign-In and Security → App-Specific Passwords. Your
primary Apple Account password is never requested and never stored.

---

## 4. App Store Connect — catalogued, not built

The Connections screen lists it because the official API exists and is read-only
capable. No client is written, so connecting does nothing yet.

**When it is built**, it will need an API key from App Store Connect → Users and
Access → Integrations → App Store Connect API:

- **Issuer ID** (shown once per team)
- **Key ID**
- **Private key** — a `.p8` file, downloadable exactly once

Give the key the **least role that works** for read-only awareness. Never paste any
of these into chat, and never commit the `.p8`. The private key will go in the vault
like every other credential; the file path is configured, and the redaction rules
already recognise PEM private keys so one cannot reach a log.

Jarvis will never copy signing certificates or provisioning profiles, and will never
estimate revenue — a period with no report is reported as missing.

---

## 5. Revoking everything

1. **Connections** → Disconnect on each provider. Removes stored credentials locally.
2. <https://myaccount.microsoft.com/privacy> → remove Jarvis.
3. Delete `JARVIS_CREDENTIAL_KEY` from `.env.local` and restart. Any credential left
   in the database becomes unreadable.
4. If you also want the rows gone:
   `delete from provider_connections;` — your projects, missions and memories are
   untouched by this.

---

## 6. Three conversations to try in the morning

These work today and need no connection at all.

**1 — Discuss an idea without building it.**

> I have an idea for a tiny app called QuickPick that lets someone enter two choices
> and randomly selects one with a clean animation. Is this worth building? Ask only
> questions that materially affect a simple V1. Do not build it yet.

You should get an assessment and questions, and an explicit statement that nothing
was created. Not "Nothing, then."

**2 — Ask for the evaluation again in plainer words.**

> Evaluate the QuickPick idea we just discussed. Tell me who would use it, whether it
> solves a worthwhile problem, what the smallest useful V1 should include, and ask
> only the questions that would materially change that V1.

You should get another assessment. You should **not** get "Type: Code change" or a
"Prepare this mission" button.

**3 — Then agree to it.**

> Go ahead.

One project, one private repository (if `GITHUB_PROVISION_TOKEN` is set), one goal
and one mission. Say it twice — nothing extra is created.

Without `ANTHROPIC_API_KEY` set, Jarvis will say it has not judged whether the idea is
worth building, because nothing did. That is deliberate: `ANTHROPIC_API_KEY` is the
metered API, not the Claude subscription your worker runs on, and Jarvis will not
switch to paid billing quietly.

---

## 7. What was tested, and how

**Verified here, against real code and a real database:**

- Credential sealing, tamper rejection, cross-field rejection, key rotation.
- The Microsoft authorization URL, PKCE challenge, scope list, and the absence of
  `Mail.Send`.
- Token exchange and refresh against a fake HTTP boundary, including that provider
  error bodies never reach a thrown message.
- Connections statuses, including that a stale row cannot promote an unsupported
  provider to connected, and that no view contains a credential field.
- The two QuickPick conversations end to end, with row counts before and after.

**Verified against provider fakes, not live services:** every Microsoft HTTP call.
No request has been made to Microsoft from this environment.

**Not verified at all:**

- A real Microsoft sign-in. Nobody has completed the round trip against a live
  Azure app registration.
- Repository creation against real GitHub.
- Anything to do with App Store Connect or Apple.

Mock-boundary tests are not live verification, and this document does not present
them as such.
