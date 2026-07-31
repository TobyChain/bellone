import { describe, it, expect, beforeEach } from "vitest";
import { store, DEFAULT_SETTINGS, applySettingsPatch } from "../src/store.js";
import { llmConfigured, setLlmOverride } from "../src/config.js";

beforeEach(() => {
  store.settings = structuredClone(DEFAULT_SETTINGS);
  setLlmOverride(null);
});

describe("applySettingsPatch llm 字段", () => {
  it("allowLlm:true 时写入并生效", () => {
    applySettingsPatch(
      { llm: { baseUrl: "http://host/v1/", apiKey: "sk-realkey123456", model: "m1" } },
      { allowLlm: true }
    );
    expect(store.settings.llm.baseUrl).toBe("http://host/v1");
    expect(store.settings.llm.apiKey).toBe("sk-realkey123456");
    expect(llmConfigured()).toBe(true);
  });

  it("未开 allowLlm 时忽略 llm 字段（agent 工具不能改 key）", () => {
    applySettingsPatch({ llm: { apiKey: "sk-hacked" } });
    expect(store.settings.llm.apiKey).toBe("");
  });

  it("掩码 apiKey 不覆盖旧值", () => {
    store.settings.llm.apiKey = "sk-realkey123456";
    applySettingsPatch({ llm: { apiKey: "sk-r****3456", baseUrl: "http://new/v1" } }, { allowLlm: true });
    expect(store.settings.llm.apiKey).toBe("sk-realkey123456");
    expect(store.settings.llm.baseUrl).toBe("http://new/v1");
  });

  it("空 apiKey 不清空旧值", () => {
    store.settings.llm.apiKey = "sk-realkey123456";
    applySettingsPatch({ llm: { apiKey: "" } }, { allowLlm: true });
    expect(store.settings.llm.apiKey).toBe("sk-realkey123456");
  });

  it("noteoneMcp.enabled 可开关", () => {
    expect(store.settings.noteoneMcp.enabled).toBe(true);
    applySettingsPatch({ noteoneMcp: { enabled: false } });
    expect(store.settings.noteoneMcp.enabled).toBe(false);
  });
});
