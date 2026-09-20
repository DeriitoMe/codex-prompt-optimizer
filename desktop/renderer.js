const api = window.contextPromptAssistant;
const $ = (id) => document.getElementById(id);
const app = $("app");
const urlInput = $("url");
const target = $("target");
const badge = $("context-badge");
const targetDetails = $("target-details");
const targetSource = $("target-source");
const retryContext = $("retry-context");
const draft = $("draft");
const result = $("result");
const status = $("status");
const copy = $("copy");
const cancel = $("cancel");
const optimizeButton = $("optimize");
const optimizePlain = $("optimize-plain");
const pasteTarget = $("paste-target");
const layoutButton = $("layout");
const themeToggle = $("theme-toggle");
const modeButtons = [...document.querySelectorAll(".mode-button")];
const settingsDialog = $("settings-dialog");
const settingsStatus = $("settings-status");
const diagnosticsOutput = $("diagnostics-output");
let context = null;
let pinned = false;
let requestId = null;
let operationToken = 0;
let preferences = { layout: "vertical", fontScale: "standard", theme: "light", optimizationMode: "simple", autoShowWithCodex: false };

function setBadge(text, kind = "neutral") {
  badge.textContent = text;
  badge.className = `badge ${kind}`;
}

function reasonLabel(reason) {
  const labels = {
    codex_shared_snapshot_load_timeout: "共享快照加载超时",
    codex_shared_snapshot_empty: "共享快照没有可读取文本",
    codex_shared_snapshot_unavailable: "共享快照当前不可访问",
    codex_shared_snapshot_requires_browser_reader: "需要在伴随窗口中读取共享快照",
    chatgpt_scheduled_task_link_not_conversation: "这是共享任务链接，不是对话历史",
    only_codex_thread_read_is_available_in_this_version: "当前版本只读取 Codex 对话线程",
    codex_thread_not_found: "找不到对应的 Codex 线程",
    codex_cli_not_found: "找不到 Codex 命令行程序",
    codex_process_check_failed: "无法检查 Codex 是否运行",
  };
  return labels[reason] || reason || "当前不可读取";
}

function describe(payload) {
  if (!payload) return "每次优化前会重新检查可访问范围。";
  const t = payload.target || payload;
  const typeLabel = t.targetType === "shared_snapshot" ? "共享快照" : t.targetType === "scheduled_task" ? "共享任务" : t.targetType === "thread" ? "对话" : t.targetType;
  const scope = [t.provider, typeLabel, t.id].filter(Boolean).join(" / ");
  if (payload.access === "read") {
    const coverage = payload.coverage?.kind === "full" ? "完整可见内容" : payload.coverage?.kind === "partial" ? "部分内容" : "未提取到可分析文本";
    const amount = Number.isFinite(payload.coverage?.turns) ? `已读取 ${payload.coverage.turns} 个轮次` : "已读取分享页可见文本";
    const snapshotNote = t.targetType === "shared_snapshot" ? " · 分享时静态快照" : "";
    return `${scope} · ${amount}，${coverage}${snapshotNote}`;
  }
  if (payload.access === "stale") return `${scope} · 刷新失败，缓存已过期（${reasonLabel(payload.reason)}）`;
  return `${scope || "目标"} · ${reasonLabel(payload.reason)}`;
}

function renderDetails(payload) {
  if (!payload) { targetDetails.hidden = true; targetDetails.textContent = ""; return; }
  const coverage = payload.coverage || {};
  const lines = [
    `状态：${payload.access || "unknown"}`,
    `检查时间：${payload.checkedAt || "未检查"}`,
    `读取范围：${Number.isFinite(coverage.turns) ? `${coverage.turns} 个轮次` : "分享页可见文本"}${coverage.kind ? ` / ${coverage.kind}` : ""}`,
    payload.reason ? `原因：${reasonLabel(payload.reason)}` : "",
  ].filter(Boolean);
  targetDetails.textContent = lines.join("\n");
}

function showContext() {
  target.textContent = describe(context);
  renderDetails(context);
  const access = context?.access;
  setBadge(access === "read" ? "已读取" : access === "stale" ? "已过期" : context ? "不可读取" : "未绑定", access === "read" ? "ok" : access === "stale" ? "warn" : context ? "error" : "neutral");
  retryContext.hidden = !urlInput.value.trim() || access === "read";
  targetSource.textContent = access === "read" ? "已检查目标，可在生成前再次刷新" : "支持 Codex 任务和只读共享快照";
}

function setBusy(busy) {
  copy.disabled = busy || !result.textContent.trim() || result.textContent === "尚未生成结果。";
  cancel.disabled = !busy;
  optimizeButton.disabled = busy;
  optimizePlain.hidden = busy || context?.access === "read";
}

function applyPreferences(next = {}) {
  preferences = { ...preferences, ...next };
  app.dataset.layout = preferences.layout === "horizontal" ? "horizontal" : "vertical";
  app.dataset.fontScale = preferences.fontScale === "large" ? "large" : "standard";
  app.dataset.theme = preferences.theme === "dark" ? "dark" : "light";
  layoutButton.textContent = app.dataset.layout === "horizontal" ? "横向" : "竖向";
  layoutButton.title = app.dataset.layout === "horizontal" ? "切换为竖向布局" : "切换为横向布局";
  themeToggle.textContent = app.dataset.theme === "dark" ? "黑色" : "浅色";
  themeToggle.title = app.dataset.theme === "dark" ? "切换为浅色主题" : "切换为黑色主题";
  $("auto-show").checked = Boolean(preferences.autoShowWithCodex);
  $("font-scale").value = preferences.fontScale;
  $("theme").value = preferences.theme;
  $("codex-path").textContent = preferences.codexExecutablePath || "自动发现或使用 Codex 协议启动。";
  modeButtons.forEach((button) => {
    const active = button.dataset.mode === preferences.optimizationMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function bind() {
  const raw = urlInput.value.trim();
  if (!raw) { context = null; showContext(); return; }
  const token = ++operationToken;
  target.textContent = "正在解析并读取目标…";
  setBadge("检查中", "neutral");
  retryContext.hidden = true;
  try {
    const parsed = await api.resolveTarget(raw);
    if (token !== operationToken) return;
    if (!parsed.ok) { context = parsed; showContext(); return; }
    context = await api.refreshContext({ url: raw });
    if (token !== operationToken) return;
    localStorage.setItem("contextPromptTarget", raw);
    showContext();
    status.textContent = context.access === "read" ? "目标已绑定。生成前仍会再次检查上下文。" : context.fallback || "目标已解析，但当前不可读取历史。";
  } catch (error) {
    if (token !== operationToken) return;
    context = { ok: false, access: "unavailable", reason: error?.message || "context_bind_failed" };
    showContext();
    status.textContent = "绑定失败，请检查链接和 Codex 登录状态。";
  }
}

async function runOptimize({ useContext = true } = {}) {
  const text = draft.value.trim();
  if (!text) { status.textContent = "请先输入待优化原话。"; draft.focus(); return; }
  const token = ++operationToken;
  requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const currentRequestId = requestId;
  result.textContent = useContext ? "正在刷新上下文并调用只读优化会话…" : "正在仅根据原话调用只读优化会话…";
  status.textContent = "";
  setBusy(true);
  try {
    if (useContext && urlInput.value.trim()) {
      context = await api.refreshContext({ url: urlInput.value.trim() });
      if (token !== operationToken) return;
      showContext();
      if (context.access !== "read") {
        result.textContent = "上下文未读取，尚未生成结果。";
        status.textContent = `${context.fallback || reasonLabel(context.reason)} 可点击“仅优化原话”继续。`;
        return;
      }
    }
    const output = await api.optimize({ draft: text, context: useContext ? context : null, optimizationMode: preferences.optimizationMode, requestId });
    if (token !== operationToken) return;
    result.textContent = output.text;
    const modelLabel = output.model ? `${output.model}（${output.reasoningEffort || "默认"}）` : (output.mode || "Codex");
    status.textContent = `已生成 · ${modelLabel} · 优化会话只读`;
  } catch (error) {
    if (token !== operationToken) return;
    result.textContent = error?.message === "optimizer_cancelled" ? "已取消本次优化。" : "暂时无法生成优化结果。";
    status.textContent = error?.message === "optimizer_cancelled" ? "可以修改原话后重试。" : `${error?.message || error}\n${error?.details || "请检查 Codex 登录状态与 CLI 可用性。"}`;
  } finally {
    if (requestId === currentRequestId) { requestId = null; setBusy(false); }
  }
}

function openSettings() {
  if (!settingsDialog.open) settingsDialog.showModal();
  void api.getPreferences().then(applyPreferences).catch(() => {});
}

$("bind").addEventListener("click", bind);
$("retry-context").addEventListener("click", bind);
pasteTarget.addEventListener("click", async () => {
  const value = await api.readClipboard();
  if (!value.trim()) { status.textContent = "剪贴板中没有可粘贴的文本。"; return; }
  urlInput.value = value.trim();
  status.textContent = "已从剪贴板粘贴链接，点击“绑定”检查上下文。";
  urlInput.focus();
});
optimizeButton.addEventListener("click", () => void runOptimize());
optimizePlain.addEventListener("click", () => void runOptimize({ useContext: false }));
cancel.addEventListener("click", () => { if (requestId) { operationToken += 1; api.cancelOptimize(requestId); status.textContent = "正在取消…"; } });
$("clear").addEventListener("click", () => { draft.value = ""; result.textContent = "尚未生成结果。"; status.textContent = ""; setBusy(false); draft.focus(); });
copy.addEventListener("click", async () => { await api.copy(result.textContent); status.textContent = "已复制优化结果。"; });
$("pin").addEventListener("click", async (event) => { pinned = !pinned; event.currentTarget.classList.toggle("active", pinned); await api.setAlwaysOnTop(pinned); status.textContent = pinned ? "窗口已置顶。" : "已取消置顶。"; });
layoutButton.addEventListener("click", async () => { const next = preferences.layout === "horizontal" ? "vertical" : "horizontal"; applyPreferences(await api.setLayout(next)); });
themeToggle.addEventListener("click", async () => { applyPreferences(await api.setTheme(preferences.theme === "dark" ? "light" : "dark")); });
$("settings").addEventListener("click", openSettings);
$("details-toggle").addEventListener("click", () => { targetDetails.hidden = !targetDetails.hidden; $("details-toggle").textContent = targetDetails.hidden ? "查看状态" : "收起状态"; });
$("auto-show").addEventListener("change", async (event) => { const response = await api.setAutoShow(event.target.checked); if (!response.ok) { event.target.checked = !event.target.checked; settingsStatus.textContent = `自动启动设置失败：${response.details || response.reason}`; return; } applyPreferences(response.preferences); settingsStatus.textContent = response.registered ? "已启用：下次登录后会后台监听 Codex。" : "已关闭自动显示。"; });
$("font-scale").addEventListener("change", async (event) => { applyPreferences(await api.setFontScale(event.target.value)); });
$("theme").addEventListener("change", async (event) => { applyPreferences(await api.setTheme(event.target.value)); settingsStatus.textContent = preferences.theme === "dark" ? "已切换为黑色主题。" : "已切换为浅色主题。"; });
modeButtons.forEach((button) => button.addEventListener("click", async () => { applyPreferences(await api.setOptimizationMode(button.dataset.mode)); status.textContent = button.dataset.mode === "professional" ? "已选择专业化优化：将补充执行范围、验收标准和待确认假设。" : "已选择简单优化：只补齐必要信息，保持原话简洁。"; }));
$("choose-codex").addEventListener("click", async () => { const response = await api.chooseCodexExecutable(); if (response.ok) { settingsStatus.textContent = "Codex 路径已保存。"; applyPreferences(await api.getPreferences()); } });
$("run-diagnostics").addEventListener("click", async () => { diagnosticsOutput.hidden = false; diagnosticsOutput.textContent = "正在检查…"; diagnosticsOutput.textContent = JSON.stringify(await api.getDiagnostics(), null, 2); });
$("launch-codex").addEventListener("click", async () => { const response = await api.launchCodex(); settingsStatus.textContent = response.ok ? "已请求启动 Codex。" : response.message || "无法启动 Codex，请选择程序路径。"; });
draft.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void runOptimize(); } });
api.onPreferences(applyPreferences);
api.onCodexStatus((value) => { if (value.state === "error") status.textContent = "无法检查 Codex 运行状态，可在设置中运行诊断。"; });
api.onDiagnostics((value) => { diagnosticsOutput.hidden = false; diagnosticsOutput.textContent = JSON.stringify(value, null, 2); });
api.onDiagnosticMessage((value) => { settingsStatus.textContent = value.message || "启动诊断失败。"; });
api.onOpenSettings(openSettings);

void api.getPreferences().then(applyPreferences).catch(() => applyPreferences());
const saved = localStorage.getItem("contextPromptTarget");
if (saved) { urlInput.value = saved; void bind(); }
