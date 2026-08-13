import { describe, it, expect, beforeEach } from "vitest";
import { store, DEFAULT_SETTINGS } from "../src/store.js";
import { tick, quietStatus, snooze, muteToday, recordCheckin, computeStats, computeNextGap } from "../src/rhythm.js";
import { setLlmOverride } from "../src/config.js";

function at(hours: number, minutes: number): Date {
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return d;
}

// 固定随机源：始终取候选列表首项，保证测试确定性
const firstPick = () => 0;

beforeEach(() => {
  store.settings = structuredClone(DEFAULT_SETTINGS);
  store.settings.workDays = [0, 1, 2, 3, 4, 5, 6];
  store.settings.reminderIntervalMin = 45;
  store.state.lastReminderAt = 0;
  store.state.nextGapMs = 0;
  store.state.lastTheme = null;
  store.state.globalSnoozeUntil = null;
  store.state.mutedTodayDate = null;
  store.state.mutedThemes = [];
  store.state.dndUntil = null;
  store.checkins = [];
  store.fired = [];
  setLlmOverride(null);
});

describe("quietStatus", () => {
  it("工作时段内不静默", () => {
    expect(quietStatus(at(11, 0)).quiet).toBe(false);
  });
  it("午休静默", () => {
    const q = quietStatus(at(12, 30));
    expect(q.quiet).toBe(true);
    expect(q.reason).toBe("午休静默");
  });
  it("下班后静默", () => {
    expect(quietStatus(at(20, 0)).quiet).toBe(true);
  });
  it("免打扰期间静默", () => {
    store.state.dndUntil = Date.now() + 60_000;
    expect(quietStatus(at(11, 0)).quiet).toBe(true);
  });
});

describe("tick（共用频率）", () => {
  it("距工作开始达到共用频率后触发一次", () => {
    // 10:00 上班，共用 45 分钟 → 10:44 未到，10:46 到点
    tick(at(10, 44), firstPick);
    expect(store.fired.length).toBe(0);
    tick(at(10, 46), firstPick);
    expect(store.fired.length).toBe(1);
  });

  it("单次 tick 只触发一个动作，且共用频率内不重复", () => {
    tick(at(11, 0), firstPick);
    expect(store.fired.length).toBe(1);
    tick(at(11, 1), firstPick); // 距上次仅 1 分钟，未到共用频率
    expect(store.fired.length).toBe(1);
  });

  it("动作在共用频率下轮换，避开上一次", () => {
    tick(at(11, 0), firstPick); // enabled: water/stand/eyes（stretch 默认关）→ 首项 water
    const first = store.fired[0].theme;
    expect(first).toBe("water");
    // 45 分钟后再触发，应避开 water
    tick(at(11, 46), firstPick);
    expect(store.fired.length).toBe(2);
    expect(store.fired[1].theme).not.toBe("water");
  });

  it("全局顺延（稍后）期间不触发", () => {
    snooze("water", 30);
    tick(at(11, 0), firstPick);
    expect(store.fired.length).toBe(0);
  });

  it("今日静音的动作不参与轮换", () => {
    // 关掉除 water 外的动作，再静音 water → 无可选动作
    store.settings.themes.stand.enabled = false;
    store.settings.themes.eyes.enabled = false;
    muteToday("water");
    tick(at(11, 0), firstPick);
    expect(store.fired.length).toBe(0);
  });

  it("所有动作关闭时不触发", () => {
    for (const t of ["water", "stand", "eyes", "stretch"] as const) store.settings.themes[t].enabled = false;
    tick(at(11, 0), firstPick);
    expect(store.fired.length).toBe(0);
  });
});

describe("computeNextGap", () => {
  it("无 AI：在基础频率 ±25% 之间", () => {
    const base = 45 * 60_000;
    expect(computeNextGap(() => 0)).toBe(Math.round(base * 0.75));
    expect(computeNextGap(() => 1)).toBe(Math.round(base * 1.25));
  });

  it("有 AI 且依从差：拉长间隔（少打扰）", () => {
    setLlmOverride({ baseUrl: "http://x", apiKey: "k", model: "m" });
    const base = 45 * 60_000;
    // 近 3 天：提醒 10 次只打卡 1 次 → 依从 0.1 < 0.4 → ×1.6
    const now = Date.now();
    for (let i = 0; i < 10; i++) store.fired.push({ ts: now - 3600_000, theme: "water" });
    store.checkins.push({ ts: now - 3600_000, theme: "water", source: "t" });
    expect(computeNextGap()).toBe(Math.round(base * 1.6));
  });

  it("有 AI 且依从好：略缩短", () => {
    setLlmOverride({ baseUrl: "http://x", apiKey: "k", model: "m" });
    const base = 45 * 60_000;
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      store.fired.push({ ts: now - 3600_000, theme: "water" });
      store.checkins.push({ ts: now - 3600_000, theme: "water", source: "t" });
    }
    expect(computeNextGap()).toBe(Math.round(base * 0.9));
  });
});

describe("checkin 与统计", () => {
  it("打卡累计健康值并清除全局顺延", () => {
    snooze("water", 60);
    const r = recordCheckin("water", "test");
    expect(r.healthPoints).toBe(10);
    expect(r.todayCount).toBe(1);
    expect(store.state.globalSnoozeUntil).toBeNull();
    expect(computeStats().streakDays).toBe(1);
  });

  it("宽容型 streak：每周允许 1 天缺勤不断链", () => {
    const day = 24 * 3600_000;
    const now = Date.now();
    for (const offset of [0, 1, 3, 4]) {
      store.checkins.push({ ts: now - offset * day, theme: "water", source: "t" });
    }
    expect(computeStats().streakDays).toBe(4);
  });

  it("连续两天缺勤则断链", () => {
    const day = 24 * 3600_000;
    const now = Date.now();
    for (const offset of [0, 1, 4, 5]) {
      store.checkins.push({ ts: now - offset * day, theme: "water", source: "t" });
    }
    expect(computeStats().streakDays).toBe(2);
  });

  it("breakpoint 顺延：打卡后 10 分钟内不触发新提醒", () => {
    recordCheckin("water", "test");
    store.fired = [];
    tick(at(11, 0), firstPick);
    expect(store.fired.length).toBe(0);
  });
});
