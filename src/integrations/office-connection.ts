/** One public configuration contract for the workbench and native CLI bundles.
 * Inputs contain secret variable names only; this module never reads credentials. */
import { createHash } from 'node:crypto';
import { OFFICE_WAIT_MS, OFFICE_TOOL_TIMEOUT_MS, OFFICE_TOOL_TIMEOUT_SECONDS, officeWaitCapacity } from '../core/office-wait-policy.js';

export const OFFICE_CAPABILITIES = {
  version: 'mindpond.office.v1',
  wait: { defaultMs: OFFICE_WAIT_MS, maxMs: OFFICE_WAIT_MS, toolTimeoutMs: OFFICE_TOOL_TIMEOUT_MS, wakesStoppedHost: false, capacity:officeWaitCapacity() },
  messages: { defaultPageSize: 10, maxPageSize: 20, defaultContextBytes: 16384, maxContextBytes: 65536 },
  correlation: 'Host session metadata or explicit public roleContext; shared credentials do not isolate untrusted chats.',
  memory: 'Office membership does not grant memory access. Personal/session/team grants are independent.'
} as const;

export function officeConnection(o: { host: string; id: string; url: string; tokenEnv?: string; sessionLabel?: string; name?: string }): {
  env: string; name: string; warnings: string[]; capabilities: typeof OFFICE_CAPABILITIES;
  place: string; text: string; docs: string | null; config?: Record<string, unknown>;
} {
  const url = new URL(o.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Use an HTTP MCP endpoint without credentials, query or fragment');
  const compact=(s:string)=>s.length<=90?s:s.slice(0,64)+'_'+createHash('sha256').update(s).digest('hex').slice(0,16);
  const env = o.tokenEnv ?? 'MINDPOND_' + compact(o.id.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()) + '_TOKEN';
  const name = o.name ?? 'mindpond_' + compact(o.id.replace(/[^A-Za-z0-9_]/g, '_'));
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(env) || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) throw new Error('Invalid public configuration identifier');
  if (o.sessionLabel && !/^[A-Za-z0-9_.:-]{1,128}$/.test(o.sessionLabel)) throw new Error('Invalid session label');
  const headers = o.sessionLabel ? { 'X-MindPond-Session': o.sessionLabel } : {};
  const warnings = [
    ...(url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? ['远程明文 HTTP 会暴露凭据，请改用 HTTPS。'] : []),
    ...(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? ['这是本机地址，其他机器需要可达的中心地址。'] : [])
  ];
  const base = { env, name, warnings, capabilities: OFFICE_CAPABILITIES };
  if (o.host === 'codex') return { ...base, place: 'Codex .codex/config.toml', docs: 'https://learn.chatgpt.com/docs/config-file/config-reference',
    text: `[mcp_servers.${name}]\nurl = ${JSON.stringify(o.url)}\nbearer_token_env_var = ${JSON.stringify(env)}\n${o.sessionLabel ? `http_headers = { "X-MindPond-Session" = ${JSON.stringify(o.sessionLabel)} }\n` : ''}tool_timeout_sec = ${OFFICE_TOOL_TIMEOUT_SECONDS}\n` };
  const config = o.host === 'opencode' ? { mcp: { [name]: { type: 'remote', url: o.url, oauth: false, headers: { Authorization: `Bearer {env:${env}}`, ...headers }, timeout: OFFICE_TOOL_TIMEOUT_MS } } }
    : { mcpServers: { [name]: { type: 'http', url: o.url, headers: { Authorization: 'Bearer ${' + env + '}', ...headers }, timeout: OFFICE_TOOL_TIMEOUT_MS } } };
  if (o.host === 'opencode' || o.host === 'claude') return { ...base, config,
    place: o.host === 'opencode' ? 'OpenCode opencode.json' : 'Claude Code .mcp.json', text: JSON.stringify(config, null, 2) + '\n',
    docs: o.host === 'opencode' ? 'https://opencode.ai/docs/mcp-servers/' : 'https://code.claude.com/docs/en/mcp',
    warnings: [...warnings, ...(o.host === 'opencode' ? ['OpenCode 不同版本对 timeout 的执行范围有差异；配置后请用实际长等待验证，工具发现成功不代表长调用已验证。'] : [])] };
  return { ...base, place: '宿主原生 HTTP MCP 设置（语法需按客户端验证）', docs: null,
    text: `Streamable HTTP MCP URL: ${o.url}\nAuthentication: Bearer supplied by host secret setting\nSecret reference: ${env}\nTool timeout: at least ${OFFICE_TOOL_TIMEOUT_SECONDS} seconds\n` };
}
