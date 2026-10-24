/** Content revisions avoid repeating large, unchanged human-page projections.
 * Stateless: no TTL, process cache, persisted browser data or invalidation list.
 * Always authorize and build the current projection before comparing revisions. */
import {digest} from './growth.js';

export function conditionalProjection<T extends object>(current:T, knownRevision?:string){
    const revision=digest(current);
    return {revision,value:knownRevision===revision?{unchanged:true as const}:current};
}
