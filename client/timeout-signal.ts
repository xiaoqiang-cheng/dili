/**
 * Safari 16.2 has no AbortSignal.timeout, so a plain controller is the portable
 * equivalent. The timer is left to fire even after an early response: aborting
 * an already-settled fetch is a no-op and keeps the helper allocation-free.
 */
export function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  globalThis.setTimeout(() => controller.abort(), ms);
  return controller.signal;
}
