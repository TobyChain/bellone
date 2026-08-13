import { describe, it, expect, beforeEach } from "vitest";
import { store, DEFAULT_SETTINGS } from "../src/store.js";
import { buildWeekReport } from "../src/report.js";

beforeEach(() => {
  store.settings = structuredClone(DEFAULT_SETTINGS);
  store.checkins = [];
  store.fired = [];
});

describe("buildWeekReport", () => {
  it("空数据不崩溃", () => {
    const r = buildWeekReport();
    expect(r.firedCount).toBe(0);
    expect(r.completionRate).toBe(0);
    expect(r.longestSitMinutes).toBeNull();
    expect(r.insight).toContain("还没有提醒记录");
  });

  it("主动打卡多于提醒时完成率封顶 100%", () => {
    const now = Date.now();
    store.fired = [{ ts: now - 3600_000, theme: "water" }];
    store.checkins = [
      { ts: now - 3600_000, theme: "water", source: "t" },
      { ts: now - 1800_000, theme: "stand", source: "t" },
    ];
    expect(buildWeekReport().completionRate).toBe(100);
  });

  it("计算完成率与最长连坐", () => {
    const now = Date.now();
    store.fired = [
      { ts: now - 3 * 3600_000, theme: "water" },
      { ts: now - 2 * 3600_000, theme: "stand" },
      { ts: now - 1 * 3600_000, theme: "stand" },
      { ts: now - 30 * 60_000, theme: "water" },
    ];
    store.checkins = [
      { ts: now - 3 * 3600_000, theme: "water", source: "t" },
      { ts: now - 2 * 3600_000, theme: "stand", source: "t" },
      { ts: now - 10 * 60_000, theme: "stand", source: "t" },
    ];
    const r = buildWeekReport();
    expect(r.firedCount).toBe(4);
    expect(r.checkinCount).toBe(3);
    expect(r.completionRate).toBe(75);
    expect(r.standCount).toBe(2);
    expect(r.longestSitMinutes).toBe(110); // 两次 stand 打卡间隔
    expect(r.byTheme.water.fired).toBe(2);
  });
});
