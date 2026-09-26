export type Exp001BridgeFailureReason =
  | 'deadline_exceeded'
  | 'readiness_failed'
  | 'invalid_result'
  | 'core_rpc_failed'
  | 'model_port_failed'
  | 'agent_failed';

const FAILURE_REASONS = new Set<Exp001BridgeFailureReason>([
  'deadline_exceeded', 'readiness_failed', 'invalid_result', 'core_rpc_failed', 'model_port_failed', 'agent_failed',
]);

export function classifyExp001BridgeFailure(message: string): Exp001BridgeFailureReason {
  const explicitPrefix = 'exp001_bridge_failure:';
  if (message.startsWith(explicitPrefix)) {
    const reason = message.slice(explicitPrefix.length) as Exp001BridgeFailureReason;
    if (FAILURE_REASONS.has(reason)) return reason;
  }
  if (message === 'deadline_exceeded' || message === 'original_agent_deadline_exceeded'
    || message.includes('deadline') || message.includes('timed out') || message.includes('cancelled')) {
    return 'deadline_exceeded';
  }
  if (message === 'model_port_readiness' || message.includes('authentication') || message.includes('binary')
    || message.includes('readiness') || message.includes('bun_unavailable')) return 'readiness_failed';
  if (message === 'model_port_integrity') return 'invalid_result';
  if (message === 'model_port_operational') return 'model_port_failed';
  if (message === 'wire_stdin_closed' || message.startsWith('core_') || message.includes('core_rpc')
    || message.includes('core_response')) return 'core_rpc_failed';
  if (message.startsWith('input_') || message.startsWith('wire_') || message === 'agent_tool_denied'
    || message.includes('core_result_not_consumed') || message.includes('final_response_invalid')
    || message.includes('preferences_') || message === 'agent_run_incomplete'
    || message === 'agent_policy_hash_mismatch') return 'invalid_result';
  if (message.startsWith('agent_')) return 'agent_failed';
  if (message.includes('process') || message.includes('spawn')) return 'agent_failed';
  if (message.includes('model')) return 'model_port_failed';
  return 'invalid_result';
}

export function classifyExp001BridgeToolFailure(
  eventType: 'tool_error' | 'tool_denied', toolName: string, error: unknown,
): Exp001BridgeFailureReason {
  if (eventType === 'tool_denied') return 'invalid_result';
  const message = typeof error === 'string' ? error : '';
  const reason = classifyExp001BridgeFailure(message);
  if (reason === 'deadline_exceeded' || reason === 'readiness_failed') return reason;
  if (toolName === 'dexter_core.evaluate') return 'core_rpc_failed';
  // Reading the frozen input and invoking Core are protocol operations, not model failures.
  return 'invalid_result';
}
