import type { ConversationMessage, Session } from '../shared/types';

const QUESTION_MARKER = '**需要你回答的问题**';

/**
 * A native question is only pending while the native status says so. For dsh
 * the status detail distinguishes a real question from an ordinary finished
 * turn; for Claude PTY, waiting_input is also the normal idle state, so the
 * question must still be the last transcript message.
 */
export function nativeQuestionPending(
  session: Pick<Session, 'backend' | 'status' | 'statusDetail'>,
  messages: ConversationMessage[] | undefined,
): boolean {
  if (session.status !== 'waiting_input') return false;
  const detail = session.statusDetail ?? '';
  if (session.backend === 'dsh') return /等待(?:你的)?回答/.test(detail);
  if (session.backend !== 'claude' || !/等待你的输入/.test(detail)) return false;
  const last = messages?.at(-1);
  return last?.role === 'assistant' && last.text.includes(QUESTION_MARKER);
}
