import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, value, { mode: 0o600 });
  await rename(temp, path);
}

// Single writer per service. Mutations are serialized and committed before becoming visible.
export class Store {
  constructor(path) {
    this.path = path;
    this.queue = Promise.resolve();
  }
  async open() {
    try {
      this.data = JSON.parse(await readFile(this.path, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      this.data = {
        version: 1,
        workspaces: [],
        jobs: [],
        runs: [],
        bridgeEnabled: false,
      };
      await atomicWrite(this.path, JSON.stringify(this.data, null, 2));
    }
    if (this.data.version !== 1) throw new Error("Unsupported state version");
    return this;
  }
  read() {
    return structuredClone(this.data);
  }
  mutate(fn) {
    const operation = this.queue.then(async () => {
      const draft = this.read();
      const result = await fn(draft);
      await atomicWrite(this.path, JSON.stringify(draft, null, 2));
      this.data = draft;
      return structuredClone(result);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
