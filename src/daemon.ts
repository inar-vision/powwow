import * as http from "http";
import * as fs from "fs";
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
}

export interface RunningDaemon {
  port: number;
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

  // --- spawn the wrapped agent under a PTY we fully own -------------------
  const spawnPty = opts.spawnPty ?? defaultSpawnPty;
  const term = spawnPty({ cmd: opts.cmd, cwd: opts.cwd, cols, rows });

  term.onData((data: string) => {
    scrollback += data;
    if (scrollback.length > SCROLLBACK_LIMIT) {
      scrollback = scrollback.slice(scrollback.length - SCROLLBACK_LIMIT);
    }
    broadcast({ type: "output", data });
  });

  term.onExit(({ exitCode }) => {
    broadcast({ type: "exit", code: exitCode });
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

  wss.on("connection", (ws: WebSocket) => {
    const id = crypto.randomBytes(6).toString("hex");
    sockets.set(ws, id);

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      handle(ws, id, msg);
    });

    ws.on("close", () => {
      sockets.delete(ws);
      if (session.has(id)) {
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
      }
    });
  });

  function broadcastTyping(id: string) {
    const now = Date.now();
    if (now - (lastTypingBroadcast.get(id) ?? 0) < TYPING_THROTTLE) return;
    lastTypingBroadcast.set(id, now);
    broadcast({ type: "typing", id, name: nameOf(id) });
  }

  function handle(ws: WebSocket, id: string, msg: ClientMessage) {
    switch (msg.type) {
      case "hello": {
        const name = (msg.name || "anon").slice(0, 40);
        const becameDriver = session.add(id, name);
        send(ws, {
          type: "init",
          youId: id,
          driverId: session.getDriverId(),
          participants: session.snapshot(),
          cols,
          rows,
          suggestions: [...suggestions],
        });
        // Replay recent output so a late joiner sees context immediately.
        if (scrollback) send(ws, { type: "output", data: scrollback });
        broadcast({
          type: "notice",
          text: becameDriver
            ? `${name} joined and is driving.`
            : `${name} joined as an observer.`,
        });
        broadcastPresence();
        break;
      }

      case "input": {
        if (session.isDriver(id)) {
          term.write(msg.data);
          // Only emit typing for pure printable text. Escape sequences (arrow
          // keys, xterm auto-responses to cursor queries like ESC[6n, focus
          // events, ctrl chords) are excluded — they contain \x1b and often
          // include digits that would otherwise pass a printable-char check.
          if (!/[\x00-\x1f\x7f]/.test(msg.data)) broadcastTyping(id);
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
          broadcast({ type: "notice", text: `${nameOf(id)} took control.` });
          broadcastPresence();
        } else if (result === "queued") {
          broadcast({
            type: "notice",
            text: `${nameOf(id)} requested control.`,
          });
          broadcastPresence();
        }
        break;
      }

      case "yield_control": {
        if (!session.isDriver(id)) break;
        const newDriver = session.yieldControl(id);
        broadcast({
          type: "notice",
          text: newDriver
            ? `${nameOf(id)} yielded control to ${nameOf(newDriver)}.`
            : `${nameOf(id)} released control. No one is driving.`,
        });
        broadcastPresence();
        break;
      }

      case "suggest": {
        if (!session.has(id)) break;
        const text = (msg.text || "").slice(0, 2000).trim();
        if (!text) break;
        const suggId = crypto.randomBytes(4).toString("hex");
        const suggestion: SuggestionInfo = { id: suggId, fromId: id, fromName: nameOf(id), text };
        suggestions.push(suggestion);
        broadcast({ type: "suggestion", suggestion });
        broadcast({ type: "notice", text: `${nameOf(id)} suggested a prompt.` });
        break;
      }

      case "accept_suggestion": {
        if (!session.isDriver(id)) break;
        const acceptIdx = suggestions.findIndex((s) => s.id === msg.id);
        if (acceptIdx === -1) break;
        const accepted = suggestions[acceptIdx];
        suggestions.splice(acceptIdx, 1);
        term.write(accepted.text + "\r");
        broadcast({ type: "suggestion_cleared", id: msg.id });
        broadcast({ type: "notice", text: `${nameOf(id)} sent ${accepted.fromName}'s suggestion to Claude.` });
        break;
      }

      case "typing": {
        if (session.has(id)) broadcastTyping(id);
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
    }
  }

  return new Promise((resolve) => {
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({
        port: boundPort,
        close: () => {
          try {
            term.kill();
          } catch {
            /* already gone */
          }
          wss.close();
          server.close();
        },
      });
    });
  });
}
