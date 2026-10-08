// Opt-in live UI check. Uses an isolated profile and history reads only; it
// does not optimize, start a source turn, register startup, or write GitHub.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const idIndex = process.argv.indexOf("--thread-id");
const threadId = process.argv[idIndex + 1];
if (idIndex < 0 || !/^[a-f\d-]{36}$/i.test(threadId)) throw new Error("Provide --thread-id with an accessible real local ID");
const out = path.join(root, ".cache", "local-context-ui-check");
fs.mkdirSync(out, { recursive: true });
process.argv.push("--user-data-dir", path.join(out, `profile-${Date.now()}`));
require("../desktop/main.cjs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await delay(100); }
  throw new Error("UI check timed out");
}
app.whenReady().then(async () => {
  try {
    await until(() => BrowserWindow.getAllWindows().find((w) => w.getTitle() === "Context Prompt Assistant"));
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "Context Prompt Assistant");
    await until(() => win.webContents.executeJavaScript("Boolean(window.contextPromptAssistant && document.getElementById('select-local'))"));
    await delay(600);
    const errors = [];
    win.webContents.on("console-message", (_e, level, message) => { if (level >= 3) errors.push(String(message)); });
    const run = (code) => win.webContents.executeJavaScript(code);
    await run("document.getElementById('select-local').click()");
    await until(() => run("Boolean(document.querySelector('.session-row'))"));
    await run(`document.getElementById('session-search').value=${JSON.stringify(threadId)};document.getElementById('session-search').dispatchEvent(new Event('input'));`);
    assert.equal(await run("document.querySelectorAll('.session-row').length"), 1);
    await run("document.querySelector('.session-row').click()");
    await until(() => run("document.getElementById('context-badge').textContent==='已读取' && document.getElementById('app').getAttribute('aria-busy')==='false'"));
    const saved = await run("window.contextPromptAssistant.getContextTarget()");
    assert.equal(saved.threadId, threadId);
    assert.equal(saved.kind, "local_thread");
    assert.equal(JSON.stringify(saved).includes('"text"'), false);
    const first = await run("document.getElementById('target-details').textContent");
    await delay(1000);
    await run("document.getElementById('refresh-target').click()");
    await until(() => run("document.getElementById('app').getAttribute('aria-busy')==='false'"));
    const second = await run("document.getElementById('target-details').textContent");
    assert.notEqual(first, second);
    await run("document.getElementById('draft').value='保留草稿测试'; document.getElementById('layout').click()");
    await until(() => run("document.getElementById('app').dataset.layout==='horizontal'"));
    assert.equal(await run("document.getElementById('draft').value"), "保留草稿测试");
    await run("document.getElementById('theme-toggle').click()");
    await until(() => run("document.getElementById('app').dataset.theme==='dark'"));
    await run("document.getElementById('settings').click()");
    assert.equal(await run("getComputedStyle(document.querySelector('.settings-card')).backgroundColor"), "rgba(31, 35, 43, 0.98)");
    await run("document.getElementById('settings-dialog').close();document.getElementById('select-local').click()");
    await until(() => run("document.getElementById('session-dialog').open"));
    assert.equal(await run("getComputedStyle(document.querySelector('.session-card')).backgroundColor"), "rgba(31, 35, 43, 0.98)");
    await run("document.getElementById('close-sessions').click();document.getElementById('layout').click();document.getElementById('theme-toggle').click()");
    await until(() => run("document.getElementById('app').dataset.layout==='vertical' && document.getElementById('app').dataset.theme==='light'"));
    await delay(250);
    assert.ok(await run("document.querySelector('.target-card').getBoundingClientRect().height >= 100"), "Target card must not shrink inside the scrolling workspace");
    assert.equal(await run("document.querySelector('.workspace').scrollWidth <= document.querySelector('.workspace').clientWidth"), true, "No horizontal overflow in vertical layout");
    const top = await run("document.querySelector('.titlebar').getBoundingClientRect().top");
    await run("document.querySelector('.workspace').scrollTop=100000");
    assert.equal(await run("document.querySelector('.titlebar').getBoundingClientRect().top"), top);
    await run("document.querySelector('.workspace').scrollTop=0");
    await delay(250);
    const screenshot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, "local-context-window.png"), screenshot.toPNG());
    win.webContents.reload();
    await delay(700);
    await until(() => run("document.getElementById('context-badge').textContent==='已读取' && document.getElementById('app').getAttribute('aria-busy')==='false'"));
    assert.equal((await run("window.contextPromptAssistant.getContextTarget()")).threadId, threadId);
    assert.equal(errors.length, 0, errors.join("\n"));
    const report = { ok: true, checks: ["live list and selection", "bound real ID", "refresh timestamp", "metadata-only persistence", "layout preserves draft", "dark settings and picker", "fixed titlebar", "reload restores binding"], modelCalled: false, screenshot: path.join(out, "local-context-window.png") };
    fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    app.exit(0);
  } catch (error) { console.error(error.stack || error); app.exit(1); }
});
