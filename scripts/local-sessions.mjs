import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { clipText } from "./context.mjs";

export function validateThreadId(id) {
  if (typeof id !== "string" || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id)) throw new Error("invalid_local_thread_id");
  return id;
}

export async function resolveCodexHome(value) {
  const candidate = value || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) throw new Error("invalid_codex_home");
  const resolved = await fs.realpath(candidate);
  if (!(await fs.stat(resolved)).isDirectory()) throw new Error("invalid_codex_home");
  return resolved;
}

function checkCancelled(signal) {
  if (signal?.aborted) throw new Error("context_cancelled");
}

async function sessionFiles(root, signal, depth = 0) {
  checkCancelled(signal);
  if (depth > 8) return [];
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const files = [];
  for (const entry of entries) {
    checkCancelled(signal);
    if (entry.isSymbolicLink()) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sessionFiles(full, signal, depth + 1));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
  }
  return files;
}

async function readMetadata(file, signal) {
  checkCancelled(signal);
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0];
    let value;
    try { value = JSON.parse(first); } catch { return null; }
    if (value.type !== "session_meta" || !value.payload?.id) return null;
    try { validateThreadId(value.payload.id); } catch { return null; }
    const stat = await handle.stat();
    return { id: value.payload.id, cwd: value.payload.cwd || "", file, size: stat.size, updatedAt: Math.floor(stat.mtimeMs / 1000), source: value.payload.source || "unknown" };
  } finally { await handle.close(); }
}

async function readTitles(home, signal) {
  const titles = new Map();
  const index = path.join(home, "session_index.jsonl");
  try { await fs.access(index); } catch (error) { if (error.code === "ENOENT") return titles; throw error; }
  const stream = createReadStream(index, { signal });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      checkCancelled(signal);
      try { const row = JSON.parse(line); if (row.id && typeof row.thread_name === "string") titles.set(row.id, row.thread_name); } catch { /* Incomplete last index line is not authoritative. */ }
    }
  } finally { lines.close(); stream.destroy(); }
  return titles;
}

export async function listLocalSessions(homeValue, options = {}) {
  const home = await resolveCodexHome(homeValue);
  const titles = await readTitles(home, options.signal);
  const roots = options.archived ? ["archived_sessions"] : ["sessions"];
  const byId = new Map();
  for (const name of roots) {
    for (const file of await sessionFiles(path.join(home, name), options.signal)) {
      const row = await readMetadata(file, options.signal);
      if (!row) continue;
      const previous = byId.get(row.id);
      const duplicateCount = (previous?.duplicateCount || 0) + 1;
      if (!previous || row.updatedAt > previous.updatedAt) byId.set(row.id, { ...row, name: titles.get(row.id) || "未命名会话", archived: Boolean(options.archived), duplicateCount });
      else previous.duplicateCount = duplicateCount;
    }
  }
  return { home, threads: [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt) };
}

// Read normal user/assistant text only. Raw files are never treated as a full
// reconstruction of the model context (compaction, images and tools may differ).
export async function readLocalSession(homeValue, threadId, options = {}) {
  validateThreadId(threadId);
  const home = await resolveCodexHome(homeValue);
  let located;
  for (const archived of [false, true]) {
    const listed = await listLocalSessions(home, { ...options, archived });
    located = listed.threads.find((row) => row.id === threadId);
    if (located) break;
  }
  if (!located) throw new Error("local_thread_not_found");
  // Resolve again to prevent a file replaced with a symlink from escaping the
  // selected Codex data directory. No auth/config/database files are opened.
  const realFile = await fs.realpath(located.file);
  const relative = path.relative(home, realFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("local_session_outside_home");
  const before = await fs.stat(realFile);
  if (!before.size) throw new Error("local_session_empty");
  const stream = createReadStream(realFile, { start: 0, end: before.size - 1, signal: options.signal });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const maxChars = Math.max(1000, Math.min(Number(options.maxChars) || 24000, 100000));
  let text = "", characters = 0, messages = 0, omitted = false, compacted = false, invalidTail = false;
  let invalidSeen = false, metadataSeen = false;
  const turns = new Set();
  try {
    for await (const line of lines) {
      checkCancelled(options.signal);
      if (!line.trim()) continue;
      if (invalidSeen) throw new Error("local_session_corrupt");
      let row;
      try { row = JSON.parse(line); } catch { invalidSeen = true; invalidTail = true; continue; }
      if (row.type === "session_meta") {
        if (row.payload?.id !== threadId) throw new Error("local_thread_identity_mismatch");
        metadataSeen = true;
      }
      if (!metadataSeen) throw new Error("local_session_metadata_missing");
      const payload = row.payload || {};
      if (row.type === "compacted" || payload.type === "context_compacted") compacted = true;
      if (payload.type === "thread_rolled_back") throw new Error("local_session_rollback_requires_app_server");
      if (row.type === "turn_context" && payload.turn_id) turns.add(payload.turn_id);
      if (row.type !== "response_item" || payload.type !== "message" || !["user", "assistant"].includes(payload.role)) continue;
      const content = typeof payload.content === "string" ? [{ type: "input_text", text: payload.content }] : payload.content || [];
      if (!Array.isArray(content)) { omitted = true; continue; }
      const parts = content.filter((part) => ["input_text", "output_text", "text"].includes(part?.type) && typeof part.text === "string");
      if (parts.length !== content.length) omitted = true;
      const body = parts.map((part) => part.text).join("\n").trim();
      if (!body) continue;
      const next = `${payload.role}: ${body}\n\n`;
      characters += next.length;
      messages += 1;
      text = (text + next).slice(-maxChars);
    }
  } finally { lines.close(); stream.destroy(); }
  const after = await fs.stat(realFile);
  if (after.size < before.size) throw new Error("local_session_changed_during_read");
  if (!text.trim()) throw new Error("local_session_no_readable_messages");
  const truncated = characters > maxChars;
  const projected = truncated ? `[本地消息前部已截断，原始字符数：${characters}]\n\n${text}` : text;
  return {
    source: "codex-local-session", text: clipText(projected, maxChars).text,
    thread: { id: threadId, name: located.name, cwd: located.cwd, updatedAt: after.mtimeMs / 1000 },
    coverage: { kind: "partial", turns: turns.size, messages, characters, truncated, omitted, compacted, incompleteTail: invalidTail, changedDuringRead: after.size !== before.size },
    sourceLocation: realFile,
    warning: "备用读取：仅包含本地记录中的用户与助手文本，未还原全部工具、图片和压缩上下文。",
  };
}
