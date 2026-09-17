import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve the Codex executable without invoking a shell. A user supplied
 * CODEX_CLI_PATH always wins; otherwise Windows installations made by the
 * Codex desktop app are searched before falling back to PATH resolution.
 */
export function resolveCodexCli(options = {}) {
  const explicit = options.cliPath ?? process.env.CODEX_CLI_PATH;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();

  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
    try {
      const directories = fs.readdirSync(binRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const directory = path.join(binRoot, entry.name);
          let mtime = 0;
          try { mtime = fs.statSync(directory).mtimeMs; } catch { /* ignore an entry removed during discovery */ }
          return { directory, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);
      for (const { directory } of directories) {
        for (const filename of ["codex.exe", "codex.cmd", "codex.bat"]) {
          const candidate = path.join(directory, filename);
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    } catch {
      // A missing or inaccessible install directory is handled by the PATH
      // fallback and surfaced as a normal spawn error if that also fails.
    }
  }
  return "codex";
}

export function describeCodexCliError(error, cliPath = resolveCodexCli()) {
  const message = String(error?.message || error || "codex_cli_unavailable");
  if (error?.code === "ENOENT" || /not found|cannot find/i.test(message)) {
    return {
      reason: "codex_cli_not_found",
      cliPath,
      hint: "请安装或打开 Codex 桌面客户端，或在 PowerShell 中设置 $env:CODEX_CLI_PATH 为 codex.exe 的完整路径后重试。",
    };
  }
  return { reason: "codex_cli_error", cliPath, message };
}
