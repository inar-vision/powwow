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
| `src/cli.ts` | `powwow start` entrypoint. Parses flags, generates the session token, starts the daemon, prints localhost + LAN join links, handles Ctrl-C shutdown. |
| `src/daemon.ts` | Spawns the PTY, serves the static UI over HTTP (token-gated), runs the WebSocket server, relays output → all clients and input → PTY (driver only). The PTY factory is injectable (`spawnPty`) so tests run without native bindings. |
| `src/session.ts` | Pure turn-taking + presence state machine. No I/O. Unit-testable in isolation. |
| `src/protocol.ts` | The wire types shared (conceptually) between daemon and browser. |
| `public/index.html` + `public/app.js` | Browser client: xterm.js terminal, presence chips, request/yield controls. |
| `public/vendor/*` | Vendored xterm.js + fit addon + css. Served by the daemon so there is no CDN/runtime network dependency. |

## HTTP surface

The daemon serves two things on one port:

- `GET /` and `GET /index.html` — the app shell. **Requires** the session token
  as `?t=<token>`; returns 403 otherwise.
- `GET /<static>` — files under `public/` (app.js, vendored xterm, css). Not
  token-gated; they are inert assets.
- `GET /ws?t=<token>` — WebSocket upgrade. The token is **re-checked here**,
  because this is where control actually lives. A bad/missing token is rejected
  at the upgrade.

The token is a 16-byte random hex string minted per `powwow start`. This is the
MVP's entire auth model: possession of the link grants observer access; the
token is unguessable but is otherwise the only gate. It is sufficient for local
and trusted-LAN use, not for exposing the daemon to the public internet.

## WebSocket protocol

JSON messages, one object per frame. Types live in `src/protocol.ts`.

### Client → daemon (`ClientMessage`)

| Message | Effect |
|---|---|
| `{ type: "hello", name }` | Join the session under a display name. Registers the client in `Session`; first joiner becomes driver. |
| `{ type: "input", data }` | Keystrokes. **Forwarded to the PTY only if the sender is the current driver**; otherwise silently dropped. |
| `{ type: "resize", cols, rows }` | Resize the shared PTY. Honored only from the driver; the new size is broadcast to everyone. |
| `{ type: "request_control" }` | Ask to drive. Grants immediately if there is no driver; otherwise queues (FIFO) and notifies the room. |
| `{ type: "yield_control" }` | Driver hands control to the next in the queue (or to nobody if the queue is empty). No-op from a non-driver. |

### Daemon → client (`ServerMessage`)

| Message | Meaning |
|---|---|
| `{ type: "init", youId, driverId, participants, cols, rows }` | Sent once on join: your id, who drives, the roster, and the current terminal size. Followed immediately by an `output` frame replaying recent scrollback. |
| `{ type: "output", data }` | Terminal bytes (utf-8) to write to xterm. Broadcast to all. |
| `{ type: "resize", cols, rows }` | Authoritative terminal size changed (driver resized). All clients resize their xterm to match. |
| `{ type: "presence", driverId, participants }` | The roster or driver changed. Drives the presence chips and the request/yield button state. |
| `{ type: "notice", text }` | Ephemeral status line, e.g. "Mara requested control." |
| `{ type: "exit", code }` | The wrapped command ended; the session is over. |

`ParticipantInfo` (in `participants`) is `{ id, name, isDriver, requestingControl }`.

### Late-joiner scrollback

The daemon keeps a rolling buffer of the most recent PTY output
(`SCROLLBACK_LIMIT`, 256 KB). On `hello` it replays that buffer to the new
client as a single `output` frame, so a late joiner sees current context
immediately instead of a blank screen.

## Turn-taking state machine (`Session`)

`Session` holds: a map of participants, their join order, a FIFO `queue` of ids
waiting for control, and the current `driverId` (or `null`).

```
join (first participant)            ─▶ becomes driver
join (subsequent)                   ─▶ observer
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

## The adapter seam (future-facing)

The MVP shares a raw PTY, which is an opaque byte stream — there are no
structured "tool call" events. The plan's `AgentEvent` adapter (normalised
`output` / `tool_call` / `tool_result` / `turn_complete` / `error`) is **not yet
wired**; it is intentionally deferred.

Because the daemon already owns the byte stream at a single point, adding it
later is a contained change: insert a parser/adapter between `term.onData` and
`broadcast`, emit `AgentEvent`s alongside (or instead of) raw `output`, and have
the UI consume them. Nothing in `Session` or the turn-taking logic needs to
change. See `docs/ROADMAP.md` for sequencing.

## Testing model

- `npm run test:relay` injects a fake echo-PTY via the `spawnPty` override and
  asserts the full turn-taking flow (input gating, queue, handoff) with no
  native dependency. Runs anywhere.
- `npm run test:e2e` runs the same flow against a real `bash` PTY, exercising
  node-pty end to end. Requires a successful `npm install`/build.
