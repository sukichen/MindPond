import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const result=spawnSync(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'-p',path.join(root,'tsconfig.json')],{cwd:root,stdio:'inherit'});
if(result.error)throw result.error;
if(result.status!==0)process.exit(result.status??1);

// tsc retains outputs from deleted or renamed sources. Remove only obsolete
// compiler artifacts after a successful build; never traverse symbolic links.
function prune(directory){
 for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  const target=path.join(directory,entry.name);
  if(entry.isDirectory()){prune(target);continue;}
  if(!entry.isFile()||!/(?:\.d\.ts(?:\.map)?|\.js(?:\.map)?)$/.test(entry.name))continue;
  const relative=path.relative(path.join(root,'dist'),target).replace(/(?:\.d\.ts(?:\.map)?|\.js(?:\.map)?)$/,'.ts');
  if(!fs.existsSync(path.join(root,'src',relative)))fs.unlinkSync(target);
 }
}
prune(path.join(root,'dist'));
