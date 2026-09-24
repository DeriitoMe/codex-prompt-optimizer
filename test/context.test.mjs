import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { contextFingerprint, fallbackInstruction, isRetryableSharedSnapshotFailure, normalizeCodexThread, normalizeSharedSnapshot, resolveContextTarget, retrySharedSnapshotRead, waitForSharedSnapshotPage } from "../scripts/context.mjs";

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

test("recognizes Codex shared snapshot links on the ChatGPT origin", () => {
  const target = resolveContextTarget("https://chatgpt.com/s/cx_6aaacdc5804481918c22acc90639d481");
  assert.equal(target.provider, "codex");
  assert.equal(target.targetType, "shared_snapshot");
  assert.equal(target.id, "cx_6aaacdc5804481918c22acc90639d481");
  assert.equal(target.access, "unverified");
  assert.match(fallbackInstruction(target, "codex_shared_snapshot_requires_browser_reader"), /共享对话快照/);
});

test("recognizes Codex shared-thread deep links", () => {
  const target = resolveContextTarget("codex://shared-thread/cx_0123456789abcdef0123456789abcdef");
  assert.equal(target.provider, "codex");
  assert.equal(target.targetType, "shared_snapshot");
  assert.equal(target.id, "cx_0123456789abcdef0123456789abcdef");
});

test("normalizes shared snapshot text without claiming turn completeness", () => {
  const normalized = normalizeSharedSnapshot("Codex shared snapshot\nUser: keep the prompt read-only", 1000);
  assert.equal(normalized.source, "codex-shared-snapshot");
  assert.equal(normalized.coverage.kind, "partial");
  assert.equal(normalized.coverage.turns, null);
  assert.match(normalized.text, /keep the prompt read-only/);
});

test("waits for a cold shared page to replace its initial shell before reading", async () => {
  let now = 0;
  const initialShell = `Shared conversation\n${"Navigation and controls ".repeat(12)}`;
  const conversation = `Shared conversation\n${"Actual conversation content. ".repeat(12)}`;
  const page = await waitForSharedSnapshotPage(
    async () => ({ text: now < 1200 ? initialShell : conversation }),
    {
      timeoutMs: 5000,
      intervalMs: 100,
      minimumInitialWaitMs: 1500,
      stableMs: 400,
      shortContentWaitMs: 2200,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    },
  );
  assert.match(page.text, /Actual conversation content/);
});

test("retries one transient shared snapshot read failure automatically", async () => {
  let attempts = 0;
  const result = await retrySharedSnapshotRead(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("codex_shared_snapshot_empty");
    return { text: "snapshot content" };
  }, { retryDelayMs: 0, sleep: async () => {} });
  assert.equal(attempts, 2);
  assert.equal(result.text, "snapshot content");
  assert.equal(isRetryableSharedSnapshotFailure("net::ERR_TIMED_OUT"), true);
  assert.equal(isRetryableSharedSnapshotFailure("unsupported_link"), false);
});

test("parses the public ChatGPT share route for paste-and-status handling", () => {
  const target = resolveContextTarget("https://chatgpt.com/share/abc123");
  assert.equal(target.provider, "chatgpt");
  assert.equal(target.targetType, "thread");
  assert.equal(target.id, "abc123");
  assert.equal(target.access, "unverified");
});

test("extracts a URL copied from Markdown or angle-bracket formatting", () => {
  const markdown = resolveContextTarget("[任务](https://chatgpt.com/s/cx_0123456789abcdef0123456789abcdef)");
  assert.equal(markdown.id, "cx_0123456789abcdef0123456789abcdef");
  assert.equal(markdown.targetType, "shared_snapshot");
  const bracketed = resolveContextTarget("<https://chatgpt.com/share/demo123>");
  assert.equal(bracketed.id, "demo123");
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
