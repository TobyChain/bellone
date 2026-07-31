import { chatCompletion, type ChatMessage, type ToolDefinition } from "./llm.js";
import type { ToolHandler } from "./tools.js";

export type LLMCall = typeof chatCompletion;

export interface AgentLoopOptions {
  maxIterations?: number;
  signal?: AbortSignal;
  llm?: LLMCall;
  onContentDelta?: (text: string) => void;
  onToolStart?: (name: string, argsSummary: string) => void;
  onToolEnd?: (name: string, resultPreview: string, durationMs: number) => void;
}

const MAX_RESULT_CHARS = 4000;

function compressResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS - 500)}\n...[已截断]...\n${text.slice(-400)}`;
}

export async function runAgentLoop(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  handlers: Record<string, ToolHandler>,
  opts: AgentLoopOptions = {}
): Promise<string> {
  const maxIterations = opts.maxIterations ?? 6;
  const llm = opts.llm ?? chatCompletion;
  const history = [...messages];
  const recentCalls: string[] = [];

  for (let i = 0; i < maxIterations; i++) {
    const response = await llm(history, tools, opts.signal, opts.onContentDelta);

    if (!response.tool_calls || response.tool_calls.length === 0) {
      return response.content ?? "";
    }

    for (const call of response.tool_calls) {
      const fingerprint = `${call.function.name}:${call.function.arguments}`;
      recentCalls.push(fingerprint);
      if (recentCalls.length > 4) recentCalls.shift();
      if (recentCalls.length >= 3 && recentCalls.slice(-3).every((f) => f === fingerprint)) {
        return "检测到重复的工具调用，已自动停止。请换一种说法再试试。";
      }
    }

    history.push({
      role: "assistant",
      content: response.content ?? "",
      tool_calls: response.tool_calls,
    });

    const results = await Promise.all(
      response.tool_calls.map(async (call) => {
        const handler = handlers[call.function.name];
        const started = Date.now();
        opts.onToolStart?.(call.function.name, call.function.arguments.slice(0, 200));
        let result: string;
        if (!handler) {
          result = JSON.stringify({ error: `未知工具: ${call.function.name}` });
        } else {
          try {
            const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            result = await handler(args);
          } catch (err) {
            result = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
          }
        }
        result = compressResult(result);
        opts.onToolEnd?.(call.function.name, result.slice(0, 400), Date.now() - started);
        return { id: call.id, result };
      })
    );
    for (const r of results) {
      history.push({ role: "tool", content: r.result, tool_call_id: r.id });
    }
  }

  const final = await llm(history, undefined, opts.signal, opts.onContentDelta);
  return final.content ?? "（已达到最大工具调用轮数）";
}
