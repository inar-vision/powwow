# Powwow Architecture

This document describes how the MVP is wired together: the components, the
WebSocket protocol, and the turn-taking state machine. It reflects the
local-first design — one daemon on one machine, reachable on localhost and LAN.

## Big picture

```
Browser A (driver)  ─┐
Browser B (observer) ─┼── WebSocket ──▶  powwow daemon  ──PTY──▶  wrapped command
Browser C (observer) ─┘                      │                    (bash / claude / …)
                                             │
                                   Session (turn-taking + presence)
```

The daemon spawns the wrapped command inside a pseudo-terminal (PTY) that it
fully owns. Every byte the command emits is broadcast to all connected browsers.
Every keystroke a browser sends is dropped unless that browser is the current
driver. That single input choke point is the whole turn-taking mechanism.

There is no VPS, no tmux, no ttyd, and no file-sync layer: the command runs in
the daemon's own working directory on the user's machine, so the file system is
shared by definition.

## Components

| File | Responsibility |
|---|---|
| `src/cli.ts` | `powwow start` / `powwow serve` entrypoint. Parses flags, generates the session token, starts the daemon, prints localhost + LAN join links, handles Ctrl-C shutdown. |
| `src/daemon.ts` | Spawns the PTY (or runs in serve mode with no PTY), serves the static UI over HTTP (token-gated), runs the WebSocket server, relays output → all clients and input → PTY (driver only). PTY factory is injectable (`spawnPty`) so tests run without native bindings. Writes a JSONL session log to `~/.powwow/sessions/`. |
| `src/session.ts` | Pure turn-taking + presence state machine. No I/O. Unit-testable in isolation. |
| `src/agent-adapter.ts` | `ClaudeSessionAdapter` — watches Claude Code's JSONL session files (`~/.claude/projects/…`) and emits structured `AgentEvent`s as they appear. Wired into the daemon when the wrapped command is claude-like or in serve mode. |
| `src/protocol.ts` | The wire types shared (conceptually) between daemon and browser. Re-exports `AgentEvent` from `agent-adapter`. |
| `public/index.html` + `public/app.js` | Full participant browser client: xterm.js terminal, presence chips, request/yield controls, suggestion queue, agent event feed. |
| `public/observe.html` | Observer-only view (read-only terminal + agent feed, no control UI). |
| `public/host.html` | Host view for serve mode: control panel without a PTY terminal. |
| `public/vendor/*` | Vendored xterm.js + fit addon + css. Served by the daemon so there is no CDN/runtime network dependency. |

## HTTP surface

The daemon serves on one port:

- `GET /` and `GET /index.html` — full participant app shell. **Requires** the session token as `?t=<token>`; returns 403 otherwise.
- `GET /observe` / `GET /observe.html` — read-only observer view. Token-gated.
- `GET /host` / `GET /host.html` — host control panel (serve mode). Token-gated.
- `GET /<static>` — files under `public/` (app.js, vendor xterm, css). Not token-gated; they are inert assets.
- `GET /ws?t=<token>` — WebSocket upgrade. The token is **re-checked here**, because this is where control actually lives. A bad/missing token is rejected at the upgrade.

Two 16-byte random hex tokens are minted per session:

- **Control token** — carried by the host terminal and host-panel URLs. Grants
  full capability: `input`, `resize`, `request_control`, `yield_control`,
  `accept_suggestion`. Never shared.
- **Observer token** — carried by the shareable teammate link (`/observe?t=…`).
  Grants view-only + `suggest` and `dismiss_suggestion` (own suggestions only).
  Safe to distribute to remote participants.

The capability is **derived at the WebSocket upgrade** from whichever token was
presented, and stored server-side in a `socketCap` map. It is never re-derived
from client messages — the "never trust the client for control" invariant holds
across both capabilities. An observer who sends `request_control` or `input` is
silently ignored by the daemon regardless of what the UI shows.

## WebSocket protocol

JSON messages, one object per frame. Types live in `src/protocol.ts`.

### Client → daemon (`ClientMessage`)

| Message | Effect |
|---|---|
| `{ type: "hello", name, clientId? }` | Join the session under a display name. Registers the client in `Session`; first joiner becomes driver. `clientId` is present on reconnect to restore identity. |
| `{ type: "input", data }` | Keystrokes. **Forwarded to the PTY only if the sender is the current driver**; otherwise silently dropped. |
| `{ type: "resize", cols, rows }` | Resize the shared PTY. Honored only from the driver; the new size is broadcast to everyone. |
| `{ type: "request_control" }` | Ask to drive. Grants immediately if there is no driver; otherwise queues (FIFO) and notifies the room. |
| `{ type: "yield_control" }` | Driver hands control to the next in the queue (or to nobody if the queue is empty). No-op from a non-driver. |
| `{ type: "suggest", text }` | Observer posts a prompt suggestion for the driver to review. |
| `{ type: "accept_suggestion", id }` | Driver accepts a suggestion — its text is written to the PTY. |
| `{ type: "dismiss_suggestion", id }` | Driver or the original poster discards a suggestion. |
| `{ type: "typing" }` | Sender is currently typing (driver input or observer suggestion box). Throttled broadcast for presence feedback. |

### Daemon → client (`ServerMessage`)

| Message | Meaning |
|---|---|
| `{ type: "init", youId, clientId, driverId, participants, cols, rows, suggestions }` | Sent once on join: your stable `clientId` (store for reconnect), who drives, the roster, current terminal size, and pending suggestions. Followed immediately by scrollback replay. |
| `{ type: "output", data }` | Terminal bytes (utf-8) to write to xterm. Broadcast to all. |
| `{ type: "resize", cols, rows }` | Authoritative terminal size changed (driver resized). All clients resize their xterm to match. |
| `{ type: "presence", driverId, participants }` | The roster or driver changed. Drives the presence chips and the request/yield button state. |
| `{ type: "notice", text }` | Ephemeral status line, e.g. "Mara requested control." |
| `{ type: "suggestion", suggestion }` | A new suggestion was posted; broadcast to all. |
| `{ type: "suggestion_cleared", id }` | A suggestion was accepted or dismissed; remove it from the UI. |
| `{ type: "typing", id, name }` | A participant is typing. |
| `{ type: "agent_event", event, historical? }` | Structured event from the AI session (see `AgentEvent` below). `historical: true` on replay frames sent to late joiners. |
| `{ type: "session_reset" }` | Claude started a new or resumed session — clear the agent event feed before replaying history. |
| `{ type: "clipboard", text }` | Serve mode only: an accepted suggestion should be copied to the host's clipboard. |
| `{ type: "exit", code }` | The wrapped command ended; the session is over. |

`ParticipantInfo` (in `participants`) is `{ id, name, isDriver, requestingControl }`.

`SuggestionInfo` is `{ id, fromId, fromName, text }`.

### AgentEvent (structured AI session events)

Emitted by `ClaudeSessionAdapter` and forwarded to all clients as `agent_event` frames:

| Event | Meaning |
|---|---|
| `{ type: "user_message", text }` | A prompt sent to the agent. |
| `{ type: "thinking" }` | Agent is in extended thinking (content stays private). |
| `{ type: "text", text }` | Agent prose response. |
| `{ type: "tool_call", tool, input }` | Agent invoked a tool (e.g. `Bash`, `Edit`). |
| `{ type: "tool_result", tool, content, isError }` | Result returned for a tool call. |

### Late-joiner scrollback

The daemon keeps a rolling buffer of the most recent PTY output
(`SCROLLBACK_LIMIT`, 256 KB). On `hello` it replays that buffer to the new
client as a single `output` frame, so a late joiner sees current context
immediately instead of a blank screen.

## Turn-taking state machine (`Session`)

`Session` holds: a map of participants, their join order, a FIFO `queue` of ids
waiting for control, and the current `driverId` (or `null`).

```
join (first control-capable participant) ─▶ becomes driver
join (observer-capable, any position)    ─▶ never driver (driverEligible=false)
join (control-capable, seat taken)       ─▶ observer
request_control, no driver          ─▶ requester becomes driver
request_control, someone driving    ─▶ requester appended to queue (notify room)
yield_control (by driver)           ─▶ queue head becomes driver, or null if empty
driver disconnects                  ─▶ queue head becomes driver, or null if empty
observer disconnects                ─▶ removed from roster and queue
```

Invariants worth preserving if you change this:

- At most one driver at any time (possibly zero).
- Only the driver's `input`/`resize` ever reach the PTY. This is enforced in
  `daemon.ts` by checking `session.isDriver(id)` — never trust the client.
- `Session` stays pure (no sockets, no PTY). All I/O lives in `daemon.ts`. This
  is what makes `test:relay` and a future unit test possible.

## Agent adapter (ClaudeSessionAdapter)

Rather than parsing raw PTY bytes, the adapter reads Claude Code's own JSONL
session files from `~/.claude/projects/<slug>/`. This gives clean structured
events without fragile terminal-scraping.

`ClaudeSessionAdapter` (in `src/agent-adapter.ts`):
- Polls for the most-recently-modified `.jsonl` file in the session directory
  (handles both new sessions and `/resume` into an existing file).
- Watches the active file with `fs.watch` for new writes; emits `AgentEvent`s
  as lines arrive.
- On session switch or Claude's `"mode"` record (init/resume signal), replays
  the history accumulated so far to all connected clients.
- Exposes `history()` for late-joiner replay.

The daemon starts the adapter when the wrapped command is claude-like (name
matches `/^claude/`) or in serve mode (no PTY). Nothing in `Session` or
turn-taking is touched; structured events flow as an independent channel
alongside (or instead of) raw `output`.

## Serve mode

`powwow serve` (or `startDaemon({ serveMode: true })`) starts the daemon
**without spawning a PTY**. Instead it just runs the agent adapter and the
WebSocket/HTTP server. This is the intended mode when Claude Code is already
running and powwow is wired in via Claude Code hooks — the PTY is owned by
Claude, not powwow. The host control panel (`/host`) is the UI surface for this
mode.

## Session log

Every session writes an append-only JSONL log to
`~/.powwow/sessions/<timestamp>.jsonl`. The daemon records `session_start`,
ANSI-stripped `output` chunks (flushed every 200 ms), and `session_end` with
exit code. This gives recording and a basis for future replay/summarisation
without committing to a database.

## Testing model

- `npm run test:session` — unit tests for `Session` (pure state machine, no I/O,
  no native deps). Run after touching `session.ts`.
- `npm run test:relay` — injects a fake echo-PTY via the `spawnPty` override and
  asserts the full turn-taking flow (input gating, queue, handoff) with no
  native dependency. Run after touching `daemon.ts`, `session.ts`, or `protocol.ts`.
- `npm run test:e2e` — same flow against a real `bash` PTY, exercising node-pty
  end to end. Requires a successful `npm install`/build.
