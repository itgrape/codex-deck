import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { Resources, workspacePath, jobInput } from "../server/resources.js";
import { validateCron } from "../server/scheduler.js";
import { parse } from "smol-toml";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "deck-core-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("store serializes concurrent writes, rolls back failures, survives reopen", async (t) => {
  const root = await setup(t);
  const path = join(root, "state.json");
  const store = await new Store(path).open();
  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      store.mutate(async (s) => {
        await new Promise((r) => setTimeout(r, i % 3));
        s.workspaces.push({ id: i });
      }),
    ),
  );
  await assert.rejects(
    store.mutate((s) => {
      s.jobs.push("bad");
      throw new Error("rollback");
    }),
  );
  await store.mutate((s) => {
    s.jobs.push("good");
  });
  const reopened = await new Store(path).open();
  assert.equal(reopened.read().workspaces.length, 25);
  assert.deepEqual(reopened.read().jobs, ["good"]);
  const snapshot = store.read();
  snapshot.jobs.push("not persisted");
  assert.deepEqual(store.read().jobs, ["good"]);
});
test("workspace prevents traversal and symlink escapes before creating directories", async (t) => {
  const root = await setup(t);
  const base = join(root, "workspaces");
  const outside = join(root, "outside");
  await mkdir(base);
  await mkdir(outside);
  await symlink(outside, join(base, "link"));
  assert.equal(
    await workspacePath(base, "project", true),
    await realpath(join(base, "project")),
  );
  await assert.rejects(
    workspacePath(base, "../outside", true),
    /DECK_WORKSPACE_ROOT/,
  );
  await assert.rejects(
    workspacePath(base, "link/never-create", true),
    /符号链接/,
  );
  await assert.rejects(readFile(join(outside, "never-create")), {
    code: "ENOENT",
  });
});
test("config revisions prevent lost updates, MCP retains unrelated keys, invalid TOML never writes", async (t) => {
  const root = await setup(t);
  const resources = new Resources({
    dataDir: root,
    codexHome: join(root, "codex"),
    skillsDir: join(root, "skills"),
    workspaceRoot: root,
  });
  const initial = await resources.readConfig("codex");
  const saved = await resources.saveConfig("codex", {
    content:
      '# preserved in backup\nmodel = "custom-model"\nweb_search = "live"\n',
    revision: initial.revision,
  });
  await assert.rejects(
    resources.saveConfig("codex", {
      content: 'model="wrong"',
      revision: initial.revision,
    }),
    /修改/,
  );
  await assert.rejects(
    resources.saveConfig("codex", {
      content: "broken [",
      revision: saved.revision,
    }),
    /TOML/,
  );
  const mcp = await resources.listMcp();
  await resources.saveMcp({
    revision: mcp.revision,
    servers: {
      local: { command: "echo", args: ["hello"] },
      remote: { url: "https://example.com/mcp", enabled: false },
    },
  });
  const current = await resources.readConfig("codex");
  const parsed = parse(current.content);
  assert.equal(parsed.model, "custom-model");
  assert.equal(parsed.web_search, "live");
  assert.equal(parsed.mcp_servers.local.command, "echo");
  assert.match(
    await readFile(`${current.path}.bak`, "utf8"),
    /preserved in backup/,
  );
});
test("managed skills use revisions and refuse symlink writes", async (t) => {
  const root = await setup(t);
  const skillsDir = join(root, "skills");
  const r = new Resources({ skillsDir });
  const content =
    "---\nname: review\ndescription: Review code\n---\nRead the diff.";
  const skill = await r.saveSkill("review", { content, revision: null });
  assert.equal((await r.skills())[0].content, content);
  await assert.rejects(
    r.saveSkill("review", { content, revision: null }),
    /变化/,
  );
  await assert.rejects(r.saveSkill("../escape", { content, revision: null }));
  const target = join(root, "external");
  await mkdir(target);
  await symlink(target, join(skillsDir, "linked"));
  await assert.rejects(
    r.saveSkill("linked", { content, revision: null }),
    /符号链接/,
  );
  await r.saveSkill("review", {
    content: content + "\nUpdated.",
    revision: skill.revision,
  });
  await r.deleteSkill("review");
  assert.deepEqual(await r.skills(), []);
});
test("schedule validates five-field cron, IANA timezone and sandbox restrictions", () => {
  assert.ok(validateCron({ cron: "0 9 * * *", timezone: "Asia/Shanghai" }));
  assert.throws(
    () => validateCron({ cron: "* * * * * *", timezone: "UTC" }),
    /5 个字段/,
  );
  assert.throws(
    () => validateCron({ cron: "99 9 * * *", timezone: "UTC" }),
    /无效/,
  );
  assert.throws(
    () => validateCron({ cron: "0 9 * * *", timezone: "Not/AZone" }),
    /无效/,
  );
  assert.equal(
    jobInput.safeParse({
      name: "a",
      workspaceId: "17d71afd-c9ec-4981-9316-21c87f7f3fd1",
      cron: "* * * * *",
      prompt: "a",
      sandbox: "danger-full-access",
    }).success,
    false,
  );
});
