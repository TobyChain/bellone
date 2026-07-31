import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:3213";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => check("页面无 JS 错误", false, e.message));

await page.goto(BASE, { waitUntil: "networkidle" });

// belly 常驻且初始 idle
check("belly 常驻右下角", await page.locator("#belly").isVisible());
check("belly 初始 idle", await page.locator("#belly.idle").count() === 1);

// 点击 belly 打开聊天浮层
await page.click("#belly");
await page.waitForSelector("#belly-panel:not([hidden])", { timeout: 3000 });
check("点击 belly 打开聊天浮层", true);
check("LLM 已配置时无警示", await page.locator("#llm-hint").isHidden());

await page.fill("#chat-text", "我喝完水了");
await page.press("#chat-text", "Enter");

// 发送后 belly 进入 running
await page.waitForSelector("#belly.running", { timeout: 3000 });
check("发送后 belly running", true);

await page.waitForSelector(".msg.user", { timeout: 5000 });
check("用户消息上屏", (await page.textContent(".msg.user")) === "我喝完水了");

await page.waitForFunction(
  () => [...document.querySelectorAll(".msg.assistant")].some((m) => m.textContent.includes("已帮你打卡")),
  { timeout: 15000 }
);
const assistants = await page.locator(".msg.assistant").allTextContents();
check("流式助手回复", assistants.some((t) => t.includes("好的，已帮你打卡喝水")), assistants.at(-1));
const dupCount = assistants.filter((t) => t.includes("已帮你打卡")).length;
check("无重复气泡", dupCount === 1, `count=${dupCount}`);
check("思考中提示已清除", (await page.locator(".msg.tool").count()) === 0);

// 回复完成 belly waving（2.5s 瞬态，允许已回落 idle）
const bellyClass = await page.getAttribute("#belly", "class");
check("回复后 belly waving/idle", /waving|idle|jumping/.test(bellyClass), bellyClass);

// 打卡应同步到侧边栏
await page.waitForFunction(() => Number(document.querySelector("#s-checkins").textContent) >= 1, { timeout: 5000 });
check("打卡同步侧边栏统计", true);

// 会话保留：关闭再打开面板，消息不丢
const msgCount = await page.locator("#chat-messages .msg").count();
await page.click("#belly-close");
await page.waitForSelector("#belly-panel", { state: "hidden", timeout: 2000 });
await page.click("#belly");
await page.waitForSelector("#belly-panel:not([hidden])", { timeout: 2000 });
const msgCount2 = await page.locator("#chat-messages .msg").count();
check("面板重开会话保留", msgCount2 === msgCount, `${msgCount} -> ${msgCount2}`);

await page.screenshot({ path: "/tmp/bellone-chat.png" });
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
