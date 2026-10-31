/**
 * Bounded replay window for state patches, so a reconnect behind a flaky
 * mobile network does not have to refetch the whole snapshot. `baseRevision`
 * chains each patch to the previous one: when the requested revision is older
 * than anything retained, the caller must fall back to a full snapshot.
 */
export interface ReplayChunk {
  revision: number;
  baseRevision: number;
  chunk: string;
}

export class SseReplayBuffer {
  private events: ReplayChunk[] = [];
  private bytes = 0;
  constructor(private readonly maxEvents = 200, private readonly maxBytes = 4 * 1024 * 1024) {}

  push(revision: number, baseRevision: number, chunk: string): void {
    if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(baseRevision) || revision <= baseRevision) return;
    const last = this.events.at(-1);
    // Revisions are monotonic; ignore a duplicate or out-of-order publish.
    if (last && revision <= last.revision) return;
    const size = Buffer.byteLength(chunk);
    if (size > this.maxBytes) return;
    this.events.push({ revision, baseRevision, chunk });
    this.bytes += size;
    while (this.events.length > this.maxEvents || this.bytes > this.maxBytes) {
      const removed = this.events.shift()!;
      this.bytes -= Buffer.byteLength(removed.chunk);
    }
  }

  /**
   * Patches to send after `revision`, or null when the caller must send a full
   * snapshot (window miss, chain gap, invalid id, or nothing retained).
   */
  after(revision: number): string[] | null {
    if (!Number.isSafeInteger(revision) || revision < 0) return null;
    const pending = this.events.filter(event => event.revision > revision);
    if (!pending.length) return null;
    // The first pending patch must continue exactly where the client stopped.
    if (pending[0].baseRevision > revision) return null;
    // Patches in between can only be replayed if the chain is intact.
    let cursor = revision;
    for (const event of pending) {
      if (event.baseRevision !== cursor) return null;
      cursor = event.revision;
    }
    return pending.map(event => event.chunk);
  }

  get size(): number { return this.events.length; }
  get latestRevision(): number { return this.events.at(-1)?.revision ?? 0; }
}
