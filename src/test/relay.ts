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

  console.log("");
  console.log(failures === 0 ? "All relay checks passed." : failures + " check(s) failed.");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("relay test crashed:", e);
  process.exit(1);
});
