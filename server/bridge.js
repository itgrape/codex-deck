import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { terminate } from "./runtime.js";

export class Bridge {
  constructor(options) {
    Object.assign(this, options);
    this.logs = [];
    this.child = null;
    this.lastError = null;
  }
  status() {
    return {
      running: Boolean(this.child),
      pid: this.child?.pid,
      lastError: this.lastError,
      logs: this.logs,
    };
  }
  async start() {
    if (this.child) return this.status();
    const file = await this.resources.readConfig("cc-connect");
    const { parse } = await import("smol-toml");
    await this.resources.validateBridge(parse(file.content));
    const child = spawn(this.command, ["--config", file.path], {
      cwd: this.dataDir,
      env: {
        ...(this.getEnv?.() || process.env),
        HOME: this.home,
        CODEX_HOME: this.codexHome,
        CODEX_CLI_PATH: this.codexCommand,
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.lastError = null;
    // Assemble lines before best-effort masking, so split pipe chunks cannot expose a token.
    const log = (data) => {
      const message = data
        .toString()
        .replace(/\bBearer\s+[^\s"',}]+/gi, "Bearer [redacted]")
        .replace(
          /((?:token|secret|api[_-]?key|authorization)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi,
          "$1[redacted]",
        );
      this.logs.push({
        time: new Date().toISOString(),
        message: message.slice(-4000),
      });
      this.logs = this.logs.slice(-100);
    };
    createInterface({ input: child.stdout }).on("line", log);
    createInterface({ input: child.stderr }).on("line", log);
    child.on("error", (e) => {
      this.lastError = e.message;
      if (this.child === child) this.child = null;
    });
    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.child = null;
        this.lastError = `cc-connect exited (${signal || code})`;
      }
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return this.status();
  }
  stop() {
    const child = this.child;
    this.child = null;
    terminate(child);
    return this.status();
  }
}
