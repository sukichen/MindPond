/** Server-owned grants. Only opaque per-account bearer tokens leave the server. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {normalizeDomain,type MemoryDomainRef} from '../core/domain.js';
import {parseMcpToolProfile,type McpToolProfile} from '../core/mcp-tool-profile.js';
export interface NetworkGrant {principal:string;tokenHash:string;domains:MemoryDomainRef[];toolProfile:McpToolProfile;}
export interface NetworkConfiguration {version:1;grants:NetworkGrant[];}
export const tokenDigest=(token:string)=>createHash('sha256').update(token).digest('hex');
export async function readNetworkConfiguration(file:string):Promise<NetworkConfiguration> {
  const stat=await fs.stat(file);
  if(stat.size>131072||!stat.isFile())throw new Error('Network configuration must be a small regular file');
  if(process.platform!=='win32'&&(stat.mode&0o077))throw new Error('Network configuration must be private (chmod 600)');
  const raw=JSON.parse(await fs.readFile(file,'utf8'));
  if(raw.version!==1||!Array.isArray(raw.grants)||raw.grants.length>128)throw new Error('Invalid network configuration');
  const principals=new Set<string>(),hashes=new Set<string>();
  const grants=raw.grants.map((value:NetworkGrant)=>{
    if(!value||typeof value.principal!=='string'||!value.principal.trim()||value.principal.length>128||principals.has(value.principal))throw new Error('Invalid or duplicate principal');
    if(typeof value.tokenHash!=='string'||!/^\w{64}$/.test(value.tokenHash)||!/^[0-9a-f]+$/.test(value.tokenHash)||hashes.has(value.tokenHash))throw new Error('Invalid or duplicate token hash');
    if(!Array.isArray(value.domains)||!value.domains.length||value.domains.length>32)throw new Error('Every account needs explicit domains');
    const domains=value.domains.map(d=>normalizeDomain(d));
    if(domains.some(d=>d.kind==='session'))throw new Error('Session identities are assigned by the server, not account grants');
    principals.add(value.principal);hashes.add(value.tokenHash);
    return {principal:value.principal,tokenHash:value.tokenHash,domains,toolProfile:parseMcpToolProfile(value.toolProfile??'work')};
  });
  return {version:1,grants};
}
export function authenticateNetworkAccount(config:NetworkConfiguration,header:unknown):NetworkGrant|undefined {
  if(typeof header!=='string'||!/^Bearer [A-Za-z0-9_-]{43}$/.test(header))return;
  const hash=Buffer.from(tokenDigest(header.slice(7)),'hex');
  return config.grants.find(grant=>timingSafeEqual(hash,Buffer.from(grant.tokenHash,'hex')));
}
/** Offline admin operation; lock avoids losing another administrator's update. */
export async function issueNetworkGrant(options:{configFile:string;tokenFile:string;principal:string;personalId?:string;rotate?:boolean}) {
  const configFile=path.resolve(options.configFile),tokenFile=path.resolve(options.tokenFile);
  if(configFile===tokenFile)throw new Error('Token file must differ from server configuration');
  if(!/^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,127}$/u.test(options.principal))throw new Error('Invalid principal');
  await fs.mkdir(path.dirname(configFile),{recursive:true,mode:0o700});
  await fs.mkdir(path.dirname(tokenFile),{recursive:true,mode:0o700});
  const lock=await fs.open(configFile+'.lock','wx',0o600);
  let wroteToken=false;
  try {
    let config:NetworkConfiguration;
    try {config=await readNetworkConfiguration(configFile);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;config={version:1,grants:[]};}
    const previous=config.grants.find(g=>g.principal===options.principal);
    if(previous&&!options.rotate)throw new Error('Account exists; use --rotate and a new token file');
    if(!previous&&config.grants.length>=128)throw new Error('Account limit reached');
    const domains=options.personalId!==undefined?[normalizeDomain({kind:'personal',id:options.personalId})]:previous?.domains??[{kind:'personal' as const,id:'default'}];
    const token=randomBytes(32).toString('base64url');
    await fs.writeFile(tokenFile,token+'\n',{flag:'wx',mode:0o600});wroteToken=true;
    const grant:NetworkGrant={principal:options.principal,tokenHash:tokenDigest(token),domains,toolProfile:previous?.toolProfile??'work'};
    config.grants=[...config.grants.filter(g=>g.principal!==grant.principal),grant];
    const temporary=configFile+'.'+randomBytes(8).toString('hex')+'.tmp';
    try {await fs.writeFile(temporary,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});await fs.rename(temporary,configFile);}
    finally {await fs.rm(temporary,{force:true});}
    return {principal:grant.principal,domains:grant.domains,configFile,tokenFile,rotated:!!previous};
  } catch(error){if(wroteToken)await fs.rm(tokenFile,{force:true});throw error;}
  finally {await lock.close();await fs.unlink(configFile+'.lock');}
}
