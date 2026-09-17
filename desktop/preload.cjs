const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("contextPromptAssistant", {
  resolveTarget: (url) => ipcRenderer.invoke("resolve-target", url),
  refreshContext: (payload) => ipcRenderer.invoke("refresh-context", payload),
  optimize: (payload) => ipcRenderer.invoke("optimize", payload),
  cancelOptimize: (requestId) => ipcRenderer.invoke("cancel-optimize", requestId),
  copy: (text) => ipcRenderer.invoke("copy", text),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke("set-always-on-top", enabled),
  openLink: (url) => ipcRenderer.invoke("open-link", url),
});
