/** Read-only source fingerprint manifest. Never executes target code or reads runtime data. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const sha=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
function git(repo:string,...args:string[]) {return execFileSync('git',['-C',repo,...args],{encoding:'utf8',maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']});}
function flag(name:string){const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];}
function untrackedCode(repo:string){return git(repo,'ls-files','--others','--exclude-standard','-z').split('\0').filter(p=>p.startsWith('src/')||p.startsWith('scripts/')).length;}
type Entry={path:string;status:'present'|'missing'|'symlink';fingerprint?:string};
async function snapshot(repo:string) {
  const root=(await fs.realpath(repo));
  if(await fs.realpath(git(root,'rev-parse','--show-toplevel').trim())!==root)throw new Error('--repo must be the repository root');
  const head=git(root,'rev-parse','HEAD').trim();
  const names=git(root,'ls-files','-z').split('\0').filter(Boolean).filter(name=>
    /^(src\/.*\.(?:ts|tsx|js|jsx)|scripts\/.*\.(?:ts|cts|mts)|package\.json|tsconfig\.json)$/.test(name));
  const files:Entry[]=[];
  for(const name of [...new Set(names)].sort()) {
    const absolute=path.resolve(root,name);
    if(!absolute.startsWith(root+path.sep))throw new Error('Tracked path escapes repository');
    let stat;try{stat=await fs.lstat(absolute);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){files.push({path:name,status:'missing'});continue;}throw error;}
    if(stat.isSymbolicLink()){files.push({path:name,status:'symlink'});continue;}
    if(!stat.isFile())throw new Error('Source path is not a regular file: '+name);
    const real=await fs.realpath(absolute);if(!real.startsWith(root+path.sep))throw new Error('Source ancestor escapes repository');
    if(stat.size>2_000_000)throw new Error('Source exceeds 2 MB budget: '+name);
    files.push({path:name,status:'present',fingerprint:sha(await fs.readFile(absolute))});
  }
  if(!files.length)throw new Error('No tracked source files found');
  const snapshotId=head+':'+sha(JSON.stringify(files));
  return {repo:root,head,snapshotId,files};
}

try {
  const check=flag('--check');
  if(check) {
    const expected=JSON.parse(await fs.readFile(check,'utf8'));
    if(expected.schema!=='mindpond.sample-project-source.v1')throw new Error('Unsupported manifest');
    const actual=await snapshot(expected.repo);
    if(actual.snapshotId!==expected.snapshotId)throw new Error('Source snapshot changed; stop this evaluation round and prepare a new manifest');
    if(expected.untrackedCodeFilesExcluded || untrackedCode(actual.repo))throw new Error('Untracked code remains outside the snapshot; include intended code in an isolated checkout before evaluation');
    if(actual.files.some(f=>f.status==='symlink'))throw new Error('Symlink source is excluded; prepare regular source files in the evaluation checkout');
    console.log('PASS unchanged tracked source snapshot: '+actual.snapshotId);
  } else {
    const repo=flag('--repo'),output=flag('--output'),context=flag('--context');
    if(!repo||!output||!context||context.length>256)throw new Error('Usage: --repo <root> --output <new.json> --context <eval/run> OR --check <manifest.json>');
    const state=await snapshot(repo);
    const untracked=untrackedCode(state.repo);
    const manifest={schema:'mindpond.sample-project-source.v1',createdAt:new Date().toISOString(),...state,context,
      untrackedCodeFilesExcluded:untracked,
      readyForEvaluation:untracked===0 && state.files.every(f=>f.status!=='symlink'),
      sourceRefs:state.files.filter(f=>f.status==='present').map(f=>({uri:'repo:sample-project/'+f.path,context,revision:state.snapshotId,fingerprint:f.fingerprint})),
      notes:['Fingerprints cover tracked code only, not runtime data or repository-wide correctness.','No target scripts were executed.','Use an isolated fixed checkout; check before every stage.']};
    await fs.writeFile(path.resolve(output),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
    console.log(`Prepared ${state.files.length} source entries; ${untracked} untracked code files excluded. Manifest: ${path.resolve(output)}`);
  }
} catch(error) {
  // Do not forward arbitrary git stderr (may contain a credential-bearing remote).
  console.error(error && typeof error==='object' && 'stderr' in error ? 'Git source inspection failed; verify the repository locally.' : (error as Error).message);
  process.exitCode=1;
}
