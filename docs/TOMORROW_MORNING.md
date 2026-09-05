# Tomorrow morning

On the machine that has your Claude login, in the checkout:

```sh
npm run jarvis:live
```

Then open <http://127.0.0.1:3000> and read the top of the dashboard. It says what Jarvis is doing
and what needs you, numbered. Reply in the box: **"do the first one"**, **"continue"**, **"not
tonight"**, or **"remember that …"**.

Three things worth knowing on day one:

- **If something looks unset**, go to **Setting up**. Twelve steps, in order, each with the next
  thing to do. Nothing on that page shows a password or a token, so it is safe to screen-share.
- **To stop it**, press **Pause Jarvis** on Operations. Work already running finishes safely;
  nothing new starts; you can still ask it things. Resuming puts it back exactly where it was.
- **Ctrl-C** stops everything. The worker gets fifteen seconds to finish what it is holding first.

If nothing is happening and you cannot see why: `npm run doctor`.

Everything else is in [JARVIS_V1_LAUNCH.md](./JARVIS_V1_LAUNCH.md).
