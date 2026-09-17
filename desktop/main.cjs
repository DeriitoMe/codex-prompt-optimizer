const { app, BrowserWindow, ipcMain, clipboard, shell } = require("electron");
const { execFile } = require("node:child_process");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let mainWindow;
let contextModule;
let appServerModule;
let optimizerModule;
let codexWatcher;
let codexWasRunning = false;
const bindings = new Map();
const activeOptimizations = new Map();
const watchCodex = process.argv.includes("--watch-codex");

async function modules() {
  if (!contextModule) contextModule = await import(pathToFileURL(path.join(__dirname, "..", "scripts", "context.mjs")));
  if (!appServerModule) appServerModule = await import(pathToFileURL(path.join(__dirname, "..", "scripts", "codex-app-server.mjs")));
  if (!optimizerModule) optimizerModule = await import(pathToFileURL(path.join(__dirname, "..", "scripts", "optimizer.mjs")));
  return { contextModule, appServerModule, optimizerModule };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 640, height: 820, minWidth: 520, minHeight: 620,
    title: "Context Prompt Assistant", backgroundColor: "#edf2f9", autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file:")) event.preventDefault();
  });
  mainWindow.on("close", (event) => {
    if (watchCodex && !app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

function isCodexRunning() {
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile("tasklist.exe", ["/FI", "IMAGENAME eq codex.exe", "/FO", "CSV", "/NH"], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve(false);
      resolve(/"codex\.exe"/i.test(String(stdout)));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readSharedCodexSnapshot(url, maxChars = 24000) {
  const { contextModule } = await modules();
  let snapshotWindow;
  try {
    snapshotWindow = new BrowserWindow({
      show: false,
      title: "Codex shared snapshot reader",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    snapshotWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    snapshotWindow.webContents.on("will-navigate", (event, nextUrl) => {
      try {
        const next = new URL(nextUrl);
        if (!next.hostname.endsWith("chatgpt.com") && next.hostname !== "chat.openai.com") event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    await Promise.race([
      snapshotWindow.loadURL(url, { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36" }),
      delay(15000).then(() => { throw new Error("codex_shared_snapshot_load_timeout"); }),
    ]);

    const deadline = Date.now() + 10000;
    let page = null;
    while (Date.now() < deadline) {
      page = await snapshotWindow.webContents.executeJavaScript(`(() => ({
        title: document.title || "",
        text: document.body?.innerText || "",
        url: location.href,
      }))()`, true);
      if (page?.text?.trim().length >= 160) break;
      await delay(300);
    }
    const text = String(page?.text || "").trim();
    if (!text) throw new Error("codex_shared_snapshot_empty");
    if (/access denied|page not found|something went wrong/i.test(text) && text.length < 1200) {
      throw new Error("codex_shared_snapshot_unavailable");
    }
    const normalized = contextModule.normalizeSharedSnapshot(text, maxChars);
    return {
      ok: true,
      target: contextModule.resolveContextTarget(url),
      access: "read",
      checkedAt: new Date().toISOString(),
      ...normalized,
    };
  } catch (error) {
    return contextModule.classifyReadFailure(
      contextModule.resolveContextTarget(url),
      error?.message || "codex_shared_snapshot_read_failed",
    );
  } finally {
    if (snapshotWindow && !snapshotWindow.isDestroyed()) snapshotWindow.destroy();
  }
}

async function watchCodexProcess() {
  const running = await isCodexRunning();
  if (running && !codexWasRunning) {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else mainWindow.show();
    mainWindow?.focus();
  } else if (!running && codexWasRunning && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
  codexWasRunning = running;
}

function startCodexWatcher() {
  void watchCodexProcess();
  codexWatcher = setInterval(() => void watchCodexProcess(), 1500);
}

async function readContext(url, maxChars = 24000) {
  const { contextModule, appServerModule } = await modules();
  const target = contextModule.resolveContextTarget(url);
  if (!target.ok) return contextModule.classifyReadFailure(target, target.reason);
  if (target.provider === "codex" && target.targetType === "shared_snapshot") {
    return await readSharedCodexSnapshot(url, maxChars);
  }
  if (target.provider !== "codex" || target.targetType !== "thread") {
    const reason = target.provider === "chatgpt" && target.targetType === "scheduled_task"
      ? "chatgpt_scheduled_task_link_not_conversation"
      : "only_codex_thread_read_is_available_in_this_version";
    return contextModule.classifyReadFailure(target, reason);
  }
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
ipcMain.handle("read-clipboard", () => clipboard.readText());
ipcMain.handle("set-always-on-top", (_event, enabled) => { mainWindow?.setAlwaysOnTop(Boolean(enabled)); return Boolean(enabled); });
ipcMain.handle("open-link", (_event, url) => shell.openExternal(String(url)));

app.whenReady().then(() => {
  if (watchCodex) startCodexWatcher();
  else createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && !watchCodex) createWindow();
    else mainWindow?.show();
  });
});
app.on("before-quit", () => { app.isQuitting = true; if (codexWatcher) clearInterval(codexWatcher); });
app.on("window-all-closed", () => { if (process.platform !== "darwin" && !watchCodex) app.quit(); });
