import { getLlmConfig, llmConfigured } from "../config.js";

export class LLMNotConfiguredError extends Error {
  constructor() {
    super("LLM 未配置：请在「设置 → AI 助手」填写，或在 .env 中设置 LLM_BASE_URL 和 LLM_API_KEY");
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMResult {
  content: string | null;
  tool_calls?: ToolCall[];
}

export type DeltaHandler = (text: string) => void;

interface StreamToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** 按 index 增量聚合流式 tool_calls；部分兼容接口不带 index 时按 id 出现降级切分 */
export class ToolCallAggregator {
  private byIndex = new Map<number, ToolCall>();
  private cursor = -1;

  feed(deltas: StreamToolCallDelta[]): void {
    for (const d of deltas) {
      let idx = d.index;
      if (idx === undefined) idx = d.id ? this.cursor + 1 : Math.max(this.cursor, 0);
      this.cursor = Math.max(this.cursor, idx);
      let call = this.byIndex.get(idx);
      if (!call) {
        call = { id: d.id ?? `call_${idx}`, type: "function", function: { name: "", arguments: "" } };
        this.byIndex.set(idx, call);
      }
      if (d.id) call.id = d.id;
      if (d.function?.name) call.function.name += d.function.name;
      if (d.function?.arguments) call.function.arguments += d.function.arguments;
    }
  }

  list(): ToolCall[] {
    return [...this.byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  }
}

class StreamCorruptedError extends Error {}

function buildRequest(messages: ChatMessage[], tools: ToolDefinition[] | undefined, stream: boolean) {
  return {
    model: getLlmConfig().model,
    messages,
    ...(tools && tools.length > 0 ? { tools } : {}),
    temperature: 0.4,
    ...(stream ? { stream: true } : {}),
  };
}

async function doFetch(body: unknown, signal?: AbortSignal): Promise<Response> {
  const llm = getLlmConfig();
  const timeout = AbortSignal.timeout(120_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(`${llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${llm.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: combined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`LLM 请求失败 (${res.status}): ${text.slice(0, 300)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return res;
}

async function requestNonStream(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  signal?: AbortSignal
): Promise<LLMResult> {
  const res = await doFetch(buildRequest(messages, tools, false), signal);
  const data = (await res.json()) as {
    choices: { message: { content: string | null; tool_calls?: ToolCall[] } }[];
  };
  const msg = data.choices?.[0]?.message;
  return { content: msg?.content ?? null, tool_calls: msg?.tool_calls };
}

async function requestStream(
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  signal: AbortSignal | undefined,
  onDelta: DeltaHandler
): Promise<LLMResult> {
  const res = await doFetch(buildRequest(messages, tools, true), signal);
  if (!res.body) throw new StreamCorruptedError("响应无 body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const agg = new ToolCallAggregator();
  let content = "";
  let buf = "";

  const processLine = (rawLine: string): void => {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return;
    let json: { choices?: { delta?: { content?: string | null; tool_calls?: StreamToolCallDelta[] } }[] };
    try {
      json = JSON.parse(payload);
    } catch {
      throw new StreamCorruptedError(`流式 chunk 解析失败: ${payload.slice(0, 120)}`);
    }
    const delta = json.choices?.[0]?.delta;
    if (delta?.content) {
      content += delta.content;
      onDelta(delta.content);
    }
    if (delta?.tool_calls) agg.feed(delta.tool_calls);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      processLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) processLine(buf);

  const toolCalls = agg.list();
  for (const c of toolCalls) {
    if (!c.function.name) throw new StreamCorruptedError("tool call 缺少 name");
    try {
      JSON.parse(c.function.arguments || "{}");
    } catch {
      throw new StreamCorruptedError(`tool call arguments 非法 JSON: ${c.function.arguments.slice(0, 120)}`);
    }
  }

  return { content: content || null, tool_calls: toolCalls.length > 0 ? toolCalls : undefined };
}

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 429 || (typeof status === "number" && status >= 500);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * OpenAI 兼容 chat completion。传入 onDelta 即走流式（token 级回调）；
 * 流式聚合损坏时自动回退一次非流式；429/5xx 指数退避重试 2 次。
 */
export async function chatCompletion(
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  signal?: AbortSignal,
  onDelta?: DeltaHandler
): Promise<LLMResult> {
  if (!llmConfigured()) throw new LLMNotConfiguredError();

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw new Error("请求已取消");
    try {
      if (onDelta) {
        try {
          return await requestStream(messages, tools, signal, onDelta);
        } catch (err) {
          if (err instanceof StreamCorruptedError) {
            return await requestNonStream(messages, tools, signal);
          }
          throw err;
        }
      }
      return await requestNonStream(messages, tools, signal);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === 2) throw err;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr;
}
