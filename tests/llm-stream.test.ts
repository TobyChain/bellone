import { describe, it, expect } from "vitest";
import { ToolCallAggregator } from "../src/agent/llm.js";

describe("ToolCallAggregator", () => {
  it("按 index 增量拼接 name 与 arguments", () => {
    const agg = new ToolCallAggregator();
    agg.feed([{ index: 0, id: "call_a", function: { name: "record_checkin", arguments: "" } }]);
    agg.feed([{ index: 0, function: { arguments: '{"the' } }]);
    agg.feed([{ index: 0, function: { arguments: 'me":"water"}' } }]);
    const calls = agg.list();
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("call_a");
    expect(calls[0].function.name).toBe("record_checkin");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ theme: "water" });
  });

  it("多个并行 tool calls 按 index 分组且保序", () => {
    const agg = new ToolCallAggregator();
    agg.feed([
      { index: 1, id: "b", function: { name: "get_status", arguments: "{}" } },
      { index: 0, id: "a", function: { name: "record_checkin", arguments: "{}" } },
    ]);
    const calls = agg.list();
    expect(calls.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("缺失 index 时按 id 出现降级切分（Ollama 兼容）", () => {
    const agg = new ToolCallAggregator();
    agg.feed([{ id: "x", function: { name: "get_status", arguments: "" } }]);
    agg.feed([{ function: { arguments: "{}" } }]);
    agg.feed([{ id: "y", function: { name: "get_week_report", arguments: "{}" } }]);
    const calls = agg.list();
    expect(calls).toHaveLength(2);
    expect(calls[0].function.name).toBe("get_status");
    expect(calls[0].function.arguments).toBe("{}");
    expect(calls[1].function.name).toBe("get_week_report");
  });
});
