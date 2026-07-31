import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, llmConfigured, getLlmConfig, maskApiKey, isMaskedKey } from "./config.js";
import { store, parseTheme, applySettingsPatch } from "./store.js";
import { syncNoteoneMcp, getNoteoneToolkit, getNoteoneStatus } from "./agent/mcp-client.js";
import { addClient, broadcast, sseFrame } from "./events.js";
import {
  tick,
  quietStatus,
  computeStats,
  recordCheckin,
  snooze,
  muteToday,
  setDnd,
  fireReminder,
} from "./rhythm.js";
import { buildWeekReport } from "./report.js";
import { THEME_META } from "./tips.js";
import { runAgentLoop } from "./agent/loop.js";
import { buildToolkit } from "./agent/tools.js";
import { buildSystemPrompt } from "./agent/prompt.js";
import { LLMNotConfiguredError, type ChatMessage } from "./agent/llm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// 防 DNS rebinding：仅接受本机 Host
app.use((req, res, next) => {
  const host = (req.headers.host || "").split(":")[0];
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "") return next();
  res.status(403).json({ error: "仅允许本机访问" });
});
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

function sseInit(res: express.Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

const CHECKIN_SOURCES = new Set(["web", "mcp", "agent"]);

// ---- 状态与设置 ----
app.get("/api/status", (_req, res) => {
  res.json({
    app: "bellone",
    name: "壹铃",
    llmConfigured: llmConfigured(),
    quiet: quietStatus(),
    stats: computeStats(),
    dndUntil: store.state.dndUntil,
    snoozedUntil: store.state.globalSnoozeUntil,
    mutedThemes: store.state.mutedThemes,
    themes: THEME_META,
    settings: {
      ...store.settings,
      llm: {
        baseUrl: store.settings.llm.baseUrl,
        model: store.settings.llm.model,
        apiKey: maskApiKey(store.settings.llm.apiKey),
        hasApiKey: Boolean(store.settings.llm.apiKey),
      },
    },
    noteone: getNoteoneStatus(),
  });
});

app.put("/api/settings", (req, res) => {
  const s = applySettingsPatch(req.body ?? {}, { allowLlm: true });
  void syncNoteoneMcp();
  broadcast("status", { type: "settings" });
  res.json({
    ok: true,
    settings: {
      ...s,
      llm: { baseUrl: s.llm.baseUrl, model: s.llm.model, apiKey: maskApiKey(s.llm.apiKey), hasApiKey: Boolean(s.llm.apiKey) },
    },
  });
});

app.post("/api/llm/test", async (req, res) => {
  const body = (req.body ?? {}) as { baseUrl?: string; apiKey?: string; model?: string };
  const current = getLlmConfig();
  const baseUrl = (body.baseUrl || current.baseUrl || "").trim().replace(/\/$/, "");
  const apiKey =
    body.apiKey && !isMaskedKey(body.apiKey) ? body.apiKey.trim() : store.settings.llm.apiKey || current.apiKey;
  const model = (body.model || current.model || "").trim();
  if (!baseUrl || !apiKey) {
    return res.json({ ok: false, error: "Base URL 和 API Key 不能为空" });
  }
  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return res.json({ ok: false, status: r.status, error: text.slice(0, 200) });
    }
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- 打卡与提醒动作 ----
app.post("/api/checkin", (req, res) => {
  const theme = parseTheme(req.body?.theme);
  if (!theme) return res.status(400).json({ error: "theme 无效" });
  const source = CHECKIN_SOURCES.has(req.body?.source) ? req.body.source : "web";
  res.json({ ok: true, ...recordCheckin(theme, source) });
});

app.post("/api/snooze", (req, res) => {
  const theme = parseTheme(req.body?.theme);
  if (!theme) return res.status(400).json({ error: "theme 无效" });
  const minutes = snooze(theme, Number(req.body?.minutes) || 15);
  res.json({ ok: true, minutes });
});

app.post("/api/mute-today", (req, res) => {
  const theme = parseTheme(req.body?.theme);
  if (!theme) return res.status(400).json({ error: "theme 无效" });
  muteToday(theme);
  res.json({ ok: true });
});

app.post("/api/dnd", (req, res) => {
  const minutes = Number(req.body?.minutes);
  if (!Number.isFinite(minutes) || minutes < 0) {
    return res.status(400).json({ error: "minutes 需为非负数字" });
  }
  setDnd(minutes === 0 ? null : minutes);
  res.json({ ok: true, dndUntil: store.state.dndUntil });
});

app.post("/api/ring", (req, res) => {
  const theme = parseTheme(req.body?.theme);
  if (!theme) return res.status(400).json({ error: "theme 无效" });
  res.json({ ok: true, fired: fireReminder(theme, "manual") });
});

app.get("/api/checkins/today", (_req, res) => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const items = store.checkins
    .filter((c) => c.ts >= start.getTime())
    .map((c) => ({
      ts: c.ts,
      theme: c.theme,
      label: THEME_META[c.theme].label,
      emoji: THEME_META[c.theme].emoji,
      source: c.source,
    }))
    .reverse();
  res.json({ items });
});

app.get("/api/report/week", (_req, res) => {
  res.json(buildWeekReport());
});

// ---- SSE 实时事件 ----
app.get("/api/events", (req, res) => {
  sseInit(res);
  res.write(sseFrame("hello", { ts: Date.now() }));
  addClient(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => clearInterval(ping));
});

// ---- AI 对话（SSE：delta / tool_start / tool_end / message / error）----
const toolkit = buildToolkit();

app.post("/api/chat", async (req, res) => {
  const userMessages = (req.body?.messages ?? []) as { role: string; content: unknown }[];
  if (!Array.isArray(userMessages) || userMessages.length === 0) {
    return res.status(400).json({ error: "messages 不能为空" });
  }

  sseInit(res);
  const send = (event: string, data: unknown) => res.write(sseFrame(event, data));

  const controller = new AbortController();
  // Node 16+ 中 req 的 close 在请求体读完即触发，须监听 res 判断客户端断开
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  const noteoneKit = getNoteoneToolkit();
  const history: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt({ noteoneConnected: noteoneKit.tools.length > 0 }) },
    ...userMessages
      .filter(
        (m): m is { role: "user" | "assistant"; content: string } =>
          (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
      )
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content })),
  ];

  try {
    const answer = await runAgentLoop(
      history,
      [...toolkit.tools, ...noteoneKit.tools],
      { ...toolkit.handlers, ...noteoneKit.handlers },
      {
        maxIterations: 6,
        signal: controller.signal,
        onContentDelta: (text) => send("delta", { text }),
        onToolStart: (name, argsSummary) => send("tool_start", { name, argsSummary }),
        onToolEnd: (name, preview, durationMs) => send("tool_end", { name, preview, durationMs }),
      }
    );
    send("message", { content: answer });
  } catch (err) {
    if (err instanceof LLMNotConfiguredError) {
      send("error", { message: err.message, code: "llm_not_configured" });
    } else if (!controller.signal.aborted) {
      send("error", { message: err instanceof Error ? err.message : String(err) });
    }
  }
  res.end();
});

// ---- 节律引擎 ----
setInterval(() => tick(), 30_000);
setInterval(() => store.pruneOld(), 24 * 3600_000);

app.listen(config.port, () => {
  console.log(`🔔 壹铃 Bellone 已启动: http://localhost:${config.port}`);
  console.log(`   数据目录: ${config.dataDir}`);
  console.log(`   AI 助手: ${llmConfigured() ? `已配置 (${getLlmConfig().model})` : "未配置（可在设置页配置）"}`);
  void syncNoteoneMcp();
});
