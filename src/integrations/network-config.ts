/** Server-owned grants. Only opaque per-account bearer tokens leave the server. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { normalizeDomain, type MemoryDomainRef } from '../core/domain.js';
import { parseMcpToolProfile, type McpToolProfile } from '../core/mcp-tool-profile.js';
export interface NetworkGrant {
  principal: string;
  tokenHash: string;
  domains: MemoryDomainRef[];
  toolProfile: McpToolProfile;
  agentId?: string;
  credentialId?: string;
  assignmentIds?: string[];
}
export interface NetworkConfiguration {
  version: 1 | 2;
  grants: NetworkGrant[];
}
export const tokenDigest = (token: string) => createHash('sha256').update(token).digest('hex');
export async function readNetworkConfiguration(file: string): Promise<NetworkConfiguration> {
  const stat = await fs.stat(file);
  if (stat.size > 131072 || !stat.isFile())
    throw new Error('Network configuration must be a small regular file');
  if (process.platform !== 'win32' && stat.mode & 0o077)
    throw new Error('Network configuration must be private (chmod 600)');
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  if (![1, 2].includes(raw.version) || !Array.isArray(raw.grants) || raw.grants.length > 128)
    throw new Error('Invalid network configuration');
  const principals = new Set<string>(),
    hashes = new Set<string>(),
    credentials = new Set<string>(),
    owners = new Map<string, string>();
  const grants = raw.grants.map((value: NetworkGrant) => {
    if (
      !value ||
      typeof value.principal !== 'string' ||
      !value.principal.trim() ||
      value.principal.length > 128 ||
      (raw.version === 1 && principals.has(value.principal))
    )
      throw new Error('Invalid or duplicate principal');
    if (
      typeof value.tokenHash !== 'string' ||
      !/^\w{64}$/.test(value.tokenHash) ||
      !/^[0-9a-f]+$/.test(value.tokenHash) ||
      hashes.has(value.tokenHash)
    )
      throw new Error('Invalid or duplicate token hash');
    if (!Array.isArray(value.domains) || !value.domains.length || value.domains.length > 32)
      throw new Error('Every account needs explicit domains');
    const domains = value.domains.map((d) => normalizeDomain(d));
    if (domains.some((d) => d.kind === 'session'))
      throw new Error('Session identities are assigned by the server, not account grants');
    if (raw.version === 2) {
      if (
        !value.agentId ||
        !value.credentialId ||
        ![value.agentId, value.credentialId].every((v) => /^[A-Za-z0-9_.:-]{1,128}$/.test(v)) ||
        credentials.has(value.credentialId)
      )
        throw new Error('Invalid agent credential binding');
      if (
        value.assignmentIds !== undefined &&
        (!Array.isArray(value.assignmentIds) ||
          !value.assignmentIds.length ||
          value.assignmentIds.some(
            (id) => typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)
          ))
      )
        throw new Error('Invalid assignment restriction');
      if (owners.has(value.agentId) && owners.get(value.agentId) !== value.principal)
        throw new Error('Agent cannot belong to multiple accounts');
      owners.set(value.agentId, value.principal);
      credentials.add(value.credentialId);
    }
    principals.add(value.principal);
    hashes.add(value.tokenHash);
    return {
      principal: value.principal,
      tokenHash: value.tokenHash,
      domains,
      toolProfile: parseMcpToolProfile(value.toolProfile ?? 'work'),
      ...(raw.version === 2
        ? {
            agentId: value.agentId,
            credentialId: value.credentialId,
            ...(value.assignmentIds ? { assignmentIds: value.assignmentIds } : {})
          }
        : {})
    };
  });
  return { version: raw.version, grants };
}
export function authenticateNetworkAccount(
  config: NetworkConfiguration,
  header: unknown
): NetworkGrant | undefined {
  if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) return;
  const hash = Buffer.from(tokenDigest(header.slice(7)), 'hex');
  return config.grants.find((grant) => timingSafeEqual(hash, Buffer.from(grant.tokenHash, 'hex')));
}
/** Offline admin operation; lock avoids losing another administrator's update. */
export async function issueNetworkGrant(options: {
  configFile: string;
  tokenFile: string;
  principal: string;
  personalId?: string;
  rotate?: boolean;
  toolProfile?: McpToolProfile;
  agentId?: string;
  assignmentIds?: string[];
}) {
  const configFile = path.resolve(options.configFile),
    tokenFile = path.resolve(options.tokenFile);
  if (options.agentId && !/^[A-Za-z0-9_.:-]{1,128}$/.test(options.agentId))
    throw new Error('Invalid agentId');
  if (
    options.assignmentIds &&
    (!options.assignmentIds.length ||
      options.assignmentIds.length > 50 ||
      options.assignmentIds.some((id) => !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)))
  )
    throw new Error('Invalid assignment restrictions');
  if (options.toolProfile !== undefined) parseMcpToolProfile(options.toolProfile);
  if (configFile === tokenFile) throw new Error('Token file must differ from server configuration');
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,127}$/u.test(options.principal))
    throw new Error('Invalid principal');
  await fs.mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  const lock = await fs.open(configFile + '.lock', 'wx', 0o600);
  let wroteToken = false;
  try {
    let config: NetworkConfiguration;
    try {
      config = await readNetworkConfiguration(configFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      config = { version: 1, grants: [] };
    }
    if (options.agentId && config.version === 1) {
      config = {
        version: 2,
        grants: config.grants.map((g) => ({
          ...g,
          agentId: 'legacy:' + tokenDigest(g.principal).slice(0, 24),
          credentialId: 'legacy:' + tokenDigest(g.principal).slice(0, 24)
        }))
      };
    }
    if (
      options.agentId &&
      config.grants.some((g) => g.agentId === options.agentId && g.principal !== options.principal)
    )
      throw new Error('Agent belongs to another account');
    const previous = config.grants.find(
      (g) =>
        g.principal === options.principal && (!options.agentId || g.agentId === options.agentId)
    );
    if (config.version === 2 && !options.agentId)
      throw new Error('Version 2 grants require --agent');
    if (previous && !options.rotate)
      throw new Error('Account exists; use --rotate and a new token file');
    if (!previous && config.grants.length >= 128) throw new Error('Account limit reached');
    const domains =
      options.personalId !== undefined
        ? [normalizeDomain({ kind: 'personal', id: options.personalId })]
        : (previous?.domains ?? [{ kind: 'personal' as const, id: 'default' }]);
    const token = randomBytes(32).toString('base64url');
    await fs.writeFile(tokenFile, token + '\n', { flag: 'wx', mode: 0o600 });
    wroteToken = true;
    const grant: NetworkGrant = {
      principal: options.principal,
      tokenHash: tokenDigest(token),
      domains,
      toolProfile: parseMcpToolProfile(options.toolProfile ?? previous?.toolProfile ?? 'work'),
      ...(options.agentId
        ? {
            agentId: options.agentId,
            credentialId: options.agentId,
            ...(options.assignmentIds ? { assignmentIds: options.assignmentIds } : {})
          }
        : {})
    };
    config.grants = [
      ...config.grants.filter((g) =>
        options.agentId ? g.agentId !== options.agentId : g.principal !== grant.principal
      ),
      grant
    ];
    const temporary = configFile + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify(config, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600
      });
      await fs.rename(temporary, configFile);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return {
      principal: grant.principal,
      agentId: grant.agentId,
      domains: grant.domains,
      configFile,
      tokenFile,
      rotated: !!previous
    };
  } catch (error) {
    if (wroteToken) await fs.rm(tokenFile, { force: true });
    throw error;
  } finally {
    await lock.close();
    await fs.unlink(configFile + '.lock');
  }
}
