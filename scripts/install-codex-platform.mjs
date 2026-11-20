import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const version = process.argv[2];
assert.match(version || '', /^\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?$/);
assert.equal(process.platform, 'linux');
assert.ok(['arm64', 'x64'].includes(process.arch));
const installed = spawnSync('codex', ['--version'], { encoding: 'utf8' });
if (installed.status === 0 && installed.stdout.trim() === `codex-cli ${version}`) {
  console.log(`Codex ${version} native platform is available`);
  process.exit(0);
}

// npm may silently omit a failed optional dependency. Install its exact official
// artifact explicitly, in bounded ranges, and verify the complete npm integrity hash.
const packageName = `@openai/codex-linux-${process.arch}`;
const response = await fetch(`https://registry.npmjs.org/@openai/codex/${version}-linux-${process.arch}`, { signal: AbortSignal.timeout(60_000) });
assert.equal(response.status, 200, 'Cannot read Codex platform metadata');
const { dist } = await response.json();
assert.equal(new URL(dist.tarball).origin, 'https://registry.npmjs.org');
assert.match(dist.integrity, /^sha512-/);
const probe = await fetch(dist.tarball, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(60_000) });
assert.equal(probe.status, 206, 'Registry must support byte ranges');
const total = Number(probe.headers.get('content-range')?.match(/\/(\d+)$/)?.[1]);
await probe.arrayBuffer();
assert.ok(Number.isSafeInteger(total) && total > 0 && total < 1_073_741_824);
const dir = await mkdtemp(join(tmpdir(), 'codex-platform-'));
try {
  const chunkSize = 1024 * 1024;
  const count = Math.ceil(total / chunkSize);
  let cursor = 0, completed = 0;
  console.log(`Downloading ${packageName}: ${(total / 1048576).toFixed(1)} MiB in ${count} verified ranges`);
  async function worker() {
    while (cursor < count) {
      const index = cursor++;
      const start = index * chunkSize, end = Math.min(total - 1, start + chunkSize - 1);
      for (let attempt = 1; ; attempt++) {
        try {
          const part = await fetch(dist.tarball, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(600_000) });
          assert.equal(part.status, 206);
          assert.equal(part.headers.get('content-range'), `bytes ${start}-${end}/${total}`);
          const bytes = Buffer.from(await part.arrayBuffer());
          assert.equal(bytes.length, end - start + 1);
          await writeFile(join(dir, String(index)), bytes);
          break;
        } catch (error) {
          if (attempt >= 3) throw error;
          console.log(`Retrying platform range ${index}, attempt ${attempt + 1}`);
        }
      }
      completed++;
      if (completed % 8 === 0 || completed === count) console.log(`Codex platform: ${completed}/${count} ranges (${Math.floor(completed * 100 / count)}%)`);
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  const archive = join(dir, 'platform.tgz');
  const hash = createHash('sha512');
  for (let index = 0; index < count; index++) {
    const bytes = await readFile(join(dir, String(index)));
    hash.update(bytes); await appendFile(archive, bytes);
  }
  assert.equal(`sha512-${hash.digest('base64')}`, dist.integrity, 'Codex platform integrity mismatch');
  const target = `/usr/local/lib/node_modules/@openai/codex/node_modules/${packageName}`;
  await mkdir(target, { recursive: true });
  const extract = spawnSync('tar', ['-xzf', archive, '--strip-components=1', '-C', target], { stdio: 'inherit' });
  assert.equal(extract.status, 0, 'Cannot extract Codex platform');
  console.log(`Installed verified ${packageName}@${version}`);
} finally { await rm(dir, { recursive: true, force: true }); }
