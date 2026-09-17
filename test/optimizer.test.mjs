import test from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, extractFinalMessage } from "../scripts/optimizer.mjs";

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
