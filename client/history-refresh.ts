/** Serialize refreshes without discarding a slow response when another update arrives. */
export function historyRefresh(run: () => Promise<void>, onError: (error: unknown) => void) {
  let running = false, pending = false, stopped = false;
  return {
    request() {
      if (stopped) return;
      pending = true;
      if (running) return;
      running = true;
      void (async () => {
        try {
          while (pending && !stopped) {
            pending = false;
            try { await run(); } catch (error) { if (!stopped) onError(error); }
          }
        } finally { running = false; }
      })();
    },
    stop() { stopped = true; pending = false; },
  };
}

/** Hook-local reading cache: never shared between owner and share applications. */
export class HistoryCache<T> {
  private entries = new Map<string, { value: T; size: number; at: number }>();
  get(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > 600_000) { this.entries.delete(key); return null; }
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  put(key: string, value: T) {
    this.entries.delete(key);
    const size = JSON.stringify(value).length;
    if (size > 500_000) return;
    this.entries.set(key, { value, size, at: Date.now() });
    let total = [...this.entries.values()].reduce((sum, entry) => sum + entry.size, 0);
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= 8 && total <= 2_000_000) break;
      this.entries.delete(id); total -= entry.size;
    }
  }
}
