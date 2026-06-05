# powwow

Share a live agentic coding session with your team. One person drives, everyone
else watches in the browser, and anyone can request control. Turn-taking is
enforced so only one person types at a time.

The MVP is a single local daemon that wraps a command (default `bash`, or
`claude` for a real Claude Code session) in a pseudo-terminal it fully owns, and
relays it to any number of browser clients over WebSocket. No VPS, no tmux, no
sync layer — everything runs on your machine and is reachable on your LAN.

```
Browser A (driver)  ─┐
Browser B (observer) ─┼── WebSocket ──▶  powwow daemon  ──PTY──▶  bash / claude / …
Browser C (observer) ─┘                      │
                                   Session (turn-taking + presence)
```

## Quick start

```bash
npm install      # builds node-pty natively; needs a C/C++ toolchain + python3
npm run build
node dist/cli.js start
```

You'll get links like:

```
  powwow session is live
  wrapping: bash

  Share one of these links:
    this machine   http://localhost:4321/?t=<token>
    on your LAN    http://192.168.1.23:4321/?t=<token>
```

Open the link in two browser windows to try it. The first to join drives; the
second joins as an observer and can hit **Request control**. The driver hits
**Yield control** to hand over.

To share a real Claude Code session instead of bash:

```bash
node dist/cli.js start --cmd "claude"
```

(Requires Claude Code installed and your `ANTHROPIC_API_KEY` in the environment —
BYOK. The daemon just spawns whatever command you give `--cmd`.)

### CLI options

| Flag | Default | Meaning |
|---|---|---|
| `--cmd "<command>"` | `bash` | Command to wrap, e.g. `--cmd "claude"` |
| `--port <n>` | `4321` | Port to listen on |
| `--host <addr>` | `0.0.0.0` | Bind address (LAN-reachable by default) |
| `--cwd <dir>` | current dir | Working directory for the wrapped command |

## What works today

- `powwow start` wrapping any command (default `bash`, or `--cmd "claude"` for a real Claude Code session).
- Multiple browsers join one shared session; live shared terminal output.
- Enforced turn-taking — exactly one driver; only the driver's keystrokes run.
- Request control (queues while someone drives) and yield control.
- **Suggestion queue** — observers type a prompt and hit Suggest; the driver sees it in a tray above the terminal and can send it to Claude or dismiss it. Observers can retract their own suggestions.
- **Typing indicators** — animated dots appear on a participant's chip in the header when they are typing (driver typing to Claude, or an observer composing a suggestion).
- Live presence roster with driver / waiting indicators.
- Late joiners get replayed scrollback for immediate context.
- Token-gated join links; localhost + LAN addresses printed on start.
- Vendored terminal library — no CDN or runtime network dependency.

See `docs/DIRECTION.md` for where this is headed, and `docs/ROADMAP.md` for sequencing.

## How it works

The daemon owns every byte in and out of the PTY. Output is broadcast to all
clients; input is forwarded **only** from the current driver. That single choke
point is what makes turn-taking trivial and leaves a clean seam to emit
structured `AgentEvent`s later.

| Path | Responsibility |
|---|---|
| `src/cli.ts` | `powwow start`: arg parsing, token, link printing |
| `src/daemon.ts` | PTY + HTTP + WebSocket relay (PTY is injectable for tests) |
| `src/session.ts` | Pure turn-taking + presence state machine (no I/O) |
| `src/protocol.ts` | WebSocket message types |
| `public/` | Browser client (terminal, presence, request/yield) |
| `public/vendor/` | Bundled xterm.js + fit addon + css |

Full component breakdown, the WebSocket protocol, and the turn-taking state
machine are documented in **`docs/ARCHITECTURE.md`**.

## Contributing / development

```bash
npm install        # builds node-pty and vendors are already in public/vendor
npm run build      # tsc -> dist/
npm run dev        # run from source via tsx (no build step)
```

Tests:

```bash
npm run test:relay # headless: input gating + control handoff (no native deps)
npm run test:e2e   # same flow against a real bash PTY (needs node-pty built)
```

Conventions:

- Keep `src/session.ts` pure — no sockets, no PTY. All I/O stays in `daemon.ts`.
  This is what keeps the logic testable.
- Never trust the client for control: input/resize are gated server-side on
  `session.isDriver(id)`.
- Don't reintroduce a CDN dependency; vendor browser assets into `public/vendor/`.

## MVP scope / not yet

Auth is a single unguessable token in the share link (observer by default;
control is an explicit request). That's deliberately minimal — fine for local
and trusted-LAN use, **not** for exposing to the public internet. Multi-model
adapters, session recording, remote/VPS hosting, and decision provenance are
post-MVP; see `docs/ROADMAP.md`.

## Troubleshooting

- **`posix_spawnp failed` on start (macOS):** node-pty's `spawn-helper` binary
  lost its execute bit during install. Run
  `chmod +x node_modules/node-pty/build/Release/spawn-helper` and retry. A
  `postinstall` hook and a runtime check now fix this automatically on fresh
  installs.
- **Join button does nothing / blank terminal:** hard-refresh (Cmd-Shift-R). The
  terminal library is served locally from `/vendor/`; the client surfaces load
  errors in the notice bar and the browser console.
- **`npm install` complains about an existing `node_modules`:** delete it and
  reinstall.

## Docs

- `docs/DIRECTION.md` — what the tool is for, the MVP's focus, and where it's headed
- `docs/ARCHITECTURE.md` — components, WebSocket protocol, state machine, adapter seam
- `docs/ROADMAP.md` — status, next steps, open design questions
- `mvp-plan.md` — the original product/MVP plan
- `CLAUDE.md` — orientation for working on this repo with Claude Code
