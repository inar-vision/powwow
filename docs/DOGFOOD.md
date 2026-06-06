# Powwow — Dogfooding Runbook

The goal of this pass is **not** to test that the tech works. It's to answer one
product question that decides how much internet/security work comes next, plus
catch friction you can only feel by using it for real.

## The question this session must answer

> When a remote teammate joins, do they actually need to **drive** (take the
> wheel and type into your shell/Claude) — or is **observe + suggest** enough?

This matters because it changes everything downstream:

- **If observe + suggest is enough:** going to the internet is comparatively
  safe and simple. Remote participants never touch your shell; the suggestion
  queue is the whole interaction. Auth work shrinks to "gate who can view."
- **If they genuinely need to drive:** internet becomes a serious security
  commitment — remote arbitrary command execution on your machine — and needs
  per-participant identity, separate control capability, TLS, and the token out
  of the URL before it can be safe.

Hold that question in mind the whole session and note every moment the answer
tips one way or the other.

## Pre-flight (host machine)

```bash
cd <your project>
npm run build          # if you've changed src/ since last build
```

Decide the mode:

- **`powwow start --cmd "claude"`** — Powwow owns the Claude process in a PTY.
  Simplest; the remote teammate can be given the driver seat (PTY input).
- **`powwow serve`** — you run Claude Code yourself; Powwow attaches to its
  session files. Driving is clipboard-based (accepted suggestions copy to the
  host). Closer to the real "I'm already in a session" workflow.

For *this* test, prefer **`powwow start --cmd "claude"`** so both "drive" and
"suggest" are physically possible and you can feel which one you actually reach
for. Note the token it prints — you'll need it for the teammate's URL.

## Exposing it over a tunnel (pick one)

### Option A — cloudflared quick tunnel (recommended: zero setup for the teammate)

```bash
# one-time install (macOS)
brew install cloudflared

# with powwow already running on :4321, in a second terminal:
cloudflared tunnel --url http://localhost:4321
```

It prints a public `https://<random>.trycloudflare.com` URL. TLS and WebSockets
are handled by Cloudflare, so the page loads over HTTPS and the client upgrades
to `wss` automatically — nothing in Powwow changes.

Compose the teammate's link by combining the tunnel host with the observer path
and your token:

```
https://<random>.trycloudflare.com/observe?t=<TOKEN>
```

(Send that. Keep the plain host terminal view for yourself on `localhost`.)

> The URL is public while the tunnel is open — the token is the only gate, same
> as on your LAN. That's fine for a short, watched test. **Ctrl-C the tunnel the
> moment you're done.**

### Option B — Tailscale (private, if you'd rather not expose a public URL)

The teammate installs Tailscale and joins your tailnet. They then reach your
machine directly at `http://<your-tailscale-ip>:4321/observe?t=<TOKEN>`. No
public URL, end-to-end encrypted. Costs the teammate a one-time install. Note
this stays `http`/`ws` (private network), which is fine for a trusted test.

## The test task

Use a **real** task, not a toy — friction only shows up under real cognitive
load. Good candidates: a bug you actually need to fix, a refactor you'd pair on,
or a feature spike where a second opinion helps. Ideally something where you'd
*naturally* have pinged the teammate anyway (that's the origin pain).

Run it as you really would: you drive Claude, the teammate watches the structured
feed, and you both talk over your normal voice channel (huddle/Zoom).

## What to watch for (capture as you go)

Primary signal — the drive-vs-suggest question:

- Did the teammate ever *want* the wheel? When, and why? (To type a command? To
  correct Claude? To explore something themselves?)
- When they had input, did **suggest → you accept** feel sufficient, or
  laggy/awkward compared to them just typing?
- Did handing over control ever actually help, or did you mostly narrate?

Secondary friction (one line each, don't polish):

- Joining: did the link + token just work? Confusion?
- The structured feed: was it legible? Did the teammate understand what Claude
  was doing without the raw terminal? What was missing?
- Suggestions: discoverable? Did the accept/dismiss flow get in the way?
- Presence/awareness: did you each know what the other was doing?
- Reconnects, lag, layout, anything that broke the spell.
- The "get findings out" half: at the end, could the teammate summarize what
  happened from the session alone, or did you still have to explain it? (That's
  the diffintel/summary signal.)

## After the session — fill this in

```
Date / task:
Mode used (start | serve):
Tunnel (cloudflared | tailscale):

DRIVE vs SUGGEST verdict:
  [ ] observe + suggest was enough → internet work is small/safe
  [ ] remote needed to drive       → internet needs full auth + TLS first
  Evidence (the specific moments):

Top 3 friction points (ranked):
  1.
  2.
  3.

Surprises / things that worked better than expected:

The one thing to build next:
```

Drop the filled-in version into `docs/ROADMAP.md` (or a `docs/dogfood-notes/`
file) so the next build round is driven by this, not by feature instinct.

## Why no code changed for this

All three browser views (`index.html`, `observe.html`, `host.html`) already pick
`wss` when served over HTTPS and connect to `location.host`, so any TLS-terminating
tunnel works as-is. The only thing the internet version will eventually need —
and what this session is meant to scope — is the **authorization** model, not the
transport.
