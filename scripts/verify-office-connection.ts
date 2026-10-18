import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { officeConnection, OFFICE_CAPABILITIES } from '../src/integrations/office-connection.js';
import { prepareRoleClientBundle } from '../src/integrations/role-client-bundle.js';
import { officeWaitCapacity } from '../src/core/office-wait-policy.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mindpond-office-config-'));
try{
  for(const host of ['codex','opencode','claude','generic-http-mcp']){
    const c=officeConnection({host,id:'example',url:'https://memory.example/mcp'});
    assert(!c.text.includes('65000')&&!c.text.includes('= 65\n'));
    if(host==='codex')assert.match(c.text,/tool_timeout_sec = 360\n/);
    else if(host!=='generic-http-mcp'){
      const parsed=JSON.parse(c.text),server=host==='opencode'?parsed.mcp.mindpond_example:parsed.mcpServers.mindpond_example;
      assert.equal(server.timeout,360000);assert.equal(server.url,'https://memory.example/mcp');
      assert(!server.headers.Authorization.includes('actual-secret'));
    }else assert(c.text.includes('at least 360 seconds'));
  }
  const longId=officeConnection({host:'codex',id:'a'.repeat(128),url:'https://memory.example/mcp'});assert(longId.env.length<=128&&longId.name.length<=128);
  assert.equal(OFFICE_CAPABILITIES.wait.maxMs,300000);assert.equal(OFFICE_CAPABILITIES.wait.wakesStoppedHost,false);
  for(const client of ['codex','opencode'] as const){
    const directory=path.join(dir,client);
    await prepareRoleClientBundle({client,directory,url:'https://memory.example/mcp',sessionLabel:'fixture',tokenEnv:'MINDPOND_FIXTURE_TOKEN'});
    const shared=officeConnection({host:client,id:'office',name:'mindpond_office',url:'https://memory.example/mcp',sessionLabel:'fixture',tokenEnv:'MINDPOND_FIXTURE_TOKEN'});
    if(client==='codex')assert.equal(await fs.readFile(path.join(directory,'.codex/config.toml'),'utf8'),shared.text);
    else assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory,'opencode.json'),'utf8')).mcp,(shared.config as any).mcp);
  }
  assert(officeConnection({host:'codex',id:'example',url:'http://127.0.0.1:7904/mcp'}).warnings.some(w=>w.includes('本机地址')));
  assert.throws(()=>officeConnection({host:'codex',id:'example',url:'https://user:secret@example.com/mcp'}));
  assert.throws(()=>officeWaitCapacity({MINDPOND_OFFICE_WAIT_PER_ACCOUNT:'65',MINDPOND_OFFICE_WAIT_GLOBAL:'64'}));
  assert.deepEqual(officeWaitCapacity({MINDPOND_OFFICE_WAIT_PER_ACCOUNT:'16',MINDPOND_OFFICE_WAIT_GLOBAL:'128'}),{maxPerPrincipal:16,maxGlobal:128});
  const browser=await fs.readFile(new URL('../web/office.js',import.meta.url),'utf8');
  assert(!browser.includes('function template('),'no second browser-only configuration generator');
  assert(browser.includes('state.data.connectionTemplates?.[agent.id]'));
  console.log('PASS shared public browser/CLI connection contract, no credentials, five-minute wait/six-minute deadline, host-specific syntax and configurable bounded capacity');
}finally{await fs.rm(dir,{recursive:true,force:true});}
