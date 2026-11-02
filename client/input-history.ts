import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';

/** Where the user is while recalling earlier messages with ↑/↓, like a shell.
 * `index` points into the entries (oldest first); null means the live draft. */
export interface HistoryCursor { index: number | null; draft: string; recalled: string }
export const idleCursor: HistoryCursor = { index: null, draft: '', recalled: '' };

/** One ↑ or ↓ press. Returns null when the key should keep its normal meaning:
 * nothing to recall, already at the oldest entry, or not browsing for ↓. Editing a
 * recalled entry ends browsing, so the edited text becomes the new draft. */
export function historyStep(entries: readonly string[], cursor: HistoryCursor, direction: 'up' | 'down', text: string): { cursor: HistoryCursor; text: string } | null {
  const browsing = cursor.index !== null && text === cursor.recalled && cursor.index < entries.length;
  if (direction === 'up') {
    if (!entries.length) return null;
    const index = browsing ? cursor.index! - 1 : entries.length - 1;
    if (index < 0) return null;
    return { cursor: { index, draft: browsing ? cursor.draft : text, recalled: entries[index]! }, text: entries[index]! };
  }
  if (!browsing) return null;
  const index = cursor.index! + 1;
  if (index >= entries.length) return { cursor: idleCursor, text: cursor.draft };
  return { cursor: { ...cursor, index, recalled: entries[index]! }, text: entries[index]! };
}

/** The user's own sent messages, oldest first, without blanks or consecutive repeats. */
export function historyEntries(texts: Iterable<string>, limit = 100): string[] {
  const entries: string[] = [];
  for (const raw of texts) {
    const text = raw.trim();
    if (text && entries.at(-1) !== text) entries.push(text);
  }
  return entries.slice(-limit);
}

/** ↑ recalls only from the first line and ↓ only from the last, so moving the caret
 * inside a multi-line draft keeps working. Modified keys and IME input are left alone. */
export function historyKey(event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'> & { isComposing?: boolean }, value: string, start: number, end: number): 'up' | 'down' | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || start !== end) return null;
  if (event.key === 'ArrowUp') return value.lastIndexOf('\n', start - 1) === -1 ? 'up' : null;
  if (event.key === 'ArrowDown') return value.indexOf('\n', end) === -1 ? 'down' : null;
  return null;
}

/** Returns a keydown handler; it reports true when it consumed the key. `apply`
 * receives the text to show and the entry index (null for the restored draft). */
export function useInputHistory(scope: string, entries: readonly string[], text: string, apply: (value: string, index: number | null, previous: number | null) => void) {
  const cursor = useRef<HistoryCursor>(idleCursor);
  useEffect(() => { cursor.current = idleCursor; }, [scope]);
  return useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.defaultPrevented || event.nativeEvent.keyCode === 229) return false;
    const field = event.currentTarget;
    const direction = historyKey({ ...event, isComposing: event.nativeEvent.isComposing }, field.value, field.selectionStart, field.selectionEnd);
    if (!direction) return false;
    const step = historyStep(entries, cursor.current, direction, text);
    if (!step) return false;
    event.preventDefault();
    const previous = cursor.current.index;
    cursor.current = step.cursor;
    apply(step.text, step.cursor.index, previous);
    // Caret at the end, as a shell does after recalling a line.
    requestAnimationFrame(() => { field.setSelectionRange(field.value.length, field.value.length); });
    return true;
  }, [entries, text, apply]);
}

/** Messages typed into a terminal session's draft box. Terminal sessions have no
 * structured transcript in the page, so this browser keeps its own short list. */
const SENT_KEY = (scope: string) => `dili.sent-history.${scope}`;
export function readSentHistory(scope: string): string[] {
  try { const value = JSON.parse(localStorage.getItem(SENT_KEY(scope)) ?? '[]'); return Array.isArray(value) ? historyEntries(value.filter(item => typeof item === 'string'), 50) : []; }
  catch { return []; }
}
export function rememberSent(scope: string, text: string): string[] {
  const entries = historyEntries([...readSentHistory(scope), text], 50);
  try { localStorage.setItem(SENT_KEY(scope), JSON.stringify(entries)); } catch { /* history is a convenience */ }
  return entries;
}
