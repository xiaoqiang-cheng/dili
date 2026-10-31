import { lazy, Suspense, memo, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import type { PluggableList } from 'unified';
import { copyToClipboard } from './clipboard';
import { splitMarkdownBlocks } from './markdown-blocks';
import 'highlight.js/styles/github.css';
import './markdown.css';

const MermaidDiagram = lazy(() => import('./MermaidDiagram'));
/** Below this size a message parses as one document; above it, sections split so a
 * long stream cannot block the main thread on one giant reconciliation. */
const BLOCK_SPLIT_THRESHOLD = 4000;

type Highlighter = typeof import('rehype-highlight').default;
let highlightPromise: Promise<Highlighter> | undefined;
/** Highlighting is a presentation enhancement: load it only when a fence exists. */
function loadHighlighter(): Promise<Highlighter> {
  highlightPromise ??= import('rehype-highlight').then(module => module.default);
  return highlightPromise;
}

function safeLink(value: string) {
  if (/^https?:\/\//i.test(value) || /^mailto:/i.test(value) || /^#[\w-]+$/.test(value)) return value;
  return '';
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [result, setResult] = useState('');
  return <div className="markdown-code"><button type="button" aria-label="复制代码" title={result || '复制代码'} onClick={async () => {
    try { await copyToClipboard(ref.current?.textContent ?? ''); setResult('已复制'); }
    catch { setResult('无法复制，请选中代码后复制'); }
  }}>{result === '已复制' ? <Check size={13} /> : <Copy size={13} />}<span>{result || '复制'}</span></button><pre ref={ref}>{children}</pre></div>;
}

/** Native text is untrusted: no raw HTML, executable URLs or remote image loads. */
const Markdown = memo(function Markdown({ text, onToggleTask }: { text: string; onToggleTask?: (offset: number, checked: boolean) => void }) {
  const [highlight, setHighlight] = useState<Highlighter | null>(null);
  const needsHighlight = text.includes('```');
  useEffect(() => {
    if (!needsHighlight || highlight) return;
    let live = true;
    const start = () => { void loadHighlighter().then(plugin => { if (live) setHighlight(() => plugin); }).catch(() => { /* plain code stays readable */ }); };
    // Safari 16 has no requestIdleCallback; a zero-delay timer is the fallback.
    const idle = window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number; cancelIdleCallback?: (handle: number) => void };
    const handle = idle.requestIdleCallback ? idle.requestIdleCallback(start, { timeout: 1500 }) : window.setTimeout(start, 0);
    const cancelIdle = idle.cancelIdleCallback;
    return () => {
      live = false;
      if (cancelIdle) cancelIdle(handle); else window.clearTimeout(handle);
    };
  }, [needsHighlight, highlight]);
  const rehypePlugins: PluggableList = highlight ? [[highlight, { detect: false }]] : [];
  // Task offsets refer to the whole message, so only split messages that cannot
  // be edited through the input callback.
  const blocks = text.length > BLOCK_SPLIT_THRESHOLD && !onToggleTask ? splitMarkdownBlocks(text) : [text];
  return <div className="chat-markdown">{blocks.map((block, index) => <ReactMarkdown key={index} remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins} skipHtml urlTransform={safeLink} components={{
    a: ({ href, children }) => href ? <a href={href} target={href.startsWith('#') ? undefined : '_blank'} rel="noreferrer noopener">{children}</a> : <span>{children}</span>,
    img: ({ alt }) => <span className="markdown-image-label">[图片{alt ? `：${alt}` : ''}]</span>,
    pre: ({ children, node }) => {
      const code = node?.children[0];
      if (code?.type === 'element' && code.tagName === 'code' && (code.properties.className as string[] | undefined)?.includes('language-mermaid')) {
        const source = code.children.map(child => child.type === 'text' ? child.value : '').join('');
        return <Suspense fallback={<CodeBlock>{children}</CodeBlock>}><MermaidDiagram source={source} /></Suspense>;
      }
      return <CodeBlock>{children}</CodeBlock>;
    },
    table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
    li: ({ node, children, ...props }) => <li {...props} onChange={onToggleTask ? event => {
      if (!(event.target instanceof HTMLInputElement) || event.target.closest('li') !== event.currentTarget || node?.position?.start.offset === undefined) return;
      onToggleTask(node.position.start.offset, event.target.checked);
    } : undefined}>{children}</li>,
    input: ({ node: _node, ...props }) => <input {...props} disabled={onToggleTask ? false : props.disabled} onChange={onToggleTask ? () => {} : undefined} aria-label={onToggleTask ? '标记待办完成' : undefined} />,
  }}>{block}</ReactMarkdown>)}</div>;
});
export default Markdown;
