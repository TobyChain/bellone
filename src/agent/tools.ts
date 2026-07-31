import { store, THEME_KEYS, parseTheme, applySettingsPatch } from "../store.js";
import type { ThemeKey } from "../store.js";
import { THEME_META } from "../tips.js";
import {
  computeStats,
  quietStatus,
  recordCheckin,
  snooze,
  muteToday,
  setDnd,
  fireReminder,
} from "../rhythm.js";
import { buildWeekReport } from "../report.js";
import type { ToolDefinition } from "./llm.js";

export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

function asTheme(v: unknown): ThemeKey {
  const theme = parseTheme(v);
  if (!theme) throw new Error(`无效的主题: ${String(v)}，可选值 ${THEME_KEYS.join("/")}`);
  return theme;
}

export function buildToolkit(): { tools: ToolDefinition[]; handlers: Record<string, ToolHandler> } {
  const tools: ToolDefinition[] = [
    {
      type: "function",
      function: {
        name: "get_status",
        description: "查看壹铃当前状态：今日提醒/打卡次数、健康值、连续天数、各主题设置、是否处于静默期",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "record_checkin",
        description: "帮用户记录一次健康打卡（如用户说已经喝完水/起身活动过了）",
        parameters: {
          type: "object",
          properties: {
            theme: { type: "string", enum: THEME_KEYS, description: "打卡主题" },
          },
          required: ["theme"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_settings",
        description:
          "更新提醒设置。reminderIntervalMin 是所有动作共用的提醒频率（分钟）——用户说「太频繁/少提醒我」就调大，「多提醒我」就调小；还可改提醒时段(workStart/workEnd HH:MM)、午休(lunchStart/lunchEnd)、工作日(workDays 0-6数组)、各动作开关",
        parameters: {
          type: "object",
          properties: {
            reminderIntervalMin: { type: "number", description: "共用提醒频率（分钟），5-480" },
            workStart: { type: "string" },
            workEnd: { type: "string" },
            lunchStart: { type: "string" },
            lunchEnd: { type: "string" },
            workDays: { type: "array", items: { type: "number" } },
            themes: {
              type: "object",
              description: '各动作开关，如 {"stretch": {"enabled": true}}',
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "snooze_theme",
        description: "将某个主题的提醒顺延若干分钟（用户说稍后提醒）",
        parameters: {
          type: "object",
          properties: {
            theme: { type: "string", enum: THEME_KEYS },
            minutes: { type: "number", description: "顺延分钟数，默认 15" },
          },
          required: ["theme"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "mute_theme_today",
        description: "今天不再提醒某个主题",
        parameters: {
          type: "object",
          properties: { theme: { type: "string", enum: THEME_KEYS } },
          required: ["theme"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "set_dnd",
        description: "开启免打扰（开会/专注时），minutes 为免打扰分钟数；传 0 表示立即关闭免打扰",
        parameters: {
          type: "object",
          properties: { minutes: { type: "number" } },
          required: ["minutes"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_week_report",
        description: "获取本周健康周报数据：完成率、起身次数、最长连坐时长、连续打卡天数等",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "ring_now",
        description: "立即敲响一次指定主题的铃（用户想现在就被提醒一下）",
        parameters: {
          type: "object",
          properties: { theme: { type: "string", enum: THEME_KEYS } },
          required: ["theme"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "remember_preference",
        description:
          "记住用户的健康偏好或近况（如\"回复要简短\"、\"最近在减脂\"、\"下午容易犯困\"），后续对话会自动带上这些记忆",
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "一句话描述要记住的内容" } },
          required: ["text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "forget_preference",
        description: "删除一条已记住的偏好（按 get_status 返回的记忆序号，从 1 开始）",
        parameters: {
          type: "object",
          properties: { index: { type: "number" } },
          required: ["index"],
        },
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    get_status: async () => {
      const stats = computeStats();
      const q = quietStatus();
      return JSON.stringify({
        now: new Date().toLocaleString("zh-CN"),
        quiet: q,
        stats,
        reminderIntervalMin: store.settings.reminderIntervalMin,
        settings: store.settings,
        dndUntil: store.state.dndUntil,
        snoozedUntil: store.state.globalSnoozeUntil,
        memories: store.memory.map((m, i) => `${i + 1}. ${m.text}`),
      });
    },
    record_checkin: async (args) => {
      const theme = asTheme(args.theme);
      const r = recordCheckin(theme, "agent");
      return JSON.stringify({
        ok: true,
        message: `已记录 ✅ 今日第 ${r.todayCount} 次打卡，健康值 +${r.pointsAdded}（累计 ${r.healthPoints}）`,
        streakDays: r.streakDays,
        tip: r.tip,
      });
    },
    update_settings: async (args) => {
      const s = applySettingsPatch(args, { strict: true });
      return JSON.stringify({ ok: true, settings: s });
    },
    snooze_theme: async (args) => {
      const theme = asTheme(args.theme);
      const m = snooze(theme, typeof args.minutes === "number" ? args.minutes : 15);
      return JSON.stringify({ ok: true, message: `${THEME_META[theme].label}提醒已顺延 ${m} 分钟` });
    },
    mute_theme_today: async (args) => {
      const theme = asTheme(args.theme);
      muteToday(theme);
      return JSON.stringify({ ok: true, message: `今天不再提醒${THEME_META[theme].label}` });
    },
    set_dnd: async (args) => {
      const minutes = Number(args.minutes);
      if (!Number.isFinite(minutes) || minutes < 0) throw new Error("minutes 需为非负数字");
      setDnd(minutes === 0 ? null : minutes);
      return JSON.stringify({
        ok: true,
        message: minutes === 0 ? "免打扰已关闭" : `免打扰已开启 ${minutes} 分钟`,
      });
    },
    get_week_report: async () => JSON.stringify(buildWeekReport()),
    ring_now: async (args) => {
      const theme = asTheme(args.theme);
      const r = fireReminder(theme, "manual");
      return JSON.stringify({ ok: true, fired: r });
    },
    remember_preference: async (args) => {
      const text = String(args.text ?? "").trim();
      if (!text) throw new Error("text 不能为空");
      if (store.memory.some((m) => m.text === text)) {
        return JSON.stringify({ ok: true, message: "这条已经记住了" });
      }
      store.memory.push({ ts: Date.now(), text });
      if (store.memory.length > 100) store.memory = store.memory.slice(-100);
      store.saveMemory();
      return JSON.stringify({ ok: true, message: `已记住：${text}`, total: store.memory.length });
    },
    forget_preference: async (args) => {
      const index = Number(args.index);
      if (!Number.isInteger(index) || index < 1 || index > store.memory.length) {
        throw new Error(`index 需在 1-${store.memory.length} 之间`);
      }
      const [removed] = store.memory.splice(index - 1, 1);
      store.saveMemory();
      return JSON.stringify({ ok: true, message: `已忘记：${removed.text}` });
    },
  };

  return { tools, handlers };
}
