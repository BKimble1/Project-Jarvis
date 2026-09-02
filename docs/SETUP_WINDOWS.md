# Windows setup

Jarvis develops comfortably on Windows. Everything below works in **PowerShell**; nothing requires
WSL, though WSL2 works too and is slightly faster for `npm install`.

## 1. Prerequisites

Install with winget (or the official installers):

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Check the versions in a **new** terminal (so the PATH refresh takes effect):

```powershell
node --version    # v20.11+ ; v22.x recommended
npm --version     # 10+
git --version
```

## 2. Clone and install

```powershell
git clone <your-fork-url> Project-Jarvis
cd Project-Jarvis
npm install
```

If `npm install` is slow or fails on a corporate machine, it is almost always antivirus scanning
`node_modules`. Excluding the project folder from real-time scanning resolves it.

## 3. Configure

```powershell
Copy-Item .env.example .env.local
notepad .env.local
```

Generate a session secret:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Minimum for local sign-in:

```
JARVIS_BASE_URL=http://localhost:3000
SESSION_SECRET=<the value you just generated>
OWNER_GITHUB_LOGIN=<your github login>
GITHUB_OAUTH_CLIENT_ID=<from your OAuth app>
GITHUB_OAUTH_CLIENT_SECRET=<from your OAuth app>
```

Set the OAuth callback URL to `http://localhost:3000/api/auth/callback`
(see [AUTHENTICATION.md](AUTHENTICATION.md)).

## 4. Run

```powershell
npm run dev
```

Open http://localhost:3000. The embedded PostgreSQL migrates itself on first use, so there is no
separate database step; `npm run db:migrate` is only needed for a hosted database.

## 5. Verify

```powershell
npm run verify:ci
```

For the browser tests, install Chromium once:

```powershell
npm run test:e2e:install
npm run verify
```

## Windows-specific notes

**Line endings.** The repository is authored with LF. Configure Git so Prettier's `--check` step
does not fail on CRLF:

```powershell
git config --global core.autocrlf input
```

If you already have CRLF files checked out:

```powershell
git rm --cached -r .
git reset --hard
```

**Paths.** Every script uses `node:path`, so backslashes are handled. Avoid cloning into a path
containing spaces or non-ASCII characters if you hit odd tool errors.

**Long paths.** `node_modules` can exceed the legacy 260-character limit. Enable long paths once,
as Administrator:

```powershell
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
  -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
git config --global core.longpaths true
```

**Execution policy.** If `npm` scripts are blocked:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

**Environment variables for one command.** Unlike bash, PowerShell needs them set separately:

```powershell
$env:JARVIS_DEMO_MODE = "true"
npm run db:seed:demo
npm run dev
```

Reset with `Remove-Item Env:JARVIS_DEMO_MODE`.

**Where the local database lives.** Development keeps it in `.jarvis-data/dev` so it survives
restarts. Override with `PGLITE_DATA_DIR` in `.env.local` if you want it elsewhere.

**Ports.** If 3000 is taken:

```powershell
npx next dev --port 3005
```

Remember to update `JARVIS_BASE_URL` and the OAuth callback URL to match.

**Firewall.** The first `npm run dev` may prompt to allow Node.js through Windows Defender
Firewall. Private networks only is sufficient.

## Recommended tooling

- **VS Code** with the ESLint, Prettier and Tailwind CSS IntelliSense extensions.
- **Windows Terminal** for a usable PowerShell experience.
- Set Prettier as the default formatter and enable format-on-save; the repository ships
  `.prettierrc.json`, so formatting matches CI exactly.
