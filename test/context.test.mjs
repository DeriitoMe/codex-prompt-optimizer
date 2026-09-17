import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { contextFingerprint, normalizeCodexThread, resolveContextTarget } from "../scripts/context.mjs";

test("parses Codex thread and strips query values from normalized URL", () => {
  const target = resolveContextTarget("codex://thread/thr_123?token=secret&title=Build");
  assert.equal(target.provider, "codex");
  assert.equal(target.targetType, "thread");
  assert.equal(target.id, "thr_123");
  assert.equal(target.normalizedUrl, "codex://thread/thr_123");
  assert.equal(target.title, "Build");
  assert.equal(target.targetKey, "codex:thread:thr_123");
});

test("parses ChatGPT conversation links without claiming access", () => {
  const target = resolveContextTarget("https://chatgpt.com/c/abc123");
  assert.equal(target.provider, "chatgpt");
  assert.equal(target.targetType, "thread");
  assert.equal(target.id, "abc123");
  assert.equal(target.access, "unverified");
});

test("parses ChatGPT shared conversation links", () => {
  const target = resolveContextTarget("https://chatgpt.com/s/cx_6aaacdc5804481918c22acc90639d481");
  assert.equal(target.provider, "chatgpt");
  assert.equal(target.targetType, "thread");
  assert.equal(target.id, "cx_6aaacdc5804481918c22acc90639d481");
  assert.equal(target.access, "unverified");
});

test("parses the public ChatGPT share route for paste-and-status handling", () => {
  const target = resolveContextTarget("https://chatgpt.com/share/abc123");
  assert.equal(target.provider, "chatgpt");
  assert.equal(target.targetType, "thread");
  assert.equal(target.id, "abc123");
  assert.equal(target.access, "unverified");
});

test("recognizes Codex routes hosted under ChatGPT", () => {
  const target = resolveContextTarget("https://chatgpt.com/codex/tasks/task_123");
  assert.equal(target.provider, "codex");
  assert.equal(target.targetType, "thread");
  assert.equal(target.id, "task_123");
});

test("rejects credentials and unsupported links", () => {
  assert.equal(resolveContextTarget("https://user:pass@chatgpt.com/c/x").reason, "credentials_in_url");
  assert.equal(resolveContextTarget("https://example.com/not-a-context").ok, false);
});

test("normalizes Codex thread messages and reports truncation", () => {
  const normalized = normalizeCodexThread({
    id: "thr_1",
    name: "Demo",
    turns: [
      { id: "turn_1", items: [{ type: "userMessage", text: "Fix the login bug." }] },
      { id: "turn_2", items: [{ type: "agentMessage", text: "I found the issue." }] },
    ],
  }, 20);
  assert.equal(normalized.coverage.turns, 2);
  assert.equal(normalized.messages.length, 2);
  assert.equal(normalized.coverage.truncated, true);
  assert.equal(normalized.messages[0].role, "user");
});

test("extracts array content and marks unextractable turns partial", () => {
  const normalized = normalizeCodexThread({
    turns: [{ id: "turn_1", items: [{ type: "userMessage", content: [{ type: "text", text: "保留登录逻辑" }] }] }],
  });
  assert.equal(normalized.messages[0].text, "保留登录逻辑");
  assert.equal(normalized.coverage.kind, "full");
});

test("fingerprints are stable for the same payload", () => {
  assert.equal(contextFingerprint({ a: 1 }), contextFingerprint({ a: 1 }));
  assert.notEqual(contextFingerprint({ a: 1 }), contextFingerprint({ a: 2 }));
  assert.equal(contextFingerprint({ a: 1, checkedAt: "now" }), contextFingerprint({ a: 1, checkedAt: "later" }));
});

function sendRpc(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

test("MCP server exposes read-only tools and honest fallback", async () => {
  const child = spawn(process.execPath, ["scripts/server.mjs"], { cwd: new URL("..", import.meta.url), stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    for (const line of buffer.split("\n").slice(0, -1)) {
      try { messages.push(JSON.parse(line)); } catch { /* ignore diagnostics */ }
    }
    buffer = buffer.split("\n").at(-1) || "";
  });
  sendRpc(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  sendRpc(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  sendRpc(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  sendRpc(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_context", arguments: { url: "https://chatgpt.com/c/abc" } } });
  await new Promise((resolve) => setTimeout(resolve, 250));
  child.kill();
  assert.equal(messages.find((message) => message.id === 1)?.result?.serverInfo?.name, "context-prompt-assistant");
  assert.equal(messages.find((message) => message.id === 2)?.result?.tools?.length, 3);
  const read = messages.find((message) => message.id === 3);
  assert.equal(read?.result?.structuredContent?.access, "unavailable");
  assert.match(read?.result?.structuredContent?.fallback || "", /Context Prompt Assistant/);
  assert.equal(read?.result?.isError, undefined);
});
