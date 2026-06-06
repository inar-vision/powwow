# CLAUDE.md

Orientation for working on **powwow** with Claude Code. Read this first; it
should save you from re-deriving the layout each session.

## What this is

Powwow lets a team share one live agentic coding session. A local daemon wraps a
command (default `bash`, optionally `claude`) in a PTY it fully owns and relays
the terminal to any number of browsers over WebSocket. One driver at a time;
others observe and can request control. Local-first: no VPS, no tmux, no sync
layer.

Deeper detail lives in `docs/ARCHITECTURE.md` (protocol + state machine),
`docs/ROADMAP.md` (what's next, open questions), and `docs/DIRECTION.md`
(strategy and product framing).

## Layout

```
src/
  cli.ts            powwow start/serve: arg parsing, token, prints localhost + LAN links
  daemon.ts         PTY spawn (or serve mode) + HTTP + WebSocket relay; PTY injectable
  session.ts        PURE turn-taking + presence state machine (no I/O)
  protocol.ts       ClientMessage / ServerMessage wire types
  agent-adapter.ts  ClaudeSessionAdapter: watches Claude's JSONL files, emits AgentEvents
  test/
    session.ts  unit tests for Session state machine (no native deps)
    relay.ts    headless turn-taking test (fake echo-PTY, no native deps)
    e2e.ts      same flow against a real bash PTY
public/
  index.html    full participant app shell
  observe.html  read-only observer view
  host.html     host control panel (serve mode)
  app.js        browser client: xterm terminal, presence chips, request/yield, suggestions
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
node dist/cli.js serve [--port N] [--host H] [--cwd DIR]   # serve mode (no PTY)
npm run test:session  # Session unit tests — run after touching session.ts
npm run test:relay    # headless turn-taking checks — run after touching daemon.ts / protocol.ts
npm run test:e2e      # real-bash PTY version (needs a successful install)
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
- **Run `npm run test:session` after touching `session.ts`** — pure unit test, no deps.
- **Run `npm run test:relay` after touching** `daemon.ts` or `protocol.ts`. Catches turn-taking regressions.

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

