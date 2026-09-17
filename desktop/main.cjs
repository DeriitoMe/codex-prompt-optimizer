const { app, BrowserWindow, ipcMain, clipboard, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let mainWindow;
let contextModule;
let appServerModule;
let optimizerModule;
const bindings = new Map();
const activeOptimizations = new Map();

async function modules() {
  if (!contextModule) contextModule = await import(pathToFileURL(path.join(__dirname, "..", "scripts", "context.mjs")));
  if (!appServerModule) appServerModule = await import(pathToFileURL(path.join(__dirname, "..", "scripts", "codex-app-server.mjs")));
  if (!optimizerModule) optimizerModule = await import(pathToFileURL(path.join(__dirname, "..", "scripts", "optimizer.mjs")));
  return { contextModule, appServerModule, optimizerModule };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 640, height: 820, minWidth: 520, minHeight: 620,
    title: "Context Prompt Assistant", backgroundColor: "#17181c", autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file:")) event.preventDefault();
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

async function readContext(url, maxChars = 24000) {
  const { contextModule, appServerModule } = await modules();
  const target = contextModule.resolveContextTarget(url);
  if (!target.ok) return contextModule.classifyReadFailure(target, target.reason);
  if (target.provider !== "codex" || target.targetType !== "thread") return contextModule.classifyReadFailure(target, "only_codex_thread_read_is_available_in_this_version");
  try {
    const thread = await appServerModule.readCodexThread(target.id, { timeoutMs: 15000 });
    if (!thread) return contextModule.classifyReadFailure(target, "codex_thread_not_found");
    const normalized = contextModule.normalizeCodexThread(thread, maxChars);
    return { ok: true, target, access: "read", checkedAt: new Date().toISOString(), ...normalized };
  } catch (error) {
    return contextModule.classifyReadFailure(target, error?.message || "context_read_failed");
  }
}

ipcMain.handle("resolve-target", async (_event, url) => (await modules()).contextModule.resolveContextTarget(url));
ipcMain.handle("refresh-context", async (_event, { url, maxChars }) => {
  const { contextModule } = await modules();
  const target = contextModule.resolveContextTarget(url);
  const key = target.targetKey || String(url || "");
  const previous = bindings.get(key);
  const current = await readContext(url, maxChars);
  if (!current.ok && previous?.ok) return { ...current, access: "stale", stale: true, staleSince: previous.checkedAt, cachedContext: previous };
  if (current.ok) bindings.set(key, current);
  return { ...current, cacheState: previous ? "refreshed" : "initialized", changedSinceLastRead: previous ? contextModule.contextFingerprint(previous) !== contextModule.contextFingerprint(current) : null };
});
ipcMain.handle("optimize", async (_event, payload) => {
  const { optimizerModule } = await modules();
  const context = payload?.context;
  const requestId = String(payload?.requestId || Date.now());
  const controller = new AbortController();
  activeOptimizations.set(requestId, controller);
  try {
    return await optimizerModule.optimizePrompt({ draft: payload?.draft, contextText: context?.access === "stale" ? "" : context?.text || "", contextStatus: context?.access || "none", cwd: payload?.cwd || process.cwd(), timeoutMs: 120000, signal: controller.signal });
  } finally {
    activeOptimizations.delete(requestId);
  }
});
ipcMain.handle("cancel-optimize", (_event, requestId) => { const controller = activeOptimizations.get(String(requestId)); controller?.abort(); return Boolean(controller); });
ipcMain.handle("copy", (_event, value) => { clipboard.writeText(String(value || "")); return true; });
ipcMain.handle("set-always-on-top", (_event, enabled) => { mainWindow?.setAlwaysOnTop(Boolean(enabled)); return Boolean(enabled); });
ipcMain.handle("open-link", (_event, url) => shell.openExternal(String(url)));

app.whenReady().then(() => { createWindow(); app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
