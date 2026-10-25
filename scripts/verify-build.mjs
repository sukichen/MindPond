import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'mindpond-build-'));
try{
 for(const dir of ['scripts','src/core','dist/core','node_modules/typescript/bin'])fs.mkdirSync(path.join(fixture,dir),{recursive:true});
 fs.copyFileSync(path.join(root,'scripts/build.mjs'),path.join(fixture,'scripts/build.mjs'));
 fs.copyFileSync(path.join(root,'tsconfig.json'),path.join(fixture,'tsconfig.json'));
 // Run the actual compiler without copying or installing any dependencies.
 fs.symlinkSync(path.join(root,'node_modules/typescript/bin/tsc'),path.join(fixture,'node_modules/typescript/bin/tsc'));
 fs.writeFileSync(path.join(fixture,'src/core/current.ts'),'export const current: number = 1;\n');
 for(const name of ['obsolete.js','obsolete.d.ts','obsolete.js.map','obsolete.d.ts.map'])fs.writeFileSync(path.join(fixture,'dist/core',name),'stale');
 fs.writeFileSync(path.join(fixture,'dist/README.txt'),'Non-compiler files are not pruned.');
 const run=()=>spawnSync(process.execPath,[path.join(fixture,'scripts/build.mjs')],{encoding:'utf8'});
 const success=run();assert.equal(success.status,0,success.stderr+success.stdout);
 assert.deepEqual(fs.readdirSync(path.join(fixture,'dist/core')).sort(),['current.d.ts','current.js']);
 assert(fs.existsSync(path.join(fixture,'dist/README.txt')));
 const compiled=fs.readFileSync(path.join(fixture,'dist/core/current.js'),'utf8');
 fs.writeFileSync(path.join(fixture,'src/core/current.ts'),'export const current: number = "wrong";\n');
 fs.writeFileSync(path.join(fixture,'dist/core/keep-on-failure.js'),'previous');
 const failed=run();assert.notEqual(failed.status,0,'Compilation failure must propagate to npm build/prepack');
 assert.equal(fs.readFileSync(path.join(fixture,'dist/core/current.js'),'utf8'),compiled,'Failed compilation must not overwrite the last valid output');
 assert(fs.existsSync(path.join(fixture,'dist/core/keep-on-failure.js')),'Do not prune after a failed build');
 console.log('PASS build: deleted-source outputs pruned, valid output retained, failed compilation cannot emit or prune');
}finally{fs.rmSync(fixture,{recursive:true,force:true});}
