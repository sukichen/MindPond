/** Actual separate HTTP MCP catalogs, multiplexed native chats and owner isolation. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GraphMemory } from '../src/core/graph-memory.js';
import { createNetworkMcpApp } from '../src/integrations/network-server.js';
import { tokenDigest } from '../src/integrations/network-config.js';
import { createOwnerMemoryServer } from '../src/role-memory-service.js';
import { renderOpenCodeSessionPlugin } from '../src/integrations/host-correlation.js';
import { pathToFileURL } from 'node:url';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mindpond-role-memory-'));
const graph = new GraphMemory('.', { dbPath: path.join(dir, 'test.db') });
const admin = { v: 1 as const, principal: 'human', operator: true, issuedAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };
const hostToken = 'fixture-host-'.repeat(5).slice(0, 43);
const clients: Client[] = [];
let server: any, network: any, userService: any;
try {
    await graph.init();
    await graph.offices.configureAgent({ id: 'host', principal: 'human', name: 'Fixture OpenCode', host: 'opencode', state: 'active', expectedRevision: 0 }, admin);
    const grant = { principal: 'human', agentId: 'host', credentialId: 'fixture', tokenHash: tokenDigest(hostToken), domains: [{ kind: 'personal' as const, id: 'default' }], toolProfile: 'work' as const };
    network = createNetworkMcpApp(graph, { configuration: async () => ({ version: 2, grants: [grant] }), allowedHosts: ['127.0.0.1'], maxPerAccount: 32, idleMs: 100 });
    // Listen before pinning the exact Host header.
    server = network.app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    const port = server.address().port;
    await network.close();
    await new Promise<void>(r => server.close(r));
    network = createNetworkMcpApp(graph, { configuration: async () => ({ version: 2, grants: [grant] }), allowedHosts: ['127.0.0.1:' + port], maxPerAccount: 32, idleMs: 300000 });
    server = network.app.listen(port, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    async function connect(endpoint: string, token = hostToken, fixed = 'same-installation') {
        const client = new Client({ name: 'fixture', version: '1' });
        clients.push(client);
        try {
            await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${endpoint}`), { requestInit: { headers: { Authorization: 'Bearer ' + token, 'X-MindPond-Session': fixed } } }));
        }
        catch (e) {
            throw Error('Connection fixture failed at ' + endpoint + ' ' + (token.startsWith('mpr_') ? 'role credential' : 'host credential'), { cause: e });
        }
        return client;
    }
    const office = await connect('/mcp');
    console.log('PASS office host connection');
    const catalog = (await office.listTools()).tools;
    assert(catalog.some(t => t.name === 'role_application'));
    assert(catalog.every(t => !t.name.startsWith('memory_')));
    const call = async (c: Client, name: string, args: any = {}, session?: string) => { const r: any = await c.callTool({ name, arguments: args, ...(session ? { _meta: { 'ai.opencode/sessionID': session } } : {}) }); return { r, data: JSON.parse(r.content[0].text) }; };
    const apply = async (session: string) => { const { r, data } = await call(office, 'role_application', { action: 'submit', name: session, introduction: 'Fictional role', reason: 'Isolation regression', key: 'apply' }, session); assert(!r.isError, JSON.stringify(data)); return graph.roles.review({ action: 'approve', applicationId: data.applicationId, expectedRevision: 1 }, admin); };
    const a = await apply('chat-a'), b = await apply('chat-b');
    assert.notEqual(a.roleId, b.roleId, 'fixed config label must not override per-call native session');
    assert.equal((await call(office, 'role_sync', {}, 'chat-a')).data.identity.roleId, a.roleId);
    assert.equal((await call(office, 'role_sync', {}, 'chat-b')).data.identity.roleId, b.roleId);
    const memory = await connect('/memory/mcp');
    const oversized=await memory.callTool({name:'memory_identity',arguments:{extra:Array(10001).fill(0)},_meta:{'ai.opencode/sessionID':'chat-a'}});
    assert(oversized.isError);assert.match(JSON.stringify(oversized.content),/maximum of 10000 elements/,'independent Memory server enables the SDK input limit');

    assert((await memory.listTools()).tools.every(t => t.name.startsWith('memory_')));
    for (const t of (await memory.listTools()).tools)
        assert(!['domains', 'domain', 'sessionId', 'spaceId', 'ownerId', 'roleId'].some(k => k in (t.inputSchema.properties ?? {})));
    const human = await graph.saveMemory('isolation fixture human environment knowledge', { domain: { kind: 'personal', id: 'another-workspace' }, memberships: [{ spaceId: 'old-project', memoryType: 'work' }] });
    const saved = await call(memory, 'memory_save', { content: 'isolation fixture A task knowledge', idempotencyKey: 'save-a' }, 'chat-a');
    assert(!saved.r.isError, JSON.stringify(saved.data));
    const own = await call(memory, 'memory_get', { nodeId: saved.data.id }, 'chat-a');
    assert.equal(own.data.owner.id, a.roleId);
    assert((await call(memory, 'memory_get', { nodeId: saved.data.id }, 'chat-b')).r.isError);
    assert((await call(memory, 'memory_get', { nodeId: human.id }, 'chat-a')).r.isError);
    assert.equal((await call(memory, 'memory_identity', {}, 'unapproved-chat')).data.owner.kind,'user','identified unbound chats are human');
    const assignment = await graph.memoryOwners.allocate([human.id], a.roleId);
    const copyId = assignment.copies[0].copyId;
    assert.equal((await graph.memoryOwners.allocate([human.id], a.roleId)).copies[0].copyId, copyId);
    const copied = await call(memory, 'memory_get', { nodeId: copyId }, 'chat-a');
    assert(copied.data.sourceRefs.some((r: any) => r.uri === 'mindpond:memory/' + human.id));
    assert(!(await call(memory, 'memory_update', { nodeId: copyId, expectedUpdatedAt: copied.data.updatedAt, content: 'A-specific revised knowledge', reason: 'Verified independent copy' }, 'chat-a')).r.isError);
    assert.equal((await graph.getNodeById(human.id))!.content, 'isolation fixture human environment knowledge');
    const crowded=await graph.saveMemory('Source-complete assignment boundary',{sourceRefs:Array.from({length:64},(_,i)=>({uri:'fixture:source/'+i,revision:'v1',context:'reviewed source'}))});
    const crowdedCopy=(await graph.memoryOwners.allocate([crowded.id],a.roleId)).copies[0].copyId;
    const complete=(await call(memory,'memory_get',{nodeId:crowdedCopy},'chat-a')).data;
    assert.equal(complete.sourceRefs.length,64);assert.equal(complete.provenance.sourceId,crowded.id);
    userService = createOwnerMemoryServer(graph);
    const user = new Client({ name: 'human', version: '1' });
    clients.push(user);
    const [x, y] = InMemoryTransport.createLinkedPair();
    await Promise.all([userService.server.connect(x), user.connect(y)]);
    for(const name of ['memory_identity','memory_directory','memory_brief','memory_search','memory_get','memory_save','memory_update','memory_delete','memory_save_policy']){
      const args:any={memory_brief:{task:'human data'},memory_search:{query:'human data'},memory_get:{nodeId:human.id},memory_save:{content:'Must not write human memory',idempotencyKey:'unidentified'},memory_update:{nodeId:human.id,expectedUpdatedAt:0,reason:'Must deny'},memory_delete:{nodeId:human.id,reason:'Must deny'}};
      const denied=await call(user,name,args[name]??{});assert(denied.r.isError,name);assert.equal(denied.data.error.code,'identity_required');
    }
    const all = await graph.listNodes({operatorAll:true});assert(all.nodes.some(n=>n.id===human.id)&&all.nodes.some(n=>n.id===copyId));
    const found=await graph.recall({query:'isolation fixture human environment knowledge',operatorAll:true,limit:20});assert(found.results.some(n=>n.node.id===human.id));
    const remoteWithoutRole=createOwnerMemoryServer(graph,{trusted:{v:1,principal:'legacy-account',transport:'http-mcp',issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER}});
    const legacy=new Client({name:'unbound-remote',version:'1'});clients.push(legacy);const [lx,ly]=InMemoryTransport.createLinkedPair();
    await Promise.all([remoteWithoutRole.server.connect(lx),legacy.connect(ly)]);
    try{assert((await call(legacy,'memory_directory')).r.isError,'remote legacy account cannot fall back to human memory');}finally{await legacy.close();await remoteWithoutRole.close();}
    const bounded=(await call(memory,'memory_search',{query:'knowledge',contextBudgetBytes:2048},'chat-a')).data;assert.equal(Buffer.byteLength(JSON.stringify({results:bounded.results})),bounded.contextBudget.used);assert(bounded.contextBudget.used<=2048);
    console.log('PASS owner isolation, independent copies and explicit human management');
    // Codex uses _meta.threadId, including on a shared transport with an old
    // fixed installation label. The same textual ID in OpenCode is distinct.
    const codexCall=async(c:Client,name:string,args:any={},threadId='chat-a')=>{const r:any=await c.callTool({name,arguments:args,_meta:{threadId}});return {r,data:JSON.parse(r.content[0].text)};};
    assert.equal((await codexCall(office,'role_sync')).data.state,'unregistered');
    const codexRoles=[];
    for(const threadId of ['chat-a','chat-b']){
        const submitted=await codexCall(office,'role_application',{action:'submit',name:'Codex '+threadId,introduction:'Fictional role',reason:'Codex metadata regression',key:'apply'},threadId);
        assert(!submitted.r.isError,JSON.stringify(submitted.data));
        const role=await graph.roles.review({action:'approve',applicationId:submitted.data.applicationId,expectedRevision:1},admin);codexRoles.push(role.roleId);
        const synced=await codexCall(office,'role_sync',{},threadId);assert.equal(synced.data.identity.roleId,role.roleId);assert.equal(synced.data.identity.bindingMode,'codex_metadata');
        assert.equal((await codexCall(memory,'memory_identity',{},threadId)).data.owner.id,role.roleId);
    }
    assert.notEqual(codexRoles[0],codexRoles[1]);assert.notEqual(codexRoles[0],a.roleId);
    const codexSaved=(await codexCall(memory,'memory_save',{content:'Codex A private fixture',idempotencyKey:'save'},'chat-a')).data;
    assert((await codexCall(memory,'memory_get',{nodeId:codexSaved.id},'chat-b')).r.isError);
    const codexReconnect=await connect('/memory/mcp');assert.equal((await codexCall(codexReconnect,'memory_identity')).data.owner.id,codexRoles[0]);
    const codexCredential=await graph.memoryOwners.issue(codexRoles[0]),codexPinned=await connect('/memory/mcp',codexCredential.token);
    assert.equal((await codexCall(codexPinned,'memory_identity')).data.owner.id,codexRoles[0]);
    await assert.rejects(()=>codexCall(codexPinned,'memory_identity',{},'chat-b'),(e:any)=>e.code===403);
    await assert.rejects(()=>memory.callTool({name:'memory_identity',arguments:{},_meta:{threadId:42}}),(e:any)=>e.code===400,'malformed native ID must never fall back to the old header');
    console.log('PASS Codex per-call threadId: shared connection isolation, source namespaces, role memory, pinned fencing, reconnect and malformed-ID rejection');
    const pin = await graph.memoryOwners.issue(a.roleId), pinned = await connect('/memory/mcp', pin.token);
    assert.equal((await call(pinned, 'memory_identity')).data.owner.id, a.roleId);
    await assert.rejects(() => call(pinned, 'memory_identity', {}, 'chat-b'), (e: any) => e.code === 403, 'pinned role rejects another approved chat');
    const pinOffice = await connect('/mcp', pin.token);
    assert.equal((await call(pinOffice, 'role_sync')).data.identity.roleId, a.roleId);
    await assert.rejects(() => call(pinOffice, 'role_sync', {}, 'chat-b'), (e: any) => e.code === 403);
    const reconnected = await connect('/memory/mcp');
    assert.equal((await call(reconnected, 'memory_identity', {}, 'chat-a')).data.owner.id, a.roleId, 'new MCP transport restores native chat binding');
    const pluginFile = path.join(dir, 'session-plugin.mjs');
    await fs.writeFile(pluginFile, renderOpenCodeSessionPlugin({ tokenEnv: 'MINDPOND_FIXTURE_SESSION_TOKEN', prefixes: ['mindpond_office_', 'mindpond_memory_'] }));
    process.env.MINDPOND_FIXTURE_SESSION_TOKEN = hostToken;
    const hooks = await (await import(pathToFileURL(pluginFile).href)).default();
    async function signed(name: string, args: any, session: string) { const output = { args: { ...args } }; await hooks['tool.execute.before']({ tool: 'mindpond_' + (name.startsWith('memory_') ? 'memory' : 'office') + '_' + name, sessionID: session }, output); return output.args; }
    const signedApply = await signed('role_application', { action: 'submit', name: 'plugin-chat', introduction: 'Signed host proof', reason: 'Older OpenCode session isolation', key: 'plugin' }, 'plugin-chat');
    const signedResult = await call(office, 'role_application', signedApply);
    assert(!signedResult.r.isError, JSON.stringify(signedResult.data));
    const pluginRole = await graph.roles.review({ action: 'approve', applicationId: signedResult.data.applicationId, expectedRevision: 1 }, admin);
    const proof = await signed('memory_identity', {}, 'plugin-chat');
    assert.equal((await call(memory, 'memory_identity', proof)).data.owner.id, pluginRole.roleId);
    await assert.rejects(() => call(memory, 'memory_get', { ...proof, nodeId: human.id }), (e: any) => e.code === 403, 'proof cannot authorize a different tool or arguments');
    const spoof: any = await memory.callTool({ name: 'memory_identity', arguments: {}, _meta: { 'mindpond/verifiedSessionID': 'chat-a' } });
    assert(spoof.isError, 'server discards unverified internal metadata');
    delete process.env.MINDPOND_FIXTURE_SESSION_TOKEN;
    const newChat=await call(pinOffice,'role_sync',{},'pinned-new-chat');
    assert.equal(newChat.data.state,'unregistered');assert(newChat.data.activation?.id,'pinned connection must expose a user activation request before accessing a new chat');
    const currentRole=(await graph.roles.registry(admin)).roles.find((r:any)=>r.id===a.roleId);
    await graph.roles.activate({requestId:newChat.data.activation.id,roleId:a.roleId,expectedRevision:currentRole.revision},admin);
    await assert.rejects(()=>call(pinned,'memory_identity',{},'pinned-new-chat'),(e:any)=>e.code===401,'a switch revokes downloaded role credentials too');
    const movedCredential=await graph.memoryOwners.issue(a.roleId);
    const movedMemory=await connect('/memory/mcp',movedCredential.token);
    assert.equal((await call(movedMemory,'memory_identity',{},'pinned-new-chat')).data.owner.id,a.roleId);
    await assert.rejects(()=>call(movedMemory,'memory_identity',{},'chat-a'),(e:any)=>e.code===403,'the original chat loses role access after switching');
    await graph.memoryOwners.issue(a.roleId,true);
    await assert.rejects(() => call(movedMemory, 'memory_identity'), (e: any) => e.code === 401, 'rotated credential is rejected on an already-open session');
    console.log('PASS separate office/memory catalogs; native multi-chat identity beats static header; role-only read/write, independent source-linked copies, human global recall, reconnect recovery and credential revocation');
}
finally {
    for (const c of clients)
        await c.close().catch(() => { });
    await userService?.close();
    await network?.close();
    if (server)
        await new Promise<void>(r => server.close(r));
    await graph.close();
    await fs.rm(dir, { recursive: true, force: true });
}
