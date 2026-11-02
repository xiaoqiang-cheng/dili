/**
 * The single message table for Dili's own UI. Only zh-CN ships today; this is
 * the foundation for new locales, not a translation framework. New strings in
 * changed areas belong here (see docs/agents/i18n.md). Placeholders are plain
 * `{name}` substitutions and never HTML.
 */
export const zh = {
  'share.read': '只读',
  'share.write': '协作',
  'share.full': '全部',
  'share.readNote': '查看消息和状态，不能操作。',
  'share.writeNote': '发送消息、指派任务、处理审批，预览当前工作区和允许的网页服务。Agent 可以执行命令，请仅分享给可信的人。',
  'share.fullNote': '包含协作全部能力，并允许使用原生终端。',
  'share.web': '网页预览',
  'share.webEmpty': '尚未配置允许预览的网页服务。',
  'share.files': '当前工作区',
  'common.copy': '复制',
  'common.copied': '已复制',
  'common.close': '关闭',
  'common.refresh': '刷新',
  'common.retry': '重试',
  'common.loading': '正在加载…',
  'usage.title': '用量',
  'usage.turns': '{n} 轮',
  'usage.input': '输入 {value}',
  'usage.output': '输出 {value}',
  'usage.cacheRead': '缓存读 {value}',
  'usage.context': '上下文约 {value}',
  'usage.partial': '最近窗口',
  'usage.unknown': '原生未提供',
  'usage.pending': '读取中…',
  'usage.remoteNotice': '用量来自本地原生历史，未上传。',
  'session.export': '导出对话 HTML',
  'session.exporting': '正在生成导出文件…',
  'session.exported': '已导出对话 HTML',
  'session.exportEmpty': '没有可导出的对话记录',
  'debug.title': '运行诊断',
  'debug.subtitle': '只读快照，不包含会话正文或凭据。',
  'debug.copy': '复制诊断信息',
  'debug.refresh': '刷新诊断信息',
  'debug.unavailable': '诊断信息暂不可用',
  'settings.idleSleep': '闲置休眠',
  'settings.idleSleepOff': '关闭（默认）',
  'settings.idleSleepNote': '超过设定时间没有活动的托管会话会自动停止，原生历史与会话身份保留，可随时恢复。',
} as const;

export type MessageKey = keyof typeof zh;
export type MessageParams = Record<string, string | number>;
export const DEFAULT_LOCALE = 'zh-CN';
export const SUPPORTED_LOCALES = ['zh-CN'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Unmatched placeholders remain visible so a missing parameter is obvious. */
export function formatMessage(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

export function t(key: MessageKey, params?: MessageParams): string {
  return formatMessage(zh[key], params);
}

/** Keys missing from another locale; used when a second locale is added. */
export function missingKeys(candidate: Partial<Record<MessageKey, string>>): MessageKey[] {
  return (Object.keys(zh) as MessageKey[]).filter(key => typeof candidate[key] !== 'string' || !candidate[key]!.trim());
}
