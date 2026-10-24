/** Credential rotation must preserve connection identity and never pick an
 * arbitrary policy when a manually managed host has multiple credentials. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {issueNetworkGrant,readNetworkConfiguration,tokenDigest} from '../src/integrations/network-config.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-grant-policy-'));
try{
 const file=path.join(dir,'accounts.json'),grant={principal:'human',agentId:'host',credentialId:'stable-connection',tokenHash:tokenDigest(randomBytes(32).toString('hex')),domains:[{kind:'personal',id:'default'}],toolProfile:'office',assignmentIds:['seat-a']};
 await fs.writeFile(file,JSON.stringify({version:2,grants:[grant]}),{mode:0o600});
 await issueNetworkGrant({configFile:file,tokenFile:path.join(dir,'rotated.token'),principal:'human',agentId:'host',rotate:true});
 const rotated=(await readNetworkConfiguration(file)).grants[0];assert.equal(rotated.credentialId,'stable-connection','rotation must preserve the configured-connection identity');assert.deepEqual(rotated.assignmentIds,['seat-a']);
 await issueNetworkGrant({configFile:file,tokenFile:path.join(dir,'new-host.token'),principal:'human',agentId:'stable-connection'});
 const distinct=await readNetworkConfiguration(file);assert.equal(new Set(distinct.grants.map(g=>g.credentialId)).size,2,'a new host must not collide with a user-chosen credential name');assert.equal(distinct.grants.find(g=>g.agentId==='host')!.credentialId,'stable-connection');
 const second={...rotated,credentialId:'second-connection',tokenHash:tokenDigest(randomBytes(32).toString('hex')),assignmentIds:undefined};
 const original=JSON.stringify({version:2,grants:[rotated,second]});await fs.writeFile(file,original);
 await assert.rejects(issueNetworkGrant({configFile:file,tokenFile:path.join(dir,'ambiguous.token'),principal:'human',agentId:'host',rotate:true}),(e:any)=>e.code==='invalid_input'&&/multiple|多份/.test(e.message),'a host-wide shortcut must not silently choose one policy and revoke every credential');
 assert.equal(await fs.readFile(file,'utf8'),original);await assert.rejects(fs.stat(path.join(dir,'ambiguous.token')),{code:'ENOENT'});
 // Order must not determine which permissions survive.
 await fs.writeFile(file,JSON.stringify({version:2,grants:[second,rotated]}));
 await assert.rejects(issueNetworkGrant({configFile:file,tokenFile:path.join(dir,'reversed.token'),principal:'human',agentId:'host',rotate:true}),(e:any)=>e.code==='invalid_input');
 console.log('PASS credential rotation: stable connection identity, retained restrictions, explicit ambiguous-policy refusal, unchanged private config and no orphan token');
}finally{await fs.rm(dir,{recursive:true,force:true});}
