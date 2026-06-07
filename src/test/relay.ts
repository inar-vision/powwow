/* Headless turn-taking check. Injects a fake echo-PTY so the relay can be
 * verified without the native node-pty module. The fake simply echoes whatever
 * is written to it, which is enough to prove that ONLY the driver's input is
 * forwarded to the terminal. Run with: npm run test:relay */
import * as os from "os";
import { WebSocket } from "ws";
import { startDaemon, PtyLike, SpawnPty } from "../daemon";

let failures = 0;
function check(cond: boolean, label: string) {
  console.log((cond ? "  PASS  " : "  FAIL  ") + label);
  if (!cond) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A PTY that echoes input straight back as output.
const fakeSpawn: SpawnPty = () => {
  let dataCb: (d: string) => void = () => {};
  const term: PtyLike = {
    onData(cb) {
      dataCb = cb;
    },
    onExit() {
      /* never exits during the test */
    },
    write(data) {
      dataCb(data); // echo
    },
    resize() {},
    kill() {},
  };
  return term;
};

class Client {
  ws: WebSocket;
  youId: string | null = null;
  driverId: string | null = null;
  presence: any[] = [];
  suggestions: any[] = [];
  constructor(url: string, private name: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "init") {
        this.youId = m.youId;
        this.driverId = m.driverId;
        this.presence = m.participants;
      } else if (m.type === "presence") {
        this.driverId = m.driverId;
        this.presence = m.participants;
      } else if (m.type === "suggestion") {
        this.suggestions.push(m.suggestion);
      } else if (m.type === "suggestion_cleared") {
        this.suggestions = this.suggestions.filter((s) => s.id !== m.id);
      }
    });
  }
  ready(): Promise<void> {
    return new Promise((res, rej) => {
      this.ws.on("open", () => {
        this.ws.send(JSON.stringify({ type: "hello", name: this.name }));
        res();
      });
      this.ws.on("error", rej);
    });
  }
  send(o: any) {
    this.ws.send(JSON.stringify(o));
  }
  amDriver() {
    return this.youId !== null && this.youId === this.driverId;
  }
}

async function main() {
  const daemon = await startDaemon({
    cmd: ["fake"],
    cwd: process.cwd(),
    port: 0,
    host: "127.0.0.1",
    token: "ctrl",
    observerToken: "obs",
    spawnPty: fakeSpawn,
    logDir: os.tmpdir(),
  });
  const url = `ws://127.0.0.1:${daemon.port}/ws?t=ctrl`;
  const obsUrl = `ws://127.0.0.1:${daemon.port}/ws?t=obs`;

  let output = "";
  const alice = new Client(url, "Alice");
  alice.ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "output") output += m.data;
  });
  await alice.ready();
  await sleep(120);
  check(alice.amDriver(), "first joiner (Alice) becomes driver");

  const bob = new Client(url, "Bob");
  await bob.ready();
  await sleep(120);
  check(!bob.amDriver(), "second joiner (Bob) is an observer");
  check(bob.presence.length === 2, "presence lists both participants");

  output = "";
  bob.send({ type: "input", data: "BOB_BLOCKED" });
  await sleep(150);
  check(output.indexOf("BOB_BLOCKED") === -1, "non-driver input is dropped");

  output = "";
  alice.send({ type: "input", data: "ALICE_OK" });
  await sleep(150);
  check(output.indexOf("ALICE_OK") !== -1, "driver input is forwarded + broadcast");

  bob.send({ type: "request_control" });
  await sleep(150);
  const chip = bob.presence.find((p) => p.id === bob.youId);
  check(!!chip && chip.requestingControl, "request_control queues Bob");
  check(!bob.amDriver(), "Bob waits while Alice drives");

  alice.send({ type: "yield_control" });
  await sleep(150);
  check(bob.amDriver(), "yield hands control to Bob");
  check(!alice.amDriver(), "Alice is no longer driving");

  output = "";
  bob.send({ type: "input", data: "BOB_NOW" });
  await sleep(150);
  check(output.indexOf("BOB_NOW") !== -1, "new driver Bob's input is forwarded");

  // Alice's input should now be blocked.
  output = "";
  alice.send({ type: "input", data: "ALICE_BLOCKED" });
  await sleep(150);
  check(output.indexOf("ALICE_BLOCKED") === -1, "former driver Alice is now blocked");

  // --- capability split: observer token ------------------------------------

  // Wrong token rejected at WebSocket upgrade.
  await new Promise<void>((resolve) => {
    const badWs = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws?t=wrongtoken`);
    let settled = false;
    const done = (opened: boolean) => {
      if (settled) return;
      settled = true;
      check(!opened, "wrong token: WebSocket upgrade rejected");
      resolve();
    };
    badWs.on("open", () => done(true));
    badWs.on("close", () => done(false));
    badWs.on("error", () => done(false));
  });

  // Observer connects with observer token.
  const carol = new Client(obsUrl, "Carol");
  await carol.ready();
  await sleep(120);
  check(!carol.amDriver(), "observer joins as non-driver");

  // Observer request_control is silently dropped.
  carol.send({ type: "request_control" });
  await sleep(150);
  check(!carol.amDriver(), "observer request_control: carol does not become driver");
  check(bob.amDriver(), "observer request_control: bob (control socket) remains driver");

  // Observer input is silently dropped.
  output = "";
  carol.send({ type: "input", data: "CAROL_BLOCKED" });
  await sleep(150);
  check(output.indexOf("CAROL_BLOCKED") === -1, "observer input: dropped, not forwarded");

  // Observer can post a suggestion (suggestion broadcasts to all).
  carol.send({ type: "suggest", text: "try a different approach" });
  await sleep(150);
  check(carol.suggestions.length > 0, "observer suggest: allowed, broadcast received");

  // Observer accept_suggestion is silently dropped — suggestion must remain.
  if (carol.suggestions.length > 0) {
    const suggId = carol.suggestions[0].id;
    carol.send({ type: "accept_suggestion", id: suggId });
    await sleep(150);
    check(
      carol.suggestions.some((s) => s.id === suggId),
      "observer accept_suggestion: denied, suggestion not cleared",
    );
  }

  carol.ws.close();
  alice.ws.close();
  bob.ws.close();
  daemon.close();
  await sleep(100);

  // --- observer-first deadlock regression -----------------------------------
  // A fresh session where an observer connects before ANY control user.
  // The driver seat must stay empty so a control user can claim it normally.

  const daemon2 = await startDaemon({
    cmd: ["fake"],
    cwd: process.cwd(),
    port: 0,
    host: "127.0.0.1",
    token: "ctrl2",
    observerToken: "obs2",
    spawnPty: fakeSpawn,
    logDir: os.tmpdir(),
  });
  const obsFirst = new Client(`ws://127.0.0.1:${daemon2.port}/ws?t=obs2`, "EarlyObs");
  await obsFirst.ready();
  await sleep(120);
  check(!obsFirst.amDriver(), "observer-first: observer does not become driver on empty session");
  check(obsFirst.driverId === null, "observer-first: driverId is null after observer joins");

  const lateCtrl = new Client(`ws://127.0.0.1:${daemon2.port}/ws?t=ctrl2`, "LateHost");
  await lateCtrl.ready();
  await sleep(120);
  check(lateCtrl.amDriver(), "observer-first: control user joining later becomes driver");
  check(!obsFirst.amDriver(), "observer-first: observer remains non-driver after control user joins");

  // Control user can still yield/drive normally.
  let output2 = "";
  lateCtrl.ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "output") output2 += m.data;
  });
  lateCtrl.send({ type: "input", data: "CTRL_DRIVES" });
  await sleep(150);
  check(output2.indexOf("CTRL_DRIVES") !== -1, "observer-first: control user input is forwarded");

  obsFirst.ws.close();
  lateCtrl.ws.close();
  daemon2.close();
  await sleep(100);

  // --- WebSocket keepalive --------------------------------------------------
  // A socket that never responds to pings is terminated by the server.

  const daemon3 = await startDaemon({
    cmd: ["fake"],
    cwd: process.cwd(),
    port: 0,
    host: "127.0.0.1",
    token: "ctrl3",
    observerToken: "obs3",
    spawnPty: fakeSpawn,
    logDir: os.tmpdir(),
    pingIntervalMs: 80, // short interval so the test doesn't drag
  });

  // Connect a raw TCP socket that upgrades to WebSocket but never replies to pings.
  await new Promise<void>((resolve) => {
    const net = require("net") as typeof import("net");
    const sock = net.createConnection(daemon3.port, "127.0.0.1", () => {
      // Minimal WS upgrade request with the control token.
      sock.write(
        "GET /ws?t=ctrl3 HTTP/1.1\r\n" +
        "Host: 127.0.0.1\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "Sec-WebSocket-Version: 13\r\n\r\n"
      );
    });
    let upgraded = false;
    sock.on("data", () => { upgraded = true; /* intentionally ignore ping frames */ });
    sock.on("close", () => {
      check(upgraded, "keepalive: server accepted the socket initially");
      check(true, "keepalive: dead socket terminated by server after missed pong");
      daemon3.close();
      resolve();
    });
    sock.on("error", () => { /* suppress ECONNRESET */ });
  });
  await sleep(100);

  // --- suggestion flood guards ----------------------------------------------
  // Use suggestRateMs:0 to skip the rate-limit delay in the test.

  const daemon4 = await startDaemon({
    cmd: ["fake"],
    cwd: process.cwd(),
    port: 0,
    host: "127.0.0.1",
    token: "ctrl4",
    observerToken: "obs4",
    spawnPty: fakeSpawn,
    logDir: os.tmpdir(),
    suggestRateMs: 0,
  });

  const floodObs = new Client(`ws://127.0.0.1:${daemon4.port}/ws?t=obs4`, "Flooder");
  await floodObs.ready();
  await sleep(80);

  // Post MAX_SUGGESTIONS_PER_POSTER (5) suggestions — all should go through.
  for (let i = 0; i < 5; i++) {
    floodObs.send({ type: "suggest", text: `suggestion ${i}` });
    await sleep(30);
  }
  check(floodObs.suggestions.length === 5, "flood guard: first 5 suggestions accepted (per-poster cap)");

  // 6th suggestion from same poster should be rejected.
  const beforeExtra = floodObs.suggestions.length;
  floodObs.send({ type: "suggest", text: "one too many" });
  await sleep(80);
  check(floodObs.suggestions.length === beforeExtra, "flood guard: 6th suggestion from same poster rejected");

  floodObs.ws.close();
  daemon4.close();
  await sleep(100);

  // Rate limit: two rapid suggests from a fresh observer — second should be dropped.
  const daemon5 = await startDaemon({
    cmd: ["fake"],
    cwd: process.cwd(),
    port: 0,
    host: "127.0.0.1",
    token: "ctrl5",
    observerToken: "obs5",
    spawnPty: fakeSpawn,
    logDir: os.tmpdir(),
    suggestRateMs: 5_000, // very long window so second fires within it
  });

  const rateObs = new Client(`ws://127.0.0.1:${daemon5.port}/ws?t=obs5`, "RateTester");
  await rateObs.ready();
  await sleep(80);

  rateObs.send({ type: "suggest", text: "first" });
  await sleep(30);
  rateObs.send({ type: "suggest", text: "second (rate limited)" });
  await sleep(80);
  check(rateObs.suggestions.length === 1, "flood guard: rapid second suggest dropped by rate limit");

  rateObs.ws.close();
  daemon5.close();
  await sleep(100);

  // --- public tunnel: control capability confined to localhost/LAN ---------
  // A `--public` session sets `tunnelHost` to the cloudflared hostname; the
  // daemon must refuse "control" auth on requests bearing that Host header,
  // even with a correct token — driving must never work through the public
  // link (see `viaTunnel` in daemon.ts). Observer auth is unaffected.

  const TUNNEL_HOST = "random-words.trycloudflare.com";
  const daemon6 = await startDaemon({
    cmd: ["fake"],
    cwd: process.cwd(),
    port: 0,
    host: "127.0.0.1",
    token: "ctrl6",
    observerToken: "obs6",
    spawnPty: fakeSpawn,
    logDir: os.tmpdir(),
    tunnelHost: TUNNEL_HOST,
  });

  function rawRequest(port: number, requestText: string): Promise<string> {
    return new Promise((resolve) => {
      const net = require("net") as typeof import("net");
      const sock = net.createConnection(port, "127.0.0.1", () => sock.write(requestText));
      let resp = "";
      sock.on("data", (d) => { resp += d.toString(); });
      sock.on("close", () => resolve(resp));
      sock.on("error", () => resolve(resp));
      setTimeout(() => sock.destroy(), 500);
    });
  }
  const wsUpgradeReq = (host: string, token: string) =>
    `GET /ws?t=${token} HTTP/1.1\r\n` +
    `Host: ${host}\r\n` +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
    "Sec-WebSocket-Version: 13\r\n\r\n";
  const pageReq = (host: string, pathAndQuery: string) =>
    `GET ${pathAndQuery} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;

  const tunnelWsResp = await rawRequest(daemon6.port, wsUpgradeReq(TUNNEL_HOST, "ctrl6"));
  check(tunnelWsResp.startsWith("HTTP/1.1 403"),
    "tunnel host: control WS upgrade refused even with a valid control token");

  const localWsResp = await rawRequest(daemon6.port, wsUpgradeReq(`127.0.0.1:${daemon6.port}`, "ctrl6"));
  check(localWsResp.startsWith("HTTP/1.1 101"),
    "local host: control WS upgrade still works with the same token");

  const tunnelPageResp = await rawRequest(daemon6.port, pageReq(TUNNEL_HOST, `/?t=ctrl6`));
  check(tunnelPageResp.startsWith("HTTP/1.1 403"),
    "tunnel host: control page refused even with a valid control token");

  const tunnelObserveResp = await rawRequest(daemon6.port, pageReq(TUNNEL_HOST, `/observe?t=obs6`));
  check(tunnelObserveResp.startsWith("HTTP/1.1 200"),
    "tunnel host: observer page unaffected, still reachable through the tunnel");

  daemon6.close();
  await sleep(100);

  console.log("");
  console.log(failures === 0 ? "All relay checks passed." : failures + " check(s) failed.");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("relay test crashed:", e);
  process.exit(1);
});
