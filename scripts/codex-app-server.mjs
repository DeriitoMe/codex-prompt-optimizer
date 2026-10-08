import { spawn } from "node:child_process";
import readline from "node:readline";
import { describeCodexCliError, resolveCodexCli } from "./codex-cli.mjs";

const DEFAULT_TIMEOUT_MS = 15000;

function commandConfig(options = {}) {
  // A nested Codex app-server may load this plugin again. Never let a nested
  // instance recursively start another app-server process.
  if (process.env.CONTEXT_PROMPT_ASSISTANT_NESTED === "1") return null;
  if (options.command) return options.command;
  const cli = resolveCodexCli();
  const socket = process.env.CODEX_APP_SERVER_SOCKET;
  // The proxy command uses Codex's default local control socket when no path
  // is supplied. This is the zero-configuration path inside a running Codex
  // desktop/CLI host; a failed connection is reported as an honest fallback.
  const mode = options.mode || process.env.CODEX_PROMPT_ASSISTANT_APP_SERVER_MODE || "stdio";
  if (mode === "proxy") {
    const args = ["app-server", "proxy"];
    if (socket) args.push("--sock", socket);
    return { cli, args };
  }
  if (mode === "stdio" || mode === "spawn") {
    return { cli, args: ["app-server", "--listen", "stdio://"] };
  }
  return null;
}

function rpcRequest(proc, id, method, params) {
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

// Deliberately restricted to history discovery and reads; never resume/start a turn.
export async function requestCodexHistory(method, params, options = {}) {
  if (!["thread/list", "thread/read"].includes(method)) throw new Error("history_method_not_allowed");
  if (options.signal?.aborted) throw new Error("context_cancelled");
  const config = commandConfig(options);
  if (!config) {
    throw new Error("codex_app_server_not_configured");
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const proc = spawn(config.cli, config.args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...(options.codexHome ? { CODEX_HOME: options.codexHome } : {}), CONTEXT_PROMPT_ASSISTANT_NESTED: "1" },
  });

  return await new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    let rl;
    const abort = () => finish(new Error("context_cancelled"));
    const timer = setTimeout(() => finish(new Error("codex_app_server_timeout")), timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      rl?.close();
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
    proc.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-4000); });
    proc.stdin.on("error", (error) => finish(error));
    proc.on("exit", (code) => {
      if (!settled) finish(new Error(`codex_app_server_exit_${code ?? "unknown"}`));
    });
    rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1) {
        if (message.error) return finish(new Error(`codex_initialize_failed: ${message.error.message || "unknown"}`));
        proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
        rpcRequest(proc, 2, method, params);
      } else if (message.id === 2) {
        if (message.error) return finish(new Error(`codex_history_failed: ${message.error.message || "unknown"}`));
        finish(null, message.result ?? null);
      }
    });
    rpcRequest(proc, 1, "initialize", {
      clientInfo: { name: "context_prompt_assistant", title: "Context Prompt Assistant", version: "0.4.2" },
      capabilities: {},
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

export async function readCodexThread(threadId, options = {}) {
  const result = await requestCodexHistory("thread/read", { threadId, includeTurns: true }, options);
  return result?.thread ?? result;
}

export async function listCodexThreads(options = {}) {
  const byId = new Map();
  let cursor = null;
  const deadline = Date.now() + (options.timeoutMs || 20000);
  for (let page = 0; page < 5; page += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("codex_app_server_timeout");
    const result = await requestCodexHistory("thread/list", {
      limit: 100, sortKey: "updated_at", sortDirection: "desc",
      sourceKinds: ["cli", "vscode", "appServer", "unknown"],
      archived: Boolean(options.archived), ...(cursor ? { cursor } : {}),
    }, { ...options, timeoutMs: remaining });
    for (const thread of result?.data || []) {
      if (!thread.id || thread.ephemeral) continue;
      const previous = byId.get(thread.id);
      if (!previous || Number(thread.updatedAt || 0) > Number(previous.updatedAt || 0)) byId.set(thread.id, thread);
    }
    cursor = result?.nextCursor;
    if (!cursor) break;
  }
  return { threads: [...byId.values()].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)), truncated: Boolean(cursor) };
}
