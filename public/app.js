const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let status = null;
let settingsDraft = null;

const DAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

/* ---------- 铃声（Web Audio，每个主题专属音色） ---------- */
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
function tone(ctx, freq, start, dur, gain = 0.18, type = "sine") {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, ctx.currentTime + start);
  g.gain.linearRampToValueAtTime(gain, ctx.currentTime + start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(ctx.currentTime + start);
  osc.stop(ctx.currentTime + start + dur + 0.05);
}
const BELLS = {
  water: (ctx) => { tone(ctx, 880, 0, 0.5); tone(ctx, 660, 0.25, 0.7); },
  stand: (ctx) => { tone(ctx, 523, 0, 0.3); tone(ctx, 659, 0.18, 0.3); tone(ctx, 784, 0.36, 0.55); },
  eyes: (ctx) => { tone(ctx, 432, 0, 1.4, 0.15); tone(ctx, 864, 0, 0.8, 0.05); },
  stretch: (ctx) => { tone(ctx, 587, 0, 0.22); tone(ctx, 740, 0.15, 0.22); tone(ctx, 880, 0.3, 0.22); tone(ctx, 1175, 0.45, 0.5, 0.12); },
};
function ringBell(theme) {
  if (status && !status.settings.soundEnabled) return;
  try {
    const ctx = ensureAudio();
    (BELLS[theme] || BELLS.water)(ctx);
  } catch { /* 浏览器限制时静默 */ }
}
document.addEventListener("click", () => { try { ensureAudio(); } catch {} }, { once: true });

/* ---------- 打卡庆祝（Fogg celebration：即时、轻量、不打断） ---------- */
function celebrationChime() {
  if (status && !status.settings.soundEnabled) return;
  try {
    const ctx = ensureAudio();
    tone(ctx, 784, 0, 0.12, 0.12);
    tone(ctx, 988, 0.09, 0.12, 0.12);
    tone(ctx, 1319, 0.18, 0.3, 0.14);
  } catch {}
}
function celebrate(streakDays) {
  celebrationChime();
  const burst = document.createElement("div");
  burst.className = "burst";
  const colors = ["#f6c453", "#30d158", "#0a84ff", "#ff9f0a", "#ff375f", "#5e5ce6"];
  for (let i = 0; i < 10; i++) {
    const s = document.createElement("span");
    s.className = "dot";
    s.style.background = colors[i % colors.length];
    s.style.setProperty("--dx", `${(Math.random() - 0.5) * 260}px`);
    s.style.setProperty("--dy", `${-60 - Math.random() * 160}px`);
    s.style.animationDelay = `${Math.random() * 0.1}s`;
    burst.appendChild(s);
  }
  document.body.appendChild(burst);
  setTimeout(() => burst.remove(), 1200);
  if (streakDays === 7 || streakDays === 30) {
    miniToast(`里程碑达成：连续打卡 ${streakDays} 天，身体正在悄悄感谢你`);
  }
  setBellyState("jumping");
  bellySay("+10 健康值，干得漂亮", 3000);
}

/* ---------- belly 宠物状态机 ---------- */
const BELLY_TRANSIENT = { waving: 2500, jumping: 1200, failed: 4000 };
const BELLY_PRIORITY = { failed: 5, waiting: 4, running: 3, jumping: 2, waving: 2, idle: 0 };
const bellyState = { current: "idle", timer: null };

function setBellyState(state) {
  const el = $("#belly");
  if (!el) return;
  if (
    bellyState.current === "running" &&
    (state === "jumping" || state === "waving") &&
    BELLY_PRIORITY[state] < BELLY_PRIORITY.running
  ) {
    return; // AI 忙时不被低优先级瞬态打断
  }
  clearTimeout(bellyState.timer);
  el.classList.remove("idle", "running", "waving", "jumping", "failed", "waiting", "talking");
  el.classList.add(state);
  bellyState.current = state;
  const ttl = BELLY_TRANSIENT[state];
  if (ttl) {
    bellyState.timer = setTimeout(() => setBellyState("idle"), ttl);
  }
}

function setBellyTalking(on) {
  $("#belly")?.classList.toggle("talking", on);
}

let bellyBubbleTimer = null;
function bellySay(text, ms = 6000) {
  const bubble = $("#belly-bubble");
  if (!bubble || !text) return;
  bubble.textContent = text.length > 60 ? `${text.slice(0, 60)}…` : text;
  bubble.hidden = false;
  clearTimeout(bellyBubbleTimer);
  bellyBubbleTimer = setTimeout(() => { bubble.hidden = true; }, ms);
}

function bellyPanelOpen() {
  return !$("#belly-panel").hidden;
}

$("#belly").addEventListener("click", () => {
  const panel = $("#belly-panel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) {
    if (bellyState.current === "waiting") setBellyState("idle");
    $("#belly-bubble").hidden = true;
    $("#chat-text").focus();
    $("#chat-messages").scrollTop = $("#chat-messages").scrollHeight;
  }
});
$("#belly-close").addEventListener("click", () => { $("#belly-panel").hidden = true; });

/* ---------- 导航 ---------- */
$$(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$(".nav-item").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    $$(".page").forEach((p) => p.classList.remove("active"));
    $(`#page-${btn.dataset.page}`).classList.add("active");
    if (btn.dataset.page === "report") loadReport();
    if (btn.dataset.page === "settings") renderSettings();
  });
});

/* ---------- 状态加载与渲染 ---------- */
async function loadStatus() {
  const [st, log] = await Promise.all([
    fetch("/api/status").then((r) => r.json()),
    fetch("/api/checkins/today").then((r) => r.json()),
  ]);
  status = st;
  const settingsActive = $("#page-settings").classList.contains("active");
  if (!settingsActive) settingsDraft = JSON.parse(JSON.stringify(status.settings));
  renderSidebar();
  renderThemes();
  renderTodayLog(log.items);
  $("#llm-hint").hidden = status.llmConfigured;
}

function renderSidebar() {
  $("#s-checkins").textContent = status.stats.todayCheckins;
  $("#s-points").textContent = status.stats.healthPoints;
  $("#s-streak").textContent = status.stats.streakDays;
  const badge = $("#quiet-badge");
  if (status.quiet.quiet) {
    badge.textContent = status.quiet.reason;
    badge.classList.add("quiet");
  } else {
    badge.textContent = "提醒守护中";
    badge.classList.remove("quiet");
  }
  const dndOn = status.dndUntil && Date.now() < status.dndUntil;
  $("#btn-dnd").hidden = dndOn;
  $("#btn-dnd-off").hidden = !dndOn;
}

function renderThemes() {
  const grid = $("#theme-grid");
  grid.innerHTML = "";
  for (const [key, meta] of Object.entries(status.themes)) {
    const cfg = status.settings.themes[key];
    const card = document.createElement("div");
    card.className = "theme-card" + (cfg.enabled ? "" : " off");
    card.innerHTML = `
      <div class="theme-name">${meta.label}</div>
      <div class="theme-int">${cfg.enabled ? `每 ${cfg.intervalMin} 分钟提醒` : "已关闭"}</div>
      <div class="theme-actions">
        <button class="chip primary" data-act="checkin" data-theme="${key}">打卡</button>
        <button class="chip" data-act="ring" data-theme="${key}">试铃</button>
      </div>`;
    grid.appendChild(card);
  }
  grid.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", async () => {
      const { act, theme } = b.dataset;
      if (act === "checkin") await doCheckin(theme);
      if (act === "ring") await fetch("/api/ring", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme }) });
    });
  });
}

async function doCheckin(theme) {
  const r = await fetch("/api/checkin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme }),
  }).then((r) => r.json());
  celebrate(r.streakDays);
  if (r.streakDays !== 7 && r.streakDays !== 30) {
    miniToast(`已记录，今日第 ${r.todayCount} 次打卡，健康值 +${r.pointsAdded ?? 10} · ${r.tip}`);
  }
  await loadStatus();
}

function renderTodayLog(items) {
  const wrap = $("#today-log");
  const fired = status.stats.todayFired;
  wrap.textContent = "";
  if (items.length === 0 && fired === 0) {
    const empty = document.createElement("div");
    empty.className = "log-empty";
    empty.textContent = '今天还没有记录，等铃声响起，或直接点上方"打卡"。';
    wrap.appendChild(empty);
  } else {
    const summary = document.createElement("div");
    summary.className = "log-item";
    summary.textContent = `提醒 ${fired} 次 · 打卡 ${items.length} 次 · 连续 ${status.stats.streakDays} 天 · 健康值 ${status.stats.healthPoints}`;
    wrap.appendChild(summary);
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "log-item";
      const time = document.createElement("span");
      time.className = "log-time";
      time.textContent = new Date(it.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      const text = document.createElement("span");
      const src = it.source === "web" ? "" : it.source === "agent" ? "（AI 助手）" : it.source === "mcp" ? "（MCP）" : "";
      text.textContent = `${it.label}打卡${src}`;
      row.append(time, text);
      wrap.appendChild(row);
    }
  }
  $("#today-sub").textContent = status.quiet.quiet
    ? `当前静默：${status.quiet.reason}`
    : `提醒时段 ${status.settings.workStart}–${status.settings.workEnd}，壹铃正在守护你的节奏`;
}

/* ---------- 周报 ---------- */
async function loadReport() {
  const r = await fetch("/api/report/week").then((res) => res.json());
  $("#report-range").textContent = `${r.range.from} – ${r.range.to}`;
  $("#metric-grid").innerHTML = `
    <div class="metric"><b>${r.completionRate}%</b><span>提醒完成率（${r.checkinCount}/${r.firedCount}）</span></div>
    <div class="metric"><b>${r.activeDays ?? 0}/7</b><span>本周达成天数</span></div>
    <div class="metric"><b>${r.standCount}</b><span>起身次数</span></div>
    <div class="metric"><b>${r.longestSitMinutes ?? "—"}</b><span>最长连坐（分钟）</span></div>
    <div class="metric"><b>${r.streakDays}</b><span>连续打卡天数</span></div>
    <div class="metric"><b>${r.healthPoints}</b><span>累计健康值</span></div>`;
  const themesEl = $("#report-themes");
  themesEl.innerHTML = "";
  for (const [key, t] of Object.entries(r.byTheme)) {
    const pct = t.fired === 0 ? 0 : Math.min(100, Math.round((t.checkins / t.fired) * 100));
    themesEl.innerHTML += `
      <div class="bar-row">
        <div class="bar-label"><span>${t.label}</span><span>${t.checkins}/${t.fired}</span></div>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </div>`;
  }
  $("#report-insight").textContent = r.insight;
}

/* ---------- 设置 ---------- */
function renderSettings() {
  const s = settingsDraft;
  $("#set-workStart").value = s.workStart;
  $("#set-workEnd").value = s.workEnd;
  $("#set-lunchStart").value = s.lunchStart;
  $("#set-lunchEnd").value = s.lunchEnd;
  $("#set-sound").checked = s.soundEnabled;
  $("#set-pet").checked = !s.petHidden;

  $("#set-llm-baseUrl").value = s.llm?.baseUrl ?? "";
  $("#set-llm-apiKey").value = s.llm?.apiKey ?? "";
  $("#set-llm-model").value = s.llm?.model ?? "";
  $("#set-noteone").checked = s.noteoneMcp?.enabled ?? true;
  const ns = status.noteone;
  $("#noteone-status").textContent = !ns
    ? "未知"
    : !ns.available
      ? "未检测到本机 noteone"
      : !ns.enabled
        ? "已禁用"
        : ns.connected
          ? `已连接（${ns.toolCount} 个工具）`
          : "检测到 noteone，连接中/已降级";

  const days = $("#set-days");
  days.innerHTML = "";
  for (let d = 0; d < 7; d++) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = DAY_NAMES[d];
    b.className = s.workDays.includes(d) ? "on" : "";
    b.addEventListener("click", () => {
      const i = s.workDays.indexOf(d);
      i >= 0 ? s.workDays.splice(i, 1) : s.workDays.push(d);
      b.classList.toggle("on");
    });
    days.appendChild(b);
  }

  $("#set-interval").value = s.reminderIntervalMin ?? 45;

  const themesEl = $("#set-themes");
  themesEl.innerHTML = "";
  for (const [key, meta] of Object.entries(status.themes)) {
    const cfg = s.themes[key];
    const row = document.createElement("div");
    row.className = "theme-setting";
    row.innerHTML = `
      <span class="t-name">${meta.label}</span>
      <label class="switch"><input type="checkbox" ${cfg.enabled ? "checked" : ""} data-k="on" /><span class="slider"></span></label>`;
    row.querySelector('[data-k="on"]').addEventListener("change", (e) => { cfg.enabled = e.target.checked; });
    themesEl.appendChild(row);
  }
}

$("#btn-save").addEventListener("click", async () => {
  settingsDraft.workStart = $("#set-workStart").value || settingsDraft.workStart;
  settingsDraft.workEnd = $("#set-workEnd").value || settingsDraft.workEnd;
  settingsDraft.lunchStart = $("#set-lunchStart").value || settingsDraft.lunchStart;
  settingsDraft.lunchEnd = $("#set-lunchEnd").value || settingsDraft.lunchEnd;
  settingsDraft.reminderIntervalMin = Number($("#set-interval").value) || settingsDraft.reminderIntervalMin || 45;
  settingsDraft.soundEnabled = $("#set-sound").checked;
  settingsDraft.petHidden = !$("#set-pet").checked;
  settingsDraft.llm = {
    baseUrl: $("#set-llm-baseUrl").value.trim(),
    apiKey: $("#set-llm-apiKey").value.trim(),
    model: $("#set-llm-model").value.trim(),
  };
  settingsDraft.noteoneMcp = { enabled: $("#set-noteone").checked };
  await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settingsDraft),
  });
  miniToast("设置已保存");
  await loadStatus();
});

$("#btn-llm-test").addEventListener("click", async () => {
  const result = $("#llm-test-result");
  result.textContent = "测试中…";
  try {
    const r = await fetch("/api/llm/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: $("#set-llm-baseUrl").value.trim(),
        apiKey: $("#set-llm-apiKey").value.trim(),
        model: $("#set-llm-model").value.trim(),
      }),
    }).then((res) => res.json());
    result.textContent = r.ok ? "连接成功" : `连接失败：${r.error || `HTTP ${r.status}`}`;
  } catch (err) {
    result.textContent = `连接失败：${err.message}`;
  }
});

/* ---------- 免打扰 ---------- */
$("#btn-dnd").addEventListener("click", async () => {
  await fetch("/api/dnd", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minutes: 60 }) });
  miniToast("免打扰已开启 60 分钟");
  await loadStatus();
});
$("#btn-dnd-off").addEventListener("click", async () => {
  await fetch("/api/dnd", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minutes: 0 }) });
  miniToast("免打扰已关闭");
  await loadStatus();
});

/* ---------- 提醒卡片 ---------- */
function showReminder(data) {
  ringBell(data.theme);
  if (bellyState.current !== "running") setBellyState("waiting");
  bellySay(`${data.title}｜${data.body}`, 15000);
  const wrap = $("#toast-wrap");
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `
    <div class="toast-title"></div>
    <div class="toast-body"></div>
    <div class="toast-tip"></div>
    <div class="toast-actions">
      <button class="chip primary" data-act="done">已完成</button>
      <button class="chip" data-act="later">稍后</button>
      <button class="chip" data-act="mute">今天不用了</button>
    </div>`;
  el.querySelector(".toast-title").textContent = data.title;
  el.querySelector(".toast-body").textContent = data.body;
  el.querySelector(".toast-tip").textContent = data.tip;
  const close = () => {
    el.remove();
    updateBadge();
    if (bellyState.current === "waiting") setBellyState("idle");
    $("#belly-bubble").hidden = true;
  };
  el.querySelector('[data-act="done"]').addEventListener("click", async () => { close(); await doCheckin(data.theme); });
  el.querySelector('[data-act="later"]').addEventListener("click", async () => {
    close();
    await fetch("/api/snooze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: data.theme, minutes: 15 }) });
    miniToast("好的，15 分钟后再提醒");
  });
  el.querySelector('[data-act="mute"]').addEventListener("click", async () => {
    close();
    await fetch("/api/mute-today", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: data.theme }) });
    miniToast("今天不再提醒这个主题");
  });
  wrap.appendChild(el);
  updateBadge();
  setTimeout(() => { if (el.isConnected) { el.remove(); updateBadge(); } }, 60_000);

  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted" &&
    document.visibilityState !== "visible"
  ) {
    const n = new Notification(data.title, {
      body: `${data.body}\n${data.tip}`,
      tag: `bellone-${data.theme}`,
    });
    n.onclick = () => { window.focus(); n.close(); };
  }
}
if (typeof Notification !== "undefined" && Notification.permission === "default") {
  document.addEventListener("click", () => Notification.requestPermission(), { once: true });
}

let miniTimer = null;
function miniToast(text) {
  const el = $("#mini-toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(miniTimer);
  miniTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

/* ---------- SSE ---------- */
let statusDebounce = null;
function connectSSE() {
  const es = new EventSource("/api/events");
  es.addEventListener("reminder", (e) => showReminder(JSON.parse(e.data)));
  es.addEventListener("status", (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === "checkin") setBellyState("jumping");
    } catch {}
    clearTimeout(statusDebounce);
    statusDebounce = setTimeout(loadStatus, 200);
  });
  es.onerror = () => { es.close(); setTimeout(connectSSE, 5000); };
}

/* ---------- AI 对话 ---------- */
const chatHistory = [];
let chatBusy = false;
$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (chatBusy) return;
  const input = $("#chat-text");
  const text = input.value.trim();
  if (!text) return;
  chatBusy = true;
  input.value = "";
  addMsg("user", text);
  chatHistory.push({ role: "user", content: text });
  setBellyState("running");

  const thinking = addMsg("tool", "思考中…");
  let streamEl = null;
  const closeStream = () => { streamEl = null; };
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: chatHistory.slice(-20) }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const eventMatch = chunk.match(/^event: (.+)$/m);
        const dataMatch = chunk.match(/^data: (.+)$/m);
        if (!eventMatch || !dataMatch) continue;
        const ev = eventMatch[1];
        const data = JSON.parse(dataMatch[1]);
        if (ev === "delta") {
          if (thinking.isConnected) thinking.remove();
          if (!streamEl) streamEl = addMsg("assistant", "");
          streamEl.textContent += data.text;
          setBellyTalking(true);
          $("#chat-messages").scrollTop = $("#chat-messages").scrollHeight;
        }
        if (ev === "tool_start") {
          closeStream();
          if (!thinking.isConnected) $("#chat-messages").appendChild(thinking);
          thinking.textContent = `调用 ${data.name} …`;
          if (!bellyPanelOpen()) bellySay(`正在${data.name.startsWith("noteone_") ? "翻笔记" : "处理"}…`, 4000);
        }
        if (ev === "tool_end") thinking.textContent = `${data.name} 完成 (${data.durationMs}ms)`;
        if (ev === "message") {
          if (thinking.isConnected) thinking.remove();
          if (streamEl && streamEl.textContent === data.content) {
            closeStream();
          } else {
            if (streamEl) { streamEl.remove(); closeStream(); }
            addMsg("assistant", data.content);
          }
          chatHistory.push({ role: "assistant", content: data.content });
          setBellyTalking(false);
          setBellyState("waving");
          if (!bellyPanelOpen()) bellySay(data.content, 8000);
          loadStatus();
        }
        if (ev === "error") {
          if (thinking.isConnected) thinking.remove();
          addMsg("error", data.message);
          setBellyTalking(false);
          setBellyState("failed");
          bellySay(data.message, 6000);
        }
      }
    }
    if (thinking.isConnected) thinking.remove();
  } catch (err) {
    thinking.remove();
    addMsg("error", `请求失败：${err.message}`);
  } finally {
    chatBusy = false;
    setBellyTalking(false);
    if (bellyState.current === "running") setBellyState("idle");
  }
});

function addMsg(cls, text) {
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  el.textContent = text;
  $("#chat-messages").appendChild(el);
  $("#chat-messages").scrollTop = $("#chat-messages").scrollHeight;
  return el;
}

/* ---------- 角标（未处理提醒数） ---------- */
function updateBadge() {
  const n = document.querySelectorAll("#toast-wrap .toast").length;
  if (navigator.setAppBadge) {
    n > 0 ? navigator.setAppBadge(n).catch(() => {}) : navigator.clearAppBadge?.().catch(() => {});
  }
  document.title = n > 0 ? `(${n}) 壹铃 Bellone` : "壹铃 Bellone";
}

/* ---------- 启动 ---------- */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
loadStatus().then(connectSSE);
setInterval(loadStatus, 60_000);
