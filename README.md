# 壹铃 Bellone

> 用不同的铃声，提醒你和平地工作 —— 喝水、起身、远眺、拉伸，也提醒你停下过久的工作。

壹铃是一个**开盒即用**的本地健康节律助手：零数据库、零账号、一条命令启动。规则决定提醒什么，AI 负责把话说得自然。

与 `noteone / 壹识` 同属一个系列：壹识记录你的所思，壹铃提醒你的所需。

## 快速开始

```bash
npx bellone        # 发布后：一条命令直接运行（数据存 ~/.bellone）
```

或从源码运行：

```bash
npm install
npm start          # 打开 http://localhost:3210
```

就这样。不需要任何配置，提醒、打卡、周报即刻可用。

### 桌面版（Electron）

```bash
npm run app        # 本地运行桌面版（主窗口 + 右下角 belly 桌宠）
npm run dist:mac   # 打包 macOS dmg（输出 release/）
```

桌面版把 Express 作为子进程拉起，主窗口与透明置顶的 belly 桌宠窗口共享同一 SSE。数据存 `~/Library/Application Support/Bellone/data`。桌宠可拖动、点击唤起主窗口、右键隐藏（隐藏后提醒转为系统通知）；重复打开只会聚焦已有实例。

### 安装 dmg

1. 打开 `release/Bellone-0.1.0-arm64.dmg`，把 **Bellone** 拖到 **Applications**
2. 首次打开若被 Gatekeeper 拦（未签名）：**系统设置 → 隐私与安全性 → 仍要打开**，或终端执行一次：
   ```bash
   xattr -dr com.apple.quarantine /Applications/Bellone.app
   ```

### 自动更新

桌面版内置 `electron-updater`，启动后自动检查 [GitHub Releases](https://github.com/TobyChain/bellone/releases) 的新版本并后台下载，下载完成后退出即自动安装。更新只替换应用本体，不影响你的数据。

> 数据存放在 `~/Library/Application Support/Bellone/data`（应用包之外），升级/重装不会丢失提醒记录、打卡与配置。

### Homebrew 安装

发布后可通过自建 tap 安装（桌面 cask，走 GitHub Release 的 dmg）：

```bash
brew install --cask TobyChain/tap/bellone
```

> tap 仓库 `TobyChain/homebrew-tap` 需另建；cask 定义见 `homebrew/bellone.rb`（发版时更新 version 与 sha256）。

### 可选：开启 AI 助手（belly · 玲玲）

打开「设置 → AI 助手」，填入任意 OpenAI 兼容接口的 Base URL / API Key / 模型（DashScope / OpenAI / Ollama），点「测试连接」确认后保存即可，无需重启。也可以用 .env：

```bash
cp .env.example .env
# LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
# LLM_API_KEY=sk-xxx
# LLM_MODEL=qwen-plus
```

之后可以直接对壹铃说："我喝完水了"、"接下来开会 1 小时"、"把喝水间隔改成 30 分钟"。

## 功能

- **按节律提醒**：工作日 10:00–19:00（可配），喝水/起身/远眺/拉伸共用一个提醒频率、轮流敲铃
- **专属铃声**：每个主题一种 Web Audio 音色 —— 喝水是清泉双音，起身是上行三音，远眺是悠长单音，拉伸是轻快琶音
- **自动避让**：午休静默、下班静默、一键免打扰（开会时用）
- **互动打卡**：提醒卡片上点「已完成 / 稍后 / 今天不用了」，打卡 +10 健康值并回赠一条不重样的小贴士；打卡瞬间有轻量庆祝动效与音效（Fogg 行为模型的 celebration）
- **不焦虑的连续打卡**：每周允许 1 天自动补签不断链；刚打完卡 10 分钟内不再打扰（activity breakpoint 择机）
- **后台也能收到**：页面切走时自动转为系统通知（按主题去重，点击即回）
- **健康周报**：完成率、起身次数、最长连坐、连续打卡天数 + 一句话解读
- **belly 宠物助手（小名玲玲）**：右下角常驻的小铃铛精灵——AI 思考时抖动、回复完成摆铃、打卡陪你弹跳、提醒到点发光等待；点击展开聊天浮层，自然语言打卡、调节律、开免打扰、问数据（token 级流式回复；工具调用循环，杜绝编造数字；会记住你的偏好，动机访谈式话术，不说教）
- **设置页直接配置 AI**：填 Base URL / API Key / 模型三项即可，支持测试连接，保存立即生效无需重启；API Key 界面回显自动打码
- **自动接入 noteone（壹识）**：检测到本机 noteone 时自动通过 MCP 连接，belly 可帮你记笔记、搜笔记、看新知日报
- **MCP Server**：把壹铃接入 Claude Code / Cursor 等任意 MCP 客户端

## MCP 接入

```json
{
  "mcpServers": {
    "bellone": {
      "command": "npx",
      "args": ["tsx", "/path/to/bellone/src/mcp.ts"]
    }
  }
}
```

提供工具：`get_health_status` / `record_checkin` / `snooze_reminder` / `mute_theme_today` / `set_do_not_disturb` / `get_week_report`

另有 resources（`bellone://today`、`bellone://weekly-report`）与 prompt（`weekly-health-review` 周度健康复盘）。

## 架构

```
src/
├── index.ts        # Express API + SSE + 节律引擎 tick
├── rhythm.ts       # 提醒节律：间隔、静默、顺延、打卡、统计
├── tips.ts         # 贴士库（按主题轮换不重样）
├── report.ts       # 周报生成
├── store.ts        # JSON 文件存储（data/，零数据库）
├── events.ts       # SSE 广播
├── mcp.ts          # MCP stdio server
└── agent/
    ├── loop.ts     # Agent tool-calling 循环（doom-loop 检测、并行工具、流式回调）
    ├── llm.ts      # OpenAI 兼容客户端（token 流式、重试、聚合降级）
    ├── tools.ts    # 10 个健康工具（含偏好记忆）
    ├── copywriter.ts # 提醒文案预生成（记忆+依从性个性化）
    └── prompt.ts   # 系统提示词（实时快照 + 记忆注入 + MI 话术）
public/             # 无框架前端：侧边栏 + 提醒卡片 + 铃声 + AI 对话
tests/              # vitest 单测（npm test）
scripts/            # Playwright E2E 与 mock LLM（node scripts/e2e.mjs）
```

设计原则（来自「职场健康 Agent」实践）：

1. **规则决定提醒什么，AI 负责把话说得自然** —— 时间/间隔/计数/积分全部由确定性代码计算
2. **短任务接力** —— 每 30 秒一次轻量 tick，无常驻轮询负担
3. **即时小反馈** —— 贴士、健康值、连续天数，纯推送等于电子闹钟
