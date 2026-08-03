import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseDotEnv } from "../config.js";
import { store, applySettingsPatch } from "../store.js";
import type { ToolDefinition } from "./llm.js";
import type { ToolHandler } from "./tools.js";

const DEFAULT_NOTEONE_DIR = "/Users/bingtao/Documents/ai.alibaba/noteone/server";
const EXCLUDED_TOOLS = new Set(["run_ascan_module", "merge_ascan_report"]);
const CALL_TIMEOUT_MS = 30_000;
const RETRY_INTERVAL_MS = 60_000;

export const NOTEONE_PREFIX = "noteone_";

interface RawTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpCaller {
  callTool(params: { name: string; arguments: Record<string, unknown> }, resultSchema?: unknown, options?: { timeout?: number }): Promise<unknown>;
}

let client: Client | null = null;
let connected = false;
let cachedTools: ToolDefinition[] = [];
let cachedHandlers: Record<string, ToolHandler> = {};
let lastAttempt = 0;
let connecting = false;

export function detectNoteone(dir = process.env.NOTEONE_DIR || DEFAULT_NOTEONE_DIR): {
  dir: string;
  env: Record<string, string>;
} | null {
  if (!fs.existsSync(dir)) return null;
  const env = parseDotEnv(path.join(dir, ".env"));
  if (!env.MCP_USER_ID || !env.DATABASE_URL) return null;
  return { dir, env };
}

function extractText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] })?.content;
  if (!Array.isArray(content)) return JSON.stringify(result);
  const text = content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
  return text || "(空结果)";
}

/** 把 MCP listTools 结果转换为 agent loop 工具集（加前缀、剔除长任务、包超时） */
export function buildNoteoneToolkit(
  caller: McpCaller,
  rawTools: RawTool[]
): { tools: ToolDefinition[]; handlers: Record<string, ToolHandler> } {
  const tools: ToolDefinition[] = [];
  const handlers: Record<string, ToolHandler> = {};
  for (const raw of rawTools) {
    if (EXCLUDED_TOOLS.has(raw.name)) continue;
    const prefixed = `${NOTEONE_PREFIX}${raw.name}`;
    tools.push({
      type: "function",
      function: {
        name: prefixed,
        description: `[noteone 笔记] ${raw.description ?? raw.name}`,
        parameters: raw.inputSchema ?? { type: "object", properties: {} },
      },
    });
    handlers[prefixed] = async (args) => {
      try {
        const result = await caller.callTool(
          { name: raw.name, arguments: args },
          undefined,
          { timeout: CALL_TIMEOUT_MS }
        );
        if ((result as { isError?: boolean })?.isError) {
          return JSON.stringify({ error: extractText(result) });
        }
        return extractText(result);
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    };
  }
  return { tools, handlers };
}

async function connect(): Promise<void> {
  const det = detectNoteone();
  if (!det) return;
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp.ts"],
    cwd: det.dir,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ...det.env,
    },
    stderr: "ignore",
  });
  const c = new Client({ name: "bellone", version: "0.1.0" });
  transport.onclose = () => {
    connected = false;
    cachedTools = [];
    cachedHandlers = {};
  };
  await c.connect(transport);
  const listed = await c.listTools();
  const kit = buildNoteoneToolkit(c, listed.tools as RawTool[]);
  client = c;
  cachedTools = kit.tools;
  cachedHandlers = kit.handlers;
  connected = true;
  console.log(`[mcp] noteone 已连接（${kit.tools.length} 个工具）`);
}

export async function syncNoteoneMcp(): Promise<void> {
  const enabled = store.settings.noteoneMcp.enabled;
  if (!enabled || !detectNoteone()) {
    await closeNoteoneMcp();
    return;
  }
  if (connected || connecting) return;
  if (Date.now() - lastAttempt < RETRY_INTERVAL_MS && lastAttempt > 0) return;
  connecting = true;
  lastAttempt = Date.now();
  try {
    await connect();
  } catch (err) {
    console.warn(`[mcp] noteone 连接失败，已降级: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    connecting = false;
  }
}

export function getNoteoneToolkit(): { tools: ToolDefinition[]; handlers: Record<string, ToolHandler> } {
  if (!connected) return { tools: [], handlers: {} };
  return { tools: cachedTools, handlers: cachedHandlers };
}

export function getNoteoneStatus(): {
  available: boolean;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
} {
  return {
    available: detectNoteone() !== null,
    enabled: store.settings.noteoneMcp.enabled,
    connected,
    toolCount: cachedTools.length,
  };
}

/** Attempt to read LLM config from a running noteone instance (API + .env fallback). */
export async function syncLlmFromNoteone(): Promise<{ baseUrl: string; model: string; apiKey: string; source: string } | null> {
  // 1. Try the noteone HTTP API for base URL + model (works for both dev and embedded).
  let baseUrl = "";
  let model = "";
  let hasApiKey = false;
  try {
    const resp = await fetch("http://127.0.0.1:3000/api/settings", { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const data = await resp.json() as { llm?: { baseUrl?: string; model?: string; hasApiKey?: boolean } };
      baseUrl = data.llm?.baseUrl ?? "";
      model = data.llm?.model ?? "";
      hasApiKey = data.llm?.hasApiKey ?? false;
    }
  } catch { /* noteone not running on 3000 */ }

  // 2. Try reading QWEN_* from the .env file (dev server only — gives us the actual key).
  let apiKey = "";
  const detected = detectNoteone();
  if (detected) {
    apiKey = detected.env.QWEN_API_KEY || "";
    if (!baseUrl) baseUrl = detected.env.QWEN_BASE_URL?.replace(/\/$/, "") || "";
    if (!model) model = detected.env.QWEN_MODEL || "";
  }

  if (!baseUrl && !model && !apiKey) return null;

  // Apply to bellone's settings.
  const patch: { llm?: Partial<{ baseUrl: string; apiKey: string; model: string }> } = {};
  if (baseUrl) patch.llm = { baseUrl };
  if (model) patch.llm!.model = model;
  if (apiKey) patch.llm!.apiKey = apiKey;
  applySettingsPatch(patch, { allowLlm: true });
  store.saveSettings();

  return {
    baseUrl,
    model,
    apiKey: apiKey ? "(已同步)" : hasApiKey ? "(需手动输入)" : "(未设置)",
    source: apiKey ? ".env" : "API",
  };
}

export async function closeNoteoneMcp(): Promise<void> {
  if (!client) return;
  const c = client;
  client = null;
  connected = false;
  cachedTools = [];
  cachedHandlers = {};
  try {
    await c.close();
  } catch {}
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    void closeNoteoneMcp().finally(() => process.exit(0));
  });
}
