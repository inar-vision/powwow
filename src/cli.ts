#!/usr/bin/env node
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { exec, spawn } from "child_process";
import { startDaemon } from "./daemon";
import { startQuickTunnel, TunnelHandle } from "./tunnel";

// --- ANSI colour helpers (no deps) ----------------------------------------
const c = {
  reset:  "\x1b[0m",
  dim:    "\x1b[2m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  cyan:   "\x1b[36m",
  blue:   "\x1b[34m",
  magenta:"\x1b[35m",
  red:    "\x1b[31m",
  bold:   "\x1b[1m",
};
const paint = (color: string, s: string) => color + s + c.reset;

// --------------------------------------------------------------------------

interface StartArgs {
  cmd: string[];
  port: number;
  host: string;
  cwd: string;
  claudeConfigDir?: string;
  public?: boolean;
}

function parseStartArgs(argv: string[]): StartArgs {
  const args: StartArgs = {
    cmd: ["bash"],
    port: 4321,
    host: "0.0.0.0",
    cwd: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--cmd":
        args.cmd = (argv[++i] ?? "").trim().split(/\s+/).filter(Boolean);
        if (args.cmd.length === 0) args.cmd = ["bash"];
        break;
      case "--port":
        args.port = parseInt(argv[++i], 10) || args.port;
        break;
      case "--host":
        args.host = argv[++i] ?? args.host;
        break;
      case "--cwd":
        args.cwd = argv[++i] ?? args.cwd;
        break;
      case "--claude-config-dir":
        args.claudeConfigDir = argv[++i];
        break;
      case "--public":
        args.public = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`powwow — share a live agentic coding session with turn-taking

Usage:
  powwow start [options]   Start a session (wraps a command in a PTY)
  powwow serve [options]   Start relay without PTY (attach to running Claude)
  powwow stop [--all]      Stop session for this directory (or all sessions)
  powwow setup [--claude-config-dir <dir>]   Install /powwow slash command
  powwow log               List recorded sessions
  powwow log <n>           Show nth most recent session (1 = latest)
  powwow log <filename>    Show a specific .jsonl file

Start options:
  --cmd "<command>"   Command to wrap (default: "bash"). e.g. --cmd "claude"
  --port <n>          Port to listen on (default: 4321)
  --host <addr>       Bind address (default: 0.0.0.0, reachable on your LAN)
  --cwd <dir>         Working directory for the wrapped command (default: cwd)
  --public            Open a public URL via a cloudflared quick tunnel (needs
                      cloudflared on PATH). Convenience tier — best-effort,
                      unauthenticated by Cloudflare, no SLA. Driving still only
                      works from localhost/LAN, never through the public link.
  -h, --help          Show this help

Serve options:
  --port <n>              Port to listen on (default: 4321)
  --cwd <dir>             Working directory of the Claude session (default: cwd)
  --foreground            Run in foreground instead of detaching (for debugging)
  --claude-config-dir     Override Claude config directory (default: ~/.claude)
  --public                Open a public URL via a cloudflared quick tunnel (needs
                          cloudflared on PATH). Same caveats as start --public.

Examples:
  powwow start                       # share a bash session
  powwow start --cmd "claude"        # share a Claude Code session
  powwow serve                       # start relay in background (default)
  powwow setup                       # install the /powwow slash command
  powwow log                         # list sessions
  powwow log 1                       # show the most recent session
`);
}

function lanAddresses(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// --- log viewer -----------------------------------------------------------

const SESSION_DIR = path.join(os.homedir(), ".powwow", "sessions");

function sessionFiles(): string[] {
  if (!fs.existsSync(SESSION_DIR)) return [];
  return fs.readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .sort() // ISO timestamp names sort chronologically
    .reverse(); // newest first
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function listSessions(): void {
  const files = sessionFiles();
  if (files.length === 0) {
    console.log("No sessions recorded yet.");
    return;
  }
  console.log("");
  console.log(paint(c.bold, `  ${"#".padEnd(4)} ${"Session".padEnd(22)} ${"Command".padEnd(20)} ${"Duration".padEnd(10)} Participants`));
  console.log("  " + "─".repeat(72));

  files.forEach((file, idx) => {
    const filePath = path.join(SESSION_DIR, file);
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
    const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    const start = events.find((e) => e.type === "session_start");
    const end = events.find((e) => e.type === "session_end");
    const joins = events.filter((e) => e.type === "join");
    const names = joins.map((e: any) => e.name).join(", ") || "—";

    const cmd = start ? start.cmd.join(" ").slice(0, 18) : "?";
    const duration = (start && end) ? fmtDuration(end.ts - start.ts) : "running?";
    const label = file.replace(".jsonl", "").replace("T", " ").replace(/-(\d{2})-(\d{2})$/, ":$1:$2");

    console.log(`  ${String(idx + 1).padEnd(4)} ${label.padEnd(22)} ${cmd.padEnd(20)} ${duration.padEnd(10)} ${names}`);
  });
  console.log("");
  console.log(paint(c.dim, `  Use 'powwow log <n>' to view a session.`));
  console.log("");
}

function showSession(filePath: string): void {
  const raw = fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
  const events: any[] = raw.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  const start = events.find((e) => e.type === "session_start");
  const end = events.find((e) => e.type === "session_end");
  const duration = (start && end) ? fmtDuration(end.ts - start.ts) : "unknown";

  console.log("");
  console.log(paint(c.bold, `  Session: ${path.basename(filePath).replace(".jsonl", "")}`));
  if (start) {
    console.log(paint(c.dim,  `  Command: ${start.cmd.join(" ")}`));
    console.log(paint(c.dim,  `  Cwd:     ${start.cwd}`));
  }
  console.log(paint(c.dim,    `  Duration: ${duration}`));
  console.log("");
  console.log("  " + "─".repeat(72));

  let lastOutputTs = 0;

  for (const e of events) {
    const t = paint(c.dim, fmtTime(e.ts));

    switch (e.type) {
      case "session_start":
        console.log(`  ${t}  ${paint(c.green, "▶ session started")}  ${paint(c.dim, e.cmd.join(" "))}`);
        break;
      case "session_end":
        console.log(`  ${t}  ${paint(c.dim, "■ session ended")}${e.exitCode != null ? paint(c.dim, "  exit " + e.exitCode) : ""}`);
        break;
      case "join":
        console.log(`  ${t}  ${paint(c.cyan, `→ ${e.name} joined`)}${e.becameDriver ? paint(c.green, "  (driving)") : ""}`);
        break;
      case "reconnect":
        console.log(`  ${t}  ${paint(c.cyan, `↩ ${e.name} reconnected`)}`);
        break;
      case "leave":
        console.log(`  ${t}  ${paint(c.dim, `← ${e.name} left`)}`);
        break;
      case "control_granted":
        console.log(`  ${t}  ${paint(c.yellow, `⇒ ${e.name} took control`)}`);
        break;
      case "control_yielded":
        console.log(`  ${t}  ${paint(c.yellow, `⇒ ${e.fromName} yielded${e.toName ? " → " + e.toName : " (no driver)"}`)}`);
        break;
      case "input":
        console.log(`  ${t}  ${paint(c.bold, e.name)}  ${paint(c.blue, e.data)}`);
        break;
      case "output": {
        // Collapse rapid output bursts — only print a separator if it's been
        // more than 2s since the last output entry.
        const gap = e.ts - lastOutputTs;
        lastOutputTs = e.ts;
        if (gap > 2000) console.log("");
        const lines = e.data.split("\n").filter((l: string) => l.trim());
        for (const line of lines) {
          console.log(`  ${" ".repeat(10)}  ${paint(c.dim, line)}`);
        }
        break;
      }
      case "suggestion_posted":
        console.log(`  ${t}  ${paint(c.magenta, `💡 ${e.fromName} suggested:`)}  ${e.text}`);
        break;
      case "suggestion_sent":
        console.log(`  ${t}  ${paint(c.magenta, `✓ ${e.driverName} sent ${e.fromName}'s suggestion`)}`);
        break;
    }
  }

  console.log("  " + "─".repeat(72));
  console.log("");
}

function cmdLog(args: string[]): void {
  const target = args[0];

  if (!target) {
    listSessions();
    return;
  }

  // Numeric index: 1 = most recent
  const n = parseInt(target, 10);
  if (!isNaN(n) && n > 0) {
    const files = sessionFiles();
    if (n > files.length) {
      console.error(`Only ${files.length} session(s) recorded.`);
      process.exit(1);
    }
    showSession(path.join(SESSION_DIR, files[n - 1]));
    return;
  }

  // Filename (with or without directory / .jsonl extension)
  let filePath = target;
  if (!path.isAbsolute(filePath)) filePath = path.join(SESSION_DIR, filePath);
  if (!filePath.endsWith(".jsonl")) filePath += ".jsonl";
  if (!fs.existsSync(filePath)) {
    console.error(`Session file not found: ${filePath}`);
    process.exit(1);
  }
  showSession(filePath);
}

// --- serve (hook mode: no PTY, just JSONL adapter + host companion) -------

const ACTIVE_DIR = path.join(os.homedir(), ".powwow", "active");

function cwdToRegistrySlug(cwd: string): string {
  return cwd.replace(/\//g, "-").replace(/\\/g, "-");
}

function writeRegistry(
  cwd: string, port: number, controlToken: string, observerToken: string,
  tunnelUrl?: string, tunnelError?: string,
): void {
  fs.mkdirSync(ACTIVE_DIR, { recursive: true });
  const file = path.join(ACTIVE_DIR, `${cwdToRegistrySlug(cwd)}.json`);
  // `tunnelUrl`/`tunnelError` are always written explicitly (string | null),
  // never omitted — their mere presence in the file is how a polling reader
  // (a detached parent with stdio:"ignore" on the child, so it can't just
  // read stderr) knows the tunnel attempt has concluded, and why if it failed.
  fs.writeFileSync(file, JSON.stringify({
    port, controlToken, observerToken,
    tunnelUrl: tunnelUrl ?? null,
    tunnelError: tunnelError ?? null,
    pid: process.pid,
  }));
}

function deleteRegistry(cwd: string): void {
  try { fs.unlinkSync(path.join(ACTIVE_DIR, `${cwdToRegistrySlug(cwd)}.json`)); } catch { }
}

function readRegistry(cwd: string): { port: number; controlToken: string; observerToken: string; tunnelUrl?: string | null; tunnelError?: string | null; pid: number } | null {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(ACTIVE_DIR, `${cwdToRegistrySlug(cwd)}.json`), "utf8"));
    // Back-compat: old registry files used a single `token` field.
    if (data.token && !data.controlToken) {
      data.controlToken = data.token;
      data.observerToken = data.token;
    }
    return data;
  } catch { return null; }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? `open "${url}"`
    : process.platform === "win32" ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, (err) => { if (err) console.error("  Could not auto-open browser:", err.message); });
}

interface ServeArgs { port: number; host: string; cwd: string; claudeConfigDir?: string; foreground?: boolean; public?: boolean; }

function parseServeArgs(argv: string[]): ServeArgs {
  const args: ServeArgs = { port: 4321, host: "0.0.0.0", cwd: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--port": args.port = parseInt(argv[++i], 10) || args.port; break;
      case "--host": args.host = argv[++i] ?? args.host; break;
      case "--cwd":  args.cwd  = argv[++i] ?? args.cwd; break;
      case "--claude-config-dir": args.claudeConfigDir = argv[++i]; break;
      case "--foreground": args.foreground = true; break;
      case "--public": args.public = true; break;
      // kept for back-compat with existing hook scripts
      case "--detach": break;
    }
  }
  return args;
}

function printShareLinks(port: number, observerToken: string, tunnelUrl?: string | null, tunnelError?: string | null): string {
  const lanIps = lanAddresses();
  const observerUrls = lanIps.length
    ? lanIps.map((ip) => `http://${ip}:${port}/observe?t=${observerToken}`)
    : [`http://localhost:${port}/observe?t=${observerToken}`];
  console.log("\npowwow is live. Share with teammates:\n");
  if (tunnelUrl) {
    console.log(`  on the internet   ${tunnelUrl}/observe?t=${observerToken}`);
  }
  for (const u of observerUrls) console.log(`  ${u}`);
  console.log("");
  if (tunnelUrl) {
    console.log("  Internet link is a cloudflared quick tunnel: best-effort, not");
    console.log("  authenticated by Cloudflare, no SLA. Driving stays local either way —");
    console.log("  this companion only ever copies accepted suggestions to your clipboard.\n");
  } else if (tunnelError) {
    console.log(`  --public was requested but no internet link was opened: ${tunnelError}`);
    console.log("  Sharing locally/on your LAN only — see the link(s) above.\n");
  }
  return tunnelUrl ? `${tunnelUrl}/observe?t=${observerToken}` : observerUrls[0];
}

async function cmdServe(argv: string[]): Promise<void> {
  const args = parseServeArgs(argv);

  if (!args.foreground) {
    // Default: detach. If already running, just print the URL and exit —
    // UNLESS what's running doesn't match what was asked for: --public on a
    // session that was started without it (so never even attempted a tunnel).
    // In that case, restart it transparently below rather than silently
    // handing back the old local-only links (which would look exactly like
    // --public was ignored) or asking the user to do the restart by hand.
    const existing = readRegistry(args.cwd);
    if (existing && isProcessAlive(existing.pid)) {
      const neverAttemptedTunnel = existing.tunnelUrl == null && existing.tunnelError == null;
      if (args.public && neverAttemptedTunnel) {
        // The running session predates the --public request and never even
        // tried to open a tunnel — restart it transparently so --public
        // "just works" in one step instead of asking the user to run
        // /powwow-stop then /powwow --public themselves.
        console.log("\n  Restarting the running session to add a public tunnel (--public)...");
        process.kill(existing.pid, "SIGTERM");
        deleteRegistry(args.cwd);
        for (let i = 0; i < 25 && isProcessAlive(existing.pid); i++) {
          await new Promise((r) => setTimeout(r, 200));
        }
      } else {
        printShareLinks(existing.port, existing.observerToken, existing.tunnelUrl, existing.tunnelError);
        process.exit(0);
      }
    }
    // Fork self with --foreground, fully detached from this process.
    const spawnArgs = [
      path.resolve(__dirname, "cli.js"), "serve", "--foreground",
      "--cwd", args.cwd,
      "--port", String(args.port),
      "--host", args.host,
    ];
    if (args.claudeConfigDir) spawnArgs.push("--claude-config-dir", args.claudeConfigDir);
    if (args.public) spawnArgs.push("--public");
    const child = spawn(process.execPath, spawnArgs, { detached: true, stdio: "ignore" });
    child.unref();
    // Poll for the registry file (up to 6 s normally; longer once a tunnel is
    // involved, since cloudflared needs time to register its public hostname).
    const pollAttempts = args.public ? 90 : 30;
    for (let i = 0; i < pollAttempts; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const reg = readRegistry(args.cwd);
      // `tunnelUrl` is written as string | null once the tunnel attempt (if
      // any) has concluded — wait for that before printing, so we never show
      // the share links mid-attempt and then again with the public one missing.
      if (reg && isProcessAlive(reg.pid) && (!args.public || reg.tunnelUrl !== undefined)) {
        const primaryObserver = printShareLinks(reg.port, reg.observerToken, reg.tunnelUrl, reg.tunnelError);
        const hostUrl = `http://localhost:${reg.port}/host?t=${reg.controlToken}&obs=${encodeURIComponent(primaryObserver)}`;
        openInBrowser(hostUrl);
        process.exit(0);
      }
    }
    console.error("powwow: relay did not start within " + (args.public ? "18" : "6") + " seconds.");
    console.error("  Another session may be running on this port — try: node " + path.resolve(__dirname, "cli.js") + " stop --all");
    process.exit(1);
    return;
  }

  // --foreground: blocking mode. Idempotent: exit if already running.
  const existing = readRegistry(args.cwd);
  if (existing && isProcessAlive(existing.pid)) {
    process.exit(0);
  }

  const controlToken = crypto.randomBytes(16).toString("hex");
  const observerToken = crypto.randomBytes(16).toString("hex");
  const daemonOpts = {
    cwd: args.cwd,
    port: args.port,
    host: args.host,
    token: controlToken,
    observerToken,
    claudeConfigDir: args.claudeConfigDir,
    serveMode: true,
  } as Parameters<typeof startDaemon>[0];
  const daemon = await startDaemon(daemonOpts);

  let tunnel: TunnelHandle | undefined;
  let tunnelError: string | undefined;
  if (args.public) {
    try {
      tunnel = await startQuickTunnel(`http://localhost:${daemon.port}`);
      // Same enforcement as `start --public`: confines driving to localhost/LAN
      // even though this whole port is now proxied to the public internet —
      // see `viaTunnel` in daemon.ts.
      daemonOpts.tunnelHost = tunnel.hostname;
    } catch (err) {
      tunnelError = (err as Error).message;
      console.error(`\n  Could not open a public tunnel: ${tunnelError}`);
      console.error("  Continuing with local/LAN sharing only.\n");
    }
  }

  // Written only once the tunnel attempt (if any) has resolved one way or the
  // other, so the detached parent's poll never observes a half-finished state.
  // The default --detach run has stdio:"ignore", so `tunnelError` is the only
  // way the failure above reaches the user — without it, --public would just
  // silently fall back to local/LAN with no explanation.
  writeRegistry(args.cwd, daemon.port, controlToken, observerToken, tunnel?.url, tunnelError);

  const lanIps = lanAddresses();
  const shareUrls = lanIps.length
    ? lanIps.map((ip) => `http://${ip}:${daemon.port}/observe?t=${observerToken}`)
    : [`http://localhost:${daemon.port}/observe?t=${observerToken}`];
  const hostUrl = `http://localhost:${daemon.port}/host?t=${controlToken}&obs=${encodeURIComponent(shareUrls[0])}`;

  console.log(`\n  powwow companion started — share with teammates:\n`);
  if (tunnel) console.log(`    on the internet   ${tunnel.url}/observe?t=${observerToken}`);
  for (const u of shareUrls) console.log(`    ${u}`);
  console.log("");

  openInBrowser(hostUrl);

  const shutdown = () => {
    tunnel?.close();
    deleteRegistry(args.cwd);
    daemon.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function cmdStop(argv: string[]): void {
  const stopAll = argv.includes("--all");

  if (stopAll) {
    if (!fs.existsSync(ACTIVE_DIR)) {
      console.log("No active sessions.");
      return;
    }
    const files = fs.readdirSync(ACTIVE_DIR).filter((f) => f.endsWith(".json"));
    if (files.length === 0) {
      console.log("No active sessions.");
      return;
    }
    let stopped = 0;
    for (const file of files) {
      const filePath = path.join(ACTIVE_DIR, file);
      try {
        const reg = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (isProcessAlive(reg.pid)) {
          process.kill(reg.pid, "SIGTERM");
          stopped++;
        }
        fs.unlinkSync(filePath);
      } catch { fs.unlinkSync(filePath); }
    }
    console.log(`Stopped ${stopped} session(s).`);
    return;
  }

  // Stop session for a specific cwd (default: current)
  let cwd = process.cwd();
  const cwdIdx = argv.indexOf("--cwd");
  if (cwdIdx !== -1) cwd = argv[cwdIdx + 1] ?? cwd;

  const reg = readRegistry(cwd);
  if (!reg) {
    console.log("No active session found for this directory.");
    return;
  }
  if (isProcessAlive(reg.pid)) {
    process.kill(reg.pid, "SIGTERM");
    console.log(`Stopped session (pid ${reg.pid}).`);
  } else {
    console.log("Session process was already gone — cleaning up registry.");
  }
  deleteRegistry(cwd);
}

function cmdSetup(argv: string[]): void {
  let claudeConfigDir = path.join(os.homedir(), ".claude");
  const idx = argv.indexOf("--claude-config-dir");
  if (idx !== -1) claudeConfigDir = argv[idx + 1] ?? claudeConfigDir;

  const commandsDir = path.join(claudeConfigDir, "commands");
  fs.mkdirSync(commandsDir, { recursive: true });

  const cliPath = path.resolve(__dirname, "cli.js");
  const serveCmd = `node ${cliPath} serve --cwd "$PWD"`
    + (idx !== -1 ? ` --claude-config-dir ${claudeConfigDir}` : "")
    + ` $ARGUMENTS`;

  const content = [
    "Run this command and reply with the observer URL from its output. Do not run any other commands.",
    "",
    "Pass --public through as an argument (e.g. `/powwow --public`) to also open",
    "a public link via a cloudflared quick tunnel (requires `cloudflared` to be",
    "installed and on PATH). Driving always stays local either way.",
    "",
    "```bash",
    serveCmd,
    "```",
  ].join("\n");

  const dest = path.join(commandsDir, "powwow.md");
  fs.writeFileSync(dest, content);

  const stopContent = [
    "Run this command to stop the powwow sharing session for the current project. Do not run any other commands.",
    "",
    "```bash",
    `node ${cliPath} stop --cwd "$PWD"`,
    "```",
  ].join("\n");

  const stopDest = path.join(commandsDir, "powwow-stop.md");
  fs.writeFileSync(stopDest, stopContent);

  console.log(`\n  /powwow       → ${dest}`);
  console.log(`  /powwow-stop  → ${stopDest}`);
  console.log("  Type /powwow or /powwow-stop in any Claude Code session.\n");
}

// --- main -----------------------------------------------------------------

async function main(): Promise<void> {
  const [, , sub, ...rest] = process.argv;

  if (sub === "log") {
    cmdLog(rest);
    return;
  }

  if (sub === "serve") {
    await cmdServe(rest);
    return;
  }

  if (sub === "setup") {
    cmdSetup(rest);
    return;
  }

  if (sub === "stop") {
    cmdStop(rest);
    return;
  }

  if (sub !== "start") {
    printHelp();
    process.exit(sub ? 1 : 0);
  }

  const args = parseStartArgs(rest);
  const controlToken = crypto.randomBytes(16).toString("hex");
  const observerToken = crypto.randomBytes(16).toString("hex");

  const daemonOpts = {
    cmd: args.cmd,
    cwd: args.cwd,
    port: args.port,
    host: args.host,
    token: controlToken,
    observerToken,
    claudeConfigDir: args.claudeConfigDir,
  } as Parameters<typeof startDaemon>[0];
  const daemon = await startDaemon(daemonOpts);

  let tunnel: TunnelHandle | undefined;
  if (args.public) {
    console.log("\n  Opening a public tunnel via cloudflared…");
    try {
      tunnel = await startQuickTunnel(`http://localhost:${daemon.port}`);
      // Mutates the same options object the daemon is holding: from this point
      // on, requests whose Host header matches the tunnel are refused control
      // capability — see the `viaTunnel` check in daemon.ts.
      daemonOpts.tunnelHost = tunnel.hostname;
    } catch (err) {
      console.error(`\n  Could not open a public tunnel: ${(err as Error).message}\n`);
      daemon.close();
      process.exit(1);
    }
  }

  const lines: string[] = [];
  lines.push("");
  lines.push("  powwow session is live");
  lines.push(`  wrapping: ${args.cmd.join(" ")}`);
  lines.push("");
  lines.push("  Host (terminal view — driving only works here, never via the public link):");
  lines.push(`    this machine   http://localhost:${daemon.port}/?t=${controlToken}`);
  for (const ip of lanAddresses()) {
    lines.push(`    on your LAN    http://${ip}:${daemon.port}/?t=${controlToken}`);
  }
  lines.push("");
  lines.push("  Teammates (observer view, safe to share):");
  if (tunnel) {
    lines.push(`    on the internet   ${tunnel.url}/observe?t=${observerToken}`);
  }
  lines.push(`    this machine   http://localhost:${daemon.port}/observe?t=${observerToken}`);
  for (const ip of lanAddresses()) {
    lines.push(`    on your LAN    http://${ip}:${daemon.port}/observe?t=${observerToken}`);
  }
  if (tunnel) {
    lines.push("");
    lines.push("  The internet link is a cloudflared quick tunnel: best-effort, not");
    lines.push("  authenticated by Cloudflare, no SLA — it can be reclaimed or throttled");
    lines.push("  any time. Driving still only works from localhost/LAN; the control link");
    lines.push("  above does nothing if opened through the tunnel, even with its token.");
  }
  lines.push("");
  lines.push("  Ctrl-C here ends the session for everyone.");
  lines.push("");
  lines.push(`  Session log: ${daemon.logFile}`);
  lines.push("");
  console.log(lines.join("\n"));

  const shutdown = () => {
    tunnel?.close();
    daemon.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("powwow failed to start:", err);
  process.exit(1);
});
