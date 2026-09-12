# The wallboard

A screen on a wall that shows where everything stands, with nobody sitting at it.

`/display` is a separate surface with less access, not a small owner session. It authenticates
with a display credential of its own, and there is **no display-authenticated write of any kind**
in Jarvis — approve, pause, stop, message, retry, merge and TestFlight are unreachable rather than
hidden behind a disabled button.

## What it shows, and what it cannot

**Shows:** portfolio status, active missions, tasks waiting for a person, recent completions,
failures, worker connectivity, when it last refreshed, and how far up the qualification ladder
this deployment has climbed.

**Cannot show:** a repository name, a branch, a diff, a file path, a transcript, an artifact body,
a pull-request URL, a private memory, a document excerpt, a worker token prefix, or any credential.

That list is enforced rather than remembered. The display payload is assembled from scratch rather
than filtered down from the owner's — a hidden field is still a field on the wire — and
`findForbiddenDisplayKeys` scans the finished object before it is served, so a future field named
`pullRequestUrl` fails the request instead of reaching a wall.

## Pairing

1. In Jarvis: **Settings → Wall displays**. Name the device, choose what it may show, pair.
2. The token is shown **once**. There is no route that returns it again and no field on the device
   record that could carry it — only a hash is stored, plus a short prefix so you can tell two
   devices apart in a list.
3. On the device, open `https://<your-jarvis>/display` and type the token into the pairing screen.

The token is verified before anything is stored, then exchanged for an `httpOnly` cookie with a
one-year life. So it is typed exactly once, by someone standing in front of the screen, and the
page's own JavaScript cannot read it back — which matters most on a screen in a shared room, where
"the token is in localStorage" means "anyone who opens devtools has the token".

> **Never put a display token in a script, a repository, a `.env` committed anywhere, or these
> instructions.** It is typed on the device and nowhere else. Everything below is written so that
> nothing needs it after the first minute.

## Android tablet

An old tablet is an excellent wallboard. Two ways, and the second is better.

### As an installed app

1. Open `https://<your-jarvis>/display` in Chrome and pair.
2. Menu → **Add to Home screen**. Jarvis ships a web-app manifest, so it installs and opens
   without Chrome's address bar or tabs.
3. Open it from the home screen. That is the whole of it.

The cookie lives in the installed app's own storage and survives reboots.

### Keeping the screen on

Chrome's own display stays on only while something is playing. Instead:

- **Settings → Display → Screen timeout → 30 minutes** (the longest most tablets offer), and
- **Settings → Developer options → Stay awake while charging**. Enable developer options by
  tapping **Build number** in **About tablet** seven times.

Leave it on a charger. A tablet doing this draws almost nothing.

### Full screen after a reboot

Android will not reopen an app on boot by itself. Either:

- Accept one tap after a reboot — for a device that reboots twice a year this is fine; or
- Use a kiosk launcher (Fully Kiosk Browser is the usual choice) with the start URL set to
  `https://<your-jarvis>/display`. Pair once through it, and it will reopen full-screen on boot.

Do not put the token in the launcher's URL. Pair through its browser and let the cookie do the
work.

## Raspberry Pi

A Pi 3 or newer, Raspberry Pi OS with a desktop, Chromium.

### 1. Pair, once, by hand

Boot to the desktop, open Chromium, go to `https://<your-jarvis>/display`, and type the token.
Confirm the board appears. That writes the cookie into the default Chromium profile, and
everything below uses that profile.

### 2. Stop the screen blanking

```bash
sudo apt install -y unclutter
mkdir -p ~/.config/lxsession/LXDE-pi
cat >> ~/.config/lxsession/LXDE-pi/autostart <<'AUTOSTART'
@xset s off
@xset -dpms
@xset s noblank
@unclutter -idle 0
AUTOSTART
```

`unclutter` hides the mouse pointer, which is otherwise parked in the middle of your wallboard
forever.

### 3. Start Chromium in kiosk mode on boot

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/jarvis-wallboard.service <<'UNIT'
[Unit]
Description=Jarvis wallboard
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
Environment=DISPLAY=:0
# The URL only. The display credential lives in Chromium's cookie store, written when you
# paired by hand, and must never appear in this file.
ExecStart=/usr/bin/chromium-browser \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --check-for-update-interval=31536000 \
  --user-data-dir=%h/.config/chromium \
  https://your-jarvis.example.com/display
Restart=always
RestartSec=10

[Install]
WantedBy=graphical-session.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now jarvis-wallboard.service
sudo loginctl enable-linger "$USER"
```

`enable-linger` is what makes the user service start at boot rather than at your first login —
without it a headless Pi never starts the board.

`--user-data-dir` points at the profile you paired in step 1. Point it somewhere else and you will
be asked for the token again.

Reboot and confirm the board comes up on its own.

### 4. Rotate the screen, if it is mounted portrait

```bash
# /boot/firmware/config.txt
display_rotate=1     # 1 = 90°, 2 = 180°, 3 = 270°
```

## Revoking a display

**Settings → Wall displays → Revoke.**

It takes effect on the device's next refresh, without touching the device — you do not need
physical access to a screen you have lost, sold, or lent to a room you no longer control.

Revoke rather than trying to recover a token. A token cannot be recovered: only its hash is
stored, which is the same property that makes a stolen database useless for pairing a new screen.

To move a display to a new device, revoke the old pairing and pair a new one. Reusing a token
across two screens is not something Jarvis prevents, and it is not something you want — revocation
would then take out both.

## When the board looks wrong

- **"Pair this display"** — the cookie is gone (a cleared profile, a different `--user-data-dir`,
  a new browser) or the device was revoked. Pair again from Settings.
- **A staleness warning** — the board could not refresh. It says how old what you are looking at
  is, deliberately: a board silently showing five-minute-old work as current is worse than a blank
  one, because it is trusted.
- **Nothing but zeroes** — the board is fine and Jarvis has nothing running. Check the readiness
  row on the dashboard: if no worker is connected, approved missions are sitting in the queue.

## Related

- [OPERATIONS.md](OPERATIONS.md#wall-displays) — what a display is allowed to see, and why.
- [SETUP_V1.md](SETUP_V1.md) — where this sits in the setup order (step 17).
- [SECURITY.md](SECURITY.md) — the display credential as a security boundary.
