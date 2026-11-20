import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  randomBytes,
  randomUUID,
  timingSafeEqual,
  createHmac,
} from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { Store } from "./store.js";
import {
  Resources,
  HttpError,
  workspaceInput,
  workspacePath,
  jobInput,
} from "./resources.js";
import { CodexRuntime } from "./runtime.js";
import { Bridge } from "./bridge.js";
import { Scheduler, validateCron } from "./scheduler.js";
import { Settings, childEnvironment } from "./settings.js";
import { importSkillZip, ZIP_LIMIT } from "./skills-zip.js";

const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
function originOK(req, expected) {
  if (!req.headers.origin) return true; // CLI / health-check clients do not send an Origin.
  try {
    return (
      new URL(req.headers.origin).origin ===
      (expected || `http://${req.headers.host}`)
    );
  } catch {
    return false;
  }
}
async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_048_576) throw new HttpError(413, "请求过大");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    throw new HttpError(400, "JSON 无效");
  }
}
function json(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}
function zipBody(req) {
  if (Number(req.headers["content-length"]) > ZIP_LIMIT) {
    req.resume();
    return Promise.reject(new HttpError(413, "ZIP 文件最多 16 MiB"));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > ZIP_LIMIT) {
        done = true;
        chunks.length = 0;
        reject(new HttpError(413, "ZIP 文件最多 16 MiB"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
    req.on("aborted", () => {
      if (!done) {
        done = true;
        reject(new HttpError(400, "上传已中断"));
      }
    });
  });
}

export async function createApp(options = {}) {
  const dataDir = resolve(
    options.dataDir || process.env.DECK_DATA_DIR || ".data",
  );
  const home = resolve(
    options.home || process.env.DECK_HOME || join(dataDir, "home"),
  );
  const codexHome = resolve(
    options.codexHome || process.env.CODEX_HOME || join(dataDir, "codex"),
  );
  const workspaceRoot = resolve(
    options.workspaceRoot ||
      process.env.DECK_WORKSPACE_ROOT ||
      join(dataDir, "workspaces"),
  );
  const skillsDir = join(home, ".agents", "skills");
  const token =
    options.token || process.env.DECK_TOKEN || randomBytes(24).toString("hex");
  if (token.length < 24) throw new Error("DECK_TOKEN 至少需要 24 个字符");
  const origin = options.origin || process.env.DECK_ORIGIN;
  if (origin && new URL(origin).origin !== origin)
    throw new Error("DECK_ORIGIN 必须为不带路径的完整 origin");
  for (const dir of [dataDir, home, codexHome, workspaceRoot, skillsDir])
    await mkdir(dir, { recursive: true, mode: 0o700 });
  const store = await new Store(join(dataDir, "state.json")).open();
  const resources = new Resources({
    dataDir,
    home,
    codexHome,
    workspaceRoot,
    skillsDir,
  });
  const settings = new Settings(dataDir);
  let general = await settings.read();
  const runtimeOptions = {
    env: childEnvironment(general.settings),
    command: options.codexCommand || process.env.CODEX_BIN || "codex",
    args: options.codexArgs || [],
    codexHome,
    home,
  };
  const bridge = new Bridge({
    getEnv: () => runtimeOptions.env,
    command: options.ccCommand || process.env.CC_CONNECT_BIN || "cc-connect",
    codexCommand: runtimeOptions.command,
    dataDir,
    home,
    codexHome,
    resources,
  });
  const concurrency = general.settings.jobConcurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new Error("DECK_JOB_CONCURRENCY 必须为 1–16");
  const scheduler = new Scheduler({
    store,
    workspaceRoot,
    runtimeOptions,
    concurrency,
  });
  const runtimes = new Set();
  const failedLogins = new Map();
  let stopping = false;
  // Stateless, expiring session cookie; the administrator token never enters browser storage.
  const cookieValue = () => {
    const until = String(Date.now() + 12 * 60 * 60_000);
    return `${until}.${createHmac("sha256", token).update(until).digest("hex")}`;
  };
  const authenticated = (req) => {
    if (equal(req.headers.authorization, `Bearer ${token}`)) return true;
    const value = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("deck_session="))
      ?.slice(13);
    if (!value) return false;
    const [until, signature] = value.split(".");
    return (
      Number(until) > Date.now() &&
      equal(signature, createHmac("sha256", token).update(until).digest("hex"))
    );
  };
  const cookie = (value, maxAge) =>
    `deck_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${origin?.startsWith("https:") ? "; Secure" : ""}`;
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;
      const method = req.method;
      if (path === "/healthz" && method === "GET")
        return json(res, { ok: !stopping });
      if (path.startsWith("/api/")) {
        if (!originOK(req, origin)) throw new HttpError(403, "Origin 不匹配");
        if (path === "/api/session" && method === "POST") {
          const key = req.socket.remoteAddress;
          const entry = failedLogins.get(key);
          if (entry?.until > Date.now() && entry.count >= 10)
            throw new HttpError(429, "尝试次数过多，请 5 分钟后重试");
          const input = z
            .object({ token: z.string().max(1024) })
            .parse(await body(req));
          if (!equal(input.token, token)) {
            if (failedLogins.size > 1000) failedLogins.clear();
            failedLogins.set(key, {
              until: Date.now() + 300_000,
              count: entry?.until > Date.now() ? entry.count + 1 : 1,
            });
            throw new HttpError(401, "访问令牌不正确");
          }
          failedLogins.delete(key);
          res.setHeader("Set-Cookie", cookie(cookieValue(), 43200));
          return json(res, { ok: true });
        }
        if (path === "/api/session" && method === "DELETE") {
          res.setHeader("Set-Cookie", cookie("", 0));
          return json(res, { ok: true });
        }
        if (!authenticated(req)) throw new HttpError(401, "请先登录");
        if (stopping) throw new HttpError(503, "服务正在关闭");
        if (path === "/api/status" && method === "GET")
          return json(res, {
            version: "0.1.0",
            workspaceRoot,
            codexHome,
            skillsDir,
            connections: runtimes.size,
            bridge: { ...bridge.status(), logs: undefined },
            runningJobs: scheduler.active.size,
          });
        if (path === "/api/config/general" && method === "GET")
          return json(res, await settings.read());
        if (path === "/api/config/general" && method === "PUT") {
          general = await settings.save(await body(req));
          runtimeOptions.env = childEnvironment(general.settings);
          scheduler.concurrency = general.settings.jobConcurrency;
          return json(res, general);
        }
        if (path === "/api/workspaces" && method === "GET")
          return json(res, store.read().workspaces);
        if (path === "/api/workspaces" && method === "POST") {
          const input = workspaceInput.parse(await body(req));
          const canonical = await workspacePath(
            workspaceRoot,
            input.path,
            input.create,
          );
          const workspace = {
            id: randomUUID(),
            name: input.name,
            path: canonical,
            createdAt: new Date().toISOString(),
          };
          await store.mutate((data) => {
            if (data.workspaces.some((w) => w.path === canonical))
              throw new HttpError(409, "该目录已登记");
            data.workspaces.push(workspace);
          });
          return json(res, workspace, 201);
        }
        const workspaceMatch = path.match(/^\/api\/workspaces\/([\w-]+)$/);
        if (workspaceMatch && method === "DELETE") {
          await store.mutate((data) => {
            if (!data.workspaces.some((w) => w.id === workspaceMatch[1]))
              throw new HttpError(404, "工作区不存在");
            if (data.jobs.some((j) => j.workspaceId === workspaceMatch[1]))
              throw new HttpError(409, "请先删除关联定时任务");
            data.workspaces = data.workspaces.filter(
              (w) => w.id !== workspaceMatch[1],
            );
          });
          return json(res, { ok: true });
        }
        if (path === "/api/skills" && method === "GET")
          return json(res, await resources.skills());
        if (path === "/api/skills/import" && method === "POST") {
          const imported = await importSkillZip(resources, await zipBody(req), {
            name: url.searchParams.get("name") || undefined,
            replace: url.searchParams.get("replace") === "true",
          });
          return json(res, imported, 201);
        }
        const skillMatch = path.match(/^\/api\/skills\/([^/]+)$/);
        if (skillMatch && method === "PUT")
          return json(
            res,
            await resources.saveSkill(
              decodeURIComponent(skillMatch[1]),
              await body(req),
            ),
          );
        if (skillMatch && method === "DELETE") {
          await resources.deleteSkill(decodeURIComponent(skillMatch[1]));
          return json(res, { ok: true });
        }
        if (path === "/api/mcp" && method === "GET")
          return json(res, await resources.listMcp());
        if (path === "/api/mcp" && method === "PUT")
          return json(res, await resources.saveMcp(await body(req)));
        const configMatch = path.match(/^\/api\/config\/(codex|cc-connect)$/);
        if (configMatch && method === "GET")
          return json(res, await resources.readConfig(configMatch[1]));
        if (configMatch && method === "PUT")
          return json(
            res,
            await resources.saveConfig(configMatch[1], await body(req)),
          );
        if (path === "/api/bridge" && method === "GET")
          return json(res, {
            ...bridge.status(),
            enabled: store.read().bridgeEnabled,
          });
        if (path === "/api/bridge/start" && method === "POST") {
          const status = await bridge.start();
          await store.mutate((d) => {
            d.bridgeEnabled = true;
          });
          return json(res, status);
        }
        if (path === "/api/bridge/stop" && method === "POST") {
          await store.mutate((d) => {
            d.bridgeEnabled = false;
          });
          return json(res, bridge.stop());
        }
        if (path === "/api/jobs" && method === "GET")
          return json(res, scheduler.jobs());
        if (path === "/api/runs" && method === "GET")
          return json(res, store.read().runs);
        const jobMatch = path.match(
          /^\/api\/jobs\/([\w-]+)(\/(?:run|cancel))?$/,
        );
        if (jobMatch?.[2] === "/run" && method === "POST")
          return json(res, await scheduler.run(jobMatch[1]), 202);
        if (jobMatch?.[2] === "/cancel" && method === "POST") {
          await scheduler.cancel(jobMatch[1]);
          return json(res, { ok: true });
        }
        if (
          (path === "/api/jobs" && method === "POST") ||
          (jobMatch && !jobMatch[2] && method === "PUT")
        ) {
          const payload = await body(req);
          const input = jobInput.parse({
            ...payload,
            timezone: payload.timezone ?? general.settings.defaultTimezone,
          });
          validateCron(input);
          const id = jobMatch?.[1] || randomUUID();
          if (scheduler.active.has(id))
            throw new HttpError(409, "执行中的任务暂不能修改");
          const job = { ...input, id };
          await store.mutate((data) => {
            if (!data.workspaces.some((w) => w.id === job.workspaceId))
              throw new HttpError(400, "工作区不存在");
            const index = data.jobs.findIndex((j) => j.id === id);
            if (method === "PUT" && index < 0)
              throw new HttpError(404, "任务不存在");
            if (index >= 0) data.jobs[index] = job;
            else data.jobs.push(job);
          });
          scheduler.reload();
          return json(res, job, method === "POST" ? 201 : 200);
        }
        if (jobMatch && !jobMatch[2] && method === "DELETE") {
          if (scheduler.active.has(jobMatch[1]))
            throw new HttpError(409, "执行中的任务暂不能删除");
          await store.mutate((d) => {
            d.jobs = d.jobs.filter((j) => j.id !== jobMatch[1]);
          });
          scheduler.reload();
          return json(res, { ok: true });
        }
        throw new HttpError(404, "API 不存在");
      }
      if (!["GET", "HEAD"].includes(method))
        throw new HttpError(405, "Method not allowed");
      const files = {
        "/": "index.html",
        "/app.js": "app.js",
        "/style.css": "style.css",
        "/logo.svg": "logo.svg",
        "/im-config.js": "im-config.js",
      };
      if (!files[path]) throw new HttpError(404, "Not found");
      const content = await readFile(join(publicRoot, files[path]));
      const types = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
      };
      res.writeHead(200, {
        "Content-Type": `${types[extname(files[path])]}; charset=utf-8`,
        "Cache-Control": "no-cache",
      });
      res.end(method === "HEAD" ? undefined : content);
    } catch (e) {
      const status =
        e instanceof z.ZodError
          ? 400
          : e.status || (e.code === "ENOENT" ? 404 : 500);
      if (status === 500) console.error(e);
      if (!res.headersSent)
        json(
          res,
          {
            error:
              e instanceof z.ZodError
                ? e.issues
                    .map((i) => `${i.path.join(".")}: ${i.message}`)
                    .join("; ")
                : status === 500
                  ? "服务内部错误，请查看服务日志"
                  : e.message,
          },
          status,
        );
      else res.end();
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });
  server.on("upgrade", async (req, socket, head) => {
    try {
      if (!originOK(req, origin) || !authenticated(req) || stopping)
        throw new HttpError(401, "Unauthorized");
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/rpc") throw new HttpError(404, "Not found");
      if (runtimes.size >= 16) throw new HttpError(429, "Too many connections");
      const workspace = store
        .read()
        .workspaces.find((w) => w.id === url.searchParams.get("workspace"));
      if (!workspace) throw new HttpError(404, "Workspace not found");
      const cwd = await workspacePath(workspaceRoot, workspace.path);
      if (socket.destroyed || stopping) return socket.destroy();
      wss.handleUpgrade(req, socket, head, async (ws) => {
        const runtime = new CodexRuntime({ ...runtimeOptions, cwd });
        runtimes.add(runtime);
        const send = (message) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (ws.bufferedAmount > 4_194_304) {
            ws.close(1013, "Client too slow");
            return;
          }
          ws.send(JSON.stringify(message));
        };
        let ready = false;
        runtime.on("message", send);
        runtime.on("closed", (error) => {
          runtimes.delete(runtime);
          send({ method: "deck/error", params: { message: error.message } });
          ws.close(1011, "Codex connection closed");
        });
        ws.on("error", () => runtime.stop());
        ws.on("close", () => {
          runtimes.delete(runtime);
          runtime.stop();
        });
        ws.on("message", (raw) => {
          let message;
          try {
            if (!ready) throw new Error("Codex 尚未就绪");
            message = JSON.parse(raw.toString());
            if (
              !message ||
              typeof message !== "object" ||
              Array.isArray(message)
            )
              throw new Error("JSON-RPC 消息无效");
            if (
              typeof message.id === "string" &&
              message.id.startsWith("deck:")
            )
              throw new Error("ID 使用了保留前缀");
            if (["initialize", "initialized"].includes(message.method))
              throw new Error("握手由 Deck 处理");
            runtime.send(message);
          } catch (e) {
            send({
              id: message?.id ?? null,
              error: { code: -32600, message: e.message },
            });
          }
        });
        try {
          const info = await runtime.initialize();
          ready = true;
          send({ method: "deck/ready", params: { ...info, cwd } });
        } catch (e) {
          send({ method: "deck/error", params: { message: e.message } });
          ws.close(1011, "Initialization failed");
          runtime.stop();
        }
      });
    } catch (e) {
      if (!socket.destroyed)
        socket.end(
          `HTTP/1.1 ${e.status || 500} Rejected\r\nConnection: close\r\n\r\n`,
        );
    }
  });
  await scheduler.init();
  if (store.read().bridgeEnabled)
    await bridge.start().catch((e) => {
      bridge.lastError = e.message;
    });
  return {
    server,
    store,
    resources,
    scheduler,
    bridge,
    token,
    runtimeOptions,
    async close() {
      stopping = true;
      bridge.stop();
      for (const client of wss.clients)
        client.close(1001, "Server shutting down");
      for (const runtime of runtimes) runtime.stop();
      await scheduler.stop();
      await store.queue;
      await settings.queue;
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeIdleConnections();
      });
      wss.close();
    },
  };
}
