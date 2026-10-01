# EXP-001 current-native infrastructure repair, 2026-10-01

The native CLI emits a disabled-Code-Mode capability notice before turn.started. Direct bounded diagnostic observation with the unchanged disabled-tool policy completed successfully; the notice is not fatal to this textual ModelPort path. Production now suppresses the separate unstable-feature warning per invocation and accepts only the exact observed disabled-capability notice once, after thread.started and before turn.started, with exact keys and a bounded ID. Unknown/invalid/native events stay fail-closed. The warning is preserved as code_mode_disabled metadata; no user config, host feature, native tool or paid provider was enabled.

ModelPort now drains later lines after a failure, preserving stronger integrity failures, and treats output truncation/limit as integrity. Regression tests cover malformed, duplicate, misplaced and unknown diagnostics, native actions, failed startup followed by malformed/native tails, and the output-limit crossing chunk.

## Evidence tiers

- features.txt/help.json: contained CLI offline inspection. feature-overrides.txt confirms only the three code-mode features are false, not every native-tool feature.
- native-probe.ts/json: diagnostic-only observation, not production acceptance; actual usage11045 input/52 output.
- production-modelport.ts/json: unmodified production ModelPort invocation after the patch. Exact synthetic final response, observed usage11065/49, native digest unchanged. No prototype accept-wrapper is used.
- tested-source-diff.json: exact tracked source/test diff at execution, encoded as JSON to preserve raw whitespace and byte digest. Base8355984, diff SHA256 b16cf7237eb227d6b1e80064290ad88401c419f8b29a5f85e383099a81873aac. This is paired with the content source identity in the Garden actual A/AB artifact set; do not relabel its measured base as the subsequent commit.
- development-full-tests.log/evidence.json: directly executed approved-host354 pass/1 Linux-only skip/0 fail. Fake CLI tests; not model execution.
- development-focused-tests.log and development-typecheck.log: directly executed source-quality evidence. This layer defines no lint/coverage scripts.
- role-review.json: parent execution, Development source/test execution and Architecture/Red-team independent saved-artifact checks separated. The Red-team focused20-test stdout exists in the thread but has no archived raw log; it must not be called a durable raw test artifact.

Garden readiness artifacts preserve the same30-candidate fixture, input/B, A and AB starts/results/decisions, typed RPC and report. The parent actually ran A2model calls and AB2model calls. A Core0; AB Core exactly1, completed and hash-linked into the second model input/final result. Usage is observed for all4calls. Each arm selects25 after a complete30-candidate ranking. Garden validators re-read saved wire/decision files; Architecture and Red-team independently inspect/replay without calling models.

These are readiness diagnostics, not future pilot trials or causal observations. Source acquisition, full503-symbol scale, contemporaneous entry/exit settlement and registration/durable-runner gates remain distinct. All previously failed readiness attempts and unavailable usage are retained. Main merge remains subject to later user approval.
