/** One public configuration contract for the workbench and native CLI bundles.
 * Inputs contain secret variable names only; this module never reads credentials. */
import { createHash } from 'node:crypto';
import {renderOpenCodeSessionPlugin} from './host-correlation.js';
import { OFFICE_WAIT_MS, OFFICE_TOOL_TIMEOUT_MS, OFFICE_TOOL_TIMEOUT_SECONDS, officeWaitCapacity } from '../core/office-wait-policy.js';

export const OFFICE_CAPABILITIES = {
  version: 'mindpond.office.v1',
  wait: { defaultMs: OFFICE_WAIT_MS, maxMs: OFFICE_WAIT_MS, toolTimeoutMs: OFFICE_TOOL_TIMEOUT_MS, wakesStoppedHost: false, capacity:officeWaitCapacity() },
  messages: { defaultPageSize: 10, maxPageSize: 20, defaultContextBytes: 16384, maxContextBytes: 65536 },
  discussions:{maxParticipants:8,maxRoomsPerOffice:16,temporary:true,oneActiveRoomPerRole:true},
  scripts:{rolePrivate:true,officeShared:true,maxBytes:131072,executesCode:false},
  correlation: 'Standard connection identity pairs Office/Memory with no host changes; shared configuration shares one role. Optional native chat identity supports separate roles per chat. Missing identity is an error, never a human fallback.',
  memory: 'Separate Memory MCP binds to this chat’s approved role. Humans see all knowledge; roles read their own knowledge, human-assigned independent copies and member-office knowledge. Office entries may be human-locked against role changes.'
} as const;

/** Both endpoints share a public prefix. Reject ambiguous paths instead of
 * exporting an apparently valid configuration for the wrong service. */
export function memoryMcpEndpoint(value:string) {
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||! /\/mcp\/?$/.test(url.pathname)||/\/memory\/mcp\/?$/.test(url.pathname))throw new Error('Office MCP address must end in /mcp and contain no credentials, query or fragment');
  url.pathname=url.pathname.replace(/\/mcp\/?$/,'/memory/mcp');return url.href;
}

export function officeConnection(o: { host: string; id: string; url: string; tokenEnv?: string; sessionLabel?: string; name?: string; identityMode?:'connection'|'native' }): {
  env: string; name: string;identityMode:'connection'|'native'; warnings: string[]; capabilities: typeof OFFICE_CAPABILITIES;
  place: string; text: string; docs: string | null; config?: Record<string, unknown>;files?:Record<string,string>;
} {
  const url = new URL(o.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Use an HTTP MCP endpoint without credentials, query or fragment');
  const compact=(s:string)=>s.length<=90?s:s.slice(0,64)+'_'+createHash('sha256').update(s).digest('hex').slice(0,16);
  const env = o.tokenEnv ?? 'MINDPOND_' + compact(o.id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()) + '_TOKEN';
  const name = o.name ?? 'mindpond_' + compact(o.id.replace(/[^A-Za-z0-9_]/g, '_'));
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(env) || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) throw new Error('Invalid public configuration identifier');
  if (o.sessionLabel && !/^[A-Za-z0-9_.:-]{1,128}$/.test(o.sessionLabel)) throw new Error('Invalid session label');
  const connectionScoped=o.identityMode==='connection';
  const headers:Record<string,string> = connectionScoped?{'X-MindPond-Identity':'connection'}:o.sessionLabel&&!['codex','opencode'].includes(o.host) ? { 'X-MindPond-Session': o.sessionLabel } : {};
  const warnings = [
    ...(url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? ['远程明文 HTTP 会暴露凭据，请改用 HTTPS。'] : []),
    ...(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? ['这是本机地址，其他机器需要可达的中心地址。'] : [])
  ];
  const memoryName=o.name==='mindpond_office'?'mindpond_memory':compact('mindpond_memory_'+o.id.replace(/[^A-Za-z0-9_]/g,'_'));
  const memoryUrl=memoryMcpEndpoint(o.url);
  warnings.push(connectionScoped?'通用连接身份：共享这份配置的聊天共享一个角色；需要不同角色时创建独立连接。无需插件，Office 和 Memory 身份一致。':'逐聊天身份：宿主必须提供可靠聊天标识；Codex 原生支持，OpenCode 可安装会话插件。不支持时选择通用连接身份。');
  const base = { env, name,identityMode:connectionScoped?'connection' as const:'native' as const, warnings, capabilities: OFFICE_CAPABILITIES };
  if (o.host === 'codex') return { ...base, place: 'Codex .codex/config.toml', docs: 'https://learn.chatgpt.com/docs/config-file/config-reference',
    text: [name,memoryName].map((entry,i)=>`[mcp_servers.${entry}]\nurl = ${JSON.stringify(i===0?o.url:memoryUrl)}\nbearer_token_env_var = ${JSON.stringify(env)}\ntool_timeout_sec = ${OFFICE_TOOL_TIMEOUT_SECONDS}\n${connectionScoped?'http_headers = { "X-MindPond-Identity" = "connection" }\n':''}`).join('\n') };
  const config = o.host === 'opencode' ? { mcp: { [name]: { type: 'remote', url: o.url, oauth: false, headers: { Authorization: `Bearer {env:${env}}`, ...headers }, timeout: OFFICE_TOOL_TIMEOUT_MS },[memoryName]:{type:'remote',url:memoryUrl,oauth:false,headers:{Authorization:`Bearer {env:${env}}`,...headers},timeout:OFFICE_TOOL_TIMEOUT_MS} } }
    : { mcpServers: { [name]: { type: 'http', url: o.url, headers: { Authorization: 'Bearer ${' + env + '}', ...headers }, timeout: OFFICE_TOOL_TIMEOUT_MS },[memoryName]:{type:'http',url:memoryUrl,headers:{Authorization:'Bearer ${'+env+'}',...headers},timeout:OFFICE_TOOL_TIMEOUT_MS} } };
  if (o.host === 'opencode' || o.host === 'claude') return { ...base, config,
    ...(o.host==='opencode'&&!connectionScoped?{files:{['.opencode/plugins/mindpond-session-'+o.id.replace(/[^A-Za-z0-9_-]/g,'_')+'.js']:renderOpenCodeSessionPlugin({tokenEnv:env,prefixes:[name+'_',memoryName+'_']})}}:{}),
    place: o.host === 'opencode' ? (connectionScoped?'OpenCode opencode.json':'OpenCode opencode.json（同时安装会话插件）') : 'Claude Code .mcp.json', text: JSON.stringify(config, null, 2) + '\n',
    docs: o.host === 'opencode' ? 'https://opencode.ai/docs/mcp-servers/' : 'https://code.claude.com/docs/en/mcp',
    warnings: [...warnings, ...(o.host === 'opencode' ? ['OpenCode 不同版本对 timeout 的执行范围有差异；配置后请用实际长等待验证，工具发现成功不代表长调用已验证。'] : [])] };
  return { ...base, place: '宿主原生 HTTP MCP 设置（语法需按客户端验证）', docs: null,
    text: `Office Streamable HTTP MCP URL: ${o.url}\nMemory Streamable HTTP MCP URL: ${memoryUrl}\nAuthentication: Bearer supplied by host secret setting\nSecret reference: ${env}\n${connectionScoped?'Header: X-MindPond-Identity: connection\n':''}Tool timeout: at least ${OFFICE_TOOL_TIMEOUT_SECONDS} seconds\n` };
}

/** One-time secret download for the role's actual current host. Server names
 * match the host template, including its installed OpenCode session plugin. */
export function roleConnectionDownload(o:{host:string;connectorId:string;roleId:string;url:string;token:string}){
  return credentialConnectionDownload({host:o.host,id:o.connectorId,url:o.url,token:o.token,tokenEnv:'MINDPOND_ROLE_TOKEN',filename:'mindpond-role-'+o.roleId.slice(0,8)+'-'+o.host});
}
/** Human-requested one-time download; never write the credential into source or logs. */
export function credentialConnectionDownload(o:{host:string;id:string;url:string;token:string;tokenEnv?:string;identityMode?:'connection'|'native';filename?:string}){
  const template=officeConnection(o);
  let text:string,extension:string,mime:string;
  if(o.host==='codex'){
    text=template.text.replace(/^http_headers = .*\n/gm,'').replaceAll('bearer_token_env_var = '+JSON.stringify(template.env),'http_headers = { Authorization = '+JSON.stringify('Bearer '+o.token)+(o.identityMode==='connection'?', "X-MindPond-Identity" = "connection"':'')+' }');
    extension='toml';mime='application/toml';
  }else if(template.config){
    const config=JSON.parse(JSON.stringify(template.config));
    for(const server of Object.values(config.mcp??config.mcpServers) as any[])server.headers.Authorization='Bearer '+o.token;
    text=JSON.stringify(config,null,2)+'\n';extension='json';mime='application/json';
  }else{
    text=template.text+'Credential: '+o.token+'\n';extension='txt';mime='text/plain';
  }
  return {text,mime,filename:(o.filename??'mindpond-'+o.id)+'.'+extension,host:o.host};
}
