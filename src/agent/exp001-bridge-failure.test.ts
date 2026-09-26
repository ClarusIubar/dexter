import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyExp001BridgeFailure, classifyExp001BridgeToolFailure } from './exp001-bridge-failure.ts';

test('Core RPC, input and wire integrity failures cannot be classified as operational agent failures', () => {
  for (const message of [
    'core_response_identity_invalid', 'core_tool_request_invalid', 'wire_stdin_closed',
    'wire_start_invalid', 'input_contract_invalid', 'input_candidate_invalid',
  ]) {
    assert.notEqual(classifyExp001BridgeFailure(message), 'agent_failed', message);
  }
  assert.equal(classifyExp001BridgeFailure('core_response_identity_invalid'), 'core_rpc_failed');
  assert.equal(classifyExp001BridgeFailure('wire_stdin_closed'), 'core_rpc_failed');
  assert.equal(classifyExp001BridgeFailure('input_contract_invalid'), 'invalid_result');
  assert.equal(classifyExp001BridgeFailure('wire_start_invalid'), 'invalid_result');
});

test('protocol tool errors preserve integrity classes instead of becoming cash-eligible Agent errors', () => {
  assert.equal(classifyExp001BridgeToolFailure('tool_error', 'dexter_core.evaluate', 'core_response_contract_invalid'), 'core_rpc_failed');
  assert.equal(classifyExp001BridgeToolFailure('tool_error', 'dexter_core.evaluate', 'wire_stdin_closed'), 'core_rpc_failed');
  assert.equal(classifyExp001BridgeToolFailure('tool_error', 'exp001.read_trial_input', 'input_contract_invalid'), 'invalid_result');
  assert.equal(classifyExp001BridgeToolFailure('tool_error', 'dexter_core.evaluate', 'request temporarily unavailable'), 'core_rpc_failed');
  assert.equal(classifyExp001BridgeToolFailure('tool_error', 'exp001.read_trial_input', 'file read failed'), 'invalid_result');
  assert.equal(classifyExp001BridgeToolFailure('tool_denied', 'dexter_core.evaluate', 'tool_not_allowed'), 'invalid_result');
});

test('explicit tool-event classification survives the bridge wire failure conversion', () => {
  const reasons = ['core_rpc_failed', 'invalid_result', 'agent_failed'] as const;
  for (const reason of reasons) {
    assert.equal(classifyExp001BridgeFailure(`exp001_bridge_failure:${reason}`), reason);
  }
});
