import yauzl from "yauzl";
import crc32 from "buffer-crc32";
import {
  mkdir,
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  rename,
  rm,
  lstat,
} from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { HttpError, slug, validateSkillContent } from "./resources.js";

export const ZIP_LIMIT = 16 * 1024 * 1024;
const MAX_EXPANDED = 64 * 1024 * 1024;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_ENTRIES = 1000;

function archivePath(name) {
  if (
    !name ||
    name.includes("\\") ||
    /[\x00-\x1f]/.test(name) ||
    name.startsWith("/") ||
    /^[a-z]:/i.test(name)
  )
    throw new HttpError(400, "ZIP 包含不安全的文件路径");
  const clean = name.replace(/\/$/, "");
  if (clean.split("/").some((part) => !part || part === "." || part === ".."))
    throw new HttpError(400, "ZIP 包含不安全的文件路径");
  return clean;
}
async function unpack(buffer, stage) {
  const files = [];
  let expanded = 0;
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => {
        if (error) return reject(new HttpError(400, "ZIP 文件无效或已损坏"));
        let settled = false;
        const paths = new Set();
        const fail = (e) => {
          if (settled) return;
          settled = true;
          zip.close();
          reject(
            e instanceof HttpError
              ? e
              : new HttpError(400, `ZIP 解压失败: ${e.message}`),
          );
        };
        if (zip.entryCount > MAX_ENTRIES)
          return fail(new HttpError(413, "ZIP 最多包含 1000 个文件和目录"));
        zip.on("error", fail);
        zip.on("end", () => {
          if (!settled) {
            settled = true;
            zip.close();
            resolve(files);
          }
        });
        zip.on("entry", (entry) => {
          (async () => {
            const name = archivePath(entry.fileName);
            const mode = entry.externalFileAttributes >>> 16;
            const type = mode & 0o170000;
            if (![0, 0o100000, 0o040000].includes(type))
              throw new HttpError(400, "ZIP 不支持符号链接或特殊文件");
            if (entry.generalPurposeBitFlag & 1)
              throw new HttpError(400, "请上传未加密的 ZIP");
            if (
              name.split("/").includes("__MACOSX") ||
              basename(name) === ".DS_Store"
            ) {
              zip.readEntry();
              return;
            }
            if (paths.has(name))
              throw new HttpError(400, "ZIP 包含重复文件路径");
            paths.add(name);
            const directory = entry.fileName.endsWith("/");
            if (type === 0o040000 && !directory)
              throw new HttpError(400, "ZIP 目录条目无效");
            const target = join(stage, ...name.split("/"));
            if (directory)
              await mkdir(target, { recursive: true, mode: 0o700 });
            else {
              expanded += entry.uncompressedSize;
              if (entry.uncompressedSize > MAX_FILE || expanded > MAX_EXPANDED)
                throw new HttpError(
                  413,
                  "ZIP 解压总大小最多 64 MiB，单个文件最多 16 MiB",
                );
              const stream = await new Promise((ok, bad) =>
                zip.openReadStream(entry, (e, stream) =>
                  e ? bad(e) : ok(stream),
                ),
              );
              const chunks = [];
              let bytes = 0;
              for await (const chunk of stream) {
                bytes += chunk.length;
                if (bytes > MAX_FILE || bytes > entry.uncompressedSize) {
                  stream.destroy();
                  throw new HttpError(413, "ZIP 文件大小超过限制");
                }
                chunks.push(chunk);
              }
              const data = Buffer.concat(chunks);
              if (
                data.length !== entry.uncompressedSize ||
                crc32.unsigned(data) !== entry.crc32
              )
                throw new HttpError(400, "ZIP 文件完整性校验失败");
              await mkdir(dirname(target), { recursive: true, mode: 0o700 });
              await writeFile(target, data, {
                flag: "wx",
                mode: mode & 0o111 ? 0o700 : 0o600,
              });
              files.push(name);
            }
            zip.readEntry();
          })().catch(fail);
        });
        zip.readEntry();
      },
    );
  });
}

export async function importSkillZip(resources, buffer, options = {}) {
  if (!buffer.length || buffer.length > ZIP_LIMIT)
    throw new HttpError(413, "ZIP 大小必须在 1 字节到 16 MiB 之间");
  if (options.name) slug.parse(options.name);
  await mkdir(resources.skillsDir, { recursive: true, mode: 0o700 });
  const root = await realpath(resources.skillsDir);
  const stage = await mkdtemp(join(root, ".import-"));
  try {
    const files = await unpack(buffer, stage);
    const manifests = files.filter((path) =>
      /^skills?\.md$/i.test(basename(path)),
    );
    if (!manifests.length)
      throw new HttpError(400, "ZIP 需要包含 SKILL.md（也兼容 Skills.md）");
    const depth = Math.min(...manifests.map((path) => path.split("/").length));
    const candidates = manifests.filter(
      (path) => path.split("/").length === depth,
    );
    if (candidates.length !== 1)
      throw new HttpError(400, "请每次上传一个技能包");
    const manifest = candidates[0];
    const prefix = dirname(manifest) === "." ? "" : dirname(manifest) + "/";
    if (files.some((path) => !path.startsWith(prefix)))
      throw new HttpError(400, "技能包文件必须位于同一个技能目录中");
    const content = await readFile(join(stage, manifest), "utf8");
    const frontmatter = validateSkillContent(content);
    const fromManifest = frontmatter.match(
      /^name:\s*["']?([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})["']?\s*$/m,
    )?.[1];
    const name =
      options.name || fromManifest || basename(prefix.replace(/\/$/, ""));
    if (!slug.safeParse(name).success)
      throw new HttpError(400, "无法识别技能名，请填写有效的技能目录名");
    const payload = prefix ? join(stage, prefix) : stage;
    if (basename(manifest) !== "SKILL.md")
      await rename(join(stage, manifest), join(payload, "SKILL.md"));
    if (options.name && options.name !== fromManifest)
      await writeFile(
        join(payload, "SKILL.md"),
        content.replace(/^name:[^\r\n]*/m, `name: ${name}`),
        { mode: 0o600 },
      );
    return await resources.serialize(async () => {
      const target = await resources.skillDir(name);
      let exists = false;
      try {
        const stat = await lstat(target);
        exists = true;
        if (!stat.isDirectory())
          throw new HttpError(409, "技能路径已被其他文件占用");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (exists && !options.replace)
        throw new HttpError(
          409,
          "同名技能已存在；可启用替换选项或使用其他目录名",
        );
      const backup = join(resources.dataDir, "skill-backups", name);
      if (exists) {
        await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
        await rm(backup, { recursive: true, force: true });
        await rename(target, backup);
      }
      try {
        await rename(payload, target);
      } catch (e) {
        if (exists) await rename(backup, target);
        throw e;
      }
      return { name, files: files.length, replaced: exists };
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
