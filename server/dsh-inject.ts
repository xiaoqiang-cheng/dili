import { access } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** dsh-tui publishes one Unix socket per mounted session for external prompt injection. */
export function dshInjectSocketPath(nativeSessionId: string, dataHome = process.env.DSH_TUI_HOME || join(homedir(), '.dsh-tui')): string {
  return join(dataHome, 'inject', `${nativeSessionId}.sock`);
}

async function sendLines(socketPath: string, lines: string[]): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else accept();
    };
    socket.setTimeout(5_000);
    socket.once('error', error => finish(error));
    socket.once('timeout', () => finish(new Error('dsh-tui 注入通道超时')));
    socket.once('connect', () => {
      socket.write(lines.map(line => `${line}\n`).join(''), 'utf8', () => {
        // Give the peer a turn to read before tearing down the socket; otherwise
        // a fast local server can observe an empty connection.
        setTimeout(() => finish(), 20);
      });
    });
  });
}

/** Wait until the live TUI exposes its inject socket (session mount finished). */
export async function waitForDshInject(nativeSessionId: string, timeoutMs = 8_000, dataHome?: string): Promise<string> {
  const socketPath = dshInjectSocketPath(nativeSessionId, dataHome);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(socketPath);
      return socketPath;
    } catch { /* not mounted yet */ }
    await delay(150);
  }
  throw new Error('原生终端尚未就绪（注入通道未打开），请稍候再发送或到「原生终端」确认会话已打开');
}

/**
 * Deliver text through dsh-tui's inject channel (same path as dsh.nvim).
 * Prefer this over PTY paste: GenUI focus / dialogs often swallow bracketed paste.
 */
export async function submitDshInject(nativeSessionId: string, text: string, dataHome?: string): Promise<void> {
  const trimmed = text.replace(/\r\n?/g, '\n').trim();
  if (!trimmed) throw new Error('消息不能为空');
  const socketPath = await waitForDshInject(nativeSessionId, 2_000, dataHome);
  await sendLines(socketPath, [
    JSON.stringify({ type: 'prompt.append', text: trimmed }),
    JSON.stringify({ type: 'command.execute', command: 'prompt.submit' }),
  ]);
}
