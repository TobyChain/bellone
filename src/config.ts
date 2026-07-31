import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function parseDotEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

function loadDotEnv(): void {
  const parsed = parseDotEnv(path.resolve(process.cwd(), ".env"));
  for (const [key, val] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();

function resolveDataDir(): string {
  if (process.env.BELLONE_DATA_DIR) {
    return path.resolve(process.cwd(), process.env.BELLONE_DATA_DIR);
  }
  const local = path.resolve(process.cwd(), "data");
  if (fs.existsSync(local)) return local;
  return path.join(os.homedir(), ".bellone");
}

export const config = {
  port: Number(process.env.PORT || 3210),
  dataDir: resolveDataDir(),
};

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

let llmOverride: Partial<LlmConfig> | null = null;

/** 由 store 加载 settings 后注入（避免 config→store 循环依赖）；空串字段视为未设置 */
export function setLlmOverride(o: Partial<LlmConfig> | null): void {
  llmOverride = o;
}

export function getLlmConfig(): LlmConfig {
  const envBase = (process.env.LLM_BASE_URL || "").replace(/\/$/, "");
  const envKey = process.env.LLM_API_KEY || "";
  const envModel = process.env.LLM_MODEL || "qwen-plus";
  return {
    baseUrl: (llmOverride?.baseUrl || envBase).replace(/\/$/, ""),
    apiKey: llmOverride?.apiKey || envKey,
    model: llmOverride?.model || envModel,
  };
}

export function llmConfigured(): boolean {
  const c = getLlmConfig();
  return Boolean(c.baseUrl && c.apiKey);
}

export function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

export function isMaskedKey(v: unknown): boolean {
  return typeof v === "string" && v.includes("****");
}
