import type {OrganizationJob} from './graph-memory.js';
/** Lossless prompt packing. The authoritative immutable snapshot stays intact.
 * Shared endpoints are emitted once; no content or association basis is sliced. */
export function organizationMaterial(job:OrganizationJob) {
  const memories:Record<string,unknown>={};
  const members=job.members.map(({memory,...member})=>{
    const {embedding,...body}=memory;
    const id=memory.id ?? member.membership.memoryId ?? `issued:${member.membership.id}`;
    memories[id]=body;
    return {...member,memoryId:id};
  });
  const associations=(job.associations??[]).map(({memoryA,memoryB,...edge})=>{
    for(const endpoint of [memoryA,memoryB])if(endpoint && !memories[endpoint.id])memories[endpoint.id]=endpoint;
    return {...edge,memoryAId:memoryA?.id,memoryBId:memoryB?.id};
  });
  // User policy is injected separately as trusted configuration, never duplicated
  // in untrusted source material or charged to its lossless packing budget.
  const {dimensionPolicy:_dimensionPolicy,...snapshot}=job;
  return {...snapshot,members,associations,memories,
    materialContract:'members[].memoryId and associations[].memoryAId/memoryBId refer to complete memories in the dictionary. Only issued members may be operation inputs.'};
}
