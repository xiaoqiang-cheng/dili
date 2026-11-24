import { decodeInvite, newSecret, relayUrl } from './invite.ts';

/** The relay this machine asks for an invite. The receipt (`claim`) is the only
 * proof of ownership; it stays sealed in this machine's settings. */
export interface InviteReceipt { serverUrl: string; id: string; claim: string; email: string; name: string; createdAt: string }
export type InviteRequestState = Omit<InviteReceipt, 'claim'> & {
  status: 'pending' | 'approved' | 'rejected' | 'unknown';
  /** Only when approved: whether the issued code can still be redeemed. */
  inviteStatus: 'ready' | 'used' | 'expired' | 'revoked' | null;
  /** The issued code, only while it is ready; never stored on this machine. */
  invite?: string;
  /** Why the relay could not be asked just now; the receipt stays valid. */
  error?: string;
};

const NAME_MAX = 80, EMAIL_MAX = 254;
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
async function relayJson(url: string, body: object, fetcher: typeof fetch) {
  let response: Response;
  try {
    response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch { fail('无法连接中继服务器，请检查网络后重试', 502); }
  let data: Record<string, unknown>;
  try { data = await response.json() as Record<string, unknown>; } catch { fail('中继服务器返回了无效响应', 502); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('中继服务器返回了无效响应', 502);
  if (!response.ok) fail(typeof data.error === 'string' ? data.error.slice(0, 200) : '中继服务器拒绝了申请', response.status === 429 ? 429 : response.status === 404 ? 404 : 502);
  return data;
}

export async function submitInviteRequest(serverUrl: string, email: unknown, name: unknown, fetcher: typeof fetch = fetch): Promise<InviteReceipt> {
  if (typeof email !== 'string' || !email.trim() || email.length > EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) fail('请填写有效的电子邮箱');
  if (typeof name !== 'string' || !name.trim() || name.length > NAME_MAX) fail('请填写 1–80 字的称呼');
  const relay = relayUrl(serverUrl), claim = newSecret();
  const data = await relayJson(`${relay}/api/requests`, { email: email.trim(), name: name.trim(), claim }, fetcher);
  if (typeof data.id !== 'string' || !/^[\w-]{1,80}$/.test(data.id)) fail('中继服务器返回了无效的申请编号', 502);
  return { serverUrl: relay, id: data.id, claim, email: email.trim().toLowerCase(), name: name.trim(), createdAt: new Date().toISOString() };
}

/** Asks the relay where the request stands. An issued code is accepted only if it
 * names the relay that was asked, so a response cannot redirect pairing elsewhere. */
export async function inviteRequestState(receipt: InviteReceipt, fetcher: typeof fetch = fetch): Promise<InviteRequestState> {
  const { claim: _claim, ...base } = receipt;
  let data: Record<string, unknown>;
  try { data = await relayJson(`${receipt.serverUrl}/api/requests/${encodeURIComponent(receipt.id)}/status`, { claim: receipt.claim }, fetcher); }
  catch (cause) {
    if ((cause as { status?: number }).status === 404) fail('中继上找不到这条申请，请重新申请', 404);
    return { ...base, status: 'unknown', inviteStatus: null, error: cause instanceof Error ? cause.message : '查询失败' };
  }
  const status = (['pending', 'approved', 'rejected'] as const).find(value => value === data.status) ?? 'unknown';
  const inviteStatus = (['ready', 'used', 'expired', 'revoked'] as const).find(value => value === data.inviteStatus) ?? null;
  let invite: string | undefined;
  if (status === 'approved' && inviteStatus === 'ready' && typeof data.invite === 'string') {
    try { if (decodeInvite(data.invite).serverUrl === receipt.serverUrl) invite = data.invite.trim(); } catch { /* reported below */ }
    if (!invite) return { ...base, status, inviteStatus, error: '中继返回的邀请码与申请的服务器不一致，已忽略' };
  }
  return { ...base, status, inviteStatus, ...(invite ? { invite } : {}) };
}
