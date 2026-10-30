import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyToClipboard } from './clipboard';

/** Copy the original message, preserving whitespace and Markdown source. */
export default function MessageCopy({ text }: { text: string }) {
  const [result, setResult] = useState('');
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(''), result === '已复制' ? 2000 : 5000);
    return () => clearTimeout(timer);
  }, [result]);
  return <span className="chat-message-copy">
    <button type="button" className="icon-button" aria-label="复制消息" title="复制消息" disabled={!text} onClick={async () => {
      try { await copyToClipboard(text); setResult('已复制'); }
      catch { setResult('复制失败，请选中文字手动复制'); }
    }}>{result === '已复制' ? <Check size={13} /> : <Copy size={13} />}</button>
    <span role="status">{result}</span>
  </span>;
}
