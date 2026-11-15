// 子进程封装：spawn(不走 shell) + 超时保护 + utf8 输出收集。
import { spawn } from "node:child_process";
import { BIN } from "./tools.mjs";

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 运行 specseal CLI。argv 由 tools.mjs 的 buildArgs 构造（参数已校验）。
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function runSpecseal(args, { cwd = process.cwd(), stdin, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`specseal ${args.join(" ")} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`failed to launch ${BIN}: ${err.message} (is it on PATH?)`));
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      }
    });

    if (typeof stdin === "string") {
      child.stdin.end(stdin, "utf8");
    } else {
      child.stdin.end();
    }
  });
}
