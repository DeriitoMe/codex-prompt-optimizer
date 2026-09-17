import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "skills/context-prompt-assistant/SKILL.md",
  "skills/context-prompt-assistant/agents/openai.yaml",
  "scripts/context.mjs",
  "scripts/codex-app-server.mjs",
  "scripts/codex-cli.mjs",
  "scripts/server.mjs",
  "scripts/optimizer.mjs",
  "scripts/app-server-diagnostics.mjs",
  "scripts/register-codex-autostart.ps1",
  "desktop/main.cjs",
  "desktop/preload.cjs",
  "desktop/index.html",
  "desktop/renderer.js",
  "desktop/styles.css",
  "LICENSE",
  "docs/acceptance-checklist.md",
  "test/cases.json",
  "docs/github-repository-template.md",
  "scripts/verify-release.mjs",
  "CHANGELOG.md",
  "register-codex-autostart.cmd",
  "unregister-codex-autostart.cmd",
  "launch-codex-with-assistant.cmd",
];
for (const relative of required) {
  if (!fs.existsSync(path.join(root, relative))) throw new Error(`Missing ${relative}`);
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin/plugin.json"), "utf8"));
const mcp = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
if (manifest.name !== "context-prompt-assistant") throw new Error("manifest name mismatch");
if (manifest.mcpServers !== "./.mcp.json") throw new Error("manifest MCP path mismatch");
if (!mcp.mcpServers?.context_prompt?.command) throw new Error("MCP server command missing");
const skill = fs.readFileSync(path.join(root, "skills/context-prompt-assistant/SKILL.md"), "utf8");
if (!skill.startsWith("---\n") || !skill.includes("name: context-prompt-assistant")) throw new Error("invalid skill frontmatter");
if (skill.includes("[TODO:")) throw new Error("skill contains TODO placeholder");
const cases = JSON.parse(fs.readFileSync(path.join(root, "test/cases.json"), "utf8"));
if (!Array.isArray(cases) || cases.length !== 40) throw new Error("expected exactly 40 acceptance cases");
const requiredCaseCounts = { fidelity: 10, reference: 8, refresh: 8, isolation: 6, edge: 8 };
const ids = new Set();
for (const testCase of cases) {
  if (!testCase?.id || ids.has(testCase.id)) throw new Error(`invalid or duplicate acceptance case id: ${testCase?.id || "missing"}`);
  if (!testCase.category || !testCase.input || !testCase.assert) throw new Error(`incomplete acceptance case: ${testCase.id}`);
  ids.add(testCase.id);
}
for (const [category, expected] of Object.entries(requiredCaseCounts)) {
  const actual = cases.filter((testCase) => testCase.category === category).length;
  if (actual !== expected) throw new Error(`expected ${expected} ${category} cases, found ${actual}`);
}
console.log(`Validated ${manifest.name} (${required.length} required files).`);
