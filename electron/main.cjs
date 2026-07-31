const { app, BrowserWindow, ipcMain, utilityProcess, nativeImage, Notification, Menu } = require("electron");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");

const ROOT = path.join(__dirname, "..");
const isDev = !app.isPackaged;

let serverProc = null;
let mainWin = null;
let petWin = null;
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
    backgroundColor: "#f5f5f7",
    show: false,
    webPreferences: { contextIsolation: true },
  });
  mainWin.loadURL(`http://127.0.0.1:${serverPort}/?shell=electron`);
  mainWin.once("ready-to-show", () => mainWin.show());
  mainWin.on("closed", () => { mainWin = null; });
}

function createPetWindow() {
  petWin = new BrowserWindow({
    width: 150,
    height: 170,
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
  petWin.setAlwaysOnTop(true, "screen-saver");
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWin.setIgnoreMouseEvents(true, { forward: true });
  petWin.loadURL(`http://127.0.0.1:${serverPort}/pet.html`);

  const { workArea } = require("electron").screen.getPrimaryDisplay();
  petWin.setPosition(workArea.x + workArea.width - 168, workArea.y + workArea.height - 188);
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
  const req = http.get({ host: "127.0.0.1", port: serverPort, path: "/api/events" }, (res) => {
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
              if (hidden) { if (petWin) { petWin.close(); petWin = null; } }
              else if (!petWin) createPetWindow();
            } catch {}
          }
          event = "";
        }
      }
    });
    res.on("end", () => setTimeout(subscribePetEvents, 3000));
  });
  req.on("error", () => setTimeout(subscribePetEvents, 3000));
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
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  serverPort = process.env.BELLONE_PORT ? Number(process.env.BELLONE_PORT) : await getFreePort();
  startServer(serverPort);
  try {
    await waitForServer(serverPort);
  } catch (err) {
    console.error(err);
  }
  buildAppMenu();
  createMainWindow();
  const status = await fetchStatus();
  if (!status?.settings?.petHidden) createPetWindow();
  subscribePetEvents();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else if (mainWin) {
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
app.on("before-quit", shutdown);
app.on("window-all-closed", () => {
  // 桌宠常驻：主窗口关闭后仍保留在 Dock（macOS 习惯），非 macOS 直接退出
  if (process.platform !== "darwin") {
    shutdown();
    app.quit();
  }
});
process.on("exit", shutdown);
