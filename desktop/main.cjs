const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  clipboard,
  shell,
  screen,
  globalShortcut,
  dialog,
} = require("electron");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// The UI is light and CSS-driven. Disabling Chromium GPU startup avoids a
// native graphics-driver crash seen on some Windows machines (0x80000003).
if (process.platform === "win32") app.disableHardwareAcceleration();

app.setName("Context Prompt Assistant");
const appUserData = path.join(app.getPath("appData"), app.isPackaged ? "Context Prompt Assistant" : "Context Prompt Assistant-dev");
fs.mkdirSync(appUserData, { recursive: true });
app.setPath("userData", appUserData);

const APP_VERSION = "0.3.0";
const DEFAULTS = {
  layout: "vertical",
  fontScale: "standard",
  autoShowWithCodex: false,
  codexExecutablePath: "",
  globalShortcut: "Control+Alt+P",
};
const STARTUP_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const STARTUP_VALUE = "Context Prompt Assistant";
const startupLogPath = path.join(os.tmpdir(), "context-prompt-assistant-startup.log");
function startupLog(message) {
  try { fs.appendFileSync(startupLogPath, `${new Date().toISOString()} ${message}\n`, "utf8"); } catch { /* diagnostics are best effort */ }
}
process.on("uncaughtException", (error) => startupLog(`uncaughtException ${error?.stack || error}`));
process.on("unhandledRejection", (error) => startupLog(`unhandledRejection ${error?.stack || error}`));
startupLog(`boot packaged=${app.isPackaged} exec=${process.execPath}`);

let mainWindow;
let tray;
let contextModule;
let appServerModule;
let optimizerModule;
let prefs = { ...DEFAULTS };
let stateSaveTimer;
let codexWatcher;
let watcherEnabled = process.argv.includes("--watch-codex");
let codexWasRunning = false;
let codexMisses = 0;
let watchInFlight = false;
let lastCodexStatus = { state: "unknown", reason: "not_checked" };
let isQuitting = false;
let shortcutRegistered = false;
const bindings = new Map();
const activeOptimizations = new Map();

const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showWindow({ focus: true });
  });
}

async function modules() {
  if (!contextModule) contextModule = await import(pathToFileURL(path.join(__dirname, "..", "scripts", "context.mjs")));
  if (!appServerModule) appServerModule = await import(pathToFileURL(path.join(__dirname, "..", "scripts", "codex-app-server.mjs")));
  if (!optimizerModule) optimizerModule = await import(pathToFileURL(path.join(__dirname, "..", "scripts", "optimizer.mjs")));
  return { contextModule, appServerModule, optimizerModule };
}

function preferencesPath() {
  return path.join(app.getPath("userData"), "preferences.json");
}

function windowStatePath() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function loadPreferences() {
  const stored = readJson(preferencesPath(), {});
  prefs = {
    ...DEFAULTS,
    ...stored,
    layout: stored.layout === "horizontal" ? "horizontal" : DEFAULTS.layout,
    fontScale: stored.fontScale === "large" ? "large" : DEFAULTS.fontScale,
    autoShowWithCodex: Boolean(stored.autoShowWithCodex),
    codexExecutablePath: typeof stored.codexExecutablePath === "string" ? stored.codexExecutablePath : "",
  };
  watcherEnabled = watcherEnabled || prefs.autoShowWithCodex;
}

function savePreferences() {
  try {
    fs.mkdirSync(path.dirname(preferencesPath()), { recursive: true });
    fs.writeFileSync(preferencesPath(), JSON.stringify(prefs, null, 2), "utf8");
  } catch {
    // Preferences are best effort and must never block normal use.
  }
}

function defaultBounds(layout = prefs.layout) {
  return layout === "horizontal" ? { width: 960, height: 680 } : { width: 440, height: 720 };
}

function loadWindowState(layout = prefs.layout) {
  const stored = readJson(windowStatePath(), {});
  // Migrate the previous flat state into the new per-layout shape.
  const state = stored[layout] || (Number.isFinite(Number(stored.width)) ? stored : {});
  const fallback = defaultBounds(layout);
  const width = Number(state.width);
  const height = Number(state.height);
  const x = Number(state.x);
  const y = Number(state.y);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return fallback;
  const minWidth = layout === "horizontal" ? 720 : 420;
  const minHeight = 600;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { width: Math.max(minWidth, Math.round(width)), height: Math.max(minHeight, Math.round(height)) };
  const display = screen.getDisplayNearestPoint({ x, y });
  const area = display.workArea;
  const safeWidth = Math.min(Math.max(Math.round(width), minWidth), Math.max(minWidth, area.width));
  const safeHeight = Math.min(Math.max(Math.round(height), minHeight), Math.max(minHeight, area.height));
  return {
    width: safeWidth,
    height: safeHeight,
    x: Math.min(Math.max(Math.round(x), area.x), area.x + area.width - minWidth),
    y: Math.min(Math.max(Math.round(y), area.y), area.y + area.height - minHeight),
  };
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const stored = readJson(windowStatePath(), {});
    stored[prefs.layout] = mainWindow.getBounds();
    fs.mkdirSync(path.dirname(windowStatePath()), { recursive: true });
    fs.writeFileSync(windowStatePath(), JSON.stringify(stored, null, 2), "utf8");
  } catch {
    // Window persistence is best effort.
  }
}

function scheduleWindowStateSave() {
  clearTimeout(stateSaveTimer);
  stateSaveTimer = setTimeout(saveWindowState, 250);
}

function showWindow({ focus = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (focus) mainWindow.focus();
  else mainWindow.showInactive();
  sendToWindow("window-visibility", { visible: true });
}

function hideWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  saveWindowState();
  mainWindow.hide();
  sendToWindow("window-visibility", { visible: false });
}

function sendToWindow(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  } catch {
    // The renderer may still be loading; the next user action will refresh it.
  }
}

function makeTrayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="4" fill="#6557d9"/><path d="M5 4h6v1.4H8.7V12H7.2V5.4H5z" fill="white"/></svg>`;
  try { return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`); } catch { return nativeImage.createEmpty(); }
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示提示词助手", click: () => showWindow({ focus: true }) },
    { label: "启动 Codex 并显示助手", click: () => void launchCodex() },
    { type: "separator" },
    { label: prefs.autoShowWithCodex ? "✓ 随 Codex 自动显示" : "随 Codex 自动显示", click: () => void setAutoShowWithCodex(!prefs.autoShowWithCodex) },
    { label: "打开设置", click: () => { showWindow({ focus: true }); sendToWindow("open-settings"); } },
    { label: "运行启动诊断", click: () => { showWindow({ focus: true }); void sendDiagnostics(); } },
    { type: "separator" },
    { label: "退出提示词助手", click: () => { isQuitting = true; app.quit(); } },
  ]));
}

function createTray() {
  if (tray) return;
  tray = new Tray(makeTrayIcon());
  tray.setToolTip("Context Prompt Assistant");
  tray.on("click", () => showWindow({ focus: true }));
  updateTrayMenu();
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const state = loadWindowState(prefs.layout);
  const horizontal = prefs.layout === "horizontal";
  mainWindow = new BrowserWindow({
    ...state,
    minWidth: horizontal ? 720 : 420,
    minHeight: 600,
    title: "Context Prompt Assistant",
    backgroundColor: "#f7f9fc",
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    ...(process.platform !== "darwin" ? { titleBarOverlay: { color: "#f7f9fc", symbolColor: "#5c6678", height: 36 } } : {}),
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => { if (!url.startsWith("file:")) event.preventDefault(); });
  mainWindow.on("move", scheduleWindowStateSave);
  mainWindow.on("resize", scheduleWindowStateSave);
  mainWindow.on("close", (event) => {
    saveWindowState();
    if (!isQuitting) { event.preventDefault(); hideWindow(); }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  return mainWindow;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function runFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); return; }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

async function queryRegistryAutostart() {
  if (process.platform !== "win32") return false;
  try { return (await runFile("reg.exe", ["QUERY", STARTUP_KEY, "/v", STARTUP_VALUE])).stdout.includes(STARTUP_VALUE); } catch { return false; }
}

async function setRegistryAutostart(enabled) {
  if (process.platform !== "win32") return { ok: false, reason: "windows_only" };
  try {
    if (enabled) {
      const command = app.isPackaged
        ? `"${process.execPath}" --watch-codex`
        : `"${process.execPath}" "${app.getAppPath()}" --watch-codex`;
      await runFile("reg.exe", ["ADD", STARTUP_KEY, "/v", STARTUP_VALUE, "/t", "REG_SZ", "/d", command, "/f"]);
    } else {
      await runFile("reg.exe", ["DELETE", STARTUP_KEY, "/v", STARTUP_VALUE, "/f"]);
    }
    return { ok: true, registered: await queryRegistryAutostart() };
  } catch (error) {
    return { ok: false, reason: "autostart_registry_failed", details: String(error.stderr || error.message || error) };
  }
}

async function setAutoShowWithCodex(enabled) {
  const result = await setRegistryAutostart(Boolean(enabled));
  if (!result.ok) return result;
  prefs.autoShowWithCodex = Boolean(enabled);
  savePreferences();
  watcherEnabled = Boolean(enabled);
  if (watcherEnabled) startCodexWatcher(); else stopCodexWatcher();
  updateTrayMenu();
  sendToWindow("preferences", getPublicPreferences(result.registered));
  return { ...result, preferences: getPublicPreferences(result.registered) };
}

function getPublicPreferences(autostartRegistered = null) {
  return { ...prefs, watcherEnabled, shortcutRegistered, autostartRegistered };
}

async function queryCodexProcess() {
  if (process.platform !== "win32") return { state: "unsupported", reason: "windows_only" };
  try {
    const output = (await runFile("tasklist.exe", ["/FI", "IMAGENAME eq codex.exe", "/FO", "CSV", "/NH"])).stdout;
    return { state: /"codex\.exe"/i.test(output) ? "running" : "not_running", processName: "codex.exe" };
  } catch (error) {
    try {
      const fallback = await runFile("powershell.exe", ["-NoProfile", "-Command", "$ErrorActionPreference='Stop'; $p = Get-Process -Name codex -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { $p.Id }"]);
      return { state: fallback.stdout.trim() ? "running" : "not_running", processName: "codex.exe", method: "powershell_fallback" };
    } catch (fallbackError) {
      return { state: "error", reason: "codex_process_check_failed", details: String(fallbackError.stderr || fallbackError.message || error.stderr || error.message || error) };
    }
  }
}

async function watchCodexProcess() {
  if (!watcherEnabled || watchInFlight) return;
  watchInFlight = true;
  try {
    lastCodexStatus = await queryCodexProcess();
    sendToWindow("codex-status", lastCodexStatus);
    if (lastCodexStatus.state === "running") {
      codexMisses = 0;
      if (!codexWasRunning) showWindow({ focus: false });
      codexWasRunning = true;
    } else if (lastCodexStatus.state === "not_running") {
      codexMisses += 1;
      if (codexWasRunning && codexMisses >= 2) hideWindow();
      if (codexMisses >= 2) codexWasRunning = false;
    }
  } finally { watchInFlight = false; }
}

function startCodexWatcher() {
  if (codexWatcher) return;
  watcherEnabled = true;
  void watchCodexProcess();
  codexWatcher = setInterval(() => void watchCodexProcess(), 1500);
}

function stopCodexWatcher() {
  if (codexWatcher) clearInterval(codexWatcher);
  codexWatcher = null;
  watcherEnabled = false;
  codexWasRunning = false;
  codexMisses = 0;
}

function registerGlobalShortcut() {
  globalShortcut.unregister(prefs.globalShortcut);
  shortcutRegistered = false;
  if (!prefs.globalShortcut) return;
  try { shortcutRegistered = globalShortcut.register(prefs.globalShortcut, () => { if (mainWindow?.isVisible()) hideWindow(); else showWindow({ focus: true }); }); } catch { shortcutRegistered = false; }
}

function codexExecutableCandidates() {
  const local = process.env.LOCALAPPDATA || "";
  const program = process.env.ProgramFiles || "C:\\Program Files";
  return [prefs.codexExecutablePath, path.join(local, "Programs", "Codex", "Codex.exe"), path.join(local, "Programs", "OpenAI", "Codex", "Codex.exe"), path.join(local, "OpenAI", "Codex", "Codex.exe"), path.join(program, "Codex", "Codex.exe")].filter(Boolean);
}

async function launchCodex() {
  for (const candidate of codexExecutableCandidates()) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const child = spawn(candidate, [], { detached: true, stdio: "ignore", windowsHide: false });
      child.unref();
      startCodexWatcher();
      showWindow({ focus: false });
      return { ok: true, method: "executable", path: candidate };
    } catch (error) { return { ok: false, reason: "codex_launch_failed", details: String(error.message || error) }; }
  }
  try {
    await shell.openExternal("codex://");
    startCodexWatcher();
    showWindow({ focus: false });
    return { ok: true, method: "codex_protocol" };
  } catch (error) {
    const message = "找不到 Codex 桌面程序。请在设置中选择 Codex.exe，或直接从 Codex 启动后使用助手。";
    sendToWindow("diagnostic-message", { level: "error", message });
    return { ok: false, reason: "codex_executable_not_found", details: String(error.message || error), message };
  }
}

async function chooseCodexExecutable() {
  const chosen = await dialog.showOpenDialog(mainWindow, { title: "选择 Codex.exe", properties: ["openFile"], filters: [{ name: "Windows 程序", extensions: ["exe"] }] });
  if (chosen.canceled || !chosen.filePaths[0]) return { ok: false, reason: "cancelled" };
  prefs.codexExecutablePath = chosen.filePaths[0];
  savePreferences();
  sendToWindow("preferences", getPublicPreferences());
  return { ok: true, path: prefs.codexExecutablePath };
}

async function sendDiagnostics() {
  const diagnostics = { ok: true, version: APP_VERSION, platform: process.platform, watcherEnabled, codex: await queryCodexProcess(), lastCodexStatus, autostartRegistered: await queryRegistryAutostart(), shortcutRegistered, codexExecutablePath: prefs.codexExecutablePath || null };
  sendToWindow("diagnostics", diagnostics);
  return diagnostics;
}

async function readSharedCodexSnapshot(url, maxChars = 24000) {
  const { contextModule } = await modules();
  let snapshotWindow;
  try {
    snapshotWindow = new BrowserWindow({ show: false, title: "Codex shared snapshot reader", webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    snapshotWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    snapshotWindow.webContents.on("will-navigate", (event, nextUrl) => { try { const next = new URL(nextUrl); if (!next.hostname.endsWith("chatgpt.com") && next.hostname !== "chat.openai.com") event.preventDefault(); } catch { event.preventDefault(); } });
    await Promise.race([snapshotWindow.loadURL(url, { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36" }), delay(15000).then(() => { throw new Error("codex_shared_snapshot_load_timeout"); })]);
    const deadline = Date.now() + 10000;
    let page = null;
    while (Date.now() < deadline) {
      page = await snapshotWindow.webContents.executeJavaScript(`(() => ({ title: document.title || "", text: document.body?.innerText || "", url: location.href }))()`, true);
      if (page?.text?.trim().length >= 160) break;
      await delay(300);
    }
    const text = String(page?.text || "").trim();
    if (!text) throw new Error("codex_shared_snapshot_empty");
    if (/access denied|page not found|something went wrong/i.test(text) && text.length < 1200) throw new Error("codex_shared_snapshot_unavailable");
    const normalized = contextModule.normalizeSharedSnapshot(text, maxChars);
    return { ok: true, target: contextModule.resolveContextTarget(url), access: "read", checkedAt: new Date().toISOString(), ...normalized };
  } catch (error) { return contextModule.classifyReadFailure(contextModule.resolveContextTarget(url), error?.message || "codex_shared_snapshot_read_failed"); }
  finally { if (snapshotWindow && !snapshotWindow.isDestroyed()) snapshotWindow.destroy(); }
}

async function readContext(url, maxChars = 24000) {
  const { contextModule, appServerModule } = await modules();
  const target = contextModule.resolveContextTarget(url);
  if (!target.ok) return contextModule.classifyReadFailure(target, target.reason);
  if (target.provider === "codex" && target.targetType === "shared_snapshot") return readSharedCodexSnapshot(url, maxChars);
  if (target.provider !== "codex" || target.targetType !== "thread") {
    const reason = target.provider === "chatgpt" && target.targetType === "scheduled_task" ? "chatgpt_scheduled_task_link_not_conversation" : "only_codex_thread_read_is_available_in_this_version";
    return contextModule.classifyReadFailure(target, reason);
  }
  try {
    const thread = await appServerModule.readCodexThread(target.id, { timeoutMs: 15000 });
    if (!thread) return contextModule.classifyReadFailure(target, "codex_thread_not_found");
    const normalized = contextModule.normalizeCodexThread(thread, maxChars);
    return { ok: true, target, access: "read", checkedAt: new Date().toISOString(), ...normalized };
  } catch (error) { return contextModule.classifyReadFailure(target, error?.message || "context_read_failed"); }
}

async function setLayout(layout) {
  if (layout !== "vertical" && layout !== "horizontal") return getPublicPreferences();
  if (prefs.layout === layout) return getPublicPreferences();
  saveWindowState();
  prefs.layout = layout;
  savePreferences();
  const state = loadWindowState(layout);
  mainWindow?.setMinimumSize(layout === "horizontal" ? 720 : 420, 600);
  mainWindow?.setBounds(state, true);
  sendToWindow("preferences", getPublicPreferences());
  return getPublicPreferences();
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
  try { return await optimizerModule.optimizePrompt({ draft: payload?.draft, contextText: context?.access === "stale" ? "" : context?.text || "", contextStatus: context?.access || "none", cwd: payload?.cwd || process.cwd(), timeoutMs: 120000, signal: controller.signal }); }
  finally { activeOptimizations.delete(requestId); }
});
ipcMain.handle("cancel-optimize", (_event, requestId) => { const controller = activeOptimizations.get(String(requestId)); controller?.abort(); return Boolean(controller); });
ipcMain.handle("copy", (_event, value) => { clipboard.writeText(String(value || "")); return true; });
ipcMain.handle("read-clipboard", () => clipboard.readText());
ipcMain.handle("set-always-on-top", (_event, enabled) => { mainWindow?.setAlwaysOnTop(Boolean(enabled)); return Boolean(enabled); });
ipcMain.handle("get-preferences", async () => getPublicPreferences(await queryRegistryAutostart()));
ipcMain.handle("set-layout", (_event, layout) => setLayout(layout));
ipcMain.handle("set-font-scale", (_event, fontScale) => { prefs.fontScale = fontScale === "large" ? "large" : "standard"; savePreferences(); sendToWindow("preferences", getPublicPreferences()); return getPublicPreferences(); });
ipcMain.handle("set-auto-show", (_event, enabled) => setAutoShowWithCodex(enabled));
ipcMain.handle("get-diagnostics", () => sendDiagnostics());
ipcMain.handle("choose-codex-executable", () => chooseCodexExecutable());
ipcMain.handle("launch-codex", () => launchCodex());
ipcMain.handle("show-window", () => { showWindow({ focus: true }); return true; });
ipcMain.handle("hide-window", () => { hideWindow(); return true; });
ipcMain.handle("quit", () => { isQuitting = true; app.quit(); return true; });
ipcMain.handle("open-link", (_event, url) => shell.openExternal(String(url)));

if (hasSingleInstance) {
  app.whenReady().then(() => {
    loadPreferences();
    createTray();
    registerGlobalShortcut();
    if (watcherEnabled) startCodexWatcher(); else createWindow();
    app.on("activate", () => showWindow({ focus: true }));
  });
}

app.on("before-quit", () => {
  isQuitting = true;
  saveWindowState();
  clearTimeout(stateSaveTimer);
  if (codexWatcher) clearInterval(codexWatcher);
  globalShortcut.unregisterAll();
  tray?.destroy();
});
app.on("window-all-closed", () => { /* tray keeps the companion available */ });
