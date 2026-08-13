import { describe, it, expect, afterEach } from "vitest";
import { getLlmConfig, setLlmOverride, llmConfigured, maskApiKey, isMaskedKey } from "../src/config.js";

afterEach(() => {
  setLlmOverride(null);
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL;
});

describe("getLlmConfig", () => {
  it("无 override 时回退 env", () => {
    process.env.LLM_BASE_URL = "http://env-host/v1/";
    process.env.LLM_API_KEY = "env-key";
    const c = getLlmConfig();
    expect(c.baseUrl).toBe("http://env-host/v1");
    expect(c.apiKey).toBe("env-key");
    expect(c.model).toBe("qwen-plus");
  });

  it("override 非空字段优先，空字段回退 env", () => {
    process.env.LLM_BASE_URL = "http://env-host/v1";
    process.env.LLM_API_KEY = "env-key";
    setLlmOverride({ baseUrl: "http://settings-host/v1", apiKey: "", model: "my-model" });
    const c = getLlmConfig();
    expect(c.baseUrl).toBe("http://settings-host/v1");
    expect(c.apiKey).toBe("env-key");
    expect(c.model).toBe("my-model");
  });

  it("llmConfigured 需要 baseUrl+apiKey 同时存在", () => {
    expect(llmConfigured()).toBe(false);
    setLlmOverride({ baseUrl: "http://x", apiKey: "k", model: "" });
    expect(llmConfigured()).toBe(true);
  });
});

describe("maskApiKey / isMaskedKey", () => {
  it("空串返回空串", () => {
    expect(maskApiKey("")).toBe("");
  });
  it("短 key 全掩码", () => {
    expect(maskApiKey("short")).toBe("****");
  });
  it("长 key 保留首尾各 4 位", () => {
    expect(maskApiKey("sk-1234567890abcd")).toBe("sk-1****abcd");
  });
  it("isMaskedKey 识别掩码", () => {
    expect(isMaskedKey("sk-1****abcd")).toBe(true);
    expect(isMaskedKey("****")).toBe(true);
    expect(isMaskedKey("sk-realkey")).toBe(false);
    expect(isMaskedKey(123)).toBe(false);
  });
});
