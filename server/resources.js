import {
  mkdir,
  readFile,
  readdir,
  realpath,
  lstat,
  unlink,
  copyFile,
} from "node:fs/promises";
import { join, resolve, relative, isAbsolute, dirname, sep } from "node:path";
import { createHash } from "node:crypto";
import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { atomicWrite } from "./store.js";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const slug = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const text = z.string().max(512_000);
export function validateSkillContent(content) {
  text.min(1).parse(content);
  const frontmatter = content.match(
    /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
  )?.[1];
  if (
    !frontmatter ||
    !/^name:\s*\S+/m.test(frontmatter) ||
    !/^description:\s*\S+/m.test(frontmatter)
  )
    throw new HttpError(
      400,
      "SKILL.md 需要包含 name 和 description 的 YAML frontmatter",
    );
  return frontmatter;
}
export const taskEnv = z
  .record(
    z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
      .refine(
        (key) => !["HOME", "CODEX_HOME"].includes(key),
        "HOME 和 CODEX_HOME 由工作台管理",
      ),
    z
      .string()
      .max(16384)
      .refine((value) => !value.includes("\0"), "环境变量不能包含 NUL 字符"),
  )
  .refine(
    (env) =>
      Object.keys(env).length <= 128 &&
      Buffer.byteLength(JSON.stringify(env)) <= 65536,
    "环境变量最多 128 项，总大小不能超过 64 KiB",
  );
export const workspaceInput = z.object({
  name: z.string().trim().min(1).max(80),
  path: z.string().min(1).max(4096),
  create: z.boolean().default(false),
});
export const jobInput = z.object({
  name: z.string().trim().min(1).max(80),
  workspaceId: z.string().uuid(),
  cron: z.string().min(1).max(100),
  timezone: z.string().default("Asia/Shanghai"),
  prompt: z.string().trim().min(1).max(100_000),
  enabled: z.boolean().default(true),
  sandbox: z.enum(["read-only", "workspace-write"]).default("read-only"),
  timeoutMinutes: z.number().int().min(1).max(120).default(15),
  env: taskEnv.default({}),
});

export async function workspacePath(root, input, create = false) {
  const base = await realpath(root);
  const candidate = resolve(base, input);
  const inside = (path) => {
    const r = relative(base, path);
    return (
      r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r))
    );
  };
  if (!inside(candidate))
    throw new HttpError(400, "工作目录必须位于 DECK_WORKSPACE_ROOT 内");
  // Validate the nearest existing ancestor before mkdir, then validate the final realpath.
  let ancestor = candidate;
  while (true) {
    try {
      if (!inside(await realpath(ancestor)))
        throw new HttpError(400, "工作目录不能通过符号链接逃逸根目录");
      break;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      ancestor = dirname(ancestor);
    }
  }
  if (create) await mkdir(candidate, { recursive: true });
  let canonical;
  try {
    canonical = await realpath(candidate);
  } catch (e) {
    if (e.code === "ENOENT")
      throw new HttpError(400, "目录不存在；可选择创建目录");
    throw e;
  }
  if (!inside(canonical) || !(await lstat(canonical)).isDirectory())
    throw new HttpError(400, "无效工作目录");
  return canonical;
}

const revision = (content) =>
  createHash("sha256").update(content).digest("hex");
export class Resources {
  constructor(options) {
    Object.assign(this, options);
    this.queue = Promise.resolve();
  }
  serialize(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  configPath(kind) {
    if (kind === "codex") return join(this.codexHome, "config.toml");
    if (kind === "cc-connect")
      return join(this.dataDir, "cc-connect", "config.toml");
    throw new HttpError(404, "未知配置");
  }
  async readConfig(kind) {
    const path = this.configPath(kind);
    let content = "";
    try {
      content = await readFile(path, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return { content, revision: revision(content), path };
  }
  async saveConfig(kind, body) {
    const input = z.object({ content: text, revision: z.string() }).parse(body);
    try {
      parse(input.content);
    } catch (e) {
      throw new HttpError(400, `TOML 无效: ${e.message}`);
    }
    return this.serialize(async () => {
      const old = await this.readConfig(kind);
      if (old.revision !== input.revision)
        throw new HttpError(409, "配置已被其他会话修改，请重新加载");
      if (kind === "cc-connect")
        await this.validateBridge(parse(input.content));
      if (old.content) await copyFile(old.path, `${old.path}.bak`);
      await atomicWrite(old.path, input.content);
      return this.readConfig(kind);
    });
  }
  async validateBridge(config) {
    if (!Array.isArray(config.projects) || !config.projects.length)
      throw new HttpError(400, "至少需要一个 [[projects]]");
    for (const project of config.projects) {
      if (project.agent?.type !== "codex")
        throw new HttpError(400, "仅支持 Codex agent");
      await workspacePath(
        this.workspaceRoot,
        project.agent?.options?.work_dir || "",
        false,
      );
    }
  }
  async listMcp() {
    const file = await this.readConfig("codex");
    return {
      servers: parse(file.content).mcp_servers || {},
      revision: file.revision,
    };
  }
  async saveMcp(body) {
    const input = z
      .object({
        revision: z.string(),
        servers: z.record(
          z.string().min(1).max(128),
          z
            .object({
              command: z.string().min(1).optional(),
              args: z.array(z.string()).optional(),
              env: z.record(z.string(), z.string()).optional(),
              url: z.string().min(1).optional(),
              enabled: z.boolean().optional(),
            })
            .catchall(z.unknown()),
        ),
      })
      .parse(body);
    // Validate the transport shape while retaining native extension fields.
    for (const server of Object.values(input.servers)) {
      if ((!server.command && !server.url) || (server.command && server.url))
        throw new HttpError(400, "MCP 必须指定 command 或 url 之一");
      if (server.command && typeof server.command !== "string")
        throw new HttpError(400, "command 必须为字符串");
      if (server.url) {
        let url;
        try {
          url = new URL(server.url);
        } catch {
          throw new HttpError(400, "MCP URL 无效");
        }
        if (!["http:", "https:"].includes(url.protocol))
          throw new HttpError(400, "MCP URL 必须为 HTTP(S)");
      }
    }
    return this.serialize(async () => {
      const old = await this.readConfig("codex");
      if (old.revision !== input.revision)
        throw new HttpError(409, "配置已变化，请重新加载");
      const config = parse(old.content);
      config.mcp_servers = input.servers;
      if (old.content) await copyFile(old.path, `${old.path}.bak`);
      await atomicWrite(old.path, stringify(config));
      return this.listMcp();
    });
  }
  async skillDir(name) {
    slug.parse(name);
    await mkdir(this.skillsDir, { recursive: true, mode: 0o700 });
    const root = await realpath(this.skillsDir);
    const dir = join(root, name);
    try {
      const stat = await lstat(dir);
      if (stat.isSymbolicLink())
        throw new HttpError(400, "不能修改符号链接技能");
      if (!stat.isDirectory())
        throw new HttpError(409, "技能路径已被其他文件占用");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    try {
      if ((await lstat(join(dir, "SKILL.md"))).isSymbolicLink())
        throw new HttpError(400, "不能修改符号链接文件");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return dir;
  }
  async skills() {
    await mkdir(this.skillsDir, { recursive: true, mode: 0o700 });
    const output = [];
    for (const entry of await readdir(this.skillsDir, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !slug.safeParse(entry.name).success) continue;
      try {
        const dir = await this.skillDir(entry.name);
        const content = await readFile(join(dir, "SKILL.md"), "utf8");
        output.push({ name: entry.name, content, revision: revision(content) });
      } catch (e) {
        if (e.code !== "ENOENT" && !(e instanceof HttpError)) throw e;
      }
    }
    return output;
  }
  async saveSkill(name, body) {
    const input = z
      .object({ content: text.min(1), revision: z.string().nullable() })
      .parse(body);
    validateSkillContent(input.content);
    return this.serialize(async () => {
      const dir = await this.skillDir(name);
      let old = null;
      try {
        old = await readFile(join(dir, "SKILL.md"), "utf8");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if ((old === null ? null : revision(old)) !== input.revision)
        throw new HttpError(409, "技能已变化，请重新加载");
      await atomicWrite(join(dir, "SKILL.md"), input.content);
      return {
        name,
        content: input.content,
        revision: revision(input.content),
      };
    });
  }
  async deleteSkill(name) {
    return this.serialize(async () => {
      const dir = await this.skillDir(name);
      // Remove only the managed entry point; retain scripts/references owned by the user.
      await unlink(join(dir, "SKILL.md"));
    });
  }
}
