import crypto from "node:crypto";

const MAX_URL_LENGTH = 4096;
const DEFAULT_MAX_CHARS = 24000;
const CODEX_HOSTS = new Set(["codex", "localhost"]);
const CHATGPT_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safePathId(value) {
  if (!value) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  const cleaned = decoded.replace(/[?#].*$/, "").trim();
  if (!cleaned || cleaned.length > 256) return null;
  return /^[A-Za-z0-9._:-]+$/.test(cleaned) ? cleaned : null;
}

function safeUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, reason: "empty_url" };
  }
  let value = raw.trim();
  // Clipboard content often includes Markdown link syntax or angle brackets.
  // Extract only the URL token; the URL is still validated below and no other
  // clipboard text is sent to a reader.
  const markdownMatch = value.match(/\]\(\s*((?:https?|codex):\/\/[^\s)]+)\s*\)/i);
  if (markdownMatch) value = markdownMatch[1];
  else if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1).trim();
  else {
    const urlMatch = value.match(/((?:https?|codex):\/\/[^\s<>"']+)/i);
    if (urlMatch) value = urlMatch[1].replace(/[.,!?;:]+$/, "");
  }
  if (value.length > MAX_URL_LENGTH) {
    return { ok: false, reason: "url_too_long" };
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (!["https:", "http:", "codex:"].includes(parsed.protocol)) {
    return { ok: false, reason: "unsupported_scheme" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "credentials_in_url" };
  }
  return { ok: true, parsed };
}

function inferTarget(parsed) {
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.split("/").filter(Boolean);
  // Custom `codex://thread/<id>` links encode the route marker as the host.
  // Treat that host as the first path segment for route detection, while
  // preserving the original URL for the safe normalized display value.
  const routePath = parsed.protocol === "codex:" && host ? [host, ...path] : path;
  const lowerPath = routePath.map((part) => part.toLowerCase());
  const sharedCodexId = lowerPath[1] && /^cx_[a-f0-9]{32}$/i.test(routePath[1]) ? routePath[1] : null;
  const queryId = parsed.searchParams.get("threadId")
    ?? parsed.searchParams.get("thread_id")
    ?? parsed.searchParams.get("conversationId")
    ?? parsed.searchParams.get("conversation_id")
    ?? parsed.searchParams.get("id");
  const projectId = parsed.searchParams.get("projectId") ?? parsed.searchParams.get("project_id");

  let provider = "unknown";
  if (
    parsed.protocol === "codex:"
    || CODEX_HOSTS.has(host)
    || host.endsWith(".codex.app")
    || (CHATGPT_HOSTS.has(host) && lowerPath[0] === "codex")
  ) {
    provider = "codex";
  } else if (CHATGPT_HOSTS.has(host) || host.endsWith(".chatgpt.com")) {
    provider = "chatgpt";
  }

  // Codex shared thread snapshots currently use the ChatGPT web origin but
  // have a distinctive /s/cx_<32 hex> route. They are read-only Codex
  // snapshots, not ChatGPT scheduled tasks.
  if (provider === "chatgpt" && lowerPath[0] === "s" && sharedCodexId) provider = "codex";

  let targetType = "unknown";
  let id = safePathId(queryId);
  const markerIndex = lowerPath.findIndex((part) =>
    ["thread", "threads", "conversation", "conversations", "c", "task", "tasks", "run", "runs"].includes(part),
  );
  const projectIndex = lowerPath.findIndex((part) => ["project", "projects", "workspace"].includes(part));
  if (projectId) {
    targetType = "project";
    id = safePathId(projectId);
  } else if (projectIndex >= 0) {
    targetType = "project";
    id = id ?? safePathId(routePath[projectIndex + 1]);
  } else if (parsed.protocol === "codex:" && lowerPath[0] === "shared-thread" && sharedCodexId) {
    targetType = "shared_snapshot";
    id = sharedCodexId;
  } else if (provider === "codex" && lowerPath[0] === "s" && sharedCodexId) {
    targetType = "shared_snapshot";
    id = sharedCodexId;
  } else if (markerIndex >= 0) {
    targetType = provider === "chatgpt" && ["task", "tasks", "run", "runs"].includes(lowerPath[markerIndex])
      ? "scheduled_task"
      : "thread";
    id = id ?? safePathId(routePath[markerIndex + 1]);
  } else if (
    provider === "chatgpt"
    && routePath.length >= 2
    && lowerPath[0] === "share"
  ) {
    targetType = "thread";
    id = safePathId(routePath[1]);
  } else if (provider === "chatgpt" && routePath.length >= 2 && lowerPath[0] === "s") {
    targetType = "scheduled_task";
    id = safePathId(routePath[1]);
  }

  const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  // The display URL intentionally omits query values, while the internal
  // identity must retain the parsed target id. Otherwise threadId=a and
  // threadId=b would share a cache entry after normalization.
  const targetKey = [provider, targetType, id].join(":");
  const title = stringOrNull(parsed.searchParams.get("title"));
  const access = provider === "unknown" || targetType === "unknown" || !id
    ? "unsupported"
    : "unverified";
  return {
    ok: access !== "unsupported",
    provider,
    targetType,
    id,
    title,
    access,
    normalizedUrl: normalized,
    targetKey,
    reason: access === "unsupported" ? "unrecognized_context_link" : "link_parsed_but_access_not_verified",
  };
}

export function resolveContextTarget(raw) {
  const result = safeUrl(raw);
  if (!result.ok) {
    return {
      ok: false,
      provider: "unknown",
      targetType: "unknown",
      id: null,
      title: null,
      access: "unsupported",
      normalizedUrl: null,
      reason: result.reason,
    };
  }
  return inferTarget(result.parsed);
}

export function clipText(text, maxChars = DEFAULT_MAX_CHARS) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MAX_CHARS;
  const value = typeof text === "string" ? text : String(text ?? "");
  if (value.length <= limit) return { text: value, truncated: false, originalChars: value.length };
  return {
    // Keep the newest part because later user corrections and decisions have
    // higher priority than the beginning of a long thread.
    text: `[上下文前部已截断，原始字符数：${value.length}]\n\n${value.slice(-Math.max(0, limit - 80))}`,
    truncated: true,
    originalChars: value.length,
  };
}

function textFromUnknown(value, depth = 0) {
  if (depth > 5 || value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => textFromUnknown(part, depth + 1)).filter(Boolean).join("\n");
  }
  if (typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  const parts = [];
  for (const key of ["message", "content", "input", "output", "items", "turns", "parts", "delta"]) {
    if (value[key] !== undefined) {
      const child = textFromUnknown(value[key], depth + 1);
      if (child) parts.push(child);
    }
  }
  return parts.join("\n");
}

export const extractText = textFromUnknown;

function inferRole(item) {
  const type = String(item?.type ?? item?.role ?? "").toLowerCase();
  if (type.includes("user") || type.includes("input")) return "user";
  if (type.includes("agent") || type.includes("assistant") || type.includes("output")) return "assistant";
  return "unknown";
}

export function normalizeCodexThread(thread, maxChars = DEFAULT_MAX_CHARS) {
  const rawTurns = Array.isArray(thread?.turns) ? thread.turns : [];
  const messages = [];
  for (const turn of rawTurns) {
    const items = Array.isArray(turn?.items) ? turn.items : [turn];
    for (const item of items) {
      const text = textFromUnknown(item).trim();
      if (!text) continue;
      messages.push({
        role: inferRole(item),
        text,
        turnId: stringOrNull(turn?.id),
      });
    }
  }
  const combined = messages.map((message) => `${message.role}: ${message.text}`).join("\n\n");
  const clipped = clipText(combined, maxChars);
  return {
    source: "codex-app-server",
    thread: {
      id: stringOrNull(thread?.id),
      name: stringOrNull(thread?.name),
      status: thread?.status ?? null,
      cwd: stringOrNull(thread?.cwd),
      updatedAt: thread?.updatedAt ?? null,
    },
    coverage: {
      kind: rawTurns.length === 0 ? "none" : clipped.truncated || messages.length === 0 ? "partial" : "full",
      turns: rawTurns.length,
      messages: messages.length,
      characters: clipped.originalChars,
      truncated: clipped.truncated,
    },
    messages,
    text: clipped.text,
  };
}

export function contextFingerprint(payload) {
  const stable = payload && typeof payload === "object" ? { ...payload } : payload;
  if (stable && typeof stable === "object") {
    // Timestamps and cache annotations describe the read operation, not the
    // content. Excluding them makes refresh comparisons meaningful.
    delete stable.checkedAt;
    delete stable.previousCheckedAt;
    delete stable.changedSinceLastRead;
    delete stable.cacheState;
  }
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function fallbackInstruction(target, reason) {
  const label = target?.provider === "codex" ? "Codex" : target?.provider === "chatgpt" ? "ChatGPT" : "目标";
  if (target?.provider === "codex" && target?.targetType === "shared_snapshot") {
    return `这是 Codex 的共享对话快照链接。它是创建分享时的只读静态副本，不会随原任务后续更新。请确认共享页面在浏览器中可以打开；如果当前客户端无法读取网页快照，可回到原 Codex 对话调用 Context Prompt Assistant。只输出优化后的提示词、待确认问题和上下文状态，暂不执行。\n\n当前快照未能自动读取：${reason}`;
  }
  if (target?.provider === "chatgpt" && target?.targetType === "scheduled_task") {
    return `这个链接是 ChatGPT 的共享任务链接（/s/），不是对话历史。请在 ChatGPT 对话中使用“分享”生成 https://chatgpt.com/share/... 链接，或直接回到原对话调用 Context Prompt Assistant；只输出优化后的提示词、待确认问题和上下文状态，暂不执行。\n\n当前链接未能自动读取：${reason}`;
  }
  return `请在这个 ${label} 项目或对话中显式调用 Context Prompt Assistant，回看当前可见的相关上下文，优化我下一条指令；只输出优化后的提示词、待确认问题和上下文状态，暂不执行。\n\n当前链接未能自动读取：${reason}`;
}

export function classifyReadFailure(target, reason) {
  return {
    ok: false,
    target,
    access: "unavailable",
    coverage: { kind: "none", turns: 0, messages: 0, truncated: false },
    reason,
    fallback: fallbackInstruction(target, reason),
  };
}

export function normalizeSharedSnapshot(text, maxChars = DEFAULT_MAX_CHARS) {
  const clipped = clipText(text, maxChars);
  return {
    source: "codex-shared-snapshot",
    coverage: {
      // DOM extraction cannot guarantee the provider's internal turn count.
      kind: "partial",
      turns: null,
      messages: null,
      characters: clipped.originalChars,
      truncated: clipped.truncated,
    },
    text: clipped.text,
  };
}
