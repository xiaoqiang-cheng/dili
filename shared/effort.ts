import type { AgentChatChoice } from './chat.ts';

/** Display names for effort ids the three backends are known to report. The
 * id stays the native value; unknown ids are shown as reported, never mapped. */
const EFFORT_LABELS: Record<string, string> = {
  off: '关闭', none: '无', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', ultra: '极限',
};

export function effortLabel(id: string): string {
  const label = EFFORT_LABELS[id.toLowerCase()];
  return label ? `${label}（${id}）` : id;
}

/** Native effort ids for one model, de-duplicated in native order. */
export function effortChoices(levels: readonly { id: string; description?: string; name?: string }[]): AgentChatChoice[] {
  const seen = new Set<string>();
  return levels.flatMap(level => {
    if (typeof level.id !== 'string' || !level.id || level.id.length > 64 || seen.has(level.id)) return [];
    seen.add(level.id);
    const label = EFFORT_LABELS[level.id.toLowerCase()] ? effortLabel(level.id) : level.name || level.id;
    return [{ id: level.id, label, ...(level.description ? { description: level.description } : {}) }];
  });
}

/** Shown when the native session reports no explicit effort: the model's
 * default applies. Names the default only when the native catalog reported it. */
export function defaultEffortLabel(defaultEffort?: string | null): string {
  return defaultEffort ? `模型默认：${effortLabel(defaultEffort)}` : '模型默认';
}
