import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import { CodexRuntime } from "./runtime.js";
import { workspacePath, HttpError } from "./resources.js";

export function validateCron(input) {
  // Keep the public contract at five fields; allow explicit IANA timezone names.
  if (input.cron.trim().split(/\s+/).length !== 5)
    throw new HttpError(400, "Cron 使用 5 个字段：分 时 日 月 周");
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timezone });
    const job = new Cron(input.cron, {
      timezone: input.timezone,
      paused: true,
    });
    const next = job.nextRun();
    job.stop();
    if (!next) throw new Error("没有下一次执行时间");
    return next.toISOString();
  } catch (e) {
    throw new HttpError(400, `定时规则无效: ${e.message}`);
  }
}

export class Scheduler {
  constructor(options) {
    Object.assign(this, options);
    this.timers = new Map();
    this.active = new Map();
    this.stopping = false;
  }
  async init() {
    await this.store.mutate((data) => {
      for (const run of data.runs)
        if (run.status === "running") {
          run.status = "interrupted";
          run.error = "服务重启中断了执行";
          run.finishedAt = new Date().toISOString();
        }
    });
    this.reload();
  }
  reload() {
    for (const timer of this.timers.values()) timer.stop();
    this.timers.clear();
    for (const job of this.store.read().jobs)
      if (job.enabled) {
        const timer = new Cron(job.cron, { timezone: job.timezone }, () => {
          this.run(job.id).catch((e) =>
            console.error(`Scheduled job ${job.id}: ${e.message}`),
          );
        });
        this.timers.set(job.id, timer);
      }
  }
  jobs() {
    return this.store.read().jobs.map((job) => ({
      ...job,
      running: this.active.has(job.id),
      nextRun: this.timers.get(job.id)?.nextRun()?.toISOString() || null,
    }));
  }
  async run(id) {
    if (this.stopping) throw new HttpError(503, "服务正在关闭");
    if (this.active.has(id))
      throw new HttpError(409, "该任务已在执行，跳过重叠执行");
    if (this.active.size >= this.concurrency)
      throw new HttpError(429, "定时任务并发已达上限");
    const data = this.store.read();
    const job = data.jobs.find((j) => j.id === id);
    if (!job) throw new HttpError(404, "任务不存在");
    const workspace = data.workspaces.find((w) => w.id === job.workspaceId);
    if (!workspace) throw new HttpError(400, "工作区不存在");
    const run = {
      id: randomUUID(),
      jobId: id,
      name: job.name,
      workspaceId: workspace.id,
      status: "running",
      startedAt: new Date().toISOString(),
      output: "",
    };
    const control = { runtime: null, cancel: null, cancelled: false };
    this.active.set(id, control);
    try {
      await this.store.mutate((state) => {
        state.runs.unshift(run);
        state.runs = state.runs.slice(0, 200);
      });
    } catch (e) {
      this.active.delete(id);
      throw e;
    }
    // Return immediately to HTTP callers. All background failures are recorded below.
    control.promise = this.execute(job, workspace, run, control).finally(() =>
      this.active.delete(id),
    );
    return run;
  }
  async cancel(id) {
    const control = this.active.get(id);
    if (!control) throw new HttpError(409, "任务当前没有执行");
    control.cancelled = true;
    control.cancel?.();
    control.runtime?.stop();
    await control.promise;
  }
  async execute(job, workspace, run, control) {
    let timer;
    try {
      const cwd = await workspacePath(this.workspaceRoot, workspace.path);
      if (this.stopping) throw new Error("服务正在关闭");
      if (control.cancelled) throw new Error("执行已取消");
      const env = { ...(this.runtimeOptions.env || process.env), ...job.env };
      for (const key of [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
      ]) {
        const lower = key.toLowerCase();
        if (
          Object.hasOwn(job.env || {}, key) &&
          !Object.hasOwn(job.env || {}, lower)
        )
          env[lower] = job.env[key];
        if (
          Object.hasOwn(job.env || {}, lower) &&
          !Object.hasOwn(job.env || {}, key)
        )
          env[key] = job.env[lower];
      }
      const runtime = new CodexRuntime({ ...this.runtimeOptions, env, cwd });
      control.runtime = runtime;
      const finished = new Promise((resolve, reject) => {
        control.cancel = () => reject(new Error("执行已取消"));
        runtime.on("closed", reject);
        runtime.on("message", (message) => {
          const p = message.params || {};
          if (message.method === "item/agentMessage/delta")
            run.output = (run.output + (p.delta || "")).slice(-100_000);
          if (message.method === "thread/started") run.threadId = p.thread?.id;
          if (message.method === "turn/completed") {
            if (p.turn?.status === "completed") resolve();
            else
              reject(
                new Error(
                  p.turn?.error?.message ||
                    `Turn ${p.turn?.status || "failed"}`,
                ),
              );
          }
          // Unattended runs never approve a server request or wait indefinitely for input.
          if (message.method && message.id !== undefined) {
            runtime.send({
              id: message.id,
              error: {
                code: -32000,
                message: "Unattended job cannot answer interactive requests",
              },
            });
            reject(new Error(`任务需要交互: ${message.method}`));
          }
        });
        timer = setTimeout(
          () => reject(new Error(`执行超过 ${job.timeoutMinutes} 分钟`)),
          job.timeoutMinutes * 60_000,
        );
      });
      // Attach a handler before the initialization awaits can reject.
      finished.catch(() => {});
      const execution = (async () => {
        await runtime.initialize();
        const { thread } = await runtime.request("thread/start", {
          cwd,
          sandbox: job.sandbox,
          approvalPolicy: "never",
        });
        run.threadId = thread.id;
        await runtime.request("turn/start", {
          threadId: thread.id,
          input: [{ type: "text", text: job.prompt }],
        });
        await finished;
      })();
      // Cancellation and timeout also interrupt initialization / an unresponsive RPC.
      await Promise.race([execution, finished]);
      run.status = "completed";
    } catch (e) {
      run.status = this.stopping
        ? "interrupted"
        : control.cancelled
          ? "cancelled"
          : "failed";
      run.error = e.message;
    } finally {
      clearTimeout(timer);
      control.runtime?.stop();
      run.finishedAt = new Date().toISOString();
      await this.store
        .mutate((data) => {
          const record = data.runs.find((r) => r.id === run.id);
          if (record) Object.assign(record, run);
        })
        .catch((e) => console.error("Failed to persist job run:", e.message));
    }
  }
  async stop() {
    this.stopping = true;
    for (const t of this.timers.values()) t.stop();
    for (const c of this.active.values()) {
      c.cancel?.();
      c.runtime?.stop();
    }
    await Promise.allSettled([...this.active.values()].map((c) => c.promise));
  }
}
