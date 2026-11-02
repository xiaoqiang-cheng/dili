import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorize, matchRoute, ROUTES } from './access.ts';
import type { Principal } from './auth.ts';

const owner: Principal = { kind: 'owner', local: true };
type Share = Extract<Principal, { kind: 'share' }>;
const share = (overrides: Partial<Share> = {}): Principal => ({ kind: 'share', deviceId: 'd1', shareId: 'sh1', sessionId: 's1', mode: 'read', name: '同事', ...overrides });
const allowed = (principal: Principal | null, method: string, path: string, remote = false) => authorize(principal, remote, method, path);

test('unregistered API paths are absent instead of implicitly allowed', () => {
  for (const path of ['/api/unknown', '/api/sessions/s1/unknown', '/api/sessions/s1/export/extra']) {
    assert.deepEqual(allowed(owner, 'GET', path), { allowed: false, status: 404, error: '接口不存在' });
  }
});

test('the route table has no duplicate method and path pairs', () => {
  const seen = new Set<string>();
  for (const route of ROUTES) {
    const key = `${route.method} ${route.path}`;
    assert.ok(!seen.has(key), `duplicate route ${key}`);
    seen.add(key);
  }
});

test('host web proxy and native proxy are owner-only', () => {
  for (const [method, path] of [['POST', '/api/web-proxy'], ['GET', '/api/sessions/s1/native-proxy']] as const) {
    assert.equal(allowed(owner, method, path).allowed, true);
    assert.equal(allowed(share(), method, path).allowed, false);
    assert.equal(allowed(null, method, path).allowed, false);
  }
});

test('HEAD uses the GET registration and query-independent matching', () => {
  assert.ok(matchRoute('HEAD', '/api/state'));
  assert.equal(matchRoute('HEAD', '/api/state')?.route.method, 'GET');
  assert.ok(matchRoute('GET', '/api/sessions/s1/export'));
});

test('the export and usage routes are read-only and require a session share match', () => {
  for (const path of ['/api/sessions/s1/export', '/api/sessions/s1/usage']) {
    assert.equal(allowed(owner, 'GET', path).allowed, true);
    assert.equal(allowed(share(), 'GET', path).allowed, true);
    assert.equal(allowed(share({ sessionId: 's2' }), 'GET', path).allowed, false);
    assert.equal(allowed(share({ mode: 'read' }), 'POST', path).allowed, false);
    assert.deepEqual(allowed(null, 'GET', path), { allowed: false, status: 401, error: '请先登录' });
  }
});

test('diagnostics are owner-only even for a writable share', () => {
  assert.equal(allowed(owner, 'GET', '/api/debug').allowed, true);
  assert.deepEqual(allowed(share({ mode: 'write' }), 'GET', '/api/debug'), { allowed: false, status: 403, error: '分享链接无权执行此操作' });
  assert.equal(allowed(share({ mode: 'write', groupId: 'g1' }), 'GET', '/api/debug').allowed, false);
});

test('writes need a writable share while reads accept a read-only share', () => {
  assert.equal(allowed(share({ mode: 'write' }), 'POST', '/api/sessions/s1/read').allowed, true);
  assert.deepEqual(allowed(share({ mode: 'read' }), 'POST', '/api/sessions/s1/read'), { allowed: false, status: 403, error: '这是只读分享' });
  assert.equal(allowed(share({ mode: 'read' }), 'GET', '/api/sessions/s1/conversation').allowed, true);
});

test('local-only routes never pass the remote listener', () => {
  assert.equal(allowed(owner, 'POST', '/api/native-event/s1', false).allowed, true);
  assert.deepEqual(allowed(owner, 'POST', '/api/native-event/s1', true), { allowed: false, status: 403, error: '此操作只能在运行 SessionDeck 的电脑上进行' });
  assert.equal(allowed(owner, 'POST', '/api/auth/password', false).allowed, true);
  assert.equal(allowed(owner, 'POST', '/api/auth/password', true).allowed, false);
});

test('a group share cannot reach session APIs or another group', () => {
  const guest = share({ groupId: 'g1' });
  assert.equal(allowed(guest, 'GET', '/api/state').allowed, true);
  assert.equal(allowed(guest, 'GET', '/api/groups/g1').allowed, true);
  assert.equal(allowed(guest, 'GET', '/api/sessions/s1/conversation').allowed, false);
  assert.equal(allowed(guest, 'GET', '/api/groups/g2').allowed, false);
  assert.equal(allowed(guest, 'GET', '/api/debug').allowed, false);
});

test('anonymous visitors only reach public or read bootstrap routes', () => {
  assert.equal(allowed(null, 'POST', '/api/auth/login').allowed, true);
  assert.equal(allowed(null, 'GET', '/api/auth/status').allowed, true);
  assert.deepEqual(allowed(null, 'GET', '/api/state'), { allowed: false, status: 401, error: '请先登录' });
  assert.deepEqual(allowed(null, 'GET', '/api/debug'), { allowed: false, status: 401, error: '请先登录' });
});

test('three share tiers isolate previews, terminal input and unrelated resources', () => {
  for (const mode of ['read', 'write', 'full'] as const) {
    const guest = share({ mode });
    assert.equal(allowed(guest, 'GET', '/api/sessions/s1/workspace/tree').allowed, mode !== 'read');
    assert.equal(allowed(guest, 'GET', '/api/sessions/s1/web-previews').allowed, mode !== 'read');
    assert.equal(allowed(guest, 'POST', '/api/sessions/s1/input').allowed, mode === 'full');
    assert.equal(allowed(guest, 'POST', '/api/sessions/s1/terminal/image').allowed, mode === 'full');
    assert.equal(allowed(guest, 'GET', '/api/sessions/other/workspace/tree').allowed, false);
    assert.equal(allowed(guest, 'POST', '/api/shells').allowed, false);
    const group = share({ mode, groupId: 'g1', sessionId: '' });
    assert.equal(allowed(group, 'GET', '/api/groups/g1/workspace/tree').allowed, mode !== 'read');
    assert.equal(allowed(group, 'POST', '/api/groups/g1/web-previews').allowed, mode !== 'read');
    assert.equal(allowed(group, 'GET', '/api/groups/other/workspace/tree').allowed, false);
    assert.equal(allowed(group, 'GET', '/api/sessions/s1/workspace/tree').allowed, false);
  }
});
