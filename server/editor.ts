import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * Opening a workspace in a desktop editor. Dili only asks the editor's own CLI
 * to open one directory: the folder opens where the user already works, with
 * their own settings and extensions. Nothing is written and no shell is
 * involved, so a path can never become a command.
 */

/** VS Code first: its `code` command also handles Remote-WSL, where the CLI
 * forwards to the Windows window instead of starting a second server. */
const DEFAULT_COMMANDS = ['code', 'code-insiders'];

/** One executable (or absolute path) that replaces the default lookup. */
export const EDITOR_ENV = 'SESSIONDECK_EDITOR_COMMAND';

/** How long to wait for the CLI to report a result before calling it started. */
const EXIT_TIMEOUT_MS = 10_000;
const MAX_STDERR = 4000;

/** Launching failed, or the editor exited with an error. The message is shown
 * to the user as-is, so it must say what is wrong on this machine. */
export class EditorUnavailableError extends Error {}

export interface EditorLaunch {
  command: string;
  path: string;
  /** `running`: the CLI is still alive after the timeout. That is not proof the
   * window opened, so the caller must not claim more than "requested". */
  state: 'exited' | 'running';
  exitCode?: number | null;
}

function isExecutableFile(file: string) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** First executable on PATH, resolved without spawning anything. */
export function findOnPath(names: string[], env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const name of names) {
    const value = name.trim();
    if (!value) continue;
    // An absolute path is a configuration, not a PATH lookup.
    if (isAbsolute(value)) {
      if (isExecutableFile(value)) return value;
      continue;
    }
    for (const dir of dirs) {
      const candidate = join(dir, value);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** The command Dili would start, or null when this machine has none. */
export function resolveEditorCommand(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env[EDITOR_ENV]?.trim();
  return findOnPath(configured ? [configured] : DEFAULT_COMMANDS, env);
}

/** A readable reason for the honest failure, including what was looked for. */
export function editorMissingMessage(env: NodeJS.ProcessEnv = process.env) {
  const configured = env[EDITOR_ENV]?.trim();
  return configured
    ? `本机无法执行 ${EDITOR_ENV}（${configured}）。请确认它是可执行文件的完整路径。`
    : '本机未找到 code 命令。安装 VS Code 并在其中执行「Shell Command: Install \'code\' command in PATH」，或用 SESSIONDECK_EDITOR_COMMAND 指定编辑器命令。';
}

/**
 * Starts the editor for one directory. The child is detached and unref'd, so
 * closing Dili never closes the window and the window never holds Dili's stdio.
 */
export async function openInEditor(cwd: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = EXIT_TIMEOUT_MS): Promise<EditorLaunch> {
  let isDirectory = false;
  try { isDirectory = statSync(cwd).isDirectory(); } catch { /* reported below */ }
  if (!isDirectory) throw Object.assign(new EditorUnavailableError('工作目录不存在或无法访问'), { status: 404 });
  const command = resolveEditorCommand(env);
  if (!command) throw Object.assign(new EditorUnavailableError(editorMissingMessage(env)), { status: 501 });

  const child = spawn(command, [cwd], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < MAX_STDERR) stderr += chunk.toString('utf8'); });

  // Only the CLI's own report counts: a spawn that never produced a result
  // stays `running`, which the UI words as "requested", not "opened".
  const outcome = await new Promise<{ kind: 'error'; error: Error } | { kind: 'exit'; code: number | null } | { kind: 'running' }>(resolve => {
    const timer = setTimeout(() => resolve({ kind: 'running' }), timeoutMs);
    timer.unref();
    child.once('error', (error) => { clearTimeout(timer); resolve({ kind: 'error', error }); });
    child.once('exit', (code) => { clearTimeout(timer); resolve({ kind: 'exit', code }); });
  });

  if (outcome.kind === 'error') {
    child.removeAllListeners();
    throw Object.assign(new EditorUnavailableError(`无法启动 ${command}：${outcome.error.message}`), { status: 501 });
  }
  if (outcome.kind === 'running') {
    child.stderr?.removeAllListeners();
    child.unref();
    return { command, path: cwd, state: 'running' };
  }
  child.unref();
  if (outcome.code !== 0) {
    const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
    throw Object.assign(new EditorUnavailableError(`${command} 未能打开工作区（退出码 ${outcome.code ?? '未知'}）${detail ? `：${detail}` : ''}`), { status: 501 });
  }
  return { command, path: cwd, state: 'exited', exitCode: 0 };
}
