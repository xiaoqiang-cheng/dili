import type { Session } from '../shared/types.ts';

/**
 * Idle sleep is opt-in and off by default: stopping a managed process discards
 * only its in-memory context, never the native history, so a contact can be
 * resumed by ID afterwards. Waiting states never qualify — the person owes the
 * agent an answer, and silently stopping it would hide that reminder.
 */
export const IDLE_SLEEP_ENV = 'SESSIONDECK_IDLE_SLEEP_MINUTES';
export const IDLE_SLEEP_MAX_MINUTES = 24 * 60;

export function idleSleepMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[IDLE_SLEEP_ENV];
  if (raw === undefined || raw.trim() === '') return 0;
  if (!/^\d+$/.test(raw.trim())) return 0;
  const minutes = Number(raw.trim());
  return Number.isSafeInteger(minutes) && minutes > 0 && minutes <= IDLE_SLEEP_MAX_MINUTES ? minutes : 0;
}

export type SleepCandidate = Pick<Session, 'running' | 'archived' | 'forkPending' | 'status' | 'lastActivity'>;

export function shouldSleep(session: SleepCandidate, now: number, minutes: number): boolean {
  if (!Number.isSafeInteger(minutes) || minutes <= 0) return false;
  if (!session.running || session.archived || session.forkPending) return false;
  // Only a settled idle process sleeps. Running, waiting and error states are
  // evidence that the contact still needs attention.
  if (session.status !== 'idle') return false;
  const activity = Date.parse(session.lastActivity);
  if (!Number.isFinite(activity)) return false;
  return now - activity >= minutes * 60_000;
}
