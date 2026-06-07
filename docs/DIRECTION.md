# Powwow — Direction & Focus

A synthesis of where this project is pointed and why. Written to hand off to
Claude Code so the next round of work stays aligned with the actual goal rather
than chasing adjacent features. Pairs with `mvp-plan.md` (original plan),
`docs/ARCHITECTURE.md` (how it's built), and `docs/ROADMAP.md` (sequencing).

## What Powwow is (and isn't)

Powwow is **not a CLI tool.** It's a daemon with two faces:

- The **CLI** (`powwow start`) is just the ignition — it boots the daemon and
  prints a join link. It's the surface for the person who *owns* the session.
- The **web UI** is where the collaboration actually happens: the shared
  terminal, presence, request/yield. It's the surface for *participants*.

The product is "the daemon plus the join experience." The CLI is the smallest of
its surfaces. The multiplayer value is inherently visual and shared, which is why
it lives in the browser — that's correct, not a gap.

## The real problem (the origin pain)

The thing that motivated this project wasn't "I wish someone could watch me
type." It was a **broken-telephone loop between a developer, their agent, and a
teammate:**

> Concluded something with a Claude Code session → manually extracted the
> conclusion → pasted it into Slack → got a reply → retyped the reply back into
> Claude.

Two lossy, manual hops. That loop has two distinct breakages, and they define
the product's job:

1. **Getting the agent's findings *out* to a teammate** without summarizing by
   hand. The teammate should just *see* the session's state, or get one link —
   not a copy-pasted excerpt.
2. **Getting the teammate's response *back into* the agent** without retyping.
   The teammate's comment or proposed instruction should flow into the session
   directly.

So the product's real job is: **collapse that loop so the agent's findings and a
teammate's response flow without manual relaying.** Live co-driving is one
transport for this — but it's the transport, not the value. The value is removing
the copy-paste hops.

## The MVP

The MVP is the live shared session with enforced turn-taking, and it is **done**.

**Definition of done (met):**

> A second person can join a running Claude Code session from a browser link,
> watch it work in real time, take the wheel, drive, and hand it back — no
> install, no confusion.

**Litmus test for any proposed feature:**

> Does this make *steering the agent together* or *passing the wheel*
> demonstrably better? If it's just adjacent collaboration plumbing — chat,
> notifications, settings screens — it's not MVP.

This is the test that keeps scope honest. The suggestion queue (observers
influence the agent without taking control) passes it. Session chat fails it —
not because chat is bad, but because the people in a session almost always
already share a voice channel (same room, a huddle, Slack), so chat duplicates a
channel they have and advances nothing this tool uniquely does. **Chat is
deferred,** and when it does come, it lives in the web UI, never the CLI.

## Decided: remote participants observe + suggest — they never drive

The synchronous collaboration model is settled. A remote teammate joining over a
link can **watch the structured session and post suggestions** — nothing more.
The driver seat (typing into the host's shell/Claude) stays **local to the host
machine** and is never handed to a remote participant.

Why this is right, at least to start:

- It already removes the broken-telephone loop. The teammate sees the session
  (findings *out*) and their suggestions flow in for the host to accept (response
  *back*). The whole origin pain, solved, without remote shell access.
- It collapses the security problem. "Go to the internet" stops being a remote
  arbitrary-code-execution project and becomes "let people watch and suggest" —
  a fundamentally safe thing to expose.
- The host's **accept** is the trust boundary: nothing a remote participant does
  executes until the local human accepts it. Review-then-apply, like merging a PR.

**This is now implemented.** The daemon mints two tokens per session: a control
token (host only, never shared) and an observer token (the shareable link).
Capability is derived at WebSocket upgrade from whichever token was presented and
stored server-side — no client message can change it. `request_control`, `input`,
`resize`, `yield_control`, and `accept_suggestion` are silently ignored from
observer connections. A tunnel (reachability + TLS) is the remaining piece before
exposing sessions beyond a trusted LAN.

## The frame that ties it together: a session is an event stream

Synchronous and asynchronous collaboration are **not two competing products.**
They're the same session consumed at different times:

- **Live participants** tail the event stream in real time.
- **An async teammate** reads the persisted version of the same stream later, and
  attaches replies to points in it.
- **The intelligence layer** (executive summaries, decision extraction — the
  "diffintel" idea) is computation run over that same stream after the fact.

One substrate, three consumers: live viewer, async reader, summarizer. The shared
coding room, the async panels, and the resumable history are the same data viewed
through different windows. Both modes matter; neither should be dropped.

The bigger use case this opens: a team where everyone has their own work items,
but some features need multiple brains. A shared agent session is where they
converge on those — and the async layer (panels, resume, summaries) lets that
collaboration outlive the live moment.

## The keystone: a structured, persisted session log

Everything on the wishlist hangs off one foundational capability — **capturing
the session as a structured, persisted log:**

- *Resume a session* → replay the log to reconstruct state.
- *Async panels / comments* → render the log for someone who wasn't live; attach
  replies to points in it.
- *Executive summaries / diffintel* → run a model over the log.
- *Provenance* → the log already records who did what, when.

None of these are buildable until the log exists; most are straightforward once
it does.

This is also where the `AgentEvent` adapter finally earns its keep. A log of raw
terminal bytes is a weak log — replayable, but you can't easily ask "what did the
agent conclude" or "what files changed," which is exactly what the Slack pain
needed. Some structure in the stream — even coarse: prompts in, commands run,
files edited, the agent's final messages — is what makes summaries and panels
possible instead of just a terminal recording.

## Sequencing — build bottom-up, not top-down

The dependency chain runs:

> structured events → persistence → (resume / async panels / diffintel, in any
> order driven by dogfooding)

The trap is building top-down: chasing executive summaries before there's a clean
log to summarize, or designing resume before events are durable. That's how this
project sprawls. Build the substrate first.

## The next concrete step

~~Tee the session's events to a per-session JSONL log.~~ **Done.** The daemon
writes an append-only JSONL log to `~/.powwow/sessions/<timestamp>.jsonl` for
every session: `session_start`, ANSI-stripped `output` chunks, and `session_end`
with exit code.

The structured `AgentEvent` adapter is also done: `ClaudeSessionAdapter` reads
Claude Code's own JSONL session files and broadcasts structured events to the UI.

The keystone exists. What's now unlocked:

- **Resume** — replay the log to reconstruct state.
- **Async panels / comments** — render the log for someone who wasn't live.
- **Summaries / diffintel** — run a model over the log.

The right next move is a **dogfooding pass**: run `powwow serve` with a real
Claude Code task as two people and write down every friction point. Let that list
— not feature instinct — drive the sequencing of the above.

## Reachability tiers and the open-core boundary

A laptop behind NAT has no public IP, so **something must bridge the public
internet to it** — this can't be eliminated, only hidden. There isn't a
peer-to-peer escape hatch either: WebRTC still needs a signaling server *and* a
TURN relay for the networks where direct connection fails, so it trades one
dependency for two. That leaves three tiers, meant to coexist:

1. **LAN** — no internet involved. Already works.
2. **Tunnel (`powwow start --public`, planned)** — powwow manages a `cloudflared`
   quick-tunnel itself so the user installs nothing. Zero infra, but it leans on
   Cloudflare's free service at runtime: it's a *convenience* escape hatch, **not
   yours** — you can't brand it, guarantee it, or build a business on it.
3. **Powwow relay (planned, the product spine)** — a server the host daemon dials
   *out* to (outbound, so NAT isn't a problem); remote browsers hit the relay,
   which forwards over that connection.

### How the relay splits across open source vs. product

The relay is two separate pieces, and the split is what keeps the open-source and
commercial stories both honest:

- **Relay *client* (in the daemon)** — knows how to dial a relay URL and speak its
  protocol. Always open source. The daemon must stay **relay-agnostic via
  `--relay <url>`**, so a user can point at their own relay or the hosted one. This
  single choice is what prevents lock-in and preserves local-first.
- **Relay *server* (the forwarder)** — **ships in the open-source repo and is
  self-hostable.** This is what answers "is the non-tunnel option in the OSS?" —
  yes. A team can run their own relay so session bytes never transit anyone else's
  infrastructure.

The **commercial product is not the relay code** — it's the *hosted instance* of
it: a relay you run at a branded domain with stable URLs, accounts, billing, a
dashboard, and (later) session history as a service. Standard open-core, exactly
the plan's "free self-hosted, flat fee for hosted." The boundary to hold:

> relay forwarding logic = open source · multi-tenant accounts / billing /
> dashboard = proprietary

Decide the precise line only when the relay is actually built; nothing now forces
it. Two things to keep disciplined when that day comes: (a) the **daemon↔relay
protocol is one spec** shared by the OSS relay and the hosted one — never fork
them; (b) a **self-hostable relay is an enterprise *feature*, not a giveaway** —
privacy-sensitive teams pay precisely because their code never leaves their own
infrastructure (bring-your-own-relay / on-prem). End-to-end encryption between
host and observers, so even the relay can't read content, is a possible later
hardening (it complicates rendering the observer feed, so it's out of scope for
now).

The tiers don't compete: the tunnel needs no server of yours, the relay needs no
third party, and both sit above plain LAN. `--public` is the near-term win;
the relay is the product spine.

## Holding it in your head

- The **live room** is the MVP, and it's done.
- The **structured, durable session artifact** milestone is also done: JSONL log
  + `ClaudeSessionAdapter` + serve mode.
- **Resume, async panels, and diffintel** are the three things now unlocked —
  build in whatever order dogfooding says hurts most.
