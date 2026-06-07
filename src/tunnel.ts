// Manages a `cloudflared` quick tunnel as a child process: spawns it, parses
// the public https://<random>.trycloudflare.com URL out of its log output, and
// hands back a handle to close it. No accounts, no config — `cloudflared
// tunnel --url <local>` is the entire "quick tunnel" feature.
import { spawn, ChildProcessByStdio } from "child_process";
import { Readable } from "stream";

export interface TunnelHandle {
  url: string;       // e.g. https://random-words.trycloudflare.com
  hostname: string;  // e.g. random-words.trycloudflare.com
  close: () => void;
}

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;

export const CLOUDFLARED_NOT_FOUND =
  "cloudflared not found on PATH.\n" +
  "  --public needs it to open a quick tunnel. Install it and try again:\n" +
  "    macOS:   brew install cloudflared\n" +
  "    other:   https://github.com/cloudflare/cloudflared/releases";

/**
 * Spawns `cloudflared tunnel --url <localUrl>` and resolves once the public
 * URL appears in its output (cloudflared logs to stderr, format has shifted
 * across versions, hence the loose regex scan over both streams).
 */
export function startQuickTunnel(localUrl: string, timeoutMs = 30_000): Promise<TunnelHandle> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcessByStdio<null, Readable, Readable>;
    try {
      proc = spawn("cloudflared", ["tunnel", "--url", localUrl], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout.removeListener("data", onData);
      proc.stderr.removeListener("data", onData);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        proc.kill();
        reject(new Error("Timed out waiting for cloudflared to print a tunnel URL."));
      });
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      const m = chunk.toString("utf8").match(TUNNEL_URL_RE);
      if (!m) return;
      finish(() => {
        const url = m[0];
        proc.removeAllListeners("error");
        proc.removeAllListeners("exit");
        resolve({ url, hostname: new URL(url).hostname, close: () => proc.kill() });
      });
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);

    proc.once("error", (err: NodeJS.ErrnoException) => {
      finish(() => {
        reject(err.code === "ENOENT" ? new Error(CLOUDFLARED_NOT_FOUND) : err);
      });
    });
    proc.once("exit", (code) => {
      finish(() => reject(new Error(`cloudflared exited before printing a tunnel URL (code ${code}).`)));
    });
  });
}
