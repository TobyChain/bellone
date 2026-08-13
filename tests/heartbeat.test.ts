import { describe, it, expect } from "vitest";

process.env.LLM_BASE_URL = "http://mock-llm";
process.env.LLM_API_KEY = "test";

const { gateReminder } = await import("../src/agent/heartbeat.js");

describe("gateReminder", () => {
  it("LLM 输出 SPEAK 时放行", async () => {
    expect(await gateReminder("water", async () => ({ content: "SPEAK" }))).toBe("SPEAK");
  });

  it("LLM 输出 HOLD 时暂缓（容忍前后噪声文本）", async () => {
    expect(await gateReminder("water", async () => ({ content: "判断：hold，用户在开会" }))).toBe("HOLD");
  });

  it("LLM 出错时兜底 SPEAK", async () => {
    expect(
      await gateReminder("water", async () => {
        throw new Error("boom");
      })
    ).toBe("SPEAK");
  });

  it("输出无法识别时默认 SPEAK", async () => {
    expect(await gateReminder("water", async () => ({ content: "呃我不确定" }))).toBe("SPEAK");
  });
});
