import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "./config.js";
import { store, THEME_KEYS } from "./store.js";
import type { ThemeKey } from "./store.js";
import { THEME_META } from "./tips.js";
import {
  computeStats,
  quietStatus,
  recordCheckin,
  snooze,
  muteToday,
  setDnd,
} from "./rhythm.js";
import { buildWeekReport } from "./report.js";

const themeSchema = z.enum(THEME_KEYS);
const API = `http://localhost:${config.port}`;

/**
 * 主服务运行时必须走 HTTP（两个进程各持内存副本直写文件会互相覆盖），
 * 仅在主服务未启动时才回退为直接读写数据文件。
 */
async function tryApi<T>(method: string, path: string, body?: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function text(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) },
    ],
  };
}

async function statusSnapshot(): Promise<unknown> {
  const remote = await tryApi("GET", "/api/status");
  if (remote) return remote;
  return { quiet: quietStatus(), stats: computeStats(), settings: store.settings };
}

async function weekReport(): Promise<unknown> {
  const remote = await tryApi("GET", "/api/report/week");
  return remote ?? buildWeekReport();
}

const server = new McpServer({ name: "bellone", version: "0.1.0" });

server.tool(
  "get_health_status",
  "查看壹铃当前健康状态：今日提醒/打卡、健康值、连续天数、提醒节律设置与静默状态",
  {},
  async () => text(await statusSnapshot())
);

server.tool(
  "record_checkin",
  "记录一次健康打卡（喝水 water / 起身 stand / 远眺 eyes / 拉伸 stretch）",
  { theme: themeSchema },
  async ({ theme }) => {
    const remote = await tryApi<{ todayCount: number; healthPoints: number; streakDays: number; tip: string }>(
      "POST",
      "/api/checkin",
      { theme, source: "mcp" }
    );
    const r = remote ?? recordCheckin(theme as ThemeKey, "mcp");
    return text(
      `已记录 ✅ 今日第 ${r.todayCount} 次打卡，健康值 +10（累计 ${r.healthPoints}），连续 ${r.streakDays} 天。小贴士：${r.tip}`
    );
  }
);

server.tool(
  "snooze_reminder",
  "顺延某主题的提醒若干分钟",
  { theme: themeSchema, minutes: z.number().min(1).max(480).default(15) },
  async ({ theme, minutes }) => {
    const remote = await tryApi("POST", "/api/snooze", { theme, minutes });
    if (!remote) snooze(theme as ThemeKey, minutes);
    return text(`${THEME_META[theme as ThemeKey].label}提醒已顺延 ${minutes} 分钟`);
  }
);

server.tool(
  "mute_theme_today",
  "今天不再提醒某个主题",
  { theme: themeSchema },
  async ({ theme }) => {
    const remote = await tryApi("POST", "/api/mute-today", { theme });
    if (!remote) muteToday(theme as ThemeKey);
    return text(`今天不再提醒${THEME_META[theme as ThemeKey].label}`);
  }
);

server.tool(
  "set_do_not_disturb",
  "开启免打扰 minutes 分钟（开会/专注时用）；minutes 传 0 关闭免打扰",
  { minutes: z.number().min(0).max(720) },
  async ({ minutes }) => {
    const remote = await tryApi("POST", "/api/dnd", { minutes });
    if (!remote) setDnd(minutes === 0 ? null : minutes);
    return text(minutes === 0 ? "免打扰已关闭" : `免打扰已开启 ${minutes} 分钟`);
  }
);

server.tool("get_week_report", "获取本周健康周报（完成率、起身次数、最长连坐、连续天数等）", {}, async () =>
  text(await weekReport())
);

server.resource("today-status", "bellone://today", async (uri) => ({
  contents: [
    {
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify(await statusSnapshot(), null, 2),
    },
  ],
}));

server.resource("weekly-report", "bellone://weekly-report", async (uri) => ({
  contents: [
    {
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify(await weekReport(), null, 2),
    },
  ],
}));

server.prompt(
  "weekly-health-review",
  "基于本周打卡数据做一次周度健康复盘，给出下周可执行的小改进",
  {},
  async () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `请根据以下壹铃本周健康数据做一次复盘：先肯定做得好的地方，再指出 1-2 个改进点，最后给出下周一个"最容易做到"的小行动。语气轻松不说教。\n\n${JSON.stringify(await weekReport(), null, 2)}`,
        },
      },
    ],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
