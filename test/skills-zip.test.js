import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resources } from "../server/resources.js";
import { importSkillZip } from "../server/skills-zip.js";
import { makeZip } from "./fixtures/zip.mjs";
const manifest =
  "---\nname: zip-review\ndescription: Review code with supporting scripts and references.\n---\nUse script/run.sh and reference/guide.md.\n";
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "deck-zip-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new Resources({ dataDir: dir, skillsDir: join(dir, "skills") });
}
test("ZIP imports full skills with wrapper folders, plural manifest name, scripts and references", async (t) => {
  const r = await setup(t);
  const zip = makeZip([
    { path: "bundle/Skills.md", data: manifest, compress: true },
    {
      path: "bundle/script/run.sh",
      data: "#!/bin/sh\nprintf review",
      mode: 0o100755,
    },
    { path: "bundle/reference/guide.md", data: "# Guide" },
    { path: "__MACOSX/._Skills.md", data: "metadata" },
  ]);
  assert.deepEqual(await importSkillZip(r, zip), {
    name: "zip-review",
    files: 3,
    replaced: false,
  });
  assert.equal(
    await readFile(join(r.skillsDir, "zip-review", "SKILL.md"), "utf8"),
    manifest,
  );
  assert.equal(
    await readFile(
      join(r.skillsDir, "zip-review", "reference", "guide.md"),
      "utf8",
    ),
    "# Guide",
  );
  assert.ok(
    (await stat(join(r.skillsDir, "zip-review", "script", "run.sh"))).mode &
      0o100,
  );
  assert.equal((await r.skills()).length, 1);
});
test("ZIP conflict leaves existing package intact; explicit replacement keeps a complete backup", async (t) => {
  const r = await setup(t);
  await importSkillZip(
    r,
    makeZip([
      { path: "SKILL.md", data: manifest },
      { path: "scripts/old.sh", data: "old" },
    ]),
  );
  const next = makeZip([
    { path: "SKILL.md", data: manifest + "\nUpdated." },
    { path: "scripts/new.sh", data: "new" },
  ]);
  await assert.rejects(importSkillZip(r, next), (e) => e.status === 409);
  assert.equal(
    await readFile(
      join(r.skillsDir, "zip-review", "scripts", "old.sh"),
      "utf8",
    ),
    "old",
  );
  assert.equal(
    (await importSkillZip(r, next, { replace: true })).replaced,
    true,
  );
  assert.equal(
    await readFile(
      join(r.dataDir, "skill-backups", "zip-review", "scripts", "old.sh"),
      "utf8",
    ),
    "old",
  );
  await assert.rejects(
    access(join(r.skillsDir, "zip-review", "scripts", "old.sh")),
    { code: "ENOENT" },
  );
  assert.equal((await r.skills()).length, 1);
});
test("ZIP refuses traversal, symlinks, CRC corruption and excessive expanded sizes without installing files", async (t) => {
  const r = await setup(t);
  for (const archive of [
    makeZip([
      { path: "../escape", data: "bad" },
      { path: "SKILL.md", data: manifest },
    ]),
    makeZip([
      { path: "SKILL.md", data: manifest },
      { path: "link", data: "../outside", mode: 0o120777 },
    ]),
    makeZip([{ path: "SKILL.md", data: manifest, crc: 0 }]),
    makeZip([
      { path: "SKILL.md", data: manifest },
      {
        path: "bomb",
        data: "small",
        compress: true,
        declaredSize: 17 * 1024 * 1024,
      },
    ]),
    makeZip([
      { path: "SKILL.md", data: manifest },
      { path: "SKILL.md", data: manifest },
    ]),
  ])
    await assert.rejects(importSkillZip(r, archive), (e) =>
      [400, 413].includes(e.status),
    );
  assert.deepEqual(await r.skills(), []);
  assert.deepEqual(await readdir(r.skillsDir), []);
  await assert.rejects(access(join(r.dataDir, "escape")), { code: "ENOENT" });
});
test("ZIP accepts a custom directory name and rejects missing/ambiguous manifests", async (t) => {
  const r = await setup(t);
  assert.equal(
    (
      await importSkillZip(r, makeZip([{ path: "SKILL.md", data: manifest }]), {
        name: "review-custom",
      })
    ).name,
    "review-custom",
  );
  assert.match(
    await readFile(join(r.skillsDir, "review-custom", "SKILL.md"), "utf8"),
    /^name: review-custom$/m,
  );
  await assert.rejects(
    importSkillZip(r, makeZip([{ path: "readme.md", data: "not a skill" }])),
    /SKILL.md/,
  );
  await assert.rejects(
    importSkillZip(
      r,
      makeZip([
        { path: "a/SKILL.md", data: manifest },
        { path: "b/SKILL.md", data: manifest },
      ]),
    ),
    /一个技能包/,
  );
});
