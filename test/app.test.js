import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createApp } from "../server/app.js";
import { CodexRuntime } from "../server/runtime.js";
const fixture = fileURLToPath(
  new URL("./fixtures/fake-codex.mjs", import.meta.url),
);
const token = "test-access-token-12345678901234567890";
async function setup(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "deck-app-"));
  const app = await createApp({
    dataDir: dir,
    token,
    codexCommand: process.execPath,
    codexArgs: [fixture],
    ...extra,
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const request = async (path, method = "GET", value, headers = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
    return { status: res.status, data: await res.json(), headers: res.headers };
  };
  return { app, base, request };
}
async function poll(fn) {
  for (let i = 0; i < 400; i++) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("Condition timed out");
}
function nextMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", handler);
      reject(new Error("WebSocket timed out"));
    }, 4000);
    function handler(raw) {
      const m = JSON.parse(raw);
      if (predicate(m)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(m);
      }
    }
    ws.on("message", handler);
  });
}
test("authentication requires token, rejects foreign Origin, uses expiring HttpOnly cookie", async (t) => {
  const { base, request } = await setup(t);
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal(
    (
      await request("/api/status", "GET", undefined, {
        Origin: "https://evil.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (await request("/api/session", "POST", { token: "incorrect" })).status,
    401,
  );
  const login = await request("/api/session", "POST", { token });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(
    (await fetch(`${base}/api/status`, { headers: { Cookie: cookie } })).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${base}/api/status`, {
        headers: { Cookie: "deck_session=9999999999999.fake" },
      })
    ).status,
    401,
  );
});
test("workspace/job CRUD validates references; removal keeps project files", async (t) => {
  const { request } = await setup(t);
  const w = await request("/api/workspaces", "POST", {
    name: "Project",
    path: "project",
    create: true,
  });
  assert.equal(w.status, 201);
  assert.equal(
    (
      await request("/api/workspaces", "POST", {
        name: "Duplicate",
        path: "project",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("/api/workspaces", "POST", {
        name: "Escape",
        path: "../escape",
        create: true,
      })
    ).status,
    400,
  );
  const job = await request("/api/jobs", "POST", {
    name: "Daily",
    workspaceId: w.data.id,
    prompt: "check project",
    cron: "0 9 * * *",
    enabled: false,
  });
  assert.equal(job.status, 201);
  assert.equal(
    (await request(`/api/workspaces/${w.data.id}`, "DELETE")).status,
    409,
  );
  assert.equal(
    (await request(`/api/jobs/${job.data.id}`, "DELETE")).status,
    200,
  );
  assert.equal(
    (await request(`/api/workspaces/${w.data.id}`, "DELETE")).status,
    200,
  );
  const { stat } = await import("node:fs/promises");
  assert.ok((await stat(w.data.path)).isDirectory());
});
test("WebSocket passes native methods, streaming events and approval responses intact", async (t) => {
  const { base, request } = await setup(t);
  const { data: w } = await request("/api/workspaces", "POST", {
    name: "Project",
    path: "project",
    create: true,
  });
  const ws = new WebSocket(
    `${base.replace("http:", "ws:")}/rpc?workspace=${w.id}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  t.after(() => ws.terminate());
  await nextMessage(ws, (m) => m.method === "deck/ready");
  const echo = nextMessage(ws, (m) => m.id === 1);
  ws.send(
    JSON.stringify({
      id: 1,
      method: "fixture/echo",
      params: { unchanged: ["web_search", "MCP"] },
    }),
  );
  assert.deepEqual((await echo).result, { unchanged: ["web_search", "MCP"] });
  const error = nextMessage(ws, (m) => m.id === 2);
  ws.send(JSON.stringify({ id: 2, method: "fixture/error" }));
  assert.equal((await error).error.message, "native error");
  const approval = nextMessage(
    ws,
    (m) => m.method === "item/commandExecution/requestApproval",
  );
  ws.send(
    JSON.stringify({
      id: 3,
      method: "turn/start",
      params: { input: [{ type: "text", text: "approval" }] },
    }),
  );
  const message = await approval;
  assert.equal(message.id, 888);
  assert.equal(message.params.command, "git status");
  const delta = nextMessage(ws, (m) => m.method === "item/agentMessage/delta");
  ws.send(JSON.stringify({ id: 888, result: { decision: "accept" } }));
  assert.equal((await delta).params.delta, "mock native output");
  ws.close();
});
test("WebSocket denies unauthenticated upgrades and foreign origins", async (t) => {
  const { base, request } = await setup(t);
  const { data: w } = await request("/api/workspaces", "POST", {
    name: "Project",
    path: "project",
    create: true,
  });
  for (const headers of [
    {},
    { Authorization: `Bearer ${token}`, Origin: "https://evil.example" },
  ]) {
    const ws = new WebSocket(
      `${base.replace("http:", "ws:")}/rpc?workspace=${w.id}`,
      { headers },
    );
    const error = await once(ws, "error");
    assert.match(error[0].message, /401/);
  }
});
test("scheduler executes native turns, persists output, rejects interactive approvals and overlapping jobs", async (t) => {
  const { app, request } = await setup(t);
  const { data: w } = await request("/api/workspaces", "POST", {
    name: "Project",
    path: "project",
    create: true,
  });
  const createJob = async (prompt) =>
    (
      await request("/api/jobs", "POST", {
        name: prompt,
        workspaceId: w.id,
        prompt,
        cron: "0 9 * * *",
        enabled: false,
      })
    ).data;
  const success = await createJob("success");
  assert.equal(
    (await request(`/api/jobs/${success.id}/run`, "POST")).status,
    202,
  );
  const completed = await poll(() =>
    app.store
      .read()
      .runs.find((r) => r.jobId === success.id && r.status === "completed"),
  );
  assert.equal(completed.output, "mock native output");
  assert.ok(completed.threadId);
  const interactive = await createJob("approval");
  await app.scheduler.run(interactive.id);
  const failed = await poll(() =>
    app.store
      .read()
      .runs.find((r) => r.jobId === interactive.id && r.status === "failed"),
  );
  assert.match(failed.error, /需要交互/);
  const hanging = await createJob("hang");
  await app.scheduler.run(hanging.id);
  assert.equal(
    (await request(`/api/jobs/${hanging.id}/run`, "POST")).status,
    409,
  );
  await poll(() => app.scheduler.active.get(hanging.id)?.runtime);
  assert.equal(
    (await request(`/api/jobs/${hanging.id}/cancel`, "POST")).status,
    200,
  );
  assert.equal(
    app.store.read().runs.find((r) => r.jobId === hanging.id).status,
    "cancelled",
  );
  assert.equal(app.scheduler.stopping, false);
  await app.scheduler.run(hanging.id);
  await poll(() => app.scheduler.active.get(hanging.id)?.runtime);
  await app.scheduler.stop();
  assert.equal(
    app.store.read().runs.find((r) => r.jobId === hanging.id).status,
    "interrupted",
  );
});
test("runtime rejects pending requests immediately when child exits", async () => {
  const runtime = new CodexRuntime({
    command: process.execPath,
    args: [fixture],
    cwd: tmpdir(),
    home: tmpdir(),
    codexHome: tmpdir(),
  });
  await runtime.initialize();
  await assert.rejects(runtime.request("fixture/exit"), /exited/);
  runtime.stop();
});

test("bridge starts once, masks split/quoted credentials, persists enable state and stops its child", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "deck-bridge-fixture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const command = join(dir, "fake-cc-connect");
  await writeFile(
    command,
    `#!/usr/bin/env node
process.stdout.write('Authorization=Be');
setTimeout(() => {
  process.stdout.write('arer synthetic-token\\n');
  console.log('api_key="synthetic multiword secret"');
  console.log('{"token":"synthetic-json"}');
  console.log('proxy probe ' + process.env.http_proxy);
  console.log('bridge ready');
}, 5);
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`,
    { mode: 0o755 },
  );
  const { app, request } = await setup(t, { ccCommand: command });
  const { data: workspace } = await request("/api/workspaces", "POST", {
    name: "Bridge",
    path: "bridge",
    create: true,
  });
  const { data: file } = await request("/api/config/cc-connect");
  assert.equal(
    (
      await request("/api/config/cc-connect", "PUT", {
        revision: file.revision,
        content: `[[projects]]\nname="bridge-test"\n[projects.agent]\ntype="codex"\n[projects.agent.options]\nwork_dir=${JSON.stringify(workspace.path)}\nbackend="app_server"\n`,
      })
    ).status,
    200,
  );
  const general = (await request("/api/config/general")).data;
  await request("/api/config/general", "PUT", {
    revision: general.revision,
    settings: {
      ...general.settings,
      proxyMode: "custom",
      httpProxy: "http://127.0.0.1:7890",
    },
  });
  const started = await request("/api/bridge/start", "POST");
  assert.equal(started.status, 200);
  assert.equal(started.data.running, true);
  assert.equal(
    (await request("/api/bridge/start", "POST")).data.pid,
    started.data.pid,
  );
  await poll(() =>
    app.bridge.logs.some((l) => l.message.includes("bridge ready")),
  );
  const log = app.bridge.logs.map((l) => l.message).join("\n");
  assert.doesNotMatch(log, /synthetic/);
  assert.match(log, /redacted/);
  assert.match(log, /proxy probe http:\/\/127\.0\.0\.1:7890/);
  assert.equal(app.store.read().bridgeEnabled, true);
  const exited = once(app.bridge.child, "exit");
  assert.equal((await request("/api/bridge/stop", "POST")).data.running, false);
  await exited;
  assert.equal(app.store.read().bridgeEnabled, false);
});

test("general settings persist, validate revisions, and reach new Codex processes", async (t) => {
  const { app, base, request } = await setup(t);
  const initial = await request("/api/config/general");
  const settings = {
    ...initial.data.settings,
    proxyMode: "custom",
    httpProxy: "http://127.0.0.1:7890",
    httpsProxy: "http://127.0.0.1:7890",
    allProxy: "socks5://127.0.0.1:1080",
    noProxy: "localhost,127.0.0.1",
    jobConcurrency: 1,
    defaultTimezone: "UTC",
  };
  const saved = await request("/api/config/general", "PUT", {
    settings,
    revision: initial.data.revision,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(
    (await request("/api/config/general")).data.settings,
    settings,
  );
  assert.equal(
    (
      await request("/api/config/general", "PUT", {
        settings,
        revision: initial.data.revision,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("/api/config/general", "PUT", {
        settings: { ...settings, httpProxy: "file:///etc/passwd" },
        revision: saved.data.revision,
      })
    ).status,
    400,
  );
  const { data: w } = await request("/api/workspaces", "POST", {
    name: "Proxy",
    path: "proxy",
    create: true,
  });
  const inspectEnv = async () => {
    const ws = new WebSocket(
      `${base.replace("http:", "ws:")}/rpc?workspace=${w.id}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    t.after(() => ws.terminate());
    await nextMessage(ws, (m) => m.method === "deck/ready");
    const response = nextMessage(ws, (m) => m.id === 1);
    ws.send(JSON.stringify({ id: 1, method: "fixture/environment" }));
    const env = (await response).result;
    ws.close();
    return env;
  };
  const env = await inspectEnv();
  assert.equal(env.HTTP_PROXY, settings.httpProxy);
  assert.equal(env.http_proxy, settings.httpProxy);
  assert.equal(env.HTTPS_PROXY, settings.httpsProxy);
  assert.equal(env.ALL_PROXY, settings.allProxy);
  assert.equal(env.no_proxy, settings.noProxy);
  const jobBody = {
    name: "Scheduled",
    workspaceId: w.id,
    prompt: "hang",
    cron: "0 9 * * *",
    enabled: false,
  };
  const job = await request("/api/jobs", "POST", jobBody);
  assert.equal(job.data.timezone, "UTC");
  await app.scheduler.run(job.data.id);
  const second = await request("/api/jobs", "POST", {
    ...jobBody,
    name: "Second",
  });
  assert.equal(
    (await request(`/api/jobs/${second.data.id}/run`, "POST")).status,
    429,
  );
  await app.scheduler.cancel(job.data.id);
  assert.equal(
    (
      await request("/api/config/general", "PUT", {
        settings: { ...settings, proxyMode: "disabled" },
        revision: saved.data.revision,
      })
    ).status,
    200,
  );
  assert.deepEqual(await inspectEnv(), {});
  const { Settings } = await import("../server/settings.js");
  assert.equal(
    (await new Settings(app.resources.dataDir).read()).settings.proxyMode,
    "disabled",
  );
});

test("task environment variables survive create/edit, override inherited values and do not leak into other jobs", async (t) => {
  const { app, request } = await setup(t);
  const general = (await request("/api/config/general")).data;
  await request("/api/config/general", "PUT", {
    revision: general.revision,
    settings: {
      ...general.settings,
      proxyMode: "custom",
      httpProxy: "http://127.0.0.1:7800",
    },
  });
  const workspace = (
    await request("/api/workspaces", "POST", {
      name: "Environment",
      path: "environment",
      create: true,
    })
  ).data;
  const input = {
    name: "Env task",
    workspaceId: workspace.id,
    cron: "0 9 * * *",
    prompt: "environment",
    enabled: false,
    env: { BUILD_MODE: "original" },
  };
  const created = await request("/api/jobs", "POST", input);
  assert.equal(created.status, 201);
  assert.deepEqual(created.data.env, input.env);
  const variables = {
    BUILD_MODE: "edited",
    TASK_VALUE: "literal=$(printf nope)\nsecond line",
    HTTP_PROXY: "http://127.0.0.1:7900",
  };
  assert.equal(
    (
      await request(`/api/jobs/${created.data.id}`, "PUT", {
        ...input,
        env: variables,
      })
    ).status,
    200,
  );
  await app.scheduler.run(created.data.id);
  const completed = await poll(() =>
    app.store
      .read()
      .runs.find(
        (r) => r.jobId === created.data.id && r.status === "completed",
      ),
  );
  const env = JSON.parse(completed.output);
  assert.equal(env.BUILD_MODE, "edited");
  assert.equal(env.TASK_VALUE, variables.TASK_VALUE);
  assert.equal(env.HTTP_PROXY, variables.HTTP_PROXY);
  assert.equal(env.http_proxy, variables.HTTP_PROXY);
  const second = (
    await request("/api/jobs", "POST", { ...input, name: "Inherited", env: {} })
  ).data;
  await app.scheduler.run(second.id);
  const inherited = JSON.parse(
    (
      await poll(() =>
        app.store
          .read()
          .runs.find((r) => r.jobId === second.id && r.status === "completed"),
      )
    ).output,
  );
  assert.equal(inherited.BUILD_MODE, undefined);
  assert.equal(inherited.HTTP_PROXY, "http://127.0.0.1:7800");
  assert.equal(
    (
      await request("/api/jobs", "POST", {
        ...input,
        env: { "INVALID-NAME": "x" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/api/jobs", "POST", {
        ...input,
        env: { HOME: "/tmp/other" },
      })
    ).status,
    400,
  );
  assert.deepEqual(
    app.store.read().jobs.find((j) => j.id === created.data.id).env,
    variables,
  );
});

test("authenticated ZIP upload endpoint installs package assets and reports duplicate conflicts", async (t) => {
  const { base, app } = await setup(t);
  const { makeZip } = await import("./fixtures/zip.mjs");
  const { readFile } = await import("node:fs/promises");
  const zip = makeZip([
    {
      path: "SKILL.md",
      data: "---\nname: uploaded\ndescription: Uploaded skill\n---\nUse reference/guide.md.",
    },
    { path: "reference/guide.md", data: "Guide content", compress: true },
  ]);
  const upload = async () =>
    fetch(`${base}/api/skills/import`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/zip",
      },
      body: zip,
    });
  const response = await upload();
  assert.equal(response.status, 201);
  assert.equal((await response.json()).files, 2);
  assert.equal(
    await readFile(
      join(app.resources.skillsDir, "uploaded", "reference", "guide.md"),
      "utf8",
    ),
    "Guide content",
  );
  assert.equal((await upload()).status, 409);
});
