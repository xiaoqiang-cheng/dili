import type { Backend } from './types.ts';

export type ExecutionMode = 'default' | 'auto';
export const AUTO_MODE_NOTE: Record<Backend, string> = {
  claude: 'Claude 原生 Auto 自动审核工具操作；部分操作仍可能需要你确认。',
  codex: 'Codex 自动审核审批请求，并使用工作目录可写沙箱。',
  dsh: 'DeepSeek Harness 0.2 没有原生 Auto 权限预设；请使用原生默认权限，或在原生设置中选择具体预设。',
};
export function executionMode(value: unknown): ExecutionMode {
  if (value === undefined) return 'default';
  if (value !== 'default' && value !== 'auto') throw Object.assign(new Error('执行模式仅支持 default 或 auto'), { status: 400 });
  return value;
}

/** dsh contacts are attached either through the native Web session or dsh-tui.
 * The native Web delivery path (`session.prompt`) is only valid for the former. */
export function dshWebTransport(item: { backend: Backend; executionTransport?: string }): boolean {
  return item.backend === 'dsh' && item.executionTransport === 'web';
}
