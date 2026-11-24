import type { AgentChatAdapter } from './chat.ts';
import type { AgentChatAnswer, AgentChatHistoryPage, AgentChatSnapshot, AgentChatSettings, AgentChatSettingsUpdate } from '../../shared/chat.ts';
import type { SessionStatus } from '../../shared/types.ts';
import type { PiBridge, PiNativeStatus } from '../pi.ts';

export interface PiChatAdapterOptions {
  bridge: PiBridge;
  /** Forward native turn state to the contact card; Pi is a real process, not
   * a UI-only status. */
  onStatus?: (nativeSessionId: string, status: PiNativeStatus) => void;
}

/** Pi already owns the session and all execution. Dili only translates its
 * documented RPC snapshots into the shared Agent chat contract. */
export class PiChatAdapter implements AgentChatAdapter {
  private readonly bridge: PiBridge;
  private readonly cache = new Map<string, AgentChatSnapshot>();
  private readonly listeners = new Set<(sessionId: string, snapshot: AgentChatSnapshot) => void>();
  private readonly offChat: () => void;
  private readonly offStatus: () => void;

  constructor(options: PiChatAdapterOptions) {
    this.bridge = options.bridge;
    this.offChat = this.bridge.onChat(nativeId => {
      let snapshot: AgentChatSnapshot;
      try { snapshot = this.bridge.snapshotSync(nativeId); } catch { return; }
      this.cache.set(nativeId, snapshot);
      for (const listener of this.listeners) { try { listener(nativeId, snapshot); } catch { /* another pane must not break this one */ } }
    });
    this.offStatus = this.bridge.onStatus((nativeId, status) => {
      // The bridge's final stop event bypasses the normal chat refresh. Keep the
      // adapter cache in sync so group turn detection does not see a dead turn.
      const cached = this.cache.get(nativeId);
      if (cached) {
        const terminal = status.status === 'stopped' || status.status === 'error';
        this.cache.set(nativeId, { ...cached, connected: !terminal && cached.connected, activeTurnId: terminal || status.status === 'idle' ? null : cached.activeTurnId, revision: cached.revision + 1 });
      }
      options.onStatus?.(nativeId, status);
    });
  }

  async readChatSettings(sessionId: string): Promise<AgentChatSettings> { return this.bridge.readSettings(sessionId); }
  async updateChatSettings(sessionId: string, update: AgentChatSettingsUpdate): Promise<AgentChatSettings> { return this.bridge.updateSettings(sessionId, update); }

  async readChat(sessionId: string): Promise<AgentChatSnapshot> {
    try {
      const snapshot = this.bridge.snapshotSync(sessionId);
      this.cache.set(sessionId, snapshot);
      return snapshot;
    } catch (error) {
      // Keep the last known transcript visible after Pi stops; the snapshot is
      // explicitly disconnected, not a new native session.
      const cached = this.cache.get(sessionId);
      if (cached) return { ...cached, connected: false, revision: cached.revision + 1 };
      throw error;
    }
  }
  chatSnapshot(sessionId: string): AgentChatSnapshot | undefined { return this.cache.get(sessionId); }

  async readChatHistory(_sessionId: string, _cursor: string): Promise<AgentChatHistoryPage> {
    // Pi's RPC has no cursor-paged history command. Returning an empty page
    // would look like the native session lost its past, so keep the honest
    // native-terminal escape hatch instead.
    throw Object.assign(new Error('Pi 的完整历史请在原生终端查看；图形视图显示最近的会话窗口'), { status: 409 });
  }

  onChat(listener: (sessionId: string, snapshot: AgentChatSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async sendPrompt(sessionId: string, text: string, _model?: string, images: string[] = [], expectedTurnId?: string): Promise<{ turnId: string }> {
    return this.bridge.sendPrompt(sessionId, text, images, expectedTurnId);
  }

  async getStatus(sessionId: string): Promise<{ status: SessionStatus; detail: string; timestamp: string }> {
    const status = this.bridge.getStatus(sessionId);
    return { status: status.status, detail: status.detail, timestamp: status.timestamp };
  }

  async answerChatRequest(sessionId: string, requestId: string, answer: AgentChatAnswer): Promise<void> {
    await this.bridge.answerRequest(sessionId, requestId, answer);
  }

  async stopSession(sessionId: string): Promise<void> {
    // The chat UI's "stop generating" must abort the turn, not close the RPC
    // process: the same process still owns settings and future prompts.
    await this.bridge.abort(sessionId);
  }

  dispose(): void { this.offChat(); this.offStatus(); this.listeners.clear(); this.cache.clear(); }
}
