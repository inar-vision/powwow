import { ParticipantInfo } from "./protocol";

interface Participant {
  id: string;
  name: string;
}

/**
 * Pure turn-taking + presence state. No I/O, so it is trivially unit-testable.
 *
 * Rules:
 *  - The first participant to join becomes the driver.
 *  - If there is no driver, requesting control grants it immediately.
 *  - If someone else is driving, a request is queued (FIFO) and the driver is
 *    notified. The driver yields to hand control to the next in the queue.
 *  - When the driver leaves, control passes to the next in the queue (or nobody).
 */
export class Session {
  private participants = new Map<string, Participant>();
  private order: string[] = []; // join order, for stable presence listing
  private queue: string[] = []; // ids waiting for control, FIFO
  private driverId: string | null = null;

  getDriverId(): string | null {
    return this.driverId;
  }

  isDriver(id: string): boolean {
    return this.driverId === id;
  }

  has(id: string): boolean {
    return this.participants.has(id);
  }

  /**
   * Returns true if this participant became the driver on join.
   * Pass driverEligible=false (observer-capability connections) to prevent
   * auto-assignment of the driver seat even when the session is empty.
   */
  add(id: string, name: string, driverEligible = true): boolean {
    if (this.participants.has(id)) return this.driverId === id;
    this.participants.set(id, { id, name });
    this.order.push(id);
    if (driverEligible && this.driverId === null) {
      this.driverId = id;
      return true;
    }
    return false;
  }

  remove(id: string): void {
    this.participants.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.queue = this.queue.filter((x) => x !== id);
    if (this.driverId === id) {
      this.driverId = this.queue.shift() ?? null;
    }
  }

  /**
   * A participant asks to drive.
   * Returns "granted" if they became the driver now, "queued" if they were added
   * to the wait list, or "noop" if they already drive or already wait.
   */
  requestControl(id: string): "granted" | "queued" | "noop" {
    if (!this.participants.has(id)) return "noop";
    if (this.driverId === id) return "noop";
    if (this.driverId === null) {
      this.driverId = id;
      this.queue = this.queue.filter((x) => x !== id);
      return "granted";
    }
    if (this.queue.includes(id)) return "noop";
    this.queue.push(id);
    return "queued";
  }

  /**
   * The current driver yields. Control passes to the next waiting participant,
   * or to nobody if the queue is empty. Returns the new driver id (or null).
   * No-op (returns current driver) if a non-driver calls it.
   */
  yieldControl(id: string): string | null {
    if (this.driverId !== id) return this.driverId;
    this.driverId = this.queue.shift() ?? null;
    return this.driverId;
  }

  snapshot(): ParticipantInfo[] {
    return this.order.map((id) => {
      const p = this.participants.get(id)!;
      return {
        id: p.id,
        name: p.name,
        isDriver: this.driverId === id,
        requestingControl: this.queue.includes(id),
      };
    });
  }
}
