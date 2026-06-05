import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import { Session } from "./session";
import { ClientMessage, ServerMessage, SuggestionInfo } from "./protocol";

// Minimal surface of a pseudo-terminal we depend on. node-pty satisfies this;
// tests inject a fake so the relay can be exercised without native bindings.
export interface PtyLike {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtySpawnConfig {
  cmd: string[];
  cwd: string;
  cols: number;
  rows: number;
}

export type SpawnPty = (config: PtySpawnConfig) => PtyLike;

// Default factory: lazily require node-pty so headless tests that inject their
// own PtyLike never need the native module installed.
const defaultSpawnPty: SpawnPty = (config) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pty = require("node-pty");
  // Belt-and-suspenders: on macOS node-pty execs a `spawn-helper` binary that
  // npm sometimes installs without the execute bit, causing "posix_spawnp
  // failed". Restore it before spawning.
  try {
    const ptyDir = path.dirname(require.resolve("node-pty/package.json"));
    for (const sub of ["build/Release/spawn-helper", "build/Debug/spawn-helper"]) {
      const helper = path.join(ptyDir, sub);
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
    }
  } catch {
    /* non-macOS builds have no spawn-helper — ignore */
  }
  return pty.spawn(config.cmd[0], config.cmd.slice(1), {
    name: "xterm-256color",
    cols: config.cols,
    rows: config.rows,
    cwd: config.cwd,
    env: process.env,
  });
};

export interface DaemonOptions {
  cmd: string[]; // command + args to wrap, e.g. ["bash"] or ["claude", "--model", "..."]
  cwd: string;
  port: number;
  host: string; // bind address, e.g. "0.0.0.0"
  token: string; // shared session secret carried in the join link
  spawnPty?: SpawnPty; // override the PTY factory (used by tests)
  logDir?: string;  // override log directory (used by tests to avoid polluting ~/.powwow)
}

export interface RunningDaemon {
  port: number;
  logFile: string;
  close: () => void;
}

const SCROLLBACK_LIMIT = 256 * 1024; // bytes of recent output replayed to late joiners
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  const session = new Session();
  const sockets = new Map<WebSocket, string>(); // socket -> participant id
  const suggestions: SuggestionInfo[] = [];
  const lastTypingBroadcast = new Map<string, number>();
  const TYPING_THROTTLE = 400;
  let scrollback = "";
  let cols = 80;
  let rows = 24;

  // --- session log (append-only JSONL in ~/.powwow/sessions/) -------------
  const sessionId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logDir = opts.logDir ?? path.join(os.homedir(), ".powwow", "sessions");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${sessionId}.jsonl`);
  const logStream = fs.createWriteStream(logFile, { flags: "a" });

  function logEntry(entry: object): void {
    logStream.write(JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
  }

  function stripAnsi(s: string): string {
    return s
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC (title, hyperlinks)
      .replace(/\x1b[@-Z\\-_]/g, "")                       // 2-char sequences
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")              // CSI sequences
      .replace(/[\x00-\x09\x0b-\x0c\x0e-\x1f\x7f]/g, "")  // control chars (keep \n)
      .replace(/\r/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  const inputBuffers = new Map<string, string>(); // driver id -> buffered line

  logEntry({ type: "session_start", cmd: opts.cmd, cwd: opts.cwd });

  // --- spawn the wrapped agent under a PTY we fully own -------------------
  const spawnPty = opts.spawnPty ?? defaultSpawnPty;
  const term = spawnPty({ cmd: opts.cmd, cwd: opts.cwd, cols, rows });

  let outputBuffer = "";
  let outputFlushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushOutputLog() {
    outputFlushTimer = null;
    const stripped = stripAnsi(outputBuffer);
    if (stripped.length > 0) logEntry({ type: "output", data: stripped });
    outputBuffer = "";
  }

  term.onData((data: string) => {
    scrollback += data;
    if (scrollback.length > SCROLLBACK_LIMIT) {
      scrollback = scrollback.slice(scrollback.length - SCROLLBACK_LIMIT);
    }
    broadcast({ type: "output", data });
    outputBuffer += data;
    if (!outputFlushTimer) outputFlushTimer = setTimeout(flushOutputLog, 200);
  });

  term.onExit(({ exitCode }) => {
    if (outputFlushTimer) { clearTimeout(outputFlushTimer); flushOutputLog(); }
    broadcast({ type: "exit", code: exitCode });
    logEntry({ type: "session_end", exitCode });
    logStream.end();
  });

  // --- helpers ------------------------------------------------------------
  function send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function broadcast(msg: ServerMessage) {
    const text = JSON.stringify(msg);
    for (const ws of sockets.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    }
  }

  function broadcastPresence() {
    broadcast({
      type: "presence",
      driverId: session.getDriverId(),
      participants: session.snapshot(),
    });
  }

  function nameOf(id: string): string {
    return session.snapshot().find((p) => p.id === id)?.name ?? "someone";
  }

  // --- static file + token-gated HTTP server ------------------------------
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // The join link must carry the right token. The page itself is harmless;
    // the token is re-checked on the websocket upgrade where control lives.
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (url.searchParams.get("t") !== opts.token) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Invalid or missing session token.");
        return;
      }
    }

    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
    const abs = path.join(PUBLIC_DIR, filePath);
    if (!abs.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(abs, (err, buf) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(abs)] ?? "application/octet-stream",
      });
      res.end(buf);
    });
  });

  // --- websocket layer ----------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== "/ws" || url.searchParams.get("t") !== opts.token) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  // Participants who disconnected recently — held here so a reconnect within
  // the grace window restores their identity without a "left / joined" pair.
  const reconnectBuffer = new Map<string, { id: string; name: string; timer: ReturnType<typeof setTimeout> }>();
  const RECONNECT_GRACE_MS = 30_000;

  function broadcastTyping(id: string) {
    const now = Date.now();
    if (now - (lastTypingBroadcast.get(id) ?? 0) < TYPING_THROTTLE) return;
    lastTypingBroadcast.set(id, now);
    broadcast({ type: "typing", id, name: nameOf(id) });
  }

  wss.on("connection", (ws: WebSocket) => {
    // `id` is mutable: the hello handler may reassign it to a buffered id on reconnect.
    let id = crypto.randomBytes(6).toString("hex");
    sockets.set(ws, id);

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case "hello": {
          const rawName = (msg.name || "anon").slice(0, 40);
          let displayName = rawName;
          let isReconnect = false;

          if (msg.clientId) {
            const buffered = reconnectBuffer.get(msg.clientId);
            if (buffered) {
              clearTimeout(buffered.timer);
              reconnectBuffer.delete(msg.clientId);
              id = buffered.id;
              sockets.set(ws, id);
              displayName = buffered.name;
              isReconnect = true;
            }
          }

          const becameDriver = session.add(id, displayName);
          send(ws, {
            type: "init",
            youId: id,
            clientId: id,
            driverId: session.getDriverId(),
            participants: session.snapshot(),
            cols,
            rows,
            suggestions: [...suggestions],
          });
          if (scrollback) send(ws, { type: "output", data: scrollback });
          if (isReconnect) {
            logEntry({ type: "reconnect", id, name: displayName });
          } else {
            logEntry({ type: "join", id, name: displayName, becameDriver });
          }
          broadcast({
            type: "notice",
            text: isReconnect
              ? `${displayName} reconnected.`
              : becameDriver
                ? `${displayName} joined and is driving.`
                : `${displayName} joined as an observer.`,
          });
          broadcastPresence();
          break;
        }

        case "input": {
          if (session.isDriver(id)) {
            term.write(msg.data);
            // Only emit typing for pure printable text — not escape sequences,
            // xterm cursor-query responses, focus events, or ctrl chords.
            if (!/[\x00-\x1f\x7f]/.test(msg.data)) broadcastTyping(id);
            // Buffer printable chars; flush complete line on Enter (\r)
            if (msg.data === "\r") {
              const line = inputBuffers.get(id) ?? "";
              inputBuffers.set(id, "");
              if (line.length > 0) logEntry({ type: "input", id, name: nameOf(id), data: line });
            } else if (!/[\x00-\x1f\x7f]/.test(msg.data)) {
              inputBuffers.set(id, (inputBuffers.get(id) ?? "") + msg.data);
            }
          }
          break;
        }

        case "resize": {
          if (session.isDriver(id)) {
            cols = Math.max(20, Math.min(500, Math.floor(msg.cols)));
            rows = Math.max(5, Math.min(200, Math.floor(msg.rows)));
            try {
              term.resize(cols, rows);
              broadcast({ type: "resize", cols, rows });
            } catch {
              /* terminal may have exited */
            }
          }
          break;
        }

        case "request_control": {
          const result = session.requestControl(id);
          if (result === "granted") {
            logEntry({ type: "control_granted", id, name: nameOf(id) });
            broadcast({ type: "notice", text: `${nameOf(id)} took control.` });
            broadcastPresence();
          } else if (result === "queued") {
            broadcast({ type: "notice", text: `${nameOf(id)} requested control.` });
            broadcastPresence();
          }
          break;
        }

        case "yield_control": {
          if (!session.isDriver(id)) break;
          const fromName = nameOf(id);
          const newDriver = session.yieldControl(id);
          if (newDriver) {
            logEntry({ type: "control_yielded", fromId: id, fromName, toId: newDriver, toName: nameOf(newDriver) });
          } else {
            logEntry({ type: "control_yielded", fromId: id, fromName, toId: null, toName: null });
          }
          broadcast({
            type: "notice",
            text: newDriver
              ? `${fromName} yielded control to ${nameOf(newDriver)}.`
              : `${fromName} released control. No one is driving.`,
          });
          broadcastPresence();
          break;
        }

        case "suggest": {
          if (!session.has(id)) break;
          const text = (msg.text || "").slice(0, 2000).trim();
          if (!text) break;
          const suggId = crypto.randomBytes(4).toString("hex");
          const fromName = nameOf(id);
          const suggestion: SuggestionInfo = { id: suggId, fromId: id, fromName, text };
          suggestions.push(suggestion);
          logEntry({ type: "suggestion_posted", fromId: id, fromName, text });
          broadcast({ type: "suggestion", suggestion });
          broadcast({ type: "notice", text: `${fromName} suggested a prompt.` });
          break;
        }

        case "accept_suggestion": {
          if (!session.isDriver(id)) break;
          const acceptIdx = suggestions.findIndex((s) => s.id === msg.id);
          if (acceptIdx === -1) break;
          const accepted = suggestions[acceptIdx];
          suggestions.splice(acceptIdx, 1);
          term.write(accepted.text + "\r");
          logEntry({ type: "suggestion_sent", driverId: id, driverName: nameOf(id), fromName: accepted.fromName, text: accepted.text });
          broadcast({ type: "suggestion_cleared", id: msg.id });
          broadcast({ type: "notice", text: `${nameOf(id)} sent ${accepted.fromName}'s suggestion to Claude.` });
          break;
        }

        case "dismiss_suggestion": {
          const dismissIdx = suggestions.findIndex((s) => s.id === msg.id);
          if (dismissIdx === -1) break;
          const dismissed = suggestions[dismissIdx];
          if (!session.isDriver(id) && dismissed.fromId !== id) break;
          suggestions.splice(dismissIdx, 1);
          broadcast({ type: "suggestion_cleared", id: msg.id });
          break;
        }

        case "typing": {
          if (session.has(id)) broadcastTyping(id);
          break;
        }
      }
    });

    ws.on("close", () => {
      sockets.delete(ws);
      if (session.has(id)) {
        const name = nameOf(id);
        const wasDriver = session.isDriver(id);
        session.remove(id);
        if (wasDriver) {
          const newDriver = session.getDriverId();
          broadcast({
            type: "notice",
            text: newDriver
              ? `${nameOf(newDriver)} is now driving.`
              : "The driver left. The session has no driver.",
          });
        }
        broadcastPresence();
        // Hold the departure notice — if they reconnect within the grace
        // window we cancel this and skip the "X left" noise entirely.
        const departedId = id;
        const timer = setTimeout(() => {
          reconnectBuffer.delete(departedId);
          logEntry({ type: "leave", id: departedId, name });
          broadcast({ type: "notice", text: `${name} left the session.` });
        }, RECONNECT_GRACE_MS);
        reconnectBuffer.set(id, { id, name, timer });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({
        port: boundPort,
        logFile,
        close: () => {
          try {
            term.kill();
          } catch {
            /* already gone */
          }
          wss.close();
          server.close();
          if (outputFlushTimer) { clearTimeout(outputFlushTimer); flushOutputLog(); }
          logEntry({ type: "session_end", exitCode: null });
          logStream.end();
        },
      });
    });
  });
}
