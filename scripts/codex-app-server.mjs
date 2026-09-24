import { spawn } from "node:child_process";
import readline from "node:readline";
import { describeCodexCliError, resolveCodexCli } from "./codex-cli.mjs";

const DEFAULT_TIMEOUT_MS = 15000;

function commandConfig() {
  // A nested Codex app-server may load this plugin again. Never let a nested
  // instance recursively start another app-server process.
  if (process.env.CONTEXT_PROMPT_ASSISTANT_NESTED === "1") return null;
  const cli = resolveCodexCli();
  const socket = process.env.CODEX_APP_SERVER_SOCKET;
  // The proxy command uses Codex's default local control socket when no path
  // is supplied. This is the zero-configuration path inside a running Codex
  // desktop/CLI host; a failed connection is reported as an honest fallback.
  const mode = process.env.CODEX_PROMPT_ASSISTANT_APP_SERVER_MODE || "proxy";
  if (mode === "proxy") {
    const args = ["app-server", "proxy"];
    if (socket) args.push("--sock", socket);
    return { cli, args };
  }
  if (mode === "spawn" && process.env.CODEX_PROMPT_ASSISTANT_ALLOW_SPAWN === "1") {
    return { cli, args: ["app-server", "--listen", "stdio://"] };
  }
  return null;
}

function rpcRequest(proc, id, method, params) {
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

export async function readCodexThread(threadId, options = {}) {
  const config = commandConfig();
  if (!config) {
    throw new Error("codex_app_server_not_configured");
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const proc = spawn(config.cli, config.args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, CONTEXT_PROMPT_ASSISTANT_NESTED: "1" },
  });

  return await new Promise((resolve, reject) => {
    let settled = false;
    let initialized = false;
    let stderr = "";
    const timer = setTimeout(() => finish(new Error("codex_app_server_timeout")), timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill();
      if (error) {
        error.details = [error.details, stderr.trim().slice(-1000)].filter(Boolean).join("\n");
        reject(error);
      } else {
        resolve(value);
      }
    };
    proc.on("error", (error) => finish(Object.assign(new Error(describeCodexCliError(error, config.cli).reason), {
      code: error.code,
      details: describeCodexCliError(error, config.cli).hint,
    })));
    proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
    proc.on("exit", (code) => {
      if (!settled) finish(new Error(`codex_app_server_exit_${code ?? "unknown"}`));
    });
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1) {
        if (message.error) return finish(new Error(`codex_initialize_failed: ${message.error.message || "unknown"}`));
        initialized = true;
        proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
        rpcRequest(proc, 2, "thread/read", { threadId, includeTurns: true });
      } else if (message.id === 2) {
        if (message.error) return finish(new Error(`codex_thread_read_failed: ${message.error.message || "unknown"}`));
        finish(null, message.result?.thread ?? message.result ?? null);
      }
    });
    rpcRequest(proc, 1, "initialize", {
      clientInfo: { name: "context_prompt_assistant", title: "Context Prompt Assistant", version: "0.4.1" },
      capabilities: {},
    });
    // Keep a reference in the closure for diagnostics and future protocol checks.
    void initialized;
  });
}
