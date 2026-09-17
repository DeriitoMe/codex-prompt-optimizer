const api = window.contextPromptAssistant;
const $ = (id) => document.getElementById(id);
const urlInput = $("url");
const target = $("target");
const badge = $("context-badge");
const draft = $("draft");
const result = $("result");
const status = $("status");
const copy = $("copy");
const cancel = $("cancel");
const optimizeButton = $("optimize");
let context = null;
let pinned = false;
let requestId = null;

function setBadge(text, kind = "neutral") {
  badge.textContent = text;
  badge.className = `badge ${kind}`;
}

function describe(payload) {
  if (!payload) return "未绑定目标。";
  const t = payload.target || payload;
  const scope = [t.provider, t.targetType, t.id].filter(Boolean).join(" / ");
  if (payload.access === "read") { const coverage = payload.coverage?.kind === "full" ? "完整可见内容" : payload.coverage?.kind === "partial" ? "部分内容" : "未提取到可分析文本"; return `${scope} · 已读取 ${payload.coverage?.turns ?? 0} 个轮次，${coverage} · ${payload.checkedAt || "刚刚"}`; }
  if (payload.access === "stale") return `${scope} · 刷新失败，缓存已过期（${payload.reason || "unknown"}）`;
  return `${scope} · 当前不可读取（${payload.reason || "unknown"}）`;
}

function showContext() {
  target.textContent = describe(context);
  const access = context?.access;
  setBadge(access === "read" ? "已读取" : access === "stale" ? "已过期" : "不可读取", access === "read" ? "ok" : access === "stale" ? "warn" : "error");
}

async function bind() {
  const raw = urlInput.value.trim();
  if (!raw) return;
  target.textContent = "正在解析并读取目标…";
  setBadge("检查中", "neutral");
  const parsed = await api.resolveTarget(raw);
  if (!parsed.ok) { context = parsed; setBadge("链接无效", "error"); target.textContent = describe(parsed); return; }
  context = await api.refreshContext({ url: raw });
  localStorage.setItem("contextPromptTarget", raw);
  showContext();
}

async function optimize() {
  const text = draft.value.trim();
  if (!text) { status.textContent = "请先输入待优化原话。"; return; }
  requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  result.textContent = "正在刷新上下文并调用 Codex 只读优化会话…";
  copy.disabled = true;
  cancel.disabled = false;
  optimizeButton.disabled = true;
  status.textContent = "";
  try {
    if (urlInput.value.trim()) context = await api.refreshContext({ url: urlInput.value.trim() });
    showContext();
    const output = await api.optimize({ draft: text, context, requestId });
    result.textContent = output.text;
    copy.disabled = false;
    status.textContent = `已生成 · ${output.mode || "Codex"} · 优化会话只读`;
  } catch (error) {
    result.textContent = error?.message === "optimizer_cancelled" ? "已取消本次优化。" : "暂时无法生成优化结果。";
    status.textContent = error?.message === "optimizer_cancelled" ? "可以修改原话后重试。" : `${error?.message || error}\n${error?.details || "请检查 Codex 登录状态与 CLI 可用性。"}`;
  } finally {
    requestId = null;
    cancel.disabled = true;
    optimizeButton.disabled = false;
  }
}

$("bind").addEventListener("click", bind);
$("optimize").addEventListener("click", optimize);
cancel.addEventListener("click", () => { if (requestId) api.cancelOptimize(requestId); });
$("clear").addEventListener("click", () => { draft.value = ""; result.textContent = "尚未生成结果。"; status.textContent = ""; copy.disabled = true; });
copy.addEventListener("click", () => api.copy(result.textContent));
$("pin").addEventListener("click", async (event) => { pinned = !pinned; event.currentTarget.classList.toggle("active", pinned); await api.setAlwaysOnTop(pinned); status.textContent = pinned ? "窗口已置顶。" : "已取消置顶。"; });
draft.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") optimize(); });

const saved = localStorage.getItem("contextPromptTarget");
if (saved) {
  urlInput.value = saved;
  // Restoring the URL also restores the target's current access state. The
  // read is deliberately repeated after restart so an old local value cannot
  // be presented as fresh context.
  void bind().catch((error) => {
    context = { ok: false, access: "unavailable", reason: error?.message || "context_restore_failed" };
    showContext();
  });
}
