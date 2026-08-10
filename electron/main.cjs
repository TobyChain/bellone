const { app, BrowserWindow, ipcMain, utilityProcess, nativeImage, Notification, Menu, Tray } = require("electron");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");

// Auto-update via GitHub Releases (electron-updater). Only active in packaged builds.
let autoUpdater = null;
if (app.isPackaged) {
  try {
    autoUpdater = require("electron-updater").autoUpdater;
    autoUpdater.autoDownload = true;      // pull the update in the background
    autoUpdater.autoInstallOnAppQuit = true; // install when the user quits (data lives outside the bundle)
  } catch (e) {
    console.error("[updater] electron-updater unavailable:", e);
    autoUpdater = null;
  }
}

const ROOT = path.join(__dirname, "..");
const isDev = !app.isPackaged;

// Packaged apps have no visible stdout, so mirror main-process events to a log file.
const fs = require("node:fs");
const LOG_PATH = path.join(app.getPath("userData"), "main.log");
function logMain(msg) {
  try { fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`); } catch {}
}

let serverProc = null;
let mainWin = null;
let isQuitting = false;
let petWin = null;
let tray = null;
let serverPort = 0;

// 单实例：已在运行时，第二次启动只聚焦已有窗口而非重复运行
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWin) createMainWindow();
    else { mainWin.show(); mainWin.focus(); }
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForServer(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/status", timeout: 1500 }, (res) => {
        res.destroy();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on("error", retry);
      req.on("timeout", () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error("Express 子进程启动超时"));
      else setTimeout(probe, 300);
    };
    probe();
  });
}

function startServer(port) {
  const entry = path.join(ROOT, "dist", "index.js");
  serverProc = utilityProcess.fork(entry, [], {
    stdio: "pipe",
    env: {
      ...process.env,
      PORT: String(port),
      BELLONE_DATA_DIR: path.join(app.getPath("userData"), "data"),
    },
  });
  serverProc.stdout?.on("data", (d) => process.stdout.write(`[server] ${d}`));
  serverProc.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    title: "壹铃 Bellone",
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#f5f5f7",
    show: false,
    webPreferences: { contextIsolation: true },
  });
  mainWin.loadURL(`http://127.0.0.1:${serverPort}/?shell=electron`);
  mainWin.once("ready-to-show", () => mainWin.show());
  mainWin.on("close", (e) => {
    if (!isQuitting) { e.preventDefault(); mainWin.hide(); }
  });
  mainWin.on("closed", () => { mainWin = null; });
}

function createPetWindow() {
  petWin = new BrowserWindow({
    width: 240,
    height: 240,
    resizable: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    fullscreenable: false,
    webPreferences: {
      contextIsolation: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  petWin.setAlwaysOnTop(true, "floating");
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWin.setIgnoreMouseEvents(true, { forward: true });
  petWin.loadURL(`http://127.0.0.1:${serverPort}/pet.html`);

  const { workArea } = require("electron").screen.getPrimaryDisplay();
  petWin.setPosition(workArea.x + workArea.width - 248, workArea.y + workArea.height - 248);
  petWin.on("closed", () => { petWin = null; });
}

// ---- 桌宠 IPC ----
ipcMain.on("pet:set-interactive", (_e, interactive) => {
  if (petWin) petWin.setIgnoreMouseEvents(!interactive, { forward: true });
});
ipcMain.on("pet:move-by", (_e, dx, dy) => {
  if (!petWin) return;
  const [x, y] = petWin.getPosition();
  petWin.setPosition(Math.round(x + dx), Math.round(y + dy));
});

// Main-process drag: poll the global cursor and move the pet window. This works
// even when clicking the pet activates the app / the main window jumps forward
// (which breaks the renderer's pointer-capture drag). The renderer only needs to
// signal drag-start (pointerdown) and drag-end (pointerup).
let petDragOrigin = null;
let petDragTimer = null;
ipcMain.on("pet:drag-start", () => {
  if (!petWin) return;
  const { screen } = require("electron");
  const c = screen.getCursorScreenPoint();
  const [x, y] = petWin.getPosition();
  petDragOrigin = { cx: c.x, cy: c.y, wx: x, wy: y };
  if (petDragTimer) clearInterval(petDragTimer);
  petDragTimer = setInterval(() => {
    if (!petDragOrigin || !petWin) return;
    const cc = require("electron").screen.getCursorScreenPoint();
    petWin.setPosition(petDragOrigin.wx + (cc.x - petDragOrigin.cx), petDragOrigin.wy + (cc.y - petDragOrigin.cy));
  }, 16);
});
ipcMain.on("pet:drag-end", () => {
  if (petDragTimer) { clearInterval(petDragTimer); petDragTimer = null; }
  petDragOrigin = null;
});
ipcMain.on("pet:open-main", () => {
  if (!mainWin) createMainWindow();
  else { mainWin.show(); mainWin.focus(); }
});
ipcMain.on("pet:hide", () => {
  if (petWin) { petWin.close(); petWin = null; }
  persistSetting({ petHidden: true });
});
ipcMain.on("pet:notify", (_e, { title, body }) => {
  if (Notification.isSupported()) {
    const n = new Notification({ title: title || "壹铃", body: body || "" });
    n.on("click", () => { if (!mainWin) createMainWindow(); else { mainWin.show(); mainWin.focus(); } });
    n.show();
  }
});

function persistSetting(patch) {
  const body = JSON.stringify(patch);
  const req = http.request(
    { host: "127.0.0.1", port: serverPort, path: "/api/settings", method: "PUT", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
    (res) => res.resume()
  );
  req.on("error", () => {});
  req.end(body);
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, "tray-template.png"));
  if (!img.isEmpty()) img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip("壹铃 Bellone");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开主界面", click: () => { if (!mainWin) createMainWindow(); else { mainWin.show(); mainWin.focus(); } } },
    { type: "separator" },
    { label: "显示 belly 桌宠", click: () => showPet() },
    { label: "隐藏 belly 桌宠", click: () => { if (petWin) { petWin.close(); petWin = null; } persistSetting({ petHidden: true }); } },
    { type: "separator" },
    { role: "quit", label: "退出" },
  ]));
}

function showPet() {
  if (!petWin) createPetWindow();
  persistSetting({ petHidden: false });
}

function fetchStatus() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: serverPort, path: "/api/status", timeout: 2000 }, (res) => {
      let buf = "";
      res.on("data", (d) => (buf += d));
      res.on("end", () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

/** 订阅服务端 SSE 的 pet 事件，实时显示/隐藏桌宠窗（设置页开关触发） */
function subscribePetEvents() {
  logMain("subscribePetEvents: connecting");
  const req = http.get({ host: "127.0.0.1", port: serverPort, path: "/api/events" }, (res) => {
    logMain(`subscribePetEvents: connected status=${res.statusCode}`);
    let buf = "";
    let event = "";
    res.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          const payload = line.slice(5).trim();
          if (event === "pet") {
            try {
              const { hidden } = JSON.parse(payload);
              logMain(`pet event: hidden=${hidden}`);
              if (hidden) { if (petWin) { petWin.close(); petWin = null; } }
              else if (!petWin) createPetWindow();
            } catch {}
          }
          else if (event === "reminder") {
            try {
              const d = JSON.parse(payload);
              logMain(`reminder event: title=${d.title} body=${d.body} notifSupported=${Notification.isSupported()} mainVisible=${mainWin ? mainWin.isVisible() : "no-win"}`);
              if (mainWin && !mainWin.isVisible()) mainWin.show();
              if (Notification.isSupported()) {
                const n = new Notification({
                  title: d.title || "壹铃",
                  body: [d.body, d.tip].filter(Boolean).join("\n"),
                });
                n.on("click", () => { if (!mainWin) createMainWindow(); else { mainWin.show(); mainWin.focus(); } });
                n.show();
                logMain(`notification shown: ${d.title}`);
              } else {
                logMain("notification NOT supported");
              }
            } catch (err) {
              logMain(`reminder event parse error: ${err.message}`);
            }
          }
          event = "";
        }
      }
    });
    res.on("end", () => { logMain("subscribePetEvents: stream ended, reconnecting"); setTimeout(subscribePetEvents, 3000); });
    res.on("error", (e) => { logMain(`subscribePetEvents: stream error ${e.message}, reconnecting`); setTimeout(subscribePetEvents, 3000); });
  });
  req.on("error", (e) => { logMain(`subscribePetEvents: request error ${e.message}, reconnecting`); setTimeout(subscribePetEvents, 3000); });
}

function buildAppMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "壹铃",
      submenu: [
        { label: "打开主界面", click: () => { if (!mainWin) createMainWindow(); else { mainWin.show(); mainWin.focus(); } } },
        { label: "显示 belly 桌宠", click: () => showPet() },
        { label: "隐藏 belly 桌宠", click: () => { if (petWin) { petWin.close(); petWin = null; } persistSetting({ petHidden: true }); } },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "窗口",
      submenu: [
        { label: "关闭窗口", accelerator: "CmdOrCtrl+W", click: () => { if (mainWin) mainWin.close(); } },
        { role: "minimize", accelerator: "CmdOrCtrl+M" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Wire up GitHub-release auto-update. Non-blocking; data lives outside the bundle. */
function initAutoUpdate() {
  if (!autoUpdater) return;
  autoUpdater.on("update-available", (info) => {
    console.log(`[updater] update available: ${info.version}`);
  });
  autoUpdater.on("update-downloaded", (info) => {
    console.log(`[updater] downloaded ${info.version}, will install on quit`);
    if (Notification.isSupported()) {
      const n = new Notification({
        title: "壹铃 已下载新版本",
        body: `v${info.version} 将在退出后自动安装，你的数据不受影响。`,
      });
      n.on("click", () => { autoUpdater.quitAndInstall(); });
      n.show();
    }
  });
  autoUpdater.on("error", (err) => console.error("[updater] error:", err?.message || err));
  // Delay the check so it doesn't compete with server startup.
  setTimeout(() => autoUpdater.checkForUpdates().catch((e) => console.error("[updater] check failed:", e?.message || e)), 8000);
}

app.whenReady().then(async () => {
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  logMain(`app ready: packaged=${app.isPackaged} version=${app.getVersion()} userData=${app.getPath("userData")}`);
  serverPort = process.env.BELLONE_PORT ? Number(process.env.BELLONE_PORT) : await getFreePort();
  logMain(`server port: ${serverPort}`);
  startServer(serverPort);
  try {
    await waitForServer(serverPort);
  } catch (err) {
    console.error(err);
  }
  buildAppMenu();
  createTray();
  createMainWindow();
  const status = await fetchStatus();
  if (!status?.settings?.petHidden) createPetWindow();
  subscribePetEvents();
  initAutoUpdate();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else if (mainWin && !mainWin.isVisible()) {
      // Only un-hide a minimized/hidden main window. When it's already visible
      // we must NOT call show() here: macOS already brings it forward on
      // activation, and calling show() on every activate (e.g. from clicking the
      // pet, or a spurious activate when switching apps) hijacks the pet drag
      // and steals focus from the foreground app.
      mainWin.show();
    }
  });
});

function shutdown() {
  if (serverProc) {
    try { serverProc.kill(); } catch {}
    serverProc = null;
  }
}
app.on("before-quit", () => { isQuitting = true; shutdown(); });
app.on("window-all-closed", () => {
  // 桌宠常驻：主窗口关闭后仍保留在 Dock（macOS 习惯），非 macOS 直接退出
  if (process.platform !== "darwin") {
    shutdown();
    app.quit();
  }
});
process.on("exit", shutdown);
