/** A01: single source for protocol rule discovery — version, sections and
 * budgets are generated from the same constants the runtime enforces, never
 * retyped into docs. Progressive discovery contract:
 *   first call          → version, defaults and the full short-rule sections
 *   later calls         → sinceVersion (upToDate) and/or cacheDigests
 *                         {sectionId: digest} → only the changed delta
 *   lost cache          → omit everything and take the full payload again
 *   old client          → an incompatible major version is rejected explicitly;
 *                         old rules are never silently served.
 * The docs/protocol-rules.json export and its --check keep generated files
 * drift-free (scripts/export-host-prompts.ts). */
import { createHash } from 'node:crypto';
import { HOST_POLICY, capabilities } from './host-contract.js';
import { MindPondError } from './errors.js';

/** Semver of the host protocol. A major bump marks incompatible rule changes:
 * clients must reject or negotiate a downgrade, never apply stale rules. */
export const PROTOCOL_VERSION = '1.7.0';

export interface ProtocolSection { id: string; title: string; rules: number[]; digest: string; text: string }

/** Stable section identities over the numbered HOST_POLICY short rules —
 * section ids and rule grouping are part of the cache contract. */
const SECTION_RULES: ReadonlyArray<{ id: string; title: string; rules: number[] }> = [
  { id: 'dimensions-anchors', title: 'Dimensions, anchors and entrances', rules: [0] },
  { id: 'domain-read', title: 'Scoped reads and domains', rules: [1] },
  { id: 'capture-save', title: 'Capture, save and team publication', rules: [2, 3] },
  { id: 'checkpoints', title: 'Checkpoints', rules: [4] },
  { id: 'organization', title: 'Organization work', rules: [5, 6] },
  { id: 'code-recipes', title: 'Code understanding', rules: [7] },
  { id: 'sources', title: 'Source observations', rules: [8] },
  { id: 'work-state', title: 'Work state', rules: [9] },
  { id: 'feedback', title: 'Recall feedback', rules: [10] },
  { id: 'safety', title: 'Honesty and safety', rules: [11] },
];

function splitNumberedRules(): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of HOST_POLICY.split('\n')) {
    const m = line.match(/^(\d+)\.\s+(.*)$/);
    if (m) map.set(Number(m[1]), m[2]);
  }
  return map;
}

export function protocolSections(): ProtocolSection[] {
  const rules = splitNumberedRules();
  return SECTION_RULES.map(({ id, title, rules: ns }) => {
    const text = ns.map(n => `${n}. ${rules.get(n) ?? ''}`).join('\n');
    return { id, title, rules: ns, digest: createHash('sha1').update(text).digest('hex').slice(0, 12), text };
  });
}

export function protocolRulesPayload() {
  const caps = capabilities();
  return {
    version: PROTOCOL_VERSION,
    capabilitiesVersion: caps.version,
    defaults: caps.defaults,
    sections: protocolSections(),
    full: HOST_POLICY,
  };
}

export interface ProtocolRulesArgs {
  /** Protocol version the CALLING client implements; an incompatible major
   * version is rejected explicitly instead of served old rules. */
  clientVersion?: string;
  /** Return upToDate instead of the full payload when unchanged. */
  sinceVersion?: string;
  /** Section digests the client already cached → response carries only deltas. */
  cacheDigests?: Record<string, string>;
}

export function protocolRulesResponse(args: ProtocolRulesArgs = {}) {
  if (args.clientVersion !== undefined) {
    const clientMajor = args.clientVersion.split('.', 1)[0];
    const serviceMajor = PROTOCOL_VERSION.split('.', 1)[0];
    if (clientMajor !== serviceMajor)
      throw new MindPondError('invalid_input',
        `client protocol v${clientMajor} is incompatible with service protocol v${PROTOCOL_VERSION}`,
        { retryable: false, nextAction: '旧客户端必须明确拒绝本次会话或协商降级，不能默默套用旧规则；升级到当前主版本后重新获取全量规则（省略全部参数）' });
  }
  const payload = protocolRulesPayload();
  if (args.cacheDigests) {
    const changed = payload.sections.filter(s => args.cacheDigests![s.id] !== s.digest);
    return {
      version: payload.version,
      upToDate: changed.length === 0,
      ...(changed.length ? { sections: changed.map(({ id, title, rules, digest, text }) => ({ id, title, rules, digest, text })) } : {}),
    };
  }
  if (args.sinceVersion === PROTOCOL_VERSION) return { version: payload.version, upToDate: true as const };
  return payload;
}
