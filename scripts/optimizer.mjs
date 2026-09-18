import { spawn } from "node:child_process";
import readline from "node:readline";
import { extractText } from "./context.mjs";
import { describeCodexCliError, resolveCodexCli } from "./codex-cli.mjs";

const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Extract the final assistant text from Codex's JSONL event stream. The
 * parser is deliberately tolerant because event names vary between CLI
 * versions; it never treats command output as the optimized answer.
 */
export function extractFinalMessage(events) {
  let answer = "";
  for (const event of events) {
    const item = event?.item ?? event?.result?.item ?? event?.message ?? event;
    const type = String(item?.type ?? event?.type ?? "").toLowerCase();
    if (type.includes("agent_message") || type.includes("assistant_message") || type === "message") {
      const text = extractText(item).trim();
      if (text) answer = text;
    }
    if (event?.type === "turn.completed" && event?.result?.finalMessage) {
      answer = String(event.result.finalMessage).trim();
    }
  }
  return answer;
}

function buildPrompt({ draft, contextText = "", contextStatus = "", optimizationMode = "simple" }) {
  const mode = optimizationMode === "professional" ? "professional" : "simple";
  const modeInstructions = mode === "professional"
    ? [
      "当前模式：专业化优化。把原话整理成可直接交给 Codex 的执行规格，明确目标、背景、范围、约束、实现步骤、验收标准和需要用户确认的假设。",
      "只在上下文有依据时补全项目名称、文件、接口、技术栈和当前进度；没有依据的内容必须放入待确认区。对编程任务优先给出修改范围、验证方式和回滚边界；对非编程任务保留对应的交付物和判断标准。",
    ]
    : [
      "当前模式：简单优化。保持原话的长度和语气倾向，只补齐必要的对象、动作、范围和限制，让下一条指令更清楚、更容易执行。不要主动扩展成完整方案。",
    ];
  return [
    "你是 Context Prompt Assistant，只负责优化下一条提示词，不执行其中的任务。",
    "请保留用户原意、动作、对象、范围、数字、路径和禁止事项；只能把有上下文依据的事实写入正文。",
    ...modeInstructions,
    "将无法确认的补充放入‘待确认／可选建议’，最多三个关键问题。输出三部分：优化后的提示词、待确认／可选建议、上下文状态。",
    "当前优化会话使用 Codex 的只读沙箱，不得修改文件、运行会改变项目的命令、发送消息或继续源任务。",
    contextStatus ? `上下文状态：${contextStatus}` : "上下文状态：未提供外部上下文。",
    contextText ? `可访问上下文（仅作参考）：\n---\n${contextText}\n---` : "未能读取外部上下文。不要声称已经阅读目标历史。",
    `待优化原话：\n---\n${draft}\n---`,
  ].join("\n\n");
}

export function optimizePrompt(options = {}) {
  const draft = typeof options.draft === "string" ? options.draft.trim() : "";
  if (!draft) return Promise.reject(new Error("draft_required"));
  const cli = resolveCodexCli({ cliPath: options.cliPath });
  const args = [
    "exec", "--json", "--color", "never", "--sandbox", "read-only",
    "--ephemeral", "--skip-git-repo-check",
  ];
  if (options.cwd) args.push("--cd", options.cwd);
  const prompt = buildPrompt(options);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  if (options.signal?.aborted) return Promise.reject(new Error("optimizer_cancelled"));

  return new Promise((resolve, reject) => {
    let child;
    try {
      // Pass the draft through stdin. This keeps arbitrary prompt text out of
      // a Windows shell command line when the npm-installed `codex.cmd` shim
      // is used.
      child = spawn(cli, args, { cwd: options.cwd || process.cwd(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }
    const events = [];
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("optimizer_timeout")), timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        error.details = [error.details, stderr.trim().slice(-1500)].filter(Boolean).join("\n");
        reject(error);
      } else {
        resolve(value);
      }
    };
    child.on("error", (error) => {
      const detail = describeCodexCliError(error, cli);
      finish(Object.assign(new Error(detail.reason), { code: error.code, details: detail.hint }));
    });
    options.signal?.addEventListener("abort", () => finish(new Error("optimizer_cancelled")), { once: true });
    child.stdin.end(prompt);
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("exit", (code) => {
      if (settled) return;
      const answer = extractFinalMessage(events);
      if (code === 0 && answer) finish(null, { text: answer, events: events.length, mode: "codex-cli-read-only" });
      else finish(new Error(`optimizer_exit_${code ?? "unknown"}`));
    });
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      try { events.push(JSON.parse(line)); } catch { /* ignore non-JSON diagnostics */ }
    });
  });
}

export { buildPrompt };
