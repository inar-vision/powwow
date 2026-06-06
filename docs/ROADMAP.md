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
- Verified by `test:relay` (headless turn-taking), `test:e2e` (real bash PTY), and `test:session` (Session unit tests).

This maps to the MVP scope in `mvp-plan.md`, with one deliberate change: the
shared dev container on a VPS (tmux + ttyd) was replaced by a local daemon that
owns the PTY directly. See "Deviations from the original plan" below.

## Next up (small, high-value)

1. **Reconnect handling** — `clientId` is in the protocol (`hello` + `init`) but
   full server-side identity restoration across a socket drop is not yet wired.
2. **Graceful "no driver" affordance** — when the driver leaves and the queue is
   empty, make "Take control" more prominent; consider auto-promoting the
   longest-waiting observer.
3. **Dogfooding pass** — run `powwow serve` with a real Claude Code session as
   two people and record friction points. Let that list drive what comes next
   rather than feature instinct.

## Later (bigger bets)


- **Multi-model** — additional `--cmd` targets (OpenAI Codex CLI, Gemini CLI,
  Aider). Mostly "does the wrapped CLI behave in a PTY"; the relay is agnostic.
- **Remote / self-hosted hosting** — optional deployment where the daemon runs on
  a small VPS instead of localhost. This re-introduces the "how does the
  codebase get onto the host" question the local-first MVP sidesteps (git clone
  on start vs. work against a repo already on the host). Decide before building.
- **Desktop companion app** — session history, past-work summaries, settings.
  Everything in it must also be reachable via CLI (plan constraint).
- **Session recording & replay** — persist the event stream for async review.

## Open design questions

- **Auth beyond the token.** Today: unguessable link = observer; control is an
  explicit request anyone can make. Before any non-LAN exposure we need at least:
  separate observer vs. control tokens, and probably a per-participant identity.
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
