import { store, type ThemeKey } from "../store.js";
import { THEME_META } from "../tips.js";
import { llmConfigured } from "../config.js";
import { chatCompletion } from "./llm.js";

const FRESH_MS = 24 * 3600_000;
const generating = new Set<ThemeKey>();

export function consumeCopy(theme: ThemeKey): { body: string; tip: string } | null {
  const cached = store.state.pendingCopy[theme];
  if (!cached) return null;
  delete store.state.pendingCopy[theme];
  store.saveState();
  if (Date.now() - cached.ts > FRESH_MS) return null;
  return { body: cached.body, tip: cached.tip };
}

/** 预生成下一次提醒的个性化文案（fire-and-forget，失败静默回退模板） */
export function scheduleCopyGeneration(theme: ThemeKey): void {
  if (!llmConfigured() || generating.has(theme)) return;
  generating.add(theme);
  void generate(theme)
    .catch(() => {})
    .finally(() => generating.delete(theme));
}

async function generate(theme: ThemeKey): Promise<void> {
  const meta = THEME_META[theme];
  const weekAgo = Date.now() - 7 * 24 * 3600_000;
  const fired = store.fired.filter((f) => f.ts >= weekAgo && f.theme === theme).length;
  const done = store.checkins.filter((c) => c.ts >= weekAgo && c.theme === theme).length;
  const memories = store.memory.slice(-10).map((m) => m.text).join("；") || "无";

  const res = await chatCompletion([
    {
      role: "system",
      content:
        "你是健康提醒应用「壹铃」的文案师。生成一条提醒文案，要求：轻松幽默不说教，动机访谈式（肯定努力、不指责），不要使用 emoji 或颜文字。严格输出 JSON：{\"body\":\"提醒正文(30字内)\",\"tip\":\"小贴士(40字内)\"}，不要输出其他内容。",
    },
    {
      role: "user",
      content: `主题：${meta.label}（默认动作：${meta.action}）\n最近 7 天该主题：提醒 ${fired} 次 / 完成 ${done} 次\n关于用户的记忆：${memories}`,
    },
  ]);

  const text = res.content ?? "";
  const jsonStr = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const parsed = JSON.parse(jsonStr) as { body?: string; tip?: string };
  if (!parsed.body || !parsed.tip) return;
  store.state.pendingCopy[theme] = {
    body: String(parsed.body).slice(0, 60),
    tip: `小贴士：${String(parsed.tip).slice(0, 80).replace(/^小贴士[:：]\s*/, "")}`,
    ts: Date.now(),
  };
  store.saveState();
}
