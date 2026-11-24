/** What the settings page shows for each IM channel. Secrets never appear here. */
export interface ImChannelState {
  state: 'off' | 'login' | 'connecting' | 'connected' | 'paused' | 'error';
  error?: string;
  since?: string;
  /** People paired as owners; only they reach 嘀哩. */
  owners: number;
  /** Chats bound to a topic, with the topic title. */
  chats: { topic: string }[];
  pairCode?: { code: string; expiresAt: string };
}
export interface ImStatus {
  feishu: ImChannelState & { appId?: string; botName?: string };
  weixin: ImChannelState & { qr?: string; login?: 'wait' | 'scaned' | 'need_verifycode' | 'expired'; account?: string };
  /** The model 嘀哩 would use, or null when no dsh/Pi API is configured. */
  coordinator: { model: string; source: 'dsh' | 'pi' } | null;
}
