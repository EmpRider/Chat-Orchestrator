// Shared allowlist for authorized Desktop -> utilityProcess IPC commands.
// Both ends MUST consult the same list.
export const DESKTOP_EXTENSION_ACTIONS=Object.freeze([
  'set_orchestrator','diagnose','close_legacy_workers','close_managed_browser',
  'verify_managed_browser','update_readiness','inspect_root_repair',
  'confirm_root_repair','list_agent_closures','resolve_agent_closure',
  'list_completion_monitors','set_manual_completion','recover_queue_batch',
  'focus_queue_manager',
]);
export const isSupportedDesktopExtensionAction=(action)=>
  DESKTOP_EXTENSION_ACTIONS.includes(action);
