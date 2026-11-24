/** "<contact> · <topic>", within the 120-character contact name limit. */
export function forkTitle(source: string, topic: string): string {
  const title = `${source} · ${topic}`;
  return title.length > 120 ? `${title.slice(0, 119)}…` : title;
}
