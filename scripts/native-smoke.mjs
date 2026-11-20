import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRuntime } from "../server/runtime.js";

// Uses a fresh home. No existing login, model call, or IM credentials required.
const root = await mkdtemp(join(tmpdir(), "codex-deck-native-"));
const codexHome = join(root, "codex");
await mkdir(codexHome);
const runtime = new CodexRuntime({
  command: process.env.CODEX_BIN || "codex",
  cwd: root,
  home: root,
  codexHome,
});
try {
  const info = await runtime.initialize();
  assert.ok(info.userAgent);
  const threads = await runtime.request("thread/list", {
    cwd: root,
    limit: 10,
  });
  assert.ok(Array.isArray(threads.data));
  const skills = await runtime.request("skills/list", {
    cwds: [root],
    forceReload: true,
  });
  assert.ok(Array.isArray(skills.data));
  const command = await runtime.request("command/exec", {
    command: ["git", "--version"],
    cwd: root,
    timeoutMs: 10_000,
    sandboxPolicy: { type: "readOnly" },
  });
  assert.equal(command.exitCode, 0, command.stderr);
  assert.match(command.stdout, /git version/);
  const probe = join(root, "sandbox-write-probe");
  const writeCommand = ["sh", "-c", 'printf sandbox-check > "$1"', "sh", probe];
  const denied = await runtime.request("command/exec", {
    command: writeCommand,
    cwd: root,
    timeoutMs: 10_000,
    sandboxPolicy: { type: "readOnly" },
  });
  assert.notEqual(denied.exitCode, 0, "Read-only sandbox allowed a file write");
  await assert.rejects(access(probe), { code: "ENOENT" });
  const allowed = await runtime.request("command/exec", {
    command: writeCommand,
    cwd: root,
    timeoutMs: 10_000,
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [root],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
  });
  assert.equal(allowed.exitCode, 0, allowed.stderr);
  assert.equal(await readFile(probe, "utf8"), "sandbox-check");
  console.log(
    `Native Codex smoke passed: handshake, threads, skills, sandboxed command (${command.stdout.trim()}), read-only write denied, workspace write allowed`,
  );
} finally {
  runtime.stop();
  await rm(root, { recursive: true, force: true });
}
