import { store, type ThemeKey } from "./store.js";
import { THEME_META } from "./tips.js";
import { computeStats } from "./rhythm.js";

export interface WeekReport {
  range: { from: string; to: string };
  firedCount: number;
  checkinCount: number;
  completionRate: number;
  activeDays: number;
  byTheme: Record<string, { fired: number; checkins: number; label: string }>;
  standCount: number;
  longestSitMinutes: number | null;
  streakDays: number;
  healthPoints: number;
  insight: string;
}

function weekStart(now = new Date()): Date {
  const d = new Date(now);
  const day = d.getDay() === 0 ? 7 : d.getDay();
  d.setDate(d.getDate() - (day - 1));
  d.setHours(0, 0, 0, 0);
  return d;
}

function fmt(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function buildWeekReport(now = new Date()): WeekReport {
  const from = weekStart(now);
  const fromTs = from.getTime();
  const fired = store.fired.filter((f) => f.ts >= fromTs);
  const checkins = store.checkins.filter((c) => c.ts >= fromTs);

  const byTheme: WeekReport["byTheme"] = {};
  for (const theme of Object.keys(THEME_META) as ThemeKey[]) {
    byTheme[theme] = {
      label: THEME_META[theme].label,
      fired: fired.filter((f) => f.theme === theme).length,
      checkins: checkins.filter((c) => c.theme === theme).length,
    };
  }

  const standTimes = checkins
    .filter((c) => c.theme === "stand")
    .map((c) => c.ts)
    .sort((a, b) => a - b);
  let longestSitMinutes: number | null = null;
  for (let i = 1; i < standTimes.length; i++) {
    const gap = Math.round((standTimes[i] - standTimes[i - 1]) / 60_000);
    if (gap < 12 * 60 && (longestSitMinutes === null || gap > longestSitMinutes)) {
      longestSitMinutes = gap;
    }
  }

  const stats = computeStats();
  const completionRate =
    fired.length === 0 ? 0 : Math.min(100, Math.round((checkins.length / fired.length) * 100));

  let insight: string;
  if (fired.length === 0) {
    insight = "本周还没有提醒记录，先在设置里确认提醒时段，让壹铃开始为你敲铃吧。";
  } else if (completionRate >= 80) {
    insight = `完成率 ${completionRate}%，非常棒！身体的"自动驾驶"已经稳定巡航，继续保持。`;
  } else if (completionRate >= 50) {
    insight = `完成率 ${completionRate}%，及格线以上。试试在提醒响起时立刻起身，别让"稍后"变成"算了"。`;
  } else {
    insight = `完成率 ${completionRate}%，铃声响了但人没动~ 下周挑一个最容易做到的主题（比如喝水）先攒起连续打卡。`;
  }
  if (longestSitMinutes !== null && longestSitMinutes > 90) {
    insight += ` 另外，本周最长一次连坐了 ${longestSitMinutes} 分钟，久坐提醒值得优先响应。`;
  }

  return {
    range: { from: fmt(from), to: fmt(now) },
    firedCount: fired.length,
    checkinCount: checkins.length,
    completionRate,
    activeDays: new Set(checkins.map((c) => new Date(c.ts).toDateString())).size,
    byTheme,
    standCount: byTheme.stand.checkins,
    longestSitMinutes,
    streakDays: stats.streakDays,
    healthPoints: stats.healthPoints,
    insight,
  };
}
