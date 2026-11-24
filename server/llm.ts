/** Minimal OpenAI-compatible chat completions client with tool calling, for
 * Dili's own coordinator. The API key stays in the Authorization header and is
 * never written to errors or logs. */
export interface LlmApi { baseUrl: string; model: string; apiKey: string }
export interface ToolCall { id: string; name: string; arguments: string }
export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; reasoning_content?: string }
  | { role: 'tool'; tool_call_id: string; content: string };
export interface LlmTool { name: string; description: string; parameters: Record<string, unknown> }
export interface LlmReply { content: string; toolCalls: ToolCall[]; reasoning?: string; usage?: { prompt: number; completion: number } }

export class LlmError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) { super(message); }
}

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;

export async function chatCompletion(api: LlmApi, input: { messages: LlmMessage[]; tools?: LlmTool[]; timeoutMs?: number; signal?: AbortSignal }, fetcher: typeof fetch = fetch): Promise<LlmReply> {
  const url = `${api.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = JSON.stringify({
    model: api.model, messages: input.messages,
    ...(input.tools?.length ? { tools: input.tools.map(tool => ({ type: 'function', function: tool })), tool_choice: 'auto' } : {}),
  });
  let lastError: LlmError | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 1500));
    let response: Response;
    try {
      const signals = [AbortSignal.timeout(input.timeoutMs ?? 60_000), ...(input.signal ? [input.signal] : [])];
      response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.any(signals), headers: { 'content-type': 'application/json', authorization: `Bearer ${api.apiKey}` }, body });
    } catch (cause) {
      if (input.signal?.aborted) throw new LlmError('已取消');
      lastError = new LlmError(cause instanceof Error && cause.name === 'TimeoutError' ? '模型接口超时' : '无法连接模型接口', undefined, true);
      continue;
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      // Error bodies can echo request headers on some proxies: drop anything key-like.
      const detail = clip(text.replace(/(sk|Bearer)[-\w.]{8,}/g, '***'), 200);
      lastError = new LlmError(`模型接口返回 ${response.status}${detail ? `：${detail}` : ''}`, response.status, response.status === 429 || response.status >= 500);
      if (!lastError.retryable) throw lastError;
      continue;
    }
    let data: { choices?: { message?: { content?: string | null; reasoning_content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    try { data = JSON.parse(text); } catch { throw new LlmError('模型接口返回了无效响应'); }
    const message = data.choices?.[0]?.message;
    if (!message) throw new LlmError('模型接口没有返回内容');
    const toolCalls = (message.tool_calls ?? []).filter(call => call.function?.name).map((call, index) => ({ id: call.id || `call_${index}`, name: call.function!.name!, arguments: call.function!.arguments || '{}' }));
    return {
      content: typeof message.content === 'string' ? message.content : '', toolCalls,
      ...(message.reasoning_content ? { reasoning: message.reasoning_content } : {}),
      ...(data.usage ? { usage: { prompt: data.usage.prompt_tokens ?? 0, completion: data.usage.completion_tokens ?? 0 } } : {}),
    };
  }
  throw lastError ?? new LlmError('模型接口调用失败');
}
