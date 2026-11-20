import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

export class CodexRuntime extends EventEmitter {
  constructor({
    command = "codex",
    cwd,
    codexHome,
    home,
    args = [],
    env = process.env,
  }) {
    super();
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.child = spawn(
      command,
      [...args, "app-server", "--listen", "stdio://"],
      {
        cwd,
        env: { ...env, HOME: home, CODEX_HOME: codexHome },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    this.child.stdin.on("error", (e) => this.finish(e));
    this.child.on("error", (e) => this.finish(e));
    this.child.on("exit", (code, signal) =>
      this.finish(new Error(`Codex exited (${signal || code})`)),
    );
    this.child.stderr.on("data", (data) =>
      this.emit("diagnostic", data.toString().slice(-8000)),
    );
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const pending = this.pending.get(message.id);
      if (pending && !message.method) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else this.emit("message", message);
    });
  }
  send(message) {
    if (this.closed) throw new Error("Codex connection closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method, params = {}, timeout = 30_000) {
    const id = `deck:${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: { name: "codex_deck", title: "Codex Deck", version: "0.1.0" },
    });
    this.send({ method: "initialized" });
    return result;
  }
  finish(error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.emit("closed", error);
  }
  stop() {
    this.finish(new Error("Codex connection stopped"));
    terminate(this.child);
  }
}

const terminated = new WeakSet();
// Kill only the process group owned by this service, including tool subprocesses.
export function terminate(child) {
  if (
    !child?.pid ||
    terminated.has(child) ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return;
  terminated.add(child);
  const kill = (signal) => {
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (e) {
      if (e.code === "EPERM") child.kill(signal);
      else if (e.code !== "ESRCH") throw e;
    }
  };
  kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) kill("SIGKILL");
  }, 5000);
  timer.unref();
  child.once("exit", () => clearTimeout(timer));
}
