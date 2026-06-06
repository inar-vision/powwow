/* Unit tests for the Session state machine. No I/O, no native deps.
 * Run with: npm run test:session */
import { Session } from "../session";

let failures = 0;
function check(cond: boolean, label: string) {
  console.log((cond ? "  PASS  " : "  FAIL  ") + label);
  if (!cond) failures++;
}

// --- join behaviour -------------------------------------------------------

{
  const s = new Session();
  check(s.add("a", "Alice") === true, "first joiner becomes driver");
  check(s.isDriver("a"), "isDriver true for driver");
  check(s.getDriverId() === "a", "getDriverId returns driver");
  check(s.has("a"), "has returns true for joined participant");
}

{
  const s = new Session();
  s.add("a", "Alice");
  check(s.add("b", "Bob") === false, "second joiner does not become driver");
  check(!s.isDriver("b"), "second joiner is not driver");
  check(s.has("b"), "second joiner is in session");
}

{
  const s = new Session();
  s.add("a", "Alice");
  s.add("a", "Alice"); // idempotent
  check(s.snapshot().length === 1, "add is idempotent — no duplicate");
}

// --- snapshot -------------------------------------------------------------

{
  const s = new Session();
  s.add("a", "Alice");
  s.add("b", "Bob");
  const snap = s.snapshot();
  check(snap.length === 2, "snapshot lists all participants");
  check(snap[0].id === "a" && snap[0].isDriver, "snapshot: first entry is driver");
  check(snap[1].id === "b" && !snap[1].isDriver, "snapshot: second entry is observer");
  check(snap[1].requestingControl === false, "snapshot: observer not requesting control");
}

// --- requestControl -------------------------------------------------------

{
  const s = new Session();
  s.add("a", "Alice");
  check(s.requestControl("a") === "noop", "driver requestControl is noop");
}

{
  const s = new Session();
  s.add("a", "Alice");
  s.add("b", "Bob");
  const r = s.requestControl("b");
  check(r === "queued", "observer requestControl while driver present → queued");
  check(s.snapshot().find(p => p.id === "b")?.requestingControl === true, "queued participant flagged in snapshot");
}

{
  const s = new Session();
  s.add("a", "Alice");
  s.add("b", "Bob");
  s.requestControl("b");
  check(s.requestControl("b") === "noop", "already queued → noop");
}

{
  const s = new Session();
  s.add("a", "Alice");
  s.add("b", "Bob");
  s.remove("a"); // driver leaves, no queue → no driver
  const r = s.requestControl("b");
  check(r === "granted", "requestControl with no driver → granted immediately");
  check(s.isDriver("b"), "granted: participant is now driver");
}

// --- yieldControl ---------------------------------------------------------

{
  const s = new Session();
  s.add("a", "Alice");
  s.add("b", "Bob");
  s.requestControl("b");
  const next = s.yieldControl("a");
  check(next === "b", "yield passes control to queue head");
  check(s.isDriver("b"), "Bob is now driver after yield");
  check(!s.isDriver("a"), "Alice is no longer driver after yield");
}

{
  const s = new Session();
  s.add("a", "Alice");
  const next = s.yieldControl("a");
  check(next === null, "yield with empty queue → null driver");
  check(s.getDriverId() === null, "getDriverId null after yield to empty queue");
}

{
  const s = new Session();
  s.add("a", "Alice");
  s.add("b", "Bob");
  const prev = s.yieldControl("b"); // b is not driver
  check(prev === "a", "yieldControl by non-driver is noop, returns current driver");
  check(s.isDriver("a"), "driver unchanged after non-driver yield attempt");
}

// --- remove ---------------------------------------------------------------

{
  const s = new Session();
  s.add("a", "Alice");
  s.add("b", "Bob");
  s.requestControl("b");
  s.remove("a"); // driver leaves
  check(s.isDriver("b"), "driver disconnect promotes queue head");
  check(s.getDriverId() === "b", "getDriverId returns new driver after disconnect");
  check(!s.has("a"), "removed participant is gone");
}

{
  const s = new Session();
  s.add("a", "Alice");
  s.add("b", "Bob");
  s.add("c", "Carol");
  s.requestControl("b");
  s.requestControl("c");
  s.remove("a");
  check(s.isDriver("b"), "driver disconnect with multi-entry queue promotes head");
  s.remove("b");
  check(s.isDriver("c"), "second driver disconnect promotes next in queue");
}

{
  const s = new Session();
  s.add("a", "Alice");
  s.add("b", "Bob");
  s.remove("a"); // driver leaves, no one queued
  check(s.getDriverId() === null, "driver disconnect with empty queue → no driver");
}

{
  const s = new Session();
  s.add("a", "Alice");
  s.add("b", "Bob");
  s.remove("b"); // observer leaves
  check(s.isDriver("a"), "observer disconnect does not affect driver");
  check(!s.has("b"), "observer removed from session");
  check(s.snapshot().length === 1, "snapshot reflects observer removal");
}

{
  const s = new Session();
  s.add("a", "Alice");
  s.add("b", "Bob");
  s.add("c", "Carol");
  s.requestControl("c");
  s.remove("c"); // queued participant leaves
  check(s.isDriver("a"), "queued participant disconnect does not affect driver");
  check(s.snapshot().find(p => p.id === "c") === undefined, "departed queued participant not in snapshot");
}

// --- driverEligible=false (observer capability) ---------------------------

{
  // Observer joins an EMPTY session — must not become driver.
  const s = new Session();
  check(s.add("obs", "Carol", false) === false, "observer in empty session: add returns false");
  check(s.getDriverId() === null, "observer in empty session: driverId stays null");
  check(!s.isDriver("obs"), "observer in empty session: isDriver false");
  check(s.has("obs"), "observer in empty session: participant is still added");
}

{
  // Control user joining after an observer gets the driver seat normally.
  const s = new Session();
  s.add("obs", "Carol", false);
  check(s.add("ctrl", "Alice", true) === true, "control joiner after observer becomes driver");
  check(s.isDriver("ctrl"), "control joiner is driver");
  check(s.getDriverId() === "ctrl", "getDriverId returns control joiner");
}

{
  // Multiple observers joining an empty session — none become driver.
  const s = new Session();
  s.add("obs1", "Carol", false);
  s.add("obs2", "Dan", false);
  check(s.getDriverId() === null, "multiple observers: driverId still null");
  // Control user joins — takes the empty seat.
  check(s.add("ctrl", "Alice", true) === true, "control user takes empty driver seat");
  check(s.isDriver("ctrl"), "control user is driver after multiple observers");
}

{
  // Observer can still request_control and be granted if seat is empty.
  // (requestControl has no eligibility gate — daemon enforces that separately.)
  const s = new Session();
  s.add("obs", "Carol", false);
  const r = s.requestControl("obs");
  check(r === "granted", "observer requestControl on empty seat: granted by session (daemon gates this)");
}

// --- final ----------------------------------------------------------------

console.log("");
if (failures === 0) {
  console.log("All session checks passed.");
} else {
  console.log(`${failures} check(s) failed.`);
  process.exit(1);
}
