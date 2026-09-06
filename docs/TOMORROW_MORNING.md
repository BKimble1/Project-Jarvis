# Tomorrow morning

On the machine that has your Claude login, in the checkout:

```sh
npm run jarvis:live
```

Then open <http://localhost:3000> — that exact spelling, because it is the origin GitHub redirects
back to and the host the session cookie is set on. `127.0.0.1` is the same machine and a different
origin, so signing in there leaves you signed out here.

**The very first time** there is no worker token yet, so `npm run jarvis:live` starts the control
plane on its own and says so. Sign in, open **Workers**, press **Enrol**, put the token it shows
once into `.env.local` as `JARVIS_WORKER_TOKEN`, then Ctrl-C and run it again. From then on both
halves come up together.

Jarvis fills the screen: the core in the middle says what it is
doing, your projects are on the left, what needs you is on the right, numbered. Reply in the box
along the bottom: **"do the first one"**, **"continue"**, **"not tonight"**, or
**"remember that …"**. Press **Speak** to say it instead.

The button at the top right with the arrows makes it fullscreen for a wall or a big monitor;
Escape brings the navigation back. Beside it, the settings button holds a lighter graphics mode
and a switch to turn the movement off entirely.

Three things worth knowing on day one:

- **If something looks unset**, go to **Setting up**. Twelve steps, in order, each with the next
  thing to do. Nothing on that page shows a password or a token, so it is safe to screen-share.
- **To stop it**, press **Pause Jarvis** on Operations. Work already running finishes safely;
  nothing new starts; you can still ask it things. Resuming puts it back exactly where it was.
- **Ctrl-C** stops everything. The worker gets fifteen seconds to finish what it is holding first.

If nothing is happening and you cannot see why: `npm run doctor`.

Everything else is in [JARVIS_V1_LAUNCH.md](./JARVIS_V1_LAUNCH.md).
