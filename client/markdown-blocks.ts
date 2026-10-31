/**
 * Splits streamed Markdown at boundaries that cannot change the rendered
 * structure: a blank line directly before a heading or a fenced block, outside
 * any fence. Lists, tables, blockquotes and reference definitions stay whole,
 * so splitting never restarts numbering or drops a link target.
 */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function splitMarkdownBlocks(text: string): string[] {
  if (!text.includes('\n')) return text.trim() ? [text] : [];
  const lines = text.split('\n');
  const blocks: string[] = [];
  let start = 0;
  let fence: string | null = null;
  const push = (end: number) => {
    const block = lines.slice(start, end).join('\n');
    if (block.trim()) blocks.push(block);
    start = end;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence || line.trim() !== '' || index + 1 >= lines.length) continue;
    const next = lines[index + 1];
    // The blank line itself is only a separator: start the next block at the
    // heading/fence so every block reads as a standalone document.
    if (/^ {0,3}#{1,6} /.test(next) || FENCE.test(next)) { push(index); start = index + 1; }
  }
  if (start < lines.length) push(lines.length);
  return blocks.length ? blocks : (text.trim() ? [text] : []);
}
