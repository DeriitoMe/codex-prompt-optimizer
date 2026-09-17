import test from "node:test";
import assert from "node:assert/strict";
import { describeCodexCliError, resolveCodexCli } from "../scripts/codex-cli.mjs";

test("explicit Codex CLI path takes precedence", () => {
  assert.equal(resolveCodexCli({ cliPath: "C:\\Tools\\codex.exe", platform: "win32" }), "C:\\Tools\\codex.exe");
});

test("Windows discovery falls back to PATH when the desktop install is absent", () => {
  const resolved = resolveCodexCli({ platform: "win32" });
  assert.ok(typeof resolved === "string" && resolved.length > 0);
});

test("missing CLI errors include a safe remediation hint", () => {
  const detail = describeCodexCliError({ code: "ENOENT", message: "spawn codex ENOENT" }, "codex");
  assert.equal(detail.reason, "codex_cli_not_found");
  assert.match(detail.hint, /CODEX_CLI_PATH/);
  assert.equal(detail.message, undefined);
});
