import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "smol-toml";
import { imChannels, createImConfig } from "../public/im-config.js";
test("all supported IM templates use native Codex and the official channel option keys", () => {
  const workspace = { name: 'Project "团队"', path: "/workspaces/project" };
  for (const channel of imChannels) {
    const config = parse(
      createImConfig({
        workspace,
        codexHome: "/data/codex",
        stateDir: "/data/cc-connect/state",
        platform: channel.id,
      }),
    );
    const project = config.projects[0];
    assert.equal(project.name, workspace.name);
    assert.equal(project.agent.type, "codex");
    assert.equal(project.agent.options.backend, "app_server");
    assert.equal(project.agent.options.work_dir, workspace.path);
    assert.equal(project.platforms[0].type, channel.id);
    assert.deepEqual(
      { ...project.platforms[0].options },
      { ...channel.options, allow_from: "YOUR_USER_ID" },
    );
  }
  for (const id of ["qq", "qqbot", "weixin", "wecom", "feishu"])
    assert.ok(imChannels.some((c) => c.id === id));
});
