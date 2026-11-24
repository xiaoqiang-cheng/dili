import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { FeishuChannel, feishuInbound } from './im/feishu.ts';
import { WeixinChannel, parseLossless, weixinInbound } from './im/weixin.ts';
import { FRAME_CONTROL, FRAME_DATA, decodeFrame, encodeFrame, header } from './im/pbbp2.ts';
import type { ImInbound } from './im/hub.ts';

const until = async (condition: () => boolean, label: string) => { for (let i = 0; i < 200; i++) { if (condition()) return; await delay(10); } assert.fail(label); };

test('pbbp2 frames round-trip, including full-width uint64 ids', () => {
  const frame = { SeqID: 18446744073709551615n, LogID: 42n, service: 7, method: FRAME_DATA, headers: [{ key: 'type', value: 'event' }, { key: '中文', value: '值' }], payload: new TextEncoder().encode('{"a":1}') };
  const back = decodeFrame(encodeFrame(frame));
  assert.deepEqual([back.SeqID, back.LogID, back.service, back.method, back.headers, new TextDecoder().decode(back.payload)], [frame.SeqID, 42n, 7, 1, frame.headers, '{"a":1}']);
  assert.throws(() => decodeFrame(Uint8Array.from([0x0a, 0x05, 0x01])), /帧格式无效/);
});

test('Feishu events become inbound messages; mentions decide group delivery', () => {
  const event = (chat_type: string, text: string, mentions: unknown[] = []) => ({ header: { event_type: 'im.message.receive_v1', event_id: 'ev1' }, event: { sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' }, message: { message_id: 'om1', chat_id: 'oc1', chat_type, message_type: 'text', content: JSON.stringify({ text }), mentions } } });
  assert.deepEqual(feishuInbound(event('p2p', ' 你好 ')), { channel: 'feishu', chatId: 'oc1', senderId: 'ou_user', messageId: 'ev1', text: '你好', group: false, mentioned: true });
  const mentioned = feishuInbound(event('group', '@_user_1 看下进度', [{ key: '@_user_1', id: { open_id: 'ou_bot' } }]), 'ou_bot')!;
  assert.deepEqual([mentioned.text, mentioned.group, mentioned.mentioned], ['看下进度', true, true]);
  assert.equal(feishuInbound(event('group', '大家好'), 'ou_bot')!.mentioned, false);
  assert.equal(feishuInbound({ header: { event_type: 'im.chat.updated_v1' } }), null);
});

test('Feishu long connection: endpoint, ping, ACKed events and replies', async t => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>(resolve => wss.once('listening', () => resolve()));
  const port = (wss.address() as { port: number }).port;
  const frames: ReturnType<typeof decodeFrame>[] = [];
  const sentMessages: unknown[] = [];
  const received: ImInbound[] = [];
  let pushEvent!: (data: Uint8Array) => void;
  wss.on('connection', socket => {
    socket.on('message', (data: Buffer) => frames.push(decodeFrame(new Uint8Array(data))));
    pushEvent = data => socket.send(data);
  });
  const fetcher = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/callback/ws/endpoint') { assert.deepEqual(JSON.parse(String(init!.body)), { AppID: 'cli_testapp12345', AppSecret: 's3cret' }); return Response.json({ code: 0, data: { URL: `ws://127.0.0.1:${port}/ws?device_id=d1&service_id=99`, ClientConfig: { PingInterval: 120 } } }); }
    if (path === '/open-apis/auth/v3/tenant_access_token/internal') return Response.json({ code: 0, tenant_access_token: 't-abc', expire: 7200 });
    if (path === '/open-apis/bot/v3/info') return Response.json({ code: 0, bot: { open_id: 'ou_bot', app_name: '嘀哩机器人' } });
    if (path === '/open-apis/im/v1/messages') { assert.equal((init!.headers as Record<string, string>).authorization, 'Bearer t-abc'); sentMessages.push(JSON.parse(String(init!.body))); return Response.json({ code: 0 }); }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  const channel = new FeishuChannel({ receive: message => { received.push(message); }, onStatus() {}, fetcher, domain: 'https://open.feishu.example' });
  t.after(() => { channel.close(); wss.close(); });
  await channel.configure({ appId: 'cli_testapp12345', appSecret: 's3cret' });
  await until(() => channel.status().state === 'connected' && frames.length > 0, 'feishu did not connect');
  assert.deepEqual([frames[0]!.method, frames[0]!.service, header(frames[0]!, 'type')], [FRAME_CONTROL, 99, 'ping']);
  assert.equal(channel.status().botName, '嘀哩机器人');
  const payload = new TextEncoder().encode(JSON.stringify({ header: { event_type: 'im.message.receive_v1', event_id: 'ev9' }, event: { sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' }, message: { message_id: 'om9', chat_id: 'oc9', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: '你好嘀哩' }) } } }));
  // Delivered in two fragments, as Feishu does for large events.
  const half = Math.floor(payload.length / 2);
  for (const [seq, part] of [[0, payload.subarray(0, half)], [1, payload.subarray(half)]] as const) {
    pushEvent(encodeFrame({ SeqID: 5n, LogID: 6n, service: 99, method: FRAME_DATA, headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'm9' }, { key: 'sum', value: '2' }, { key: 'seq', value: String(seq) }], payload: part }));
  }
  await until(() => received.length === 1 && frames.some(frame => frame.method === FRAME_DATA), 'event not received or not ACKed');
  assert.equal(received[0]!.text, '你好嘀哩');
  const ack = frames.find(frame => frame.method === FRAME_DATA)!;
  assert.deepEqual([ack.SeqID, ack.LogID, JSON.parse(new TextDecoder().decode(ack.payload))], [5n, 6n, { code: 200 }]);
  assert.ok(header(ack, 'biz_rt') !== undefined);
  await channel.send('oc9', '收到');
  assert.deepEqual(sentMessages, [{ receive_id: 'oc9', msg_type: 'text', content: JSON.stringify({ text: '收到' }) }]);
});

test('Feishu rejects wrong credentials without retrying forever', async t => {
  const fetcher = (async () => Response.json({ code: 10003, msg: 'invalid app_secret' })) as unknown as typeof fetch;
  const channel = new FeishuChannel({ receive() {}, onStatus() {}, fetcher });
  t.after(() => channel.close());
  await channel.configure({ appId: 'cli_testapp12345', appSecret: 'bad' });
  await until(() => channel.status().state === 'error', 'no error state');
  assert.match(channel.status().error!, /飞书拒绝了长连接：invalid app_secret/);
});

test('WeChat ClawBot: QR login makes the scanner the owner, then messages flow both ways', async t => {
  const calls: { path: string; body?: Record<string, unknown>; headers: Record<string, string> }[] = [];
  let confirmed = false, delivered = false;
  const fetcher = (async (url: URL | string, init?: RequestInit) => {
    const target = new URL(String(url));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: target.pathname, body, headers: (init?.headers ?? {}) as Record<string, string> });
    switch (target.pathname) {
      case '/ilink/bot/get_bot_qrcode': return Response.json({ qrcode: 'qr-1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/abc' });
      case '/ilink/bot/get_qrcode_status': return Response.json(confirmed ? { status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'bot@im.bot', ilink_user_id: 'wx_owner', baseurl: 'https://ilinkai.weixin.qq.com' } : { status: 'scaned' });
      case '/ilink/bot/getupdates':
        if (!delivered) { delivered = true; return new Response('{"ret":0,"get_updates_buf":"cur-1","msgs":[{"message_id":12345678901234567890,"from_user_id":"wx_owner","message_type":1,"context_token":"ctx-1","item_list":[{"type":1,"text_item":{"text":"嘀哩在吗"}}]}]}'); }
        await delay(30); return Response.json({ ret: 0, msgs: [] });
      case '/ilink/bot/sendmessage': return Response.json({ ret: 0 });
      default: return Response.json({ ret: 0 });
    }
  }) as unknown as typeof fetch;
  let saved: unknown = null; const owners: string[] = []; const received: ImInbound[] = [];
  const channel = new WeixinChannel({ receive: message => { received.push(message); }, save: account => { saved = account; }, loggedIn: id => owners.push(id), onStatus() {}, botAgent: 'Dili/0.0.0', fetcher });
  t.after(() => channel.stop());
  await channel.startLogin();
  assert.deepEqual([channel.status().state, channel.status().qr], ['login', 'https://liteapp.weixin.qq.com/q/abc']);
  await until(() => channel.status().login === 'scaned', 'scan not reported');
  confirmed = true;
  await until(() => received.length === 1, 'no inbound message');
  assert.deepEqual(owners, ['wx_owner']);
  assert.deepEqual([received[0]!.chatId, received[0]!.text, received[0]!.replyContext, received[0]!.messageId], ['wx_owner', '嘀哩在吗', 'ctx-1', '12345678901234567890']);
  assert.equal((saved as { cursor?: string }).cursor, 'cur-1');
  const poll = calls.find(call => call.path === '/ilink/bot/getupdates')!;
  assert.equal(poll.headers.authorization, 'Bearer tok');
  assert.equal(poll.headers.AuthorizationType, 'ilink_bot_token');
  assert.equal((poll.body!.base_info as { bot_agent: string }).bot_agent, 'Dili/0.0.0');
  await channel.send('wx_owner', '在的', 'ctx-1');
  const sent = calls.find(call => call.path === '/ilink/bot/sendmessage')!.body!.msg as Record<string, unknown>;
  assert.deepEqual([sent.to_user_id, sent.message_type, sent.message_state, sent.context_token, sent.item_list], ['wx_owner', 2, 2, 'ctx-1', [{ type: 1, text_item: { text: '在的' } }]]);
});

test('WeChat helpers keep uint64 ids exact and ignore bot echoes', () => {
  assert.equal(parseLossless<{ message_id: string }>('{"message_id": 18446744073709551615}').message_id, '18446744073709551615');
  assert.equal(weixinInbound({ message_type: 2, from_user_id: 'x', item_list: [{ type: 1, text_item: { text: 'echo' } }] }), null);
  assert.equal(weixinInbound({ message_type: 1, from_user_id: 'x', item_list: [{ type: 3, voice_item: { text: '语音转文字' } }] })!.text, '语音转文字');
});
