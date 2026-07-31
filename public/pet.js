const $ = (sel) => document.querySelector(sel);
const native = window.bellyNative || {
  setInteractive() {},
  moveBy() {},
  openMain() {},
};

/* ---------- belly 状态机（与主界面对齐的子集） ---------- */
const BELLY_TRANSIENT = { waving: 2500, jumping: 1200, failed: 4000 };
const BELLY_PRIORITY = { failed: 5, waiting: 4, running: 3, jumping: 2, waving: 2, idle: 0 };
const belly = { current: "idle", timer: null };

function setBellyState(state) {
  const el = $("#belly");
  if (!el) return;
  if (belly.current === "running" && (state === "jumping" || state === "waving") && BELLY_PRIORITY[state] < BELLY_PRIORITY.running) {
    return;
  }
  clearTimeout(belly.timer);
  el.classList.remove("idle", "running", "waving", "jumping", "failed", "waiting", "talking");
  el.classList.add(state);
  belly.current = state;
  const ttl = BELLY_TRANSIENT[state];
  if (ttl) belly.timer = setTimeout(() => setBellyState("idle"), ttl);
}

function setTalking(on) {
  $("#belly")?.classList.toggle("talking", on);
}

let bubbleTimer = null;
function bellySay(text, ms = 6000) {
  const bubble = $("#belly-bubble");
  if (!bubble || !text) return;
  bubble.textContent = text.length > 48 ? `${text.slice(0, 48)}…` : text;
  bubble.hidden = false;
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => { bubble.hidden = true; }, ms);
}

/* ---------- 鼠标穿透：仅悬停在 belly 上时可交互 ---------- */
const wrap = $("#belly-wrap");
wrap.addEventListener("pointerenter", () => native.setInteractive(true));
wrap.addEventListener("pointerleave", () => {
  if (!dragging) native.setInteractive(false);
});

/* ---------- 拖拽移动窗口 + 点击打开主界面 ---------- */
let dragging = false;
let moved = false;
let lastX = 0;
let lastY = 0;
const bellyBtn = $("#belly");

bellyBtn.addEventListener("pointerdown", (e) => {
  dragging = true;
  moved = false;
  lastX = e.screenX;
  lastY = e.screenY;
  bellyBtn.setPointerCapture(e.pointerId);
});
bellyBtn.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const dx = e.screenX - lastX;
  const dy = e.screenY - lastY;
  if (dx || dy) {
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    native.moveBy(dx, dy);
    lastX = e.screenX;
    lastY = e.screenY;
  }
});
bellyBtn.addEventListener("pointerup", (e) => {
  dragging = false;
  bellyBtn.releasePointerCapture(e.pointerId);
  if (!moved) {
    native.openMain();
    if (belly.current === "waiting") setBellyState("idle");
    $("#belly-bubble").hidden = true;
  }
});

// 右键隐藏桌宠（隐藏后提醒改走系统通知）
bellyBtn.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  bellySay("先躲起来啦，提醒会用系统通知找你 👋", 2500);
  setTimeout(() => native.hidePet(), 600);
});

/* ---------- SSE：与主服务共享事件流 ---------- */
function connectSSE() {
  const es = new EventSource("/api/events");
  es.addEventListener("reminder", (e) => {
    const data = JSON.parse(e.data);
    if (belly.current !== "running") setBellyState("waiting");
    bellySay(`${data.title}｜${data.body}`, 15000);
  });
  es.addEventListener("status", (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === "checkin") { setBellyState("jumping"); bellySay("+10 健康值 ✨", 3000); }
    } catch {}
  });
  es.onerror = () => { es.close(); setTimeout(connectSSE, 5000); };
}
connectSSE();
