/** Test-only stdio entry for the trusted SDK/domain contract. Not shipped by npm.
 * Public dist/mcp.js is exclusively role-bound; never use this fixture for agents. */
process.env.MINDPOND_LOG_STDERR='1';
const {GraphMemory}=await import('../../dist/core/graph-memory.js');
const {createMemoryMcpServer}=await import('../../dist/mcp-service.js');
const {StdioServerTransport}=await import('@modelcontextprotocol/sdk/server/stdio.js');
const graph=new GraphMemory();await graph.init();
const service=createMemoryMcpServer(graph,{toolProfile:process.env.MINDPOND_TOOL_PROFILE??'full',trusted:process.env.MINDPOND_LIBRARY_TEST_UNBOUND==='1'?undefined:{v:1,principal:process.env.MEMORY_TRUST_PRINCIPAL??'library-test',domains:JSON.parse(process.env.MEMORY_TRUST_DOMAINS??'[{"kind":"personal","id":"default"}]'),sessionId:process.env.MEMORY_TRUST_SESSION||undefined,operator:process.env.MEMORY_TRUST_OPERATOR==='1',issuedAt:0,expiresAt:Number.MAX_SAFE_INTEGER}});
await service.server.connect(new StdioServerTransport());
console.error('[mindpond-library-fixture] ready');
let closing=false;const close=async()=>{if(closing)return;closing=true;await service.close();await graph.close();};
process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
