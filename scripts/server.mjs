#!/usr/bin/env node
import readline from "node:readline";
import { classifyReadFailure, contextFingerprint, normalizeCodexThread, resolveContextTarget } from "./context.mjs";
import { readCodexThread } from "./codex-app-server.mjs";

const cache = new Map();
const MAX_CHARS = 24000;
const MAX_URL_LENGTH = 4096;

const toolDefinitions = [
  {
    name: "resolve_context_target",
    description: "Parse a Codex or ChatGPT project/thread link without fetching private content.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Project or conversation URL." } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "read_context",
    description: "Read a target's latest context when an approved local adapter is configured; otherwise return an honest fallback state.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        maxChars: { type: "integer", minimum: 1000, maximum: 100000 },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "refresh_context",
    description: "Refresh a target, compare it with this server's last read, and report coverage or staleness.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        maxChars: { type: "integer", minimum: 1000, maximum: 100000 },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

function jsonText(value) {
  return JSON.stringify(value, null, 2);
}

function result(payload, isError = false) {
  return {
    content: [{ type: "text", text: jsonText(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

async function readTarget(args) {
  if (typeof args?.url !== "string" || args.url.length > MAX_URL_LENGTH) {
    return classifyReadFailure(null, "invalid_url");
  }
  const target = resolveContextTarget(args?.url);
  if (!target.ok) return classifyReadFailure(target, target.reason);
  if (target.provider !== "codex" || target.targetType !== "thread") {
    const reason = target.provider === "chatgpt" && target.targetType === "scheduled_task"
      ? "chatgpt_scheduled_task_link_not_conversation"
      : "only_codex_thread_read_is_available_in_this_version";
    return classifyReadFailure(target, reason);
  }
  try {
    const thread = await readCodexThread(target.id, { timeoutMs: 15000 });
    if (!thread) return classifyReadFailure(target, "codex_thread_not_found");
    const normalized = normalizeCodexThread(thread, args?.maxChars || MAX_CHARS);
    const payload = {
      ok: true,
      target,
      access: "read",
      checkedAt: new Date().toISOString(),
      ...normalized,
    };
    return payload;
  } catch (error) {
    const reason = error?.message || "context_read_failed";
    return classifyReadFailure(target, reason);
  }
}

async function callTool(name, args) {
  if (name === "resolve_context_target") {
    return resolveContextTarget(args?.url);
  }
  if (name === "read_context") {
    return await readTarget(args);
  }
  if (name === "refresh_context") {
    const resolved = resolveContextTarget(args?.url);
    const targetKey = resolved.targetKey || String(args?.url || "");
    const previous = cache.get(targetKey);
    const payload = await readTarget(args);
    if (!payload.ok && previous?.payload?.ok) {
      return {
        ...payload,
        access: "stale",
        stale: true,
        staleSince: previous.checkedAt,
        previousCheckedAt: previous.checkedAt,
        changedSinceLastRead: false,
        cacheState: "stale",
        cachedContext: previous.payload,
      };
    }
    const fingerprint = contextFingerprint(payload);
    cache.set(targetKey, { fingerprint, payload, checkedAt: payload.checkedAt || new Date().toISOString() });
    return {
      ...payload,
      changedSinceLastRead: previous ? previous.fingerprint !== fingerprint : null,
      cacheState: previous ? "refreshed" : "initialized",
      previousCheckedAt: previous?.checkedAt || null,
    };
  }
  throw new Error(`unknown_tool:${name}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

async function handle(message) {
  if (!message || typeof message !== "object") return;
  if (message.method === "initialize") {
    send({ id: message.id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "context-prompt-assistant", version: "0.2.0" },
    } });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "ping") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "tools/list") {
    send({ id: message.id, result: { tools: toolDefinitions } });
    return;
  }
  if (message.method === "tools/call") {
    try {
      const payload = await callTool(message.params?.name, message.params?.arguments || {});
      // An unavailable/private target is an expected, structured outcome. Keep
      // it as a successful tool response so the host can render the fallback
      // instruction instead of reducing it to a generic tool error.
      send({ id: message.id, result: result(payload, false) });
    } catch (error) {
      send({ id: message.id, result: result({ ok: false, reason: error?.message || "tool_failed" }, true) });
    }
    return;
  }
  if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  void handle(message);
});
