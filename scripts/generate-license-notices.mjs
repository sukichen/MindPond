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
const policy=JSON.parse(fs.readFileSync(path.join(root,'licenses/policy.json'),'utf8'));
for(const pkg of inventory.filter(p=>!p.development)){
  if(!policy.baseAllowedLicenseExpressions.includes(pkg.license))throw Error(`Base dependency license requires review: ${pkg.package}@${pkg.version}: ${pkg.license}`);
  if(policy.baseForbiddenPackagePrefixes.some(prefix=>pkg.package.startsWith(prefix)))throw Error(`Heavy local inference dependency entered base runtime: ${pkg.package}`);
}
const inventoryPath = path.join(root, 'licenses', 'inventory.json');
const textPath = path.join(root, 'licenses', 'dependencies.txt');
const optionalLock=JSON.parse(fs.readFileSync(path.join(root,'examples/local-inference/npm-shrinkwrap.json'),'utf8'));
const optionalLocalInference=Object.entries(optionalLock.packages).filter(([location])=>location).map(([location,pkg])=>({package:location.split('node_modules/').at(-1),version:pkg.version,license:pkg.license??null,location,...(pkg.optional?{optional:true}:{})})).sort((a,b)=>a.location.localeCompare(b.location,'en'));
if(optionalLocalInference.some(pkg=>!pkg.license))throw Error('Optional inference dependency without license metadata; review before distribution');
const payload=JSON.stringify({schema:'mindpond.third-party.v1',packages:inventory,optionalLocalInference},null,2)+'\n';
if (process.argv.includes('--check')) {
  if (fs.readFileSync(inventoryPath, 'utf8') !== payload) throw new Error('License inventory is stale');
  const text = fs.readFileSync(textPath, 'utf8');
  if (!text.includes('vis-network@') || !text.includes('Permission is hereby granted, free of charge'))
    throw new Error('Browser-distributed dependency license is missing');
  console.log(`PASS declared licenses for ${inventory.length} dependency records, base runtime license policy and browser notices`);
} else {
  fs.mkdirSync(path.dirname(inventoryPath), { recursive: true });
  fs.writeFileSync(inventoryPath, payload);
  const sections = ['Third-party license texts for installed base runtime packages and browser assets.\nDevelopment and explicitly optional local inference dependencies are recorded separately in the full inventory; their own installed package notices remain authoritative.\nThe inventory also lists optional platform packages not installed on this machine.\nOriginal package notices and licenses remain authoritative.\n'];
  const seen = new Set();
  for (const pkg of inventory) {
    if(pkg.development)continue;
    const identity = `${pkg.package}@${pkg.version}`;
    if (seen.has(identity)) continue;
    const directory = path.join(root, pkg.location);
    if (!fs.existsSync(directory)) continue;
    seen.add(identity);
    const files = fs.readdirSync(directory).filter(name => /^(?:licen[cs]e|copying|notice|copyright)(?:$|[._-])/i.test(name));
    for (const file of files) {
      const source = path.join(directory, file);
      if (fs.statSync(source).isFile()) sections.push(`\n===== ${identity} / ${file} =====\n${fs.readFileSync(source, 'utf8').replace(/\r\n/g,'\n').replace(/[ \t]+$/gm,'')}\n`);
    }
  }
  fs.writeFileSync(textPath, sections.join('\n'));
  console.log(`Recorded ${inventory.length} declarations and ${seen.size} installed package identities`);
}
