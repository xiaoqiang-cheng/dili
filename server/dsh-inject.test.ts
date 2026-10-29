import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dshInjectSocketPath, submitDshInject, waitForDshInject } from './dsh-inject.ts';

test('dsh inject submits append then prompt.submit over the session socket', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-inject-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const nativeId = 'session-11111111-1111-4111-8111-111111111111';
  const socketPath = dshInjectSocketPath(nativeId, home);
  await mkdir(join(home, 'inject'), { recursive: true });

  const received: string[] = [];
  const server = createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        received.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    });
  });
  await new Promise<void>(accept => server.listen(socketPath, accept));
  t.after(() => new Promise<void>(accept => server.close(() => accept())));

  await submitDshInject(nativeId, '  协作探测\n第二行  ', home);
  assert.deepEqual(received, [
    JSON.stringify({ type: 'prompt.append', text: '协作探测\n第二行' }),
    JSON.stringify({ type: 'command.execute', command: 'prompt.submit' }),
  ]);
});

test('waitForDshInject times out when the TUI never mounts', async () => {
  await assert.rejects(waitForDshInject('session-missing', 50, join(tmpdir(), 'dsh-inject-absent')), /注入通道未打开/);
});
