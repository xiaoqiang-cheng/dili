/** Match the unfinished @ query at the caret; confirmed names are checked separately. */
export function shareMentionAt(text: string, caret: number) {
  const token = text.slice(0, caret).match(/@([^\s@]{0,80})$/);
  return token ? { query: token[1], start: caret - token[0].length, end: caret } : null;
}

export function hasShareMention(text: string, title: string) {
  const token = `@${title}`;
  let start = text.indexOf(token);
  while (start >= 0) {
    const next = text[start + token.length];
    if (next === undefined || /\s/.test(next)) return true;
    start = text.indexOf(token, start + token.length);
  }
  return false;
}
