import { store, type ThemeKey, THEME_KEYS } from "./store.js";
import { THEME_META, pickTip } from "./tips.js";
import { broadcast } from "./events.js";
import { consumeCopy, scheduleCopyGeneration } from "./agent/copywriter.js";
import { gateReminder } from "./agent/heartbeat.js";
import { llmConfigured } from "./config.js";

export const POINTS_PER_CHECKIN = 10;

function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

function todayStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startOfDay(d = new Date()): number {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return s.getTime();
}

export interface QuietInfo {
  quiet: boolean;
  reason: string | null;
}

export function quietStatus(now = new Date()): QuietInfo {
  const s = store.settings;
  if (!s.workDays.includes(now.getDay())) return { quiet: true, reason: "非工作日" };
  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins < hmToMinutes(s.workStart) || mins >= hmToMinutes(s.workEnd)) {
    return { quiet: true, reason: "非提醒时段" };
  }
  if (mins >= hmToMinutes(s.lunchStart) && mins < hmToMinutes(s.lunchEnd)) {
    return { quiet: true, reason: "午休静默" };
  }
  if (store.state.dndUntil && now.getTime() < store.state.dndUntil) {
    return { quiet: true, reason: "免打扰中" };
  }
  return { quiet: false, reason: null };
}

function resetDailyMuteIfNeeded(now: Date): void {
  const today = todayStr(now);
  if (store.state.mutedTodayDate && store.state.mutedTodayDate !== today) {
    store.state.mutedTodayDate = null;
    store.state.mutedThemes = [];
    store.saveState();
  }
}

export function fireReminder(theme: ThemeKey, reason: "due" | "manual" = "due", now = new Date()): {
  theme: ThemeKey;
  title: string;
  body: string;
  tip: string;
} {
  const meta = THEME_META[theme];
  const ts = now.getTime();
  const personalized = consumeCopy(theme);
  const payload = {
    theme,
    title: `${meta.emoji} ${meta.label}提醒`,
    body: personalized?.body ?? meta.action,
    tip: personalized?.tip ?? `小贴士：${pickTip(theme)}`,
  };
  store.state.lastReminderAt = ts;
  store.state.lastTheme = theme;
  store.fired.push({ ts, theme });
  store.saveState();
  store.saveFired();
  broadcast("reminder", { ...payload, reason });
  scheduleCopyGeneration(theme);
  return payload;
}

function baseGapMs(): number {
  return Math.max(5, store.settings.reminderIntervalMin) * 60_000;
}

/** 近 3 天依从率（打卡/提醒），无提醒记录时视为正常 */
function recentAdherence(): number {
  const since = Date.now() - 3 * 24 * 3600_000;
  const fired = store.fired.filter((f) => f.ts >= since).length;
  if (fired === 0) return 1;
  const done = store.checkins.filter((c) => c.ts >= since).length;
  return Math.min(1, done / fired);
}

/** 计算下一次提醒间隔：无 AI ±25% 随机；有 AI 依从差则拉长（少打扰） */
export function computeNextGap(rand: () => number = Math.random): number {
  const base = baseGapMs();
  if (!llmConfigured()) {
    return Math.round(base * (0.75 + rand() * 0.5));
  }
  const a = recentAdherence();
  const factor = a < 0.4 ? 1.6 : a < 0.7 ? 1.25 : a > 0.85 ? 0.9 : 1.0;
  return Math.round(base * factor);
}

function scheduleNextGap(rand: () => number = Math.random): void {
  store.state.nextGapMs = computeNextGap(rand);
  store.saveState();
}

function eligibleThemes(now: Date): ThemeKey[] {
  const today = todayStr(now);
  return THEME_KEYS.filter((t) => {
    if (!store.settings.themes[t].enabled) return false;
    if (store.state.mutedThemes.includes(t) && store.state.mutedTodayDate === today) return false;
    return true;
  });
}

/** 从启用动作里随机挑一个，尽量避开上次（动作逻辑相似，共用频率轮换即可） */
function pickTheme(now: Date, rand: () => number): ThemeKey | null {
  const pool = eligibleThemes(now);
  if (pool.length === 0) return null;
  const avoid = store.state.lastTheme;
  const choices = pool.length > 1 && avoid ? pool.filter((t) => t !== avoid) : pool;
  return choices[Math.floor(rand() * choices.length)];
}

/** 全局共用频率：到点从启用动作中挑一个提醒（有 AI 时经 SPEAK/HOLD 门控） */
export function tick(now = new Date(), rand: () => number = Math.random): void {
  resetDailyMuteIfNeeded(now);
  if (quietStatus(now).quiet) return;

  const nowTs = now.getTime();
  // breakpoint 顺延：刚打过卡说明用户正处理健康事项，10 分钟内不再打扰
  const lastCheckin = store.checkins[store.checkins.length - 1];
  if (lastCheckin && nowTs - lastCheckin.ts < 10 * 60_000) return;
  // 全局顺延（用户点了「稍后」）
  if (store.state.globalSnoozeUntil && nowTs < store.state.globalSnoozeUntil) return;

  const workStartToday = new Date(now);
  {
    const [h, m] = store.settings.workStart.split(":").map(Number);
    workStartToday.setHours(h, m, 0, 0);
  }
  const anchor = Math.max(store.state.lastReminderAt || 0, workStartToday.getTime());
  const gap = store.state.nextGapMs || baseGapMs();
  if (nowTs - anchor < gap) return;

  const theme = pickTheme(now, rand);
  if (!theme) return;

  if (!llmConfigured()) {
    fireReminder(theme, "due", now);
    scheduleNextGap(rand);
    return;
  }
  // 心跳式降噪：LLM 判定 SPEAK/HOLD，判定期间防重入，HOLD 顺延 10 分钟后再评估
  if (gating) return;
  gating = true;
  void gateReminder(theme)
    .then((decision) => {
      if (decision === "SPEAK") {
        fireReminder(theme, "due");
        scheduleNextGap(rand);
      } else {
        const holdGap = store.state.nextGapMs || baseGapMs();
        store.state.lastReminderAt = Date.now() - Math.max(0, holdGap - 10 * 60_000);
        store.saveState();
        broadcast("status", { type: "held", theme });
      }
    })
    .finally(() => {
      gating = false;
    });
}

let gating = false;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** 全局顺延：用户点「稍后」时整体延后（动作共用频率，无需按主题分别顺延） */
export function snooze(_theme: ThemeKey, minutes: number): number {
  const m = clamp(Math.round(minutes) || 15, 1, 480);
  store.state.globalSnoozeUntil = Date.now() + m * 60_000;
  store.saveState();
  broadcast("status", { type: "snoozed", minutes: m });
  return m;
}

export function muteToday(theme: ThemeKey): void {
  const today = todayStr();
  if (store.state.mutedTodayDate !== today) {
    store.state.mutedTodayDate = today;
    store.state.mutedThemes = [];
  }
  if (!store.state.mutedThemes.includes(theme)) store.state.mutedThemes.push(theme);
  store.saveState();
  broadcast("status", { type: "muted_today", theme });
}

export function setDnd(minutes: number | null): void {
  const m = minutes === null ? null : clamp(Math.round(minutes), 1, 720);
  store.state.dndUntil = m === null ? null : Date.now() + m * 60_000;
  store.saveState();
  broadcast("status", { type: "dnd", until: store.state.dndUntil });
}

export function recordCheckin(theme: ThemeKey, source = "web"): {
  todayCount: number;
  healthPoints: number;
  streakDays: number;
  pointsAdded: number;
  tip: string;
} {
  store.checkins.push({ ts: Date.now(), theme, source });
  store.saveCheckins();
  store.state.globalSnoozeUntil = null;
  const tip = pickTip(theme);
  store.saveState();

  const stats = computeStats();
  broadcast("status", {
    type: "checkin",
    theme,
    todayCount: stats.todayCheckins,
    healthPoints: stats.healthPoints,
  });
  return {
    todayCount: stats.todayCheckins,
    healthPoints: stats.healthPoints,
    streakDays: stats.streakDays,
    pointsAdded: POINTS_PER_CHECKIN,
    tip,
  };
}

export function computeStats(): {
  healthPoints: number;
  streakDays: number;
  todayCheckins: number;
  todayFired: number;
} {
  const todayStart = startOfDay();
  const healthPoints = store.checkins.length * POINTS_PER_CHECKIN;

  const days = new Set<string>();
  let todayCheckins = 0;
  for (const c of store.checkins) {
    days.add(todayStr(new Date(c.ts)));
    if (c.ts >= todayStart) todayCheckins += 1;
  }
  // 宽容型 streak：每个自然周允许 1 天自动补签（不加天数但不断链），消解 streak 焦虑
  let streakDays = 0;
  const usedFreeze = new Set<string>();
  const weekKey = (d: Date) => {
    const w = new Date(d);
    const day = w.getDay() === 0 ? 7 : w.getDay();
    w.setDate(w.getDate() - (day - 1));
    return todayStr(w);
  };
  const cursor = new Date();
  if (!days.has(todayStr(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (true) {
    if (days.has(todayStr(cursor))) {
      streakDays += 1;
    } else {
      const wk = weekKey(cursor);
      const prev = new Date(cursor);
      prev.setDate(prev.getDate() - 1);
      if (usedFreeze.has(wk) || !days.has(todayStr(prev))) break;
      usedFreeze.add(wk);
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  let todayFired = 0;
  for (const f of store.fired) if (f.ts >= todayStart) todayFired += 1;

  return { healthPoints, streakDays, todayCheckins, todayFired };
}
