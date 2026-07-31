import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectNoteone, buildNoteoneToolkit, NOTEONE_PREFIX, type McpCaller } from "../src/agent/mcp-client.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "noteone-detect-"));
}

describe("detectNoteone", () => {
  it("目录不存在时返回 null", () => {
    expect(detectNoteone("/nonexistent/path")).toBeNull();
  });

  it(".env 缺关键键时返回 null", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, ".env"), "DATABASE_URL=postgres://x\n");
    expect(detectNoteone(dir)).toBeNull();
  });

  it("满足条件时返回目录与 env", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, ".env"), 'MCP_USER_ID=u1\nDATABASE_URL="postgres://x"\nEXTRA=1\n');
    const det = detectNoteone(dir);
    expect(det?.dir).toBe(dir);
    expect(det?.env.MCP_USER_ID).toBe("u1");
    expect(det?.env.DATABASE_URL).toBe("postgres://x");
    expect(det?.env.EXTRA).toBe("1");
  });
});

describe("buildNoteoneToolkit", () => {
  const rawTools = [
    { name: "search_notes", description: "搜索笔记", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
    { name: "run_ascan_module", description: "长任务" },
    { name: "create_note", description: "建笔记" },
  ];

  const fakeCaller = (impl: (name: string) => unknown): McpCaller => ({
    callTool: async ({ name }) => impl(name),
  });

  it("加前缀并剔除长任务工具", () => {
    const kit = buildNoteoneToolkit(fakeCaller(() => ({})), rawTools);
    const names = kit.tools.map((t) => t.function.name);
    expect(names).toEqual([`${NOTEONE_PREFIX}search_notes`, `${NOTEONE_PREFIX}create_note`]);
    expect(kit.tools[0].function.parameters).toEqual(rawTools[0].inputSchema);
  });

  it("handler 拼接 content text", async () => {
    const kit = buildNoteoneToolkit(
      fakeCaller(() => ({ content: [{ type: "text", text: "结果A" }, { type: "text", text: "结果B" }] })),
      rawTools
    );
    const out = await kit.handlers[`${NOTEONE_PREFIX}search_notes`]({ query: "x" });
    expect(out).toBe("结果A\n结果B");
  });

  it("isError 结果转 error JSON", async () => {
    const kit = buildNoteoneToolkit(
      fakeCaller(() => ({ isError: true, content: [{ type: "text", text: "挂了" }] })),
      rawTools
    );
    const out = await kit.handlers[`${NOTEONE_PREFIX}create_note`]({});
    expect(JSON.parse(out).error).toBe("挂了");
  });

  it("callTool 抛错时返回 error JSON 不抛出", async () => {
    const kit = buildNoteoneToolkit(
      { callTool: async () => { throw new Error("连接断开"); } },
      rawTools
    );
    const out = await kit.handlers[`${NOTEONE_PREFIX}search_notes`]({});
    expect(JSON.parse(out).error).toBe("连接断开");
  });
});
