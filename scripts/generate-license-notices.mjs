import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'npm-shrinkwrap.json'), 'utf8'));
const inventory = Object.entries(lock.packages).filter(([name]) => name).map(([location, pkg]) => ({
  package: location.split('node_modules/').at(-1), version: pkg.version,
  license: pkg.license ?? null, location,
  ...(pkg.dev ? { development: true } : {}), ...(pkg.optional ? { optional: true } : {}),
})).sort((a, b) => a.location.localeCompare(b.location, 'en'));
if (inventory.some(pkg => !pkg.license)) throw new Error('Dependency without a declared license: review before release');
const inventoryPath = path.join(root, 'licenses', 'inventory.json');
const textPath = path.join(root, 'licenses', 'dependencies.txt');
const payload = JSON.stringify({ schema: 'mindpond.third-party.v1', packages: inventory }, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (fs.readFileSync(inventoryPath, 'utf8') !== payload) throw new Error('License inventory is stale');
  const text = fs.readFileSync(textPath, 'utf8');
  if (!text.includes('vis-network@') || !text.includes('Permission is hereby granted, free of charge'))
    throw new Error('Browser-distributed dependency license is missing');
  console.log(`PASS declared licenses for ${inventory.length} dependency records and browser notices`);
} else {
  fs.mkdirSync(path.dirname(inventoryPath), { recursive: true });
  fs.writeFileSync(inventoryPath, payload);
  const sections = ['Third-party license texts from installed npm packages.\nThe inventory also lists optional platform packages not installed on this machine.\nOriginal package notices and licenses remain authoritative.\n'];
  const seen = new Set();
  for (const pkg of inventory) {
    const identity = `${pkg.package}@${pkg.version}`;
    if (seen.has(identity)) continue;
    const directory = path.join(root, pkg.location);
    if (!fs.existsSync(directory)) continue;
    seen.add(identity);
    const files = fs.readdirSync(directory).filter(name => /^(?:licen[cs]e|copying|notice|copyright)(?:$|[._-])/i.test(name));
    for (const file of files) {
      const source = path.join(directory, file);
      if (fs.statSync(source).isFile()) sections.push(`\n===== ${identity} / ${file} =====\n${fs.readFileSync(source, 'utf8')}\n`);
    }
  }
  fs.writeFileSync(textPath, sections.join('\n'));
  console.log(`Recorded ${inventory.length} declarations and ${seen.size} installed package identities`);
}
