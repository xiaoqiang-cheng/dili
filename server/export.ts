import type { Session, ConversationTranscript } from '../shared/types.ts';
import { formatTokens } from '../shared/usage.ts';

const ROLE_LABEL = { user: '用户', assistant: 'Agent' } as const;
const BACKEND_LABEL = { claude: 'Claude Code', codex: 'Codex', dsh: 'DeepSeek Harness' } as const;

/** Every native string is untrusted: escape before it reaches the document. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

const STYLE = `:root{color-scheme:light dark;--bg:#ffffff;--text:#1f2328;--muted:#656d76;--line:#d8dee4;--user:#f6f8fa;--accent:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--text:#e6edf3;--muted:#8d96a0;--line:#30363d;--user:#161b22;--accent:#58a6ff}}
*{box-sizing:border-box}body{margin:0;padding:32px 20px;background:var(--bg);color:var(--text);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{max-width:860px;margin:0 auto}header{border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:24px}
h1{font-size:22px;margin:0 0 8px;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0;color:var(--muted);font-size:13px}dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere}
.usage{margin-top:10px;color:var(--muted);font-size:13px}
article{display:grid;grid-template-columns:64px 1fr;gap:14px;padding:16px 0;border-bottom:1px solid var(--line)}
article:last-of-type{border-bottom:0}.role{font-size:13px;font-weight:600;color:var(--muted)}.user .role{color:var(--accent)}
.text{white-space:pre-wrap;overflow-wrap:anywhere}.user .text{background:var(--user);border-radius:8px;padding:10px 12px}
time{display:block;color:var(--muted);font-size:12px;margin-top:10px}
footer{margin-top:28px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:14px}`;

export interface ExportInput {
  session: Pick<Session, 'title' | 'backend' | 'cwd' | 'nativeSessionId'>;
  transcript: ConversationTranscript;
  exportedAt?: Date;
}

export function renderConversationHtml({ session, transcript, exportedAt = new Date() }: ExportInput): string {
  const title = session.title || '未命名会话';
  const id = session.nativeSessionId;
  const usage = transcript.usage;
  const usageLine = usage
    ? `用量：${usage.turns} 轮 · 输入 ${formatTokens(usage.inputTokens)} · 输出 ${formatTokens(usage.outputTokens)}${usage.partial ? ' · 最近窗口' : ''}`
    : '';
  const messages = transcript.messages.map(message => `<article class="${message.role}"><div class="role">${ROLE_LABEL[message.role]}</div><div><div class="text">${escapeHtml(message.text)}</div>${message.createdAt ? `<time datetime="${escapeHtml(message.createdAt)}">${escapeHtml(new Date(message.createdAt).toLocaleString('zh-CN'))}</time>` : ''}</div></article>`).join('\n');
  const body = transcript.messages.length
    ? messages
    : `<p class="empty">${escapeHtml(transcript.notice || '没有可导出的对话记录。')}</p>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(title)} · Dili 对话导出</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
<h1>${escapeHtml(title)}</h1>
<dl>
<dt>后端</dt><dd>${BACKEND_LABEL[session.backend]}</dd>
<dt>工作目录</dt><dd>${escapeHtml(session.cwd)}</dd>
<dt>原生会话</dt><dd>${id ? escapeHtml(id) : '未识别'}</dd>
<dt>导出时间</dt><dd>${escapeHtml(exportedAt.toLocaleString('zh-CN'))}</dd>
</dl>
${usageLine ? `<p class="usage">${escapeHtml(usageLine)}</p>` : ''}
</header>
${body}
<footer>由 Dili 导出。此文件是原生会话记录的只读快照；完整上下文仍以原生 Agent 的会话文件为准。</footer>
</main>
</body>
</html>`;
}

export function exportFileName(title: string, now = new Date()): string {
  const safe = title.replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'conversation';
  const stamp = now.toISOString().slice(0, 10);
  return `${safe}-${stamp}.html`;
}
