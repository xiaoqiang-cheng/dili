import { access, stat } from 'node:fs/promises';
import { constants, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkPty } from '../server/pty-health.ts';
import { getBackendInfo } from '../server/adapters.ts';
import { existingDataDir, resolveDataDir } from '../server/data-dir.ts';

// Read-only checks plus a short-lived local PTY. No agent is started and no model is called.
type Check = { label: string; state: 'ok' | 'warn' | 'error'; detail: string };
const checks: Check[] = [];
const dataDir = existingDataDir();
const canonicalDataDir = resolveDataDir();
const port = Number(process.env.PORT || process.env.SESSIONDECK_PORT || 4317);
checks.push({ label: 'Node.js', state: Number(process.versions.node.split('.')[0]) >= 24 ? 'ok' : 'error', detail: process.version });

try {
  let candidate = dataDir;
  while (true) {
    try {
      if (!(await stat(candidate)).isDirectory()) throw new Error('路径不是目录');
      await access(candidate, constants.W_OK | constants.X_OK);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || candidate === dirname(candidate)) throw error;
      candidate = dirname(candidate);
    }
  }
  checks.push({ label: '本地数据目录', state: 'ok', detail: dataDir === canonicalDataDir ? dataDir : `${dataDir}；服务下次启动会迁移到 ${canonicalDataDir}` });
} catch (error) { checks.push({ label: '本地数据目录', state: 'error', detail: `${dataDir}：${error instanceof Error ? error.message : '无法访问'}` }); }

try {
  await checkPty();
  checks.push({ label: '原生终端', state: 'ok', detail: 'node-pty 可以启动本地进程并读取输出' });
} catch (error) { checks.push({ label: '原生终端', state: 'error', detail: error instanceof Error ? error.message : String(error) }); }

for (const backend of await getBackendInfo()) checks.push({
  label: backend.label,
  state: backend.installed ? 'ok' : 'warn',
  detail: backend.installed ? `${backend.version || '已发现命令'}；恢复 ${backend.capabilities.resume ? '可用' : '未确认'}，Fork ${backend.capabilities.fork ? '可用' : '未确认'}` : '未找到命令；安装后在网页“连接与能力”中刷新',
});

try {
  const response = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(2000) });
  const state = await response.json() as { sessions?: unknown[]; groups?: unknown[]; demo?: boolean };
  if (!response.ok || !Array.isArray(state.sessions) || !Array.isArray(state.groups)) throw new Error('端口上运行的服务不是可用的 Dili');
  checks.push({ label: 'Web 服务', state: 'ok', detail: `http://127.0.0.1:${port}${state.demo ? '（演示模式）' : ''}` });
  // A renamed or moved project leaves contacts pointing at the old directory;
  // starting them would fail, so surface it here instead of per contact.
  const workspaces = new Set<string>();
  for (const entry of [...state.sessions, ...state.groups]) {
    const value = entry as { cwd?: unknown; workspace?: unknown } | null;
    for (const path of [value?.cwd, value?.workspace]) {
      if (typeof path !== 'string' || !path) continue;
      try { if (!statSync(path).isDirectory()) workspaces.add(path); }
      catch { workspaces.add(path); }
    }
  }
  if (workspaces.size) {
    const listed = [...workspaces].slice(0, 3).join('、');
    checks.push({ label: '工作目录', state: 'warn', detail: `${workspaces.size} 个目录不存在：${listed}${workspaces.size > 3 ? ' 等' : ''}；源码目录改名或移动后，用 npm run repair:workspaces -- --from <旧目录> --to <新目录> 预览修复` });
  } else checks.push({ label: '工作目录', state: 'ok', detail: '联系人与群组的工作目录都存在' });
} catch { checks.push({ label: 'Web 服务', state: 'warn', detail: `当前未连接；运行 dili；源码安装可构建后 npm start（端口 ${port}）` }); }

console.log('Dili 本地环境检查\n');
for (const check of checks) console.log(`${check.state === 'ok' ? '✓' : check.state === 'warn' ? '·' : '✗'} ${check.label}：${check.detail}`);
console.log('\n这里只检查本地运行条件，不检查账号凭据或调用模型。');
process.exitCode = checks.some(check => check.state === 'error') ? 1 : 0;
