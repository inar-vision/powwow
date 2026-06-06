# Powwow Roadmap & Status

## Where we are (MVP — working)

The core thesis is proven end-to-end: a shared agentic terminal session with
enforced turn-taking, joinable from the browser with no install.

Working today:

- `powwow start` wraps a configurable command (default `bash`, or `--cmd "claude"`).
- `powwow serve` — no-PTY mode for use with Claude Code hooks; agent adapter only.
- Multiple browsers join one session over WebSocket; output is shared live.
- Turn-taking: exactly one driver; only the driver's input reaches the PTY.
- Request control (queues FIFO while someone drives) and yield control.
- Presence: live roster with driver / waiting indicators.
- Late joiners get replayed scrollback so they see current context.
- Token-gated join links; localhost + LAN addresses printed on start.
- Vendored xterm.js (no CDN / no runtime network dependency).
- **Suggestion queue**: observers post prompt suggestions; driver accepts or dismisses.
- **AgentEvent adapter** (`ClaudeSessionAdapter`): structured events from Claude Code's JSONL session files broadcast as `agent_event` frames. Handles new sessions and `/resume`.
- **Session log**: append-only JSONL written to `~/.powwow/sessions/` for every session.
- **Server-enforced capability split**: two tokens per session — control token (host only, never shared) and observer token (shareable link). Capability is derived at WebSocket upgrade; observers cannot drive regardless of what the UI sends.
- **WebSocket keepalive**: server pings all connected sockets every 30 s; sockets that miss a pong are terminated. Prevents tunnel/proxy idle-kill during long agentic pauses.
- **Suggestion flood guards**: per-poster rate limit (1.5 s by default), per-poster cap (5 pending), and total cap (50). Excess suggestions are silently dropped or produce a private notice.
- **Connection cap**: concurrent WebSocket connections capped at 20 (503 on upgrade if exceeded).
- Verified by `test:relay` (headless turn-taking + capability checks), `test:e2e` (real bash PTY), and `test:session` (Session unit tests).

This maps to the MVP scope in `mvp-plan.md`, with one deliberate change: the
shared dev container on a VPS (tmux + ttyd) was replaced by a local daemon that
owns the PTY directly. See "Deviations from the original plan" below.

## Next up (small, high-value)

1. **Reconnect handling** — `clientId` is in the protocol (`hello` + `init`) but
   full server-side identity restoration across a socket drop is not yet wired.
3. **Graceful "no driver" affordance** — when the driver leaves and the queue is
   empty, make "Take control" more prominent; consider auto-promoting the
   longest-waiting observer.
4. **Dogfooding pass** — run a real Claude Code session with a remote teammate
   over a tunnel (`docs/DOGFOOD.md`). The drive-vs-suggest question is already
   decided (observe + suggest); use the pass to surface the remaining friction.

## Internet-readiness

What's already covered for remote use over a tunnel: TLS comes free (the client
upgrades to `wss` over HTTPS), the observer/control capability split is enforced
server-side, and the **control token never leaves localhost** — the host loads
the host view on `localhost`, so only the view-and-suggest observer token ever
crosses the internet. Exposure is low by construction.

What's missing, in priority order:

**Tier 1 — will bite a real remote session:**

1. ~~**WebSocket keepalive (ping/pong).**~~ **Done.** Server pings all sockets every 30 s; misses a pong → terminate. Tunnel/proxy idle-kill is neutralised.
2. **Reachability ergonomics (nice-to-have).** The CLI only prints localhost/LAN
   links, so over a tunnel the host hand-composes `https://<tunnel>/observe?t=…`.
   A `--public-url` / `--base-url` flag that makes the printed "Teammates" link
   the real tunnel URL would remove the friction. Not required (see DOGFOOD.md).

**Tier 2 — abuse guards, before the link reaches anyone less trusted than a known friend:**

3. ~~**Suggestion flooding.**~~ **Done.** Per-poster rate limit (1.5 s), per-poster cap (5), total cap (50).
4. ~~**Connection cap.**~~ **Done.** 503 on upgrade once 20 concurrent sockets are open.
5. **Revocation / rotation.** Tokens live for the process lifetime; a leaked
   observer link can't be rotated and a participant can't be kicked without
   restarting. Add rotate-observer-token and kick-participant controls.

**Tier 3 — caveats to know (not necessarily build now):**

- The observer link is effectively a password to a read-only screen-share of the
  whole terminal and Claude session (tool calls, file snippets, scrollback). Treat
  link hygiene seriously; eventually add host-approval of joiners and real
  per-participant identity (see Open design questions).
- Don't screen-share the terminal tab/stdout where the **control** token is printed.

Tier 1 and Tier 2 items #3 and #4 are now done. For a "me + one trusted person
over a tunnel" test, only #5 (revocation) remains, and it is acceptable to
restart instead. Tier 2 is fully covered for a wider audience short of revocation.

## Later (bigger bets)


- **Multi-model** — additional `--cmd` targets (OpenAI Codex CLI, Gemini CLI,
  Aider). Mostly "does the wrapped CLI behave in a PTY"; the relay is agnostic.
- **Remote access (near term, small).** Host stays local; expose the session
  through a tunnel (cloudflared/Tailscale = reachability + TLS, no code). Combined
  with the observer/control capability split (Next up #1), that's the entire
  "internet" story for the observe+suggest model — safe because remote can't drive.
- **VPS-hosted variant (later, bigger).** Running the daemon on a server instead
  of localhost re-introduces the "how does the codebase get onto the host"
  question the local-first design sidesteps (git clone on start vs. work against a
  repo already there). A separate bet; not needed for remote observe+suggest.
- **Desktop companion app** — session history, past-work summaries, settings.
  Everything in it must also be reachable via CLI (plan constraint).
- **Session recording & replay** — persist the event stream for async review.

## Open design questions

- **Auth — capability split DONE.** Two tokens per session; server enforces observer-only for the shareable link. Still open: per-participant identity (vs. one shared observer token) if named remote presence or per-person revocation is ever needed.
- **Driver eviction / timeouts.** Should an idle driver auto-yield? Should the
  session owner be able to force-yield? Not modeled yet.
- **Resize policy.** The driver currently dictates one shared terminal size;
  observers letterbox. Fine for a demo — revisit if it annoys people.
- **Where structured events come from for Claude Code.** Parsing the TTY vs.
  driving Claude Code through a programmatic JSON stream. The latter is cleaner
  but changes how the agent is launched. Tied to the AgentEvent work.
- **Multiple concurrent sessions per daemon.** Today one daemon = one session.
  Multi-session would need session ids in the routes and a registry.

## Deviations from the original plan (`mvp-plan.md`)

- **Local daemon + owned PTY instead of VPS + tmux + ttyd.** Owning the PTY
  gives input-gating for free, removes the code-sync problem (everything is
  local), and leaves a clean seam for AgentEvents. The VPS path becomes optional
  hosting, not core architecture.
- **Self-hosted is in, not out.** The plan's "what it does not do" list
  contradicted its own "self-hosted first" philosophy; local-first resolves this
  in favour of self-hosted.
- **xterm.js custom relay instead of stock ttyd.** Turn-taking requires
  intercepting input, which stock ttyd does not do, so the custom relay was the
  only real option anyway.
