import type { RelayPairing } from '../shared/pairing.ts';
import type { RelayNotice } from './relay-notices.ts';

/** Long-polls the relay for notices its admin sent to this device. Runs only while
 * the device is paired and its relay connection is enabled; the relay holds each
 * request open until a notice arrives or ~25 s pass. */
export class RelayNoticePoller {
  private closed = false;
  private abort = new AbortController();
  private after = 0;
  private running: Promise<void> | null = null;
  constructor(private readonly pairing: () => RelayPairing | null, private readonly deliver: (notices: RelayNotice[]) => void, private readonly fetcher: typeof fetch = fetch) {}

  start() { this.running ??= this.loop(); }
  /** Re-check the pairing now instead of after the current wait (e.g. just paired). */
  wake() { this.abort.abort(); }
  async close() { this.closed = true; this.abort.abort(); await this.running; }

  private async loop() {
    while (!this.closed) {
      this.abort = new AbortController();
      const pair = this.pairing();
      if (!pair) { await this.sleep(15_000); continue; }
      try {
        const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(45_000)]);
        const response = await this.fetcher(`${pair.serverUrl}/api/devices/${pair.deviceId}/notices?after=${this.after}`, { redirect: 'error', signal, headers: { authorization: `Bearer ${pair.credential}` } });
        // A revoked credential or a relay without this endpoint: check back rarely.
        if (response.status === 401 || response.status === 404) { await this.sleep(10 * 60_000); continue; }
        if (!response.ok) { await this.sleep(10_000); continue; }
        const { notices } = await response.json() as { notices?: RelayNotice[] };
        if (Array.isArray(notices) && notices.length) {
          this.after = Math.max(this.after, ...notices.map(notice => notice.id));
          this.deliver(notices);
        }
      } catch { if (!this.closed) await this.sleep(10_000); }
    }
  }
  private sleep(ms: number) {
    if (this.closed || this.abort.signal.aborted) return Promise.resolve();
    return new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, ms);
      this.abort.signal.addEventListener('abort', done, { once: true });
    });
  }
}
