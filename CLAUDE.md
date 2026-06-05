# CLAUDE.md

Orientation for working on **powwow** with Claude Code. Read this first; it
should save you from re-deriving the layout each session.

## What this is

Powwow lets a team share one live agentic coding session. A local daemon wraps a
command (default `bash`, optionally `claude`) in a PTY it fully owns and relays
the terminal to any number of browsers over WebSocket. One driver at a time;
others observe and can request control. Local-first: no VPS, no tmux, no sync
layer.

Deeper detail lives in `docs/ARCHITECTURE.md` (protocol + state machine) and
`docs/ROADMAP.md` (what's next, open questions). The original product plan is
`mvp-plan.md`.

## Layout

```
src/
  cli.ts        powwow start: arg parsing, token, prints localhost + LAN links
  daemon.ts     PTY spawn + HTTP (token-gated) + WebSocket relay; PTY injectable
  session.ts    PURE turn-taking + presence state machine (no I/O)
  protocol.ts   ClientMessage / ServerMessage wire types
  test/
    relay.ts    headless turn-taking test (fake echo-PTY, no native deps)
    e2e.ts      same flow against a real bash PTY
public/
  index.html    app shell
  app.js        browser client: xterm terminal, presence chips, request/yield
  vendor/       bundled xterm.js + fit addon + css (NO CDN)
scripts/
  fix-pty-perms.js   postinstall: restores node-pty spawn-helper +x on macOS
```

## Commands

```bash
npm install        # builds node-pty (native); runs postinstall perm fix
npm run build      # tsc -> dist/
npm run dev        # run from source via tsx, no build
node dist/cli.js start [--cmd "claude"] [--port N] [--host H] [--cwd DIR]
npm run test:relay # headless turn-taking checks — run this after touching the relay
npm run test:e2e   # real-bash PTY version (needs a successful install)
```

After changing anything in `public/`, no rebuild is needed — just hard-refresh
the browser. After changing `src/`, rebuild (or use `npm run dev`).

## How it fits together (the one thing to internalise)

The daemon is the single choke point for all terminal bytes:

- PTY output → broadcast to **every** client.
- Client input → written to the PTY **only if** `session.isDriver(id)`.

That gating *is* turn-taking. `session.ts` decides who the driver is; `daemon.ts`
enforces it. The protocol is small JSON messages — see `protocol.ts` and the
table in `docs/ARCHITECTURE.md`.

## Conventions / invariants — don't break these

- **`session.ts` stays pure.** No sockets, no PTY, no `process`. All I/O lives in
  `daemon.ts`. This is what makes the relay test possible and the logic
  reviewable.
- **Never trust the client for control.** `input` and `resize` are gated
  server-side on `session.isDriver(id)`. A client claiming to be the driver
  means nothing.
- **At most one driver** (possibly zero). Control passes via the FIFO queue on
  yield or driver-disconnect.
- **No CDN.** Browser libraries are vendored in `public/vendor/` and served by
  the daemon. Keep it that way (self-hosted, offline-friendly).
- **The PTY is injectable.** `startDaemon({ spawnPty })` lets tests pass a fake.
  Production uses the lazy `defaultSpawnPty` (requires `node-pty`).
- **Run `npm run test:relay` after touching** `session.ts`, `daemon.ts`, or
  `protocol.ts`. It's fast and catches turn-taking regressions.

## Gotchas

- **`posix_spawnp failed` (macOS):** node-pty's `spawn-helper` lost its execute
  bit. `chmod +x node_modules/node-pty/build/Release/spawn-helper`. The
  `postinstall` hook and a runtime check in `defaultSpawnPty` now self-heal this.
- **node-pty needs native build tools.** A sandbox without a compiler/headers
  can't install it; that's why the PTY is injectable and `test:relay` exists.
- **Join button dead / blank terminal:** almost always a failed terminal-library
  load. It's local now (`/vendor/`), and `app.js` surfaces errors in the notice
  bar — check there and the console first.
- **One daemon = one session** currently. Multi-session would need session ids in
  the routes and a registry.

## Adding the obvious next features

- **Session chat:** add a `chat` `ClientMessage` + broadcast `chat`
  `ServerMessage`, render a panel in `app.js`. No `session.ts` change.
- **AgentEvent adapter:** insert a parser between `term.onData` and `broadcast`
  in `daemon.ts`; emit structured events alongside raw `output`. `session.ts`
  and turn-taking are unaffected. See `docs/ROADMAP.md`.
