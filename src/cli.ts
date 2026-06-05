#!/usr/bin/env node
import * as os from "os";
import * as crypto from "crypto";
import { startDaemon } from "./daemon";

interface Args {
  cmd: string[];
  port: number;
  host: string;
  cwd: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    cmd: ["bash"],
    port: 4321,
    host: "0.0.0.0",
    cwd: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--cmd":
        // Wrap an arbitrary command. Split on whitespace for MVP simplicity,
        // e.g. --cmd "claude --model sonnet".
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
  powwow start [options]

Options:
  --cmd "<command>"   Command to wrap (default: "bash"). e.g. --cmd "claude"
  --port <n>          Port to listen on (default: 4321)
  --host <addr>       Bind address (default: 0.0.0.0, reachable on your LAN)
  --cwd <dir>         Working directory for the wrapped command (default: cwd)
  -h, --help          Show this help

Examples:
  powwow start                       # share a bash session
  powwow start --cmd "claude"        # share a Claude Code session
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

async function main(): Promise<void> {
  const [, , sub, ...rest] = process.argv;
  if (sub !== "start") {
    printHelp();
    process.exit(sub ? 1 : 0);
  }

  const args = parseArgs(rest);
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
  lines.push("  Share one of these links:");
  lines.push(`    this machine   http://localhost:${daemon.port}/${q}`);
  for (const ip of lanAddresses()) {
    lines.push(`    on your LAN    http://${ip}:${daemon.port}/${q}`);
  }
  lines.push("");
  lines.push("  First to join drives. Others observe and can request control.");
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
