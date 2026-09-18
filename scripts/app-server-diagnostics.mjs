#!/usr/bin/env node
import { spawn } from "node:child_process";
import readline from "node:readline";
import { describeCodexCliError, resolveCodexCli } from "./codex-cli.mjs";

const args = process.argv.slice(2);
const readIndex = args.indexOf("--read");
const readId = readIndex >= 0 ? args[readIndex + 1] : null;
const method = readId ? "thread/read" : "thread/list";
const params = readId ? { threadId: readId, includeTurns: true } : { limit: 10, sortDirection: "desc" };
const cli = resolveCodexCli();
const child = spawn(cli, ["app-server", "--listen", "stdio://"], {
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
let buffer = "";
let finished = false;
const finish = (value, code = 0) => {
  if (finished) return;
  finished = true;
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  child.kill();
  process.exitCode = code;
};
const timer = setTimeout(() => finish({ ok: false, reason: "diagnostics_timeout", stderr: stderr.slice(-1000) }, 1), 20000);
const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

child.on("error", (error) => {
  clearTimeout(timer);
  finish({ ok: false, ...describeCodexCliError(error, cli) }, 1);
});
child.stderr.on("data", (chunk) => { stderr += String(chunk); });
const rl = readline.createInterface({ input: child.stdout });
rl.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === 1) {
    if (message.error) return finish({ ok: false, reason: "initialize_failed", details: message.error }, 1);
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    send({ jsonrpc: "2.0", id: 2, method, params });
  } else if (message.id === 2) {
    clearTimeout(timer);
    if (message.error) return finish({ ok: false, reason: `${method}_failed`, details: message.error }, 1);
    if (!readId) {
      const data = message.result?.data || message.result?.threads || [];
      return finish({ ok: true, method, count: data.length, threads: data.map((thread) => ({ id: thread.id, name: thread.name, cwd: thread.cwd, updatedAt: thread.updatedAt })) });
    }
    const thread = message.result?.thread || message.result;
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const text = turns.flatMap((turn) => Array.isArray(turn?.items) ? turn.items : []).map((item) => item?.text || item?.content || "").filter(Boolean).join("\n");
    return finish({ ok: true, method, thread: { id: thread?.id, name: thread?.name, cwd: thread?.cwd, updatedAt: thread?.updatedAt }, coverage: { turns: turns.length, characters: text.length }, sample: text.slice(-1200) });
  }
});

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "context-prompt-assistant-diagnostics", title: "Context Prompt Assistant diagnostics", version: "0.4.0" }, capabilities: {} } });
