# EXP-001 current-native readiness evidence — 2026-10-01

Source: Original Dexter `102a446ce5caac3f3860e5d0cb7d3d012277ef57`; evidence parent `c60c9f5c278f85bedd97c164a66c85a6573f46f3`.
Native binary: Codex CLI 0.159.2, SHA-256 `50ac633af64851511f9bbc71032cdae7f1ba20b3234c189687d61ba846c354c5`.

## Execution and observer

The parent agent executed the preflight and all three synthetic diagnostics on macOS through approved host execution. The ModelPort retained its safe environment, binary digest verification, ChatGPT authentication check, `sandbox-exec` deny-process-fork wrapper, ignored user config, ephemeral request directory, disabled native tools and existing strict parser. No production source was edited. Invocation from this Original EXP checkout:

```
./.exp001-tools/bun artifacts/quality/exp001-readiness-2026-10-01/modelport-compatibility.ts
```

The final harness contains bounded structural capture delegated to the unmodified production accumulator. Initial and structural-only attempt outputs are preserved separately; the harness changed between attempts to capture diagnostics and is not claimed to reproduce the earlier capture format. All three attempts failed and no usage was observed. These are readiness diagnostics, not registered treatment retries or pilot trials.

## Files and findings

- `preflight.json`: contained version, existing ChatGPT auth route and required exec options passed. No raw authentication output was retained. The failed features-list diagnostic used an exec-only option; it is invalid diagnostic usage, not proof of exec feature incompatibility.
- `modelport-compatibility-initial.json`: attempt 1, integrity error after 628 ms.
- `modelport-compatibility-structural.json`: attempt 2, first preturn error item captured after 545 ms. Its `malformed` metadata describes the logging wrapper receiving a joined tail, not proof that the CLI emitted malformed JSON.
- `modelport-compatibility.json`: attempt 3, individual tail lines captured; 633 ms. Sequence: thread.started, preturn item.completed/error (unstable skip_host_skill_discovery warning), preturn item.completed/error (Code Mode unavailable, host disabled), turn.started. The production parser rejected the first preturn item and killed the child.
- `modelport-compatibility.ts`: final diagnostic harness; synthetic input without market data or tools; timeout 60 seconds.
- `sha256.json`: content digests of the four reports/harness before README/manifest creation.

## Responsibility and limits

Parent executed and persisted evidence. Development read accumulator/modelport code and recommends per-invocation warning suppression plus narrow diagnostic classification; the Code Mode diagnostic remains a readiness blocker until its effect is verified. Architecture reviewed unchanged source/schema/arm identities: the macOS pilot does not require Linux support, but needs current ModelPort and outcome-source readiness plus a fresh future five-session registration. Red-team review must not be described as independent model execution.

Observed failure is CLI preturn diagnostics incompatible with the strict parser. It is not evidence of a native tool attempt, model response, complete usage/cost, market outcome or treatment efficacy. Model request/charging status cannot be inferred from unavailable usage. No paid fallback, Chrome, pilot registration, market trial or main merge occurred. Historical full-suite results do not certify this new native binary. Pilot remains blocked at #1872/#1877; parent #1871 remains open.
