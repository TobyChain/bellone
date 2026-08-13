import { describe, it, expect, vi } from "vitest";
import { runAgentLoop, type LLMCall } from "../src/agent/loop.js";
import type { ChatMessage } from "../src/agent/llm.js";

const toolCallMsg = (name: string, args: string, id = "c1") => ({
  content: null,
  tool_calls: [{ id, type: "function" as const, function: { name, arguments: args } }],
});

const base: ChatMessage[] = [{ role: "user", content: "hi" }];

describe("runAgentLoop", () => {
  it("无工具调用时直接返回内容", async () => {
    const llm: LLMCall = async () => ({ content: "你好" });
    const result = await runAgentLoop(base, [], {}, { llm });
    expect(result).toBe("你好");
  });

  it("执行工具后把结果回填并继续", async () => {
    const handler = vi.fn(async (args: Record<string, unknown>) => JSON.stringify({ got: args.x }));
    let call = 0;
    const seen: ChatMessage[][] = [];
    const llm: LLMCall = async (messages) => {
      seen.push(messages);
      call += 1;
      return call === 1 ? toolCallMsg("echo", '{"x":1}') : { content: "done" };
    };
    const events: string[] = [];
    const result = await runAgentLoop(base, [], { echo: handler }, {
      llm,
      onToolStart: (n) => events.push(`start:${n}`),
      onToolEnd: (n) => events.push(`end:${n}`),
    });
    expect(result).toBe("done");
    expect(handler).toHaveBeenCalledWith({ x: 1 });
    expect(events).toEqual(["start:echo", "end:echo"]);
    const second = seen[1];
    expect(second.at(-1)?.role).toBe("tool");
    expect(second.at(-1)?.content).toContain('"got":1');
  });

  it("doom loop：连续 3 次相同调用被中止", async () => {
    const llm: LLMCall = async () => toolCallMsg("echo", '{"x":1}');
    const result = await runAgentLoop(base, [], { echo: async () => "ok" }, { llm });
    expect(result).toContain("重复的工具调用");
  });

  it("未知工具返回错误但不中断循环", async () => {
    let call = 0;
    const llm: LLMCall = async (messages) => {
      call += 1;
      if (call === 1) return toolCallMsg("nope", "{}");
      expect(messages.at(-1)?.content).toContain("未知工具");
      return { content: "recovered" };
    };
    expect(await runAgentLoop(base, [], {}, { llm })).toBe("recovered");
  });

  it("工具抛错时错误信息回填给模型", async () => {
    let call = 0;
    const llm: LLMCall = async (messages) => {
      call += 1;
      if (call === 1) return toolCallMsg("boom", "{}");
      expect(messages.at(-1)?.content).toContain("炸了");
      return { content: "handled" };
    };
    const result = await runAgentLoop(base, [], { boom: async () => { throw new Error("炸了"); } }, { llm });
    expect(result).toBe("handled");
  });

  it("达到最大轮数后做无工具收尾", async () => {
    let call = 0;
    const llm: LLMCall = async (_m, tools) => {
      call += 1;
      if (tools && call <= 2) return toolCallMsg("echo", `{"x":${call}}`, `c${call}`);
      return { content: "final" };
    };
    const result = await runAgentLoop(base, [], { echo: async () => "ok" }, { llm, maxIterations: 2 });
    expect(result).toBe("final");
  });
});

describe("并行工具执行", () => {
  it("同轮多个 tool_calls 并行执行且结果保序回填", async () => {
    const order: string[] = [];
    let call = 0;
    const llm: LLMCall = async (messages) => {
      call += 1;
      if (call === 1) {
        return {
          content: null,
          tool_calls: [
            { id: "c1", type: "function" as const, function: { name: "slow", arguments: "{}" } },
            { id: "c2", type: "function" as const, function: { name: "fast", arguments: "{}" } },
          ],
        };
      }
      const tools = messages.filter((m) => m.role === "tool");
      expect(tools.map((m) => m.tool_call_id)).toEqual(["c1", "c2"]);
      return { content: "ok" };
    };
    const handlers = {
      slow: async () => { await new Promise((r) => setTimeout(r, 50)); order.push("slow"); return "s"; },
      fast: async () => { order.push("fast"); return "f"; },
    };
    const result = await runAgentLoop(base, [], handlers, { llm });
    expect(result).toBe("ok");
    expect(order).toEqual(["fast", "slow"]); // fast 先完成 → 证明并行
  });
});

describe("记忆工具", () => {
  it("remember/forget 偏好", async () => {
    const { buildToolkit } = await import("../src/agent/tools.js");
    const { store } = await import("../src/store.js");
    store.memory = [];
    const { handlers } = buildToolkit();
    const r1 = JSON.parse(await handlers.remember_preference({ text: "回复要简短" }));
    expect(r1.ok).toBe(true);
    const dup = JSON.parse(await handlers.remember_preference({ text: "回复要简短" }));
    expect(dup.message).toContain("已经记住");
    expect(store.memory).toHaveLength(1);
    const r2 = JSON.parse(await handlers.forget_preference({ index: 1 }));
    expect(r2.message).toContain("已忘记");
    expect(store.memory).toHaveLength(0);
    await expect(handlers.forget_preference({ index: 5 })).rejects.toThrow();
  });
});
