/** Static MCP catalogs: clients need no tools/list refresh support. HTTP stays complete. */
export type McpToolProfile = 'work' | 'full';
export function parseMcpToolProfile(value: string | undefined): McpToolProfile {
  const profile = value ?? 'full';
  if (profile !== 'work' && profile !== 'full') throw new Error('MINDPOND_TOOL_PROFILE must be work or full');
  return profile;
}
const WORK_TOOLS = new Set([
  'memory_export', 'memory_finish', 'memory_directory', 'memory_history', 'memory_event_search',
  'memory_brief', 'memory_search', 'memory_get', 'memory_expand', 'memory_connections', 'memory_spaces',
  'memory_protocol_rules', 'memory_capabilities', 'memory_dimension_policy', 'memory_retrieval_status',
  'memory_retrieval_profiles','memory_retrieval_devices',
  'memory_save_policy', 'memory_save_validate', 'memory_save', 'memory_update',
  'memory_use_report', 'memory_improvement_list', 'memory_improvement_resolve',
  'memory_source_get', 'memory_source_observe', 'memory_profile_get', 'memory_trace',
  'memory_association_upsert', 'memory_association_review', 'memory_session_state',
  'memory_checkpoint', 'memory_lifecycle_policy', 'memory_lifecycle_prepare',
  'memory_extraction_job', 'memory_extraction_commit',
  'memory_organization_policy', 'memory_organization_claim', 'memory_organization_validate',
  'memory_organization_commit', 'memory_organization_renew', 'memory_organization_release',
  'work_context_create', 'work_context_list', 'work_task_create', 'work_task_list',
  'work_task_claim', 'work_task_renew', 'work_task_transition',
]);
export function exposesMcpTool(profile: McpToolProfile, name: string): boolean {
  return profile === 'full' || WORK_TOOLS.has(name);
}
