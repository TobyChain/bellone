import { chromium } from "playwright";

const BASE = "http://localhost:3210";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
page.on("pageerror", (e) => check("页面无 JS 错误", false, e.message));

// 1. 首页渲染
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector(".theme-card", { timeout: 5000 });
const brand = await page.textContent(".brand-name");
const cardCount = await page.locator(".theme-card").count();
check("侧边栏品牌渲染", brand.trim() === "壹铃", `brand=${brand.trim()}`);
check("今日主题卡渲染", cardCount === 4, `count=${cardCount}`);

// 2. 打卡按钮 → mini toast + 统计更新 + belly jumping
const before = Number(await page.textContent("#s-checkins"));
await page.click('.theme-card .chip.primary');
await page.waitForSelector("#belly.jumping", { timeout: 3000 }).then(
  () => check("打卡触发 belly jumping", true),
  () => check("打卡触发 belly jumping", false, "未捕获到 jumping")
);
await page.waitForSelector("#mini-toast:not([hidden])", { timeout: 5000 });
const toastText = await page.textContent("#mini-toast");
await page.waitForFunction(
  (b) => Number(document.querySelector("#s-checkins").textContent) === b + 1,
  before,
  { timeout: 5000 }
);
check("打卡 mini toast", toastText.includes("已记录"), toastText.slice(0, 40));
check("侧边栏统计 +1", true, `${before} -> ${before + 1}`);

// 3. SSE 提醒卡片 + belly waiting
await page.evaluate(() =>
  fetch("/api/ring", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme: "eyes" }),
  })
);
await page.waitForSelector(".toast", { timeout: 5000 });
const toastTitle = await page.textContent(".toast .toast-title");
check("SSE 提醒卡片弹出", toastTitle.includes("远眺"), toastTitle);
check("提醒时 belly waiting", (await page.locator("#belly.waiting").count()) === 1);
check("belly 气泡显示提醒", !(await page.locator("#belly-bubble").isHidden()));
const actions = await page.locator(".toast .toast-actions button").allTextContents();
check("提醒卡片三按钮", actions.join(",") === "已完成,稍后,今天不用了", actions.join("/"));
await page.click('.toast [data-act="later"]');
await page.waitForSelector(".toast", { state: "detached", timeout: 3000 });
await page.waitForSelector("#belly.idle", { timeout: 3000 });
check("点击「稍后」后 belly 回 idle", true);

// 4. 设置页修改并保存
await page.click('[data-page="settings"]');
await page.fill("#set-interval", "50");
await page.click("#btn-save");
await page.waitForSelector("#mini-toast:not([hidden])", { timeout: 5000 });
await page.reload({ waitUntil: "networkidle" });
await page.click('[data-page="settings"]');
const saved = await page.inputValue("#set-interval");
check("共用频率保存并持久化", saved === "50", `interval=${saved}`);
// 还原
await page.fill("#set-interval", "45");
await page.click("#btn-save");

// 5. 周报页渲染
await page.click('[data-page="report"]');
await page.waitForSelector(".metric b", { timeout: 5000 });
const metricCount = await page.locator(".metric").count();
const insight = await page.textContent("#report-insight");
check("周报指标卡渲染", metricCount === 6, `metrics=${metricCount}`);
check("周报解读文案", insight.trim().length > 5, insight.slice(0, 40));

// 6. 设置页 AI 助手卡：保存 + 掩码回显
await page.click('[data-page="settings"]');
await page.fill("#set-llm-baseUrl", "http://localhost:9/v1");
await page.fill("#set-llm-apiKey", "sk-e2e-test-key-12345");
await page.fill("#set-llm-model", "test-model");
await page.click("#btn-save");
await page.waitForSelector("#mini-toast:not([hidden])", { timeout: 5000 });
await page.reload({ waitUntil: "networkidle" });
await page.click('[data-page="settings"]');
const maskedKey = await page.inputValue("#set-llm-apiKey");
check("apiKey 掩码回显", maskedKey.includes("****") && !maskedKey.includes("test-key"), maskedKey);
check("baseUrl 持久化", (await page.inputValue("#set-llm-baseUrl")) === "http://localhost:9/v1");
check("noteone 状态渲染", ((await page.textContent("#noteone-status")) || "").trim().length > 0);
// 还原（清空 llm 配置，掩码 key 不会覆盖真实清空——直接置空 baseUrl/model 即可让 llmConfigured 回 false 由 env 决定）
await page.evaluate(() =>
  fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ llm: { baseUrl: "", model: "" } }),
  })
);

await page.screenshot({ path: "/tmp/bellone-ui.png", fullPage: false });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
