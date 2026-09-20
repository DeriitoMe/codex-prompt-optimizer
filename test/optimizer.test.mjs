import test from "node:test";
import assert from "node:assert/strict";
import { buildCodexArgs, buildPrompt, extractFinalMessage } from "../scripts/optimizer.mjs";

test("extracts only the final assistant message from Codex events", () => {
  const text = extractFinalMessage([
    { type: "item.completed", item: { type: "command_execution", command: "echo unsafe" } },
    { type: "item.completed", item: { type: "agent_message", text: "第一版" } },
    { type: "item.completed", item: { type: "agent_message", content: [{ type: "text", text: "最终优化结果" }] } },
  ]);
  assert.equal(text, "最终优化结果");
});

test("optimizer prompt states read-only and preserves the draft", () => {
  const prompt = buildPrompt({ draft: "保留登录逻辑，暂不执行", contextText: "用户确认使用 Windows", contextStatus: "read" });
  assert.match(prompt, /只读沙箱/);
  assert.match(prompt, /保留登录逻辑，暂不执行/);
  assert.match(prompt, /用户确认使用 Windows/);
});

test("optimization modes have distinct scopes", () => {
  const simple = buildPrompt({ draft: "把页面改紧凑点", optimizationMode: "simple" });
  const professional = buildPrompt({ draft: "把页面改紧凑点", optimizationMode: "professional" });
  assert.match(simple, /简单优化/);
  assert.doesNotMatch(simple, /执行规格/);
  assert.match(professional, /专业化优化/);
  assert.match(professional, /验收标准/);
});

test("optimizer pins the low-cost Luna model and high reasoning effort", () => {
  const args = buildCodexArgs({ cwd: "D:/CodexProjects/example" });
  assert.deepEqual(args.slice(-6), [
    "--model", "gpt-5.6-luna",
    "--config", 'model_reasoning_effort="high"',
    "--cd", "D:/CodexProjects/example",
  ]);
});
