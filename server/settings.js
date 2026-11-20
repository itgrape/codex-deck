import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { atomicWrite } from "./store.js";
import { HttpError } from "./resources.js";

const proxyUrl = (protocols) =>
  z
    .string()
    .trim()
    .max(2048)
    .refine((value) => {
      if (!value) return true;
      if (/[\r\n]/.test(value)) return false;
      try {
        return protocols.includes(new URL(value).protocol);
      } catch {
        return false;
      }
    }, "请输入有效的代理 URL");
export const generalSchema = z.object({
  proxyMode: z.enum(["inherit", "custom", "disabled"]),
  httpProxy: proxyUrl(["http:", "https:"]),
  httpsProxy: proxyUrl(["http:", "https:"]),
  allProxy: proxyUrl(["http:", "https:", "socks5:", "socks5h:"]),
  noProxy: z
    .string()
    .trim()
    .max(4096)
    .refine((v) => !/[\r\n]/.test(v), "不支持换行"),
  defaultTimezone: z
    .string()
    .min(1)
    .refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, "请输入有效的 IANA 时区"),
  jobConcurrency: z.number().int().min(1).max(16),
});
const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];
export function childEnvironment(settings, inherited = process.env) {
  const env = { ...inherited };
  if (settings.proxyMode === "inherit") return env;
  for (const key of proxyKeys) {
    delete env[key];
    delete env[key.toLowerCase()];
  }
  if (settings.proxyMode === "custom") {
    for (const [key, value] of Object.entries({
      HTTP_PROXY: settings.httpProxy,
      HTTPS_PROXY: settings.httpsProxy,
      ALL_PROXY: settings.allProxy,
      NO_PROXY: settings.noProxy,
    })) {
      if (value) {
        env[key] = value;
        env[key.toLowerCase()] = value;
      }
    }
  }
  return env;
}
export class Settings {
  constructor(dataDir) {
    this.path = join(dataDir, "settings.json");
    this.queue = Promise.resolve();
    this.defaults = generalSchema.parse({
      proxyMode: "inherit",
      httpProxy: "",
      httpsProxy: "",
      allProxy: "",
      noProxy: "localhost,127.0.0.1,::1",
      defaultTimezone: "Asia/Shanghai",
      jobConcurrency: Number(process.env.DECK_JOB_CONCURRENCY || 2),
    });
  }
  async read() {
    let content = "";
    try {
      content = await readFile(this.path, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return {
      settings: content
        ? generalSchema.parse(JSON.parse(content))
        : this.defaults,
      revision: createHash("sha256").update(content).digest("hex"),
    };
  }
  async save(body) {
    const input = z
      .object({ settings: generalSchema, revision: z.string() })
      .parse(body);
    const operation = this.queue.then(async () => {
      const old = await this.read();
      if (input.revision !== old.revision)
        throw new HttpError(409, "通用配置已变化，请重新加载");
      await atomicWrite(this.path, JSON.stringify(input.settings, null, 2));
      return this.read();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
