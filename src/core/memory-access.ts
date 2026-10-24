/** Request-local memory authority. Identity is resolved by the transport; this
 * object carries its narrowing grants through every consumer of role knowledge.
 * Never cache memberships: moving a role or revoking a seat takes effect now. */
import type {GraphMemory} from './graph-memory.js';
import type {MemoryOwner} from './memory-owners.js';
import type {TrustedCallContext} from './trust.js';

export type MemoryActor = Extract<MemoryOwner,{kind:'user'|'agent'}>;
export type MemoryAuthority = Pick<TrustedCallContext,'assignmentIds'>;

export function memoryAccess(graph:GraphMemory, actor:MemoryActor, authority:MemoryAuthority|undefined) {
    const owner=Object.freeze({...actor});
    // Copy the authenticated grant so callers cannot widen it during a request.
    const assignments=authority?.assignmentIds?.slice();
    return Object.freeze({
        owner,
        offices:()=>graph.memoryOwners.offices(owner.kind==='agent'?owner.id:undefined,assignments),
        context:(officeId?:string)=>graph.memoryOwners.context(owner,officeId,assignments),
        assertWritable:(target:MemoryOwner,memoryId?:string)=>graph.memoryOwners.assertWritable(owner,target,memoryId,assignments)
    });
}
