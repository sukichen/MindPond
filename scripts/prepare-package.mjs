import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Lifecycle diagnostics belong on stderr so npm pack --json stays valid JSON.
for (const args of [
  [path.join(root, 'scripts/build.mjs')],
  [path.join(root, 'scripts/generate-license-notices.mjs'), '--check'],
  [path.join(root, 'scripts/verify-public-release.mjs')],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: ['inherit', 2, 2] });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
