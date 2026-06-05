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

Not a database, not resume — the **smallest version of the keystone:**

> Tee the session's events to a per-session append-only log file (JSONL) as they
> are broadcast. The daemon already has the single choke point in `daemon.ts`
> where every byte and every control event passes through — write them to a file
> there.

Roughly a day's work. It immediately gives recording and replay-from-file, seeds
resume, and gives the summarizer something to read — all without committing to a
DB or a schema you'll regret. The DB comes when you actually need to query across
many sessions, not before.

## Holding it in your head

- The **live room** is the MVP, and it's done.
- The **next milestone** is: "the session is now a durable, structured artifact."
- **Resume, async panels, and diffintel** are the three things that milestone
  unlocks — built in whatever order dogfooding says hurts most.

Before adding anything, the most valuable move is a **dogfooding pass**: point
`--cmd "claude"` at a real task, run it as two people, and write down every point
of friction. Let that list — not feature instinct — drive what comes next.
