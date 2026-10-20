/** Authenticated per-call correlation for hosts that multiplex MCP across chats.
 * No secret enters prompts. Bind the proof to the exact tool and arguments. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { MindPondError } from '../core/errors.js';
export function canonical(value: any): string { return JSON.stringify(value === null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, JSON.parse(canonical(value[k]))]))); }
export function signHostSession(sessionId: string, tool: string, args: any, token: string, now = Date.now()) {
    const copy = { ...args };
    delete copy.hostContext;
    const payload = Buffer.from(JSON.stringify({ v: 1, sessionId, tool, digest: createHash('sha256').update(canonical(copy)).digest('hex'), at: now })).toString('base64url');
    return payload + '.' + createHmac('sha256', token).update(payload).digest('base64url');
}
export function verifyHostSession(proof: unknown, tool: string, args: any, token: string, now = Date.now()) {
    const bad = () => new MindPondError('scope_denied', 'Invalid or expired host session proof; reconnect using the host session plugin');
    if (typeof proof !== 'string' || proof.length > 4096)
        throw bad();
    const [body, signature, ...extra] = proof.split('.');
    if (!body || !signature || extra.length)
        throw bad();
    const expected = createHmac('sha256', token).update(body).digest(), actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw bad();
    let p: any;
    try {
        p = JSON.parse(Buffer.from(body, 'base64url').toString());
    }
    catch {
        throw bad();
    }
    const copy = { ...args };
    delete copy.hostContext;
    if (p.v !== 1 || typeof p.sessionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(p.sessionId) || p.tool !== tool || !Number.isFinite(p.at) || p.at > now + 60000 || p.at < now - 300000 || p.digest !== createHash('sha256').update(canonical(copy)).digest('hex'))
        throw bad();
    return p.sessionId as string;
}
export function renderOpenCodeSessionPlugin(options: {
    tokenEnv?: string;
    prefixes?: string[];
} = {}) {
    if (options.tokenEnv && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(options.tokenEnv) || options.prefixes?.some(p => !/^[A-Za-z0-9_.-]+_$/.test(p)))
        throw Error('Invalid host plugin configuration');
    return `import {createHash,createHmac} from 'node:crypto';
${canonical.toString()}
${signHostSession.toString()}
export default async function(host){
 const configured=${JSON.stringify(options)};let cached,last=0;
 async function config(){if(!cached||Date.now()-last>2000){const response=await host.client.config.get();if(response.error)throw Error('Cannot read host MCP configuration');cached=response.data;last=Date.now();}return cached;}
 return {"tool.execute.before":async(input,output)=>{
  let prefix=(configured.prefixes||[]).find(p=>input.tool.startsWith(p));
  let token=configured.tokenEnv&&process.env[configured.tokenEnv];
  if(host?.client?.config){prefix=undefined;token=undefined;}
  if(!prefix||!token){
   const c=await config(),servers=c.mcp?.servers||c.mcp||{};
   const name=Object.keys(servers).sort((a,b)=>b.length-a.length).find(n=>n.toLowerCase().includes('mindpond')&&input.tool.startsWith(n+'_'));
   if(!name)return;prefix=name+'_';if(servers[name]?.type==='local'||!servers[name]?.url)return;
   const authorization=servers[name]?.headers?.Authorization||servers[name]?.headers?.authorization;
   if(typeof authorization!=='string'||!authorization.startsWith('Bearer '))throw Error('MindPond requires a host-configured Bearer credential');
   token=authorization.slice(7).replace(/\{env:([^}]+)\}/g,(_m,name)=>process.env[name]||'');
  }
  if(!token)throw Error('MindPond host credential is missing; configure it outside chat');
  delete output.args.roleContext;
  output.args.hostContext=signHostSession(input.sessionID,input.tool.slice(prefix.length),output.args,token);
 }};
}
`;
}
