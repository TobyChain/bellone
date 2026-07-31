import { describe, it, expect, beforeEach } from "vitest";
import { store, DEFAULT_SETTINGS } from "../src/store.js";
import { consumeCopy } from "../src/agent/copywriter.js";
import { fireReminder } from "../src/rhythm.js";

beforeEach(() => {
  store.settings = structuredClone(DEFAULT_SETTINGS);
  store.state.pendingCopy = {};
  store.fired = [];
});

describe("copywriter", () => {
  it("无缓存时返回 null，提醒回退模板", () => {
    expect(consumeCopy("water")).toBeNull();
    const r = fireReminder("water", "manual");
    expect(r.body).toContain("温水");
    expect(r.tip.startsWith("小贴士：")).toBe(true);
  });

  it("有新鲜缓存时消费并清除", () => {
    store.state.pendingCopy.water = { body: "定制文案", tip: "小贴士：定制贴士", ts: Date.now() };
    const r = fireReminder("water", "manual");
    expect(r.body).toBe("定制文案");
    expect(r.tip).toBe("小贴士：定制贴士");
    expect(store.state.pendingCopy.water).toBeUndefined();
  });

  it("过期缓存不使用", () => {
    store.state.pendingCopy.stand = { body: "旧文案", tip: "旧", ts: Date.now() - 25 * 3600_000 };
    const r = fireReminder("stand", "manual");
    expect(r.body).not.toBe("旧文案");
  });
});
