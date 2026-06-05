# Powwow — MVP Plan
*Collaborative agentic coding sessions for development teams*

## Problem

When working with AI coding agents like Claude Code, findings, decisions, and progress are trapped in a local session. There is no good way to share what the agent is doing with the rest of the team in real time. Screen sharing is clunky, copy-pasting context is lossy, and handing off a session mid-task is effectively impossible today.

## Product Vision

A lightweight tool that lets a development team share a live agentic coding session. One person drives, others observe — and anyone can request control. The goal is to make agentic coding a team sport rather than a solo activity.

The collaboration infrastructure is model-agnostic. Claude Code is the starting point, but the product is not a Claude product — teams should be able to bring their own model and API keys.

## Philosophy

**Zero-config, zero friction.** The tools that win with developers are the ones where you run one command and it works. No account wizard, no workspace setup, no enterprise onboarding flow. A session link is the entire first experience — click it and you're in.

**Self-hosted first.** Teams who don't want a cloud dependency should be able to run the whole thing themselves with a single `docker-compose up`. The hosted version is a convenience, not a requirement. Open source builds trust and spreads through GitHub naturally.

**Developer tool, not SaaS dashboard.** The terminal is the hero of the UI. Minimal chrome, fast, functional. No corporate product feel.

**Simple pricing.** Free self-hosted. Flat fee for hosted. No per-seat enterprise pricing, no sales process.

## Product Surfaces

Three surfaces, one underlying daemon API:

```
powwow daemon
    ├── CLI          — start / join / status / summary (primary interface)
    ├── Desktop app  — session history, past work summaries, notifications, settings
    └── Web UI       — browser-based join link for session participants
```

**CLI** is the primary interface and what developers reach for first. Starting a session, joining one, checking status — all of this lives in the terminal.

**Desktop app** is a companion surface for things that benefit from a persistent UI: session history, past work summaries, team presence overview. It is not a replacement for the CLI — everything available in the desktop app is also available via CLI flags or stdout.

**Web UI** is how session participants join without installing anything. Share a link, click it, you're watching the session in your browser.

---

## MVP Scope

### What it does

- `powwow start` spins up a shared session in the current project and prints a shareable link
- Runs Claude Code inside a shared container
- Team members join via browser link — no install required to observe
- Enforces turn-taking: one active driver at a time
- Any team member can request control; the current driver can yield
- Self-hostable via a single `docker-compose.yml`

### What it does not do (yet)

- Multi-model support (OpenAI Codex CLI, Gemini CLI, Aider)
- Session recording and replay
- Decision provenance / audit trail
- IDE integrations
- Fine-grained permissions or roles beyond driver/observer
- On-premise or self-hosted deployment

---

## Architecture

### Overview

```
Browser (team member)
    │  WebSocket + terminal embed
    ▼
Web UI Server
    │
    ├── Session manager (turn-taking, presence)
    │
    └── Shared Dev Container (VPS)
            │
            ├── tmux (shared terminal session)
            ├── Claude Code (running agent)
            └── Codebase (single filesystem, no sync needed)
```

### Key components

**Shared dev container**
A small cloud VPS (e.g. Hetzner CX22, ~€4/month) running a Docker dev container. All team members connect to the same machine, which means file system state is shared by definition — no sync layer needed. This is deliberately simpler than trying to keep multiple local machines in sync.

**tmux**
Handles the shared terminal session. One Claude Code process runs inside tmux. All connected clients see the same output in real time. Turn-taking is enforced at the application layer — only the active driver's input is forwarded to the tmux session.

**Web UI**
A browser-based interface that embeds the terminal (via ttyd or a custom WebSocket relay) and adds:
- Presence indicators (who is in the session, who is driving)
- Turn-taking controls (request control, yield control)
- Basic session chat for coordination between team members

**Agent adapter interface**
Even though only Claude Code is implemented in the MVP, the interface is defined from day one so that adding future agents is a contained change:

```typescript
type AgentEvent =
  | { type: 'output'; text: string }
  | { type: 'tool_call'; tool: string; input: unknown }
  | { type: 'tool_result'; tool: string; output: unknown }
  | { type: 'turn_complete' }
  | { type: 'error'; message: string }
```

The UI and any future audit trail consume this normalised event stream, not Claude Code-specific output.

---

## Technical Stack

| Concern | Choice | Notes |
|---|---|---|
| Container host | Hetzner CX22 | ~€4/month, sufficient for a dev session |
| Container runtime | Docker | Standard dev container setup |
| Terminal sharing | tmux | Zero custom code for session sharing |
| Terminal in browser | ttyd | Thin WebSocket relay, embeds in UI |
| Web UI | Next.js + TypeScript | Familiar stack |
| Real-time layer | WebSocket | Presence, turn events, chat |
| Coding agent (MVP) | Claude Code | Via Anthropic API |
| Auth | To be decided | Simple invite links or team auth |

---

## Key Design Decisions

**Cloud container over git-sync**
The alternative was to keep each team member on their own machine and sync file changes via a git daemon. This sounds simpler but has real edge cases: latency during agent tool calls, micro-commit pollution, gitignore complexity, and you still need a separate layer to sync the conversation stream. A shared container eliminates the sync problem entirely.

**Turn-taking over simultaneous control**
Concurrent input from multiple people creates conflicts in the agent context and in the file system. Turn-taking is a meaningful constraint but it reflects how teams actually work — one person drives while others review and advise. It can be relaxed later with a queuing model.

**API-based, BYOK**
The product does not depend on or proxy any vendor subscription. Teams connect their own Anthropic API key. This keeps the legal situation clean, avoids per-seat subscription complexity, and is the natural path toward multi-model support. The product charges for the collaboration infrastructure, not the AI.

**Adapter pattern from day one**
Claude Code is the MVP agent. But the product is not a Claude wrapper — it is a collaboration layer. Defining the adapter interface early means that when OpenAI Codex CLI and Gemini CLI support are added, nothing in the UI or session management needs to change.

---

## Post-MVP Roadmap

**v2 — Desktop app**
A companion app (Tauri or Electron) for session history, settings, and notifications. Everything in it is also available via CLI — the desktop app is additive, not exclusive. No feature lives only in the GUI.

**v2 — Past work summaries**
After a session closes, generate a readable digest: what was the goal, what changed, what decisions were made, what is left open. Delivered via CLI stdout and surfaced in the desktop app as a session history feed. The thing you send to the team member who missed the session, or reference a week later.

**v2 — Multi-model support**
- OpenAI Codex CLI adapter
- Google Gemini CLI adapter
- Aider adapter (open source, already supports Anthropic, OpenAI, Gemini, and local models — one adapter covers most of the multi-model story)

**v3 — Decision provenance**
Every tool call tagged with who initiated or approved it, what changed, and why. Session becomes a collaborative audit trail — useful for code review, onboarding, and async handoffs. The layer that turns the product from a session-sharing tool into something with genuine organisational memory value.

**Later — Session recording and replay**
Record sessions for async review. Team members who were not present can replay what the agent did, step by step, with full context.
