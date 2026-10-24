/** One version source in source checkouts, npm installs and offline releases. */
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const root=new URL('../../',import.meta.url);
const pkg=JSON.parse(fs.readFileSync(new URL('package.json',root),'utf8')) as {version:string;engines:{node:string}};
const digest=(file:string)=>{try{return createHash('sha256').update(fs.readFileSync(new URL(file,root))).digest('hex');}catch{return null;}};
export const RELEASE_VERSION=pkg.version;
const build={version:pkg.version,nodeRequirement:pkg.engines.node,lockSha256:digest('npm-shrinkwrap.json'),frontendSha256:digest('web/office.js')};
export function releaseInfo(){return {...build,node:process.version,platform:process.platform,arch:process.arch};}
