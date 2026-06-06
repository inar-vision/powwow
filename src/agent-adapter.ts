import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { EventEmitter } from "events";

// Structured events extracted from an AI coding session.
export type AgentEvent =
  | { type: "user_message"; text: string }
  | { type: "thinking" }                                               // presence only — content stays private
  | { type: "text"; text: string }
  | { type: "tool_call"; tool: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool: string; content: string; isError: boolean };

export interface AgentAdapter {
  on(event: "agent_event", cb: (e: AgentEvent) => void): this;
  start(): void;
  stop(): void;
}

// Claude Code encodes the project cwd as the project dir name:
// /Users/foo/bar/project  →  -Users-foo-bar-project
function cwdToSlug(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

// Parse a single JSONL line from a Claude Code session file.
// Returns zero or more AgentEvents (a single line can contain multiple content blocks).
function parseLine(line: string, toolNames: Map<string, string>): AgentEvent[] {
  let record: any;
  try { record = JSON.parse(line); } catch { return []; }

  const events: AgentEvent[] = [];

  if (record.type === "user") {
    const content = record.message?.content;
    if (typeof content === "string" && content.trim()) {
      events.push({ type: "user_message", text: content.trim() });
    } else if (Array.isArray(content)) {
      for (const c of content) {
        if (c.type === "tool_result") {
          const tool = toolNames.get(c.tool_use_id) ?? "unknown";
          const text = typeof c.content === "string" ? c.content
            : Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? "").join("") : "";
          events.push({ type: "tool_result", tool, content: text.slice(0, 2000), isError: !!c.is_error });
        }
      }
    }
  }

  if (record.type === "assistant") {
    const content = record.message?.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c.type === "tool_use") {
          toolNames.set(c.id, c.name);
          events.push({ type: "tool_call", tool: c.name, input: c.input ?? {} });
        } else if (c.type === "thinking") {
          events.push({ type: "thinking" });
        } else if (c.type === "text" && c.text?.trim()) {
          events.push({ type: "text", text: c.text.trim() });
        }
      }
    }
  }

  return events;
}

export class ClaudeSessionAdapter extends EventEmitter implements AgentAdapter {
  private sessionDir: string;
  private currentFile: string | null = null;
  private filePos = 0;
  private toolNames = new Map<string, string>(); // tool_use_id → tool name
  private dirWatcher: fs.FSWatcher | null = null;
  private fileWatcher: fs.FSWatcher | null = null;
  private stopped = false;

  constructor(cwd: string, configDir?: string) {
    super();
    const base = configDir
      ?? process.env["CLAUDE_CONFIG_DIR"]
      ?? path.join(os.homedir(), ".claude");
    this.sessionDir = path.join(base, "projects", cwdToSlug(cwd));
  }

  start(): void {
    fs.mkdirSync(this.sessionDir, { recursive: true });

    const existing = this.mostRecentFile();
    if (existing) this.attachToFile(existing);

    // Watch for new session files (user starts a fresh Claude session)
    this.dirWatcher = fs.watch(this.sessionDir, (_event, filename) => {
      if (this.stopped || !filename?.endsWith(".jsonl")) return;
      const candidate = path.join(this.sessionDir, filename);
      if (candidate !== this.currentFile && fs.existsSync(candidate)) {
        this.detachFileWatcher();
        this.toolNames.clear();
        this.emit("new_session");
        this.attachToFile(candidate);
      }
    });
  }

  stop(): void {
    this.stopped = true;
    this.detachFileWatcher();
    this.dirWatcher?.close();
    this.dirWatcher = null;
  }

  private mostRecentFile(): string | null {
    if (!fs.existsSync(this.sessionDir)) return null;
    const files = fs.readdirSync(this.sessionDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, mtime: fs.statSync(path.join(this.sessionDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length ? path.join(this.sessionDir, files[0].f) : null;
  }

  // Read all events from the current session file up to filePos.
  // Used by the daemon to populate the replay buffer for late joiners.
  history(): AgentEvent[] {
    if (!this.currentFile || this.filePos === 0) return [];
    const buf = Buffer.alloc(this.filePos);
    let fd: number;
    try { fd = fs.openSync(this.currentFile, "r"); } catch { return []; }
    fs.readSync(fd, buf, 0, this.filePos, 0);
    fs.closeSync(fd);
    const localToolNames = new Map<string, string>();
    const events: AgentEvent[] = [];
    for (const line of buf.toString("utf8").split("\n")) {
      for (const ev of parseLine(line, localToolNames)) events.push(ev);
    }
    return events;
  }

  private attachToFile(filePath: string): void {
    this.currentFile = filePath;
    // Position at end — only emit events that happen from now on.
    // history() reads back to this position for late-joiner replay.
    try { this.filePos = fs.statSync(filePath).size; } catch { this.filePos = 0; }

    this.fileWatcher = fs.watch(filePath, () => {
      if (!this.stopped) this.readNewContent();
    });
  }

  private readNewContent(): void {
    if (!this.currentFile) return;
    let size: number;
    try { size = fs.statSync(this.currentFile).size; } catch { return; }
    if (size <= this.filePos) return;

    const len = size - this.filePos;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(this.currentFile, "r");
    fs.readSync(fd, buf, 0, len, this.filePos);
    fs.closeSync(fd);
    this.filePos = size;

    for (const line of buf.toString("utf8").split("\n")) {
      for (const ev of parseLine(line, this.toolNames)) {
        this.emit("agent_event", ev);
      }
    }
  }

  private detachFileWatcher(): void {
    this.fileWatcher?.close();
    this.fileWatcher = null;
  }
}
