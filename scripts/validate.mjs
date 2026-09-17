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
  "LICENSE",
  "docs/acceptance-checklist.md",
  "test/cases.json",
  "docs/github-repository-template.md",
  "CHANGELOG.md",
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
console.log(`Validated ${manifest.name} (${required.length} required files).`);
