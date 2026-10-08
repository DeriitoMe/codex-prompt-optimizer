import os from "node:os";
import crypto from "node:crypto";
import { listCodexThreads, readCodexThread } from "./codex-app-server.mjs";
import { normalizeCodexThread, classifyReadFailure } from "./context.mjs";
import { resolveCodexHome, validateThreadId, listLocalSessions, readLocalSession } from "./local-sessions.mjs";

export async function createLocalBinding(thread, homeValue) {
  const threadId = validateThreadId(thread.id || thread.threadId);
  const codexHome = await resolveCodexHome(homeValue);
  const hostName = os.hostname();
  const identity = `${hostName}\0${process.platform === "win32" ? codexHome.toLowerCase() : codexHome}\0${threadId}`;
  return { version: 1, kind: "local_thread", threadId, codexHome, hostName,
    title: String(thread.name || thread.title || "未命名会话").slice(0, 300), cwd: String(thread.cwd || ""),
    targetKey: `codex:local:${crypto.createHash("sha256").update(identity).digest("hex")}` };
}

export async function validateLocalBinding(binding) {
  if (binding?.kind !== "local_thread" || binding.version !== 1 || binding.hostName !== os.hostname()) throw new Error("local_binding_wrong_machine");
  const normalized = await createLocalBinding({ id: binding.threadId, name: binding.title, cwd: binding.cwd }, binding.codexHome);
  if (normalized.targetKey !== binding.targetKey) throw new Error("local_binding_identity_mismatch");
  return normalized;
}

export function localBindingTarget(binding) {
  return { ok: true, provider: "codex", targetType: "local_thread", id: binding.threadId, title: binding.title, targetKey: binding.targetKey, access: "unverified" };
}

export async function listAvailableThreads(options = {}) {
  const codexHome = await resolveCodexHome(options.codexHome);
  let listed, source = "codex-app-server", warning = "";
  try { listed = await (options.listThreads || listCodexThreads)({ ...options, codexHome }); }
  catch (error) {
    if (options.signal?.aborted || error.message === "context_cancelled") throw new Error("context_cancelled");
    listed = await listLocalSessions(codexHome, options);
    source = "codex-local-session";
    warning = "官方接口暂不可用，当前列表来自本机保存的会话记录。";
  }
  const threads = [];
  const seen = new Set();
  for (const row of listed.threads || []) {
    try { validateThreadId(row.id); } catch { continue; }
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    threads.push({ id: row.id, name: row.name || row.threadName || row.preview?.slice(0, 80) || "未命名会话", cwd: row.cwd || "", updatedAt: row.updatedAt || 0, archived: Boolean(options.archived) });
  }
  return { ok: true, codexHome, source, warning, truncated: Boolean(listed.truncated), checkedAt: new Date().toISOString(), threads };
}

export async function readBoundThread(stored, options = {}) {
  let binding;
  try { binding = await validateLocalBinding(stored); }
  catch (error) { return { ...classifyReadFailure(localBindingTarget(stored || {}), error.message), checkedAt: new Date().toISOString() }; }
  const target = localBindingTarget(binding);
  let normalized, primaryReason;
  try {
    const thread = await (options.readThread || readCodexThread)(binding.threadId, { ...options, codexHome: binding.codexHome });
    if (thread?.id !== binding.threadId) throw new Error("local_thread_identity_mismatch");
    normalized = normalizeCodexThread(thread, options.maxChars);
    if (!normalized.text.trim()) throw new Error("codex_thread_no_readable_messages");
    // IPC and caches only need bounded text and provenance, not the unbounded
    // array of original messages returned by the normalizer.
    delete normalized.messages;
  } catch (error) {
    if (options.signal?.aborted || error.message === "context_cancelled") throw new Error("context_cancelled");
    // An identity mismatch is not an availability failure: do not hide it.
    if (error.message === "local_thread_identity_mismatch") return { ...classifyReadFailure(target, error.message), checkedAt: new Date().toISOString() };
    primaryReason = error.message;
    try { normalized = await readLocalSession(binding.codexHome, binding.threadId, options); }
    catch (fallbackError) {
      if (options.signal?.aborted) throw new Error("context_cancelled");
      return { ...classifyReadFailure(target, fallbackError.message), checkedAt: new Date().toISOString(), primaryReason,
        fallback: "无法读取这条绑定会话。请重试，或检查 Codex 数据目录；不会自动换成另一条会话。" };
    }
  }
  return { ok: true, target: { ...target, title: normalized.thread?.name || binding.title }, access: "read", checkedAt: new Date().toISOString(), ...normalized,
    ...(primaryReason ? { primaryReason } : {}) };
}

export function contextContentFingerprint(context) {
  return crypto.createHash("sha256").update(JSON.stringify({ targetKey: context.target?.targetKey, text: context.text, coverage: context.coverage })).digest("hex");
}
