/** Local-only credential diagnosis. Read-only SQLite; never initializes/migrates GraphMemory. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {open} from 'sqlite';
import sqlite3 from 'sqlite3';
import {readNetworkConfiguration,authenticateNetworkAccount,networkHostId} from './network-config.js';
export async function checkNetworkCredential(options:{configFile:string;tokenFile:string;dbPath:string}){
  const configFile=path.resolve(options.configFile),databasePath=path.resolve(options.dbPath);
  const config=await readNetworkConfiguration(configFile),stat=await fs.stat(options.tokenFile);
  if(!stat.isFile()||stat.size>512||(process.platform!=='win32'&&(stat.mode&0o077)))throw Error('Use a small private token file (chmod 600)');
  const token=(await fs.readFile(options.tokenFile,'utf8')).trim();
  const report={version:'mindpond.auth-check.v1',configFile,databasePath,configVersion:config.version,readOnly:true,scope:'Local account/host authorization only; not remote routing, proxy or native chat identity.'};
  const result=(ok:boolean,reason:string,details:Record<string,unknown>={})=>({...report,ok,reason,...details});
  if(!/^(?:mpr_)?[A-Za-z0-9_-]{43}$/.test(token))return result(false,'invalid_token_format');
  const grant=token.startsWith('mpr_')?undefined:authenticateNetworkAccount(config,'Bearer '+token);
  if(!token.startsWith('mpr_')&&!grant)return result(false,'credential_not_in_account_file');
  const db=await open({filename:databasePath,driver:sqlite3.Database,mode:sqlite3.OPEN_READONLY});
  try{
    await db.exec('PRAGMA busy_timeout=5000');
    const tables=new Set((await db.all('SELECT name FROM sqlite_master WHERE type=\'table\'')).map(r=>r.name));
    let agentId=grant?networkHostId(grant):undefined,principal=grant?.principal;
    if(token.startsWith('mpr_')){
      if(!['memory_role_credentials','character_roles','role_bindings'].every(t=>tables.has(t)))return result(false,'role_schema_missing');
      const r=await db.get("SELECT c.role_id,r.state,r.principal,b.connector_id FROM memory_role_credentials c JOIN character_roles r ON r.id=c.role_id LEFT JOIN role_bindings b ON b.role_id=r.id AND b.state='active' WHERE c.token_hash=? AND c.state='active'",[createHash('sha256').update(token).digest('hex')]);
      if(!r)return result(false,'role_credential_revoked_or_unknown');
      if(r.state!=='active')return result(false,'role_disabled');
      if(!r.connector_id)return result(false,'role_has_no_active_chat');
      agentId=r.connector_id;principal=r.principal;
    }
    if(!agentId)return result(false,'account_requires_host_registration',{credentialRecognized:true,hostBound:false,nextAction:'Generate a registered host connection in the workbench; account-domain MCP access is no longer served.'});
    if(!tables.has('office_agents'))return result(false,'host_registry_missing');
    if(tables.has('office_agent_tombstones')&&await db.get('SELECT 1 FROM office_agent_tombstones WHERE id=?',[agentId]))return result(false,'host_deleted',{hostId:agentId});
    const host=await db.get('SELECT principal,state FROM office_agents WHERE id=?',[agentId]);
    if(!host)return result(false,'host_not_in_this_database',{hostId:agentId});
    if(host.principal!==principal)return result(false,'host_account_mismatch',{hostId:agentId});
    if(host.state!=='active')return result(false,'host_not_active',{hostId:agentId,hostState:host.state});
    return result(true,'credential_and_host_match',{hostBound:true,hostId:agentId,...(grant?{toolProfile:grant.toolProfile}:{credentialKind:'role'})});
  }finally{await db.close();}
}
