/* End-to-end check: turn-taking actually gates input to the driver.
 * Wraps `bash`, connects two clients, and asserts the relay behaviour. */
import * as os from "os";
import { WebSocket } from "ws";
import { startDaemon } from "../daemon";

let failures = 0;
function check(cond: boolean, label: string) {
  if (cond) {
    console.log("  PASS  " + label);
  } else {
    console.log("  FAIL  " + label);
    failures++;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client {
  ws: WebSocket;
  youId: string | null = null;
  driverId: string | null = null;
  presence: any[] = [];
  notices: string[] = [];

  constructor(url: string, private name: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "init") {
        this.youId = msg.youId;
        this.driverId = msg.driverId;
        this.presence = msg.participants;
      } else if (msg.type === "presence") {
        this.driverId = msg.driverId;
        this.presence = msg.participants;
      } else if (msg.type === "notice") {
        this.notices.push(msg.text);
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
  send(obj: any) {
    this.ws.send(JSON.stringify(obj));
  }
  amDriver(): boolean {
    return this.youId !== null && this.youId === this.driverId;
  }
}

async function main() {
  // Capture all terminal output broadcast to any client by spying on one of them.
  let output = "";

  const daemon = await startDaemon({
    cmd: ["bash"],
    cwd: process.cwd(),
    port: 0,
    host: "127.0.0.1",
    token: "testtoken",
    logDir: os.tmpdir(),
  });
  const url = `ws://127.0.0.1:${daemon.port}/ws?t=testtoken`;

  const alice = new Client(url, "Alice");
  alice.ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "output") output += m.data;
  });
  await alice.ready();
  await sleep(200);
  check(alice.amDriver(), "first joiner (Alice) becomes driver");

  const bob = new Client(url, "Bob");
  await bob.ready();
  await sleep(200);
  check(!bob.amDriver(), "second joiner (Bob) joins as observer");
  check(bob.presence.length === 2, "both participants visible in presence");

  // Bob is NOT the driver: his input must never reach the PTY.
  output = "";
  bob.send({ type: "input", data: "echo BOB_SHOULD_NOT_RUN\n" });
  await sleep(400);
  check(
    output.indexOf("BOB_SHOULD_NOT_RUN") === -1,
    "non-driver input is ignored by the PTY"
  );

  // Alice IS the driver: her input runs.
  output = "";
  alice.send({ type: "input", data: "echo ALICE_RAN_THIS\n" });
  await sleep(500);
  check(
    output.indexOf("ALICE_RAN_THIS") !== -1,
    "driver input reaches the PTY and output is broadcast"
  );

  // Bob requests control -> queued while Alice drives.
  bob.send({ type: "request_control" });
  await sleep(250);
  const bobChip = bob.presence.find((p) => p.id === bob.youId);
  check(!!bobChip && bobChip.requestingControl, "request_control queues Bob");
  check(!bob.amDriver(), "Bob does not seize control while Alice drives");

  // Alice yields -> Bob becomes driver.
  alice.send({ type: "yield_control" });
  await sleep(300);
  check(bob.amDriver(), "yield_control hands the driver role to Bob");
  check(!alice.amDriver(), "Alice is no longer the driver after yielding");

  // Now Bob's input runs.
  output = "";
  bob.send({ type: "input", data: "echo BOB_DRIVES_NOW\n" });
  await sleep(500);
  check(
    output.indexOf("BOB_DRIVES_NOW") !== -1,
    "new driver (Bob) input now reaches the PTY"
  );

  alice.ws.close();
  bob.ws.close();
  daemon.close();
  await sleep(150);

  console.log("");
  if (failures === 0) {
    console.log("All e2e checks passed.");
    process.exit(0);
  } else {
    console.log(failures + " e2e check(s) failed.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("e2e crashed:", err);
  process.exit(1);
});
