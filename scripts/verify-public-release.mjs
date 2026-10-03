import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const policy = JSON.parse(fs.readFileSync(path.join(root, 'scripts/release-policy.json'), 'utf8'));
const fixtureSecrets = policy.syntheticCredentialLiterals;
const topFiles = new Set(['.env.example', '.gitignore', '.npmrc', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'npm-shrinkwrap.json', 'tsconfig.json']);
const failures = [];
const forbid = /(?:^|\/)(?:\.env(?:\.[^/]+)?|id_rsa|id_ed25519)(?:$)|\.(?:db(?:-[^/]*)?|sqlite(?:3)?(?:-[^/]*)?|bak|pem|key|p12|pfx|onnx|node|log|tgz|png|jpg|pdf|docx|zip)$/i;
const secrets = /(?:sk-[A-Za-z0-9_-]{16,}|(?:ghp|github_pat|gho)_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|LTAI[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9_.=-]{25,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|secret|password|access[_-]?token)["']?\s*[:=]\s*["']([A-Za-z0-9+/_=-]{16,})["']|(?:api[_-]?key|secret|password|access[_-]?token)\s*=\s*([A-Za-z0-9+/_=-]{16,}))/gi;
const personalPath = /\/home\/[^\s/"'<>`]+(?:\/[^\s"'<>`]+)?/g;
function inspect(name, data) {
  if (data.includes(0)) { failures.push(`${name}: unexpected binary`); return; }
  const text = data.toString('utf8');
  for (const match of text.matchAll(secrets)) {
    const value = match[1] ?? match[2];
    // Built JS contains the same audited synthetic checks as its source TS.
    const fixturePath = name.startsWith('dist/') ? name.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts') : name;
    if (!value || !fixtureSecrets[fixturePath]?.includes(value))
      failures.push(`${name}: credential signature (value suppressed)`);
  }
  if (personalPath.test(text)) failures.push(`${name}: hardcoded home-directory path`);
  personalPath.lastIndex = 0;
  if (/\b192\.168\.\d{1,3}\.\d{1,3}\b/.test(text)) failures.push(`${name}: private network address`);
}

if (pkg.license !== 'MIT' || !fs.existsSync(path.join(root, 'LICENSE'))) failures.push('Project MIT license is missing');
if (pkg.repository?.url !== 'git+https://github.com/sukichen/MindPond.git') failures.push('Unexpected public repository URL');
if (pkg.files.some(name => name.includes('*'))) failures.push('npm files must be explicit; wildcard publication is forbidden');
const sourceFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
for (const name of new Set(sourceFiles)) {
  const full = path.join(root, name);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
  if (name !== '.env.example' && forbid.test(name)) failures.push(`${name}: private/binary file type`);
  const permitted = topFiles.has(name) || /^(?:src|web|scripts|examples|licenses|\.github)\//.test(name)
    || /^evals\/(?:anchors|datasets|fixtures)\//.test(name)
    || (name.startsWith('docs/') && (pkg.files.includes(name) || name === 'docs/adr/0001-product-boundaries.md'));
  if (!permitted) failures.push(`${name}: source publication allowlist`);
  inspect(name, fs.readFileSync(full));
  if (name.endsWith('.md')) {
    const text = fs.readFileSync(full, 'utf8');
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
      if (!fs.existsSync(path.resolve(path.dirname(full), target))) failures.push(`${name}: missing local link ${target}`);
    }
  }
}
// Do not run prepack recursively. Scan the exact npm file list and compiled output.
const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: root, maxBuffer: 8_000_000 }).toString())[0];
for (const { path: name } of packed.files) {
  const permitted = ['package.json', 'README.md', 'LICENSE', 'npm-shrinkwrap.json'].includes(name)
    || pkg.files.some(entry => entry === name || (entry.endsWith('/') && name.startsWith(entry)));
  if (!permitted || (name !== '.env.example' && forbid.test(name))) failures.push(`${name}: npm publication allowlist`);
  inspect(name, fs.readFileSync(path.join(root, name)));
}
for (const required of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses/dependencies.txt', 'licenses/inventory.json', 'dist/server.js', 'dist/mcp.js'])
  if (!packed.files.some(file => file.path === required)) failures.push(`${required}: missing from package`);
if (failures.length) throw new Error('Public release rejected:\n' + [...new Set(failures)].join('\n'));
console.log(`PASS public source (${new Set(sourceFiles).size} files), npm package (${packed.files.length} files), licenses and documentation links`);
