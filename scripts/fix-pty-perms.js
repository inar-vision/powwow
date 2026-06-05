#!/usr/bin/env node
/* node-pty on macOS execs a small `spawn-helper` binary to launch the shell.
 * npm occasionally installs it without the execute bit, which makes spawning
 * fail with "posix_spawnp failed". This runs after install to restore it. */
const fs = require("fs");
const path = require("path");

const candidates = [
  "node-pty/build/Release/spawn-helper",
  "node-pty/build/Debug/spawn-helper",
];

let fixed = false;
for (const rel of candidates) {
  const p = path.join(__dirname, "..", "node_modules", rel);
  try {
    fs.chmodSync(p, 0o755);
    fixed = true;
  } catch {
    /* not present in this build (e.g. non-macOS) — ignore */
  }
}
if (fixed) console.log("[powwow] ensured node-pty spawn-helper is executable");
