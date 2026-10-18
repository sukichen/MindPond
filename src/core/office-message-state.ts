/** Mailbox lifecycle is independent of display/read receipts and task leases. */
export function messageState(state: string): 'pending'|'processing'|'archived' {
  return ['resolved','accepted','archived'].includes(state) ? 'archived' : state==='processing' ? 'processing' : 'pending';
}
export const messageStateSql = (alias = 's') => `CASE WHEN ${alias}.state IN ('resolved','accepted','archived') THEN 'archived' WHEN ${alias}.state='processing' THEN 'processing' ELSE 'pending' END`;
