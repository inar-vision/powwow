#!/usr/bin/env node
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { startDaemon } from "./daemon";

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
  powwow start [options]   Start a session
  powwow log               List recorded sessions
  powwow log <n>           Show nth most recent session (1 = latest)
  powwow log <filename>    Show a specific .jsonl file

Start options:
  --cmd "<command>"   Command to wrap (default: "bash"). e.g. --cmd "claude"
  --port <n>          Port to listen on (default: 4321)
  --host <addr>       Bind address (default: 0.0.0.0, reachable on your LAN)
  --cwd <dir>         Working directory for the wrapped command (default: cwd)
  -h, --help          Show this help

Examples:
  powwow start                       # share a bash session
  powwow start --cmd "claude"        # share a Claude Code session
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

// --- main -----------------------------------------------------------------

async function main(): Promise<void> {
  const [, , sub, ...rest] = process.argv;

  if (sub === "log") {
    cmdLog(rest);
    return;
  }

  if (sub !== "start") {
    printHelp();
    process.exit(sub ? 1 : 0);
  }

  const args = parseStartArgs(rest);
  const token = crypto.randomBytes(16).toString("hex");

  const daemon = await startDaemon({
    cmd: args.cmd,
    cwd: args.cwd,
    port: args.port,
    host: args.host,
    token,
  });

  const q = `?t=${token}`;
  const lines: string[] = [];
  lines.push("");
  lines.push("  powwow session is live");
  lines.push(`  wrapping: ${args.cmd.join(" ")}`);
  lines.push("");
  lines.push("  Host (terminal view):");
  lines.push(`    this machine   http://localhost:${daemon.port}/${q}`);
  for (const ip of lanAddresses()) {
    lines.push(`    on your LAN    http://${ip}:${daemon.port}/${q}`);
  }
  lines.push("");
  lines.push("  Teammates (observer view):");
  lines.push(`    this machine   http://localhost:${daemon.port}/observe${q}`);
  for (const ip of lanAddresses()) {
    lines.push(`    on your LAN    http://${ip}:${daemon.port}/observe${q}`);
  }
  lines.push("");
  lines.push("  Ctrl-C here ends the session for everyone.");
  lines.push("");
  lines.push(`  Session log: ${daemon.logFile}`);
  lines.push("");
  console.log(lines.join("\n"));

  const shutdown = () => {
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
