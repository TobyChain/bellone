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
  bubble.textContent = text.length > 90 ? `${text.slice(0, 90)}…` : text;
  bubble.hidden = false;
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => { bubble.hidden = true; }, ms);
}

/* ---------- 鼠标穿透：仅悬停在 belly 上时可交互 ---------- */
const wrap = $("#belly-wrap");
wrap.addEventListener("pointerenter", () => native.setInteractive(true));
wrap.addEventListener("pointerleave", () => {
  if (dragging) return;
  const menu = document.getElementById("pet-menu");
  if (menu) menu.hidden = true;
  native.setInteractive(false);
});

/* ---------- 拖拽移动窗口 + 点击打开主界面 ---------- */
let dragging = false;
let moved = false;
let lastX = 0;
let lastY = 0;
const bellyBtn = $("#belly");

bellyBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  dragging = true;
  moved = false;
  lastX = e.screenX;
  lastY = e.screenY;
  native.dragStart();
  bellyBtn.setPointerCapture(e.pointerId);
});
const onDragMove = (e) => {
  if (!dragging) return;
  if (Math.abs(e.screenX - lastX) + Math.abs(e.screenY - lastY) > 3) moved = true;
  lastX = e.screenX;
  lastY = e.screenY;
};
const onDragEnd = (e) => {
  if (!dragging) return;
  dragging = false;
  native.dragEnd();
  try { bellyBtn.releasePointerCapture(e.pointerId); } catch {}
  if (!moved) {
    native.openMain();
    if (belly.current === "waiting") setBellyState("idle");
    $("#belly-bubble").hidden = true;
  }
};
bellyBtn.addEventListener("pointermove", onDragMove);
bellyBtn.addEventListener("pointerup", onDragEnd);
window.addEventListener("pointerup", onDragEnd);
window.addEventListener("pointercancel", onDragEnd);

// 右键弹出菜单（选择「隐藏」才隐藏，而非直接隐藏）
const petMenu = document.getElementById("pet-menu");
function closeMenu() {
  petMenu.hidden = true;
  if (!dragging) native.setInteractive(false);
}
bellyBtn.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  native.setInteractive(true);
  petMenu.hidden = false;
});
document.getElementById("menu-hide").addEventListener("click", () => {
  petMenu.hidden = true;
  bellySay("先躲起来啦，提醒会用系统通知找你", 1800);
  setTimeout(() => native.hidePet(), 500);
});
document.getElementById("menu-open").addEventListener("click", () => {
  closeMenu();
  native.openMain();
});
// 点菜单以外区域关闭
document.addEventListener("pointerdown", (e) => {
  if (!petMenu.hidden && !petMenu.contains(e.target) && e.target !== bellyBtn && !bellyBtn.contains(e.target)) {
    closeMenu();
  }
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
      if (data.type === "checkin") { setBellyState("jumping"); bellySay("+10 健康值", 3000); }
    } catch {}
  });
  es.onerror = () => { es.close(); setTimeout(connectSSE, 5000); };
}
connectSSE();
