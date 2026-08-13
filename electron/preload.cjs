const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bellyNative", {
  setInteractive: (interactive) => ipcRenderer.send("pet:set-interactive", interactive),
  moveBy: (dx, dy) => ipcRenderer.send("pet:move-by", dx, dy),
  dragStart: () => ipcRenderer.send("pet:drag-start"),
  dragEnd: () => ipcRenderer.send("pet:drag-end"),
  openMain: () => ipcRenderer.send("pet:open-main"),
  hidePet: () => ipcRenderer.send("pet:hide"),
  notify: (title, body) => ipcRenderer.send("pet:notify", { title, body }),
});
