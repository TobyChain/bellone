import { store, type ThemeKey } from "../store.js";
import { THEME_META } from "../tips.js";
import { llmConfigured } from "../config.js";
import { chatCompletion, type ChatMessage } from "./llm.js";

export type GateDecision = "SPEAK" | "HOLD";
export type GateFn = (messages: ChatMessage[]) => Promise<{ content: string | null }>;

const GATE_TIMEOUT_MS = 4000;

/**
 * 心跳式降噪（OpenClaw heartbeat 模式）：提醒到期后由 LLM 结合记忆快照
 * 输出单词决策——SPEAK 立即提醒 / HOLD 静默顺延。超时或出错一律 SPEAK 兜底，
 * 未配置 LLM 时不参与（纯规则路径完整可用）。
 */
export async function gateReminder(theme: ThemeKey, llm: GateFn = chatCompletion): Promise<GateDecision> {
  if (!llmConfigured()) return "SPEAK";

  const meta = THEME_META[theme];
  const recentMemories = store.memory.slice(-10).map((m) => m.text).join("；") || "无";
  const lastCheckin = store.checkins[store.checkins.length - 1];
  const minsSinceCheckin = lastCheckin ? Math.round((Date.now() - lastCheckin.ts) / 60_000) : null;

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "你是健康提醒的守门人。根据上下文判断现在是否适合打扰用户提醒健康事项。只输出一个单词：SPEAK（该提醒）或 HOLD（暂缓，比如记忆显示用户正在开会/专注/明确说过此时段别打扰）。没有明确暂缓理由时一律 SPEAK。",
    },
    {
      role: "user",
      content: `即将提醒：${meta.label}\n当前时间：${new Date().toLocaleString("zh-CN")}\n距上次打卡：${minsSinceCheckin === null ? "今日未打卡" : `${minsSinceCheckin} 分钟`}\n关于用户的记忆：${recentMemories}`,
    },
  ];

  try {
    const result = await Promise.race([
      llm(messages),
      new Promise<{ content: string | null }>((resolve) =>
        setTimeout(() => resolve({ content: "SPEAK" }), GATE_TIMEOUT_MS)
      ),
    ]);
    return (result.content ?? "").toUpperCase().includes("HOLD") ? "HOLD" : "SPEAK";
  } catch {
    return "SPEAK";
  }
}
