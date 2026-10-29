/** A notice the relay admin sends to one device. The device's Dili long-polls for
 * them with its credential and shows them on its open pages. */
export interface RelayNotice { id: number; text: string; createdAt: string }

const KEEP_MS = 24 * 3600_000, KEEP_COUNT = 20;
export const NOTICE_MAX_LENGTH = 500;

/** In memory: a notice waits up to a day for its device, then is dropped. Ids grow
 * with the clock, so a device's last acknowledged id stays valid across restarts. */
export class RelayNotices {
  private queues = new Map<string, RelayNotice[]>();
  private waiters = new Map<string, Set<() => void>>();
  private last = 0;
  constructor(private readonly now = () => Date.now()) {}

  push(deviceId: string, text: string): RelayNotice {
    const notice = { id: this.last = Math.max(this.last + 1, this.now()), text, createdAt: new Date(this.now()).toISOString() };
    this.queues.set(deviceId, [...this.pending(deviceId), notice].slice(-KEEP_COUNT));
    for (const wake of this.waiters.get(deviceId) ?? []) wake();
    return notice;
  }
  pending(deviceId: string): RelayNotice[] {
    const fresh = (this.queues.get(deviceId) ?? []).filter(notice => this.now() - Date.parse(notice.createdAt) < KEEP_MS);
    if (fresh.length) this.queues.set(deviceId, fresh); else this.queues.delete(deviceId);
    return fresh;
  }
  /** Drops everything up to `after` (the device has shown it), then returns what is
   * left, waiting up to `timeoutMs` for something new. */
  async take(deviceId: string, after: number, timeoutMs: number, signal?: AbortSignal): Promise<RelayNotice[]> {
    const left = this.pending(deviceId).filter(notice => notice.id > after);
    if (left.length) this.queues.set(deviceId, left); else this.queues.delete(deviceId);
    if (left.length || timeoutMs <= 0 || signal?.aborted) return left;
    await new Promise<void>(resolve => {
      const waiters = this.waiters.get(deviceId) ?? new Set<() => void>();
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); waiters.delete(done); if (!waiters.size) this.waiters.delete(deviceId); resolve(); };
      const timer = setTimeout(done, timeoutMs);
      signal?.addEventListener('abort', done);
      waiters.add(done); this.waiters.set(deviceId, waiters);
    });
    return this.pending(deviceId).filter(notice => notice.id > after);
  }
  /** Revoked devices never collect their notices. */
  forget(deviceId: string) { this.queues.delete(deviceId); }
}
