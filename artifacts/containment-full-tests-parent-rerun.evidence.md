# EXP-001 Original Dexter full-test evidence

- Evidence ID: EXP-001-DEV-1875-parent-rerun-2026-09-26
- Producer: parent agent, independently replaying the Development agent's reported suite
- Repository: https://github.com/ClarusIubar/dexter
- Branch: exp/exp-001-original-agent-core
- Tested source commit: 102a446ce5caac3f3860e5d0cb7d3d012277ef57
- Base: origin/main at ecaed3011f24ea24ef687ab536aa7f22f7294038
- Environment: macOS Darwin, Bun 1.4.2, approved host execution
- Command: ./.exp001-tools/bun test
- Result: exit 0; 336 passed, 1 skipped, 0 failed; 553 assertions; 337 tests across 28 files
- Skip: Linux-only unsupported-host readiness test, skipped on macOS
- Restricted-sandbox diagnostic attempt: 329 passed, 1 skipped, 7 auth-readiness failures with codex_chatgpt_authentication_unavailable; not an acceptance run
- Restricted-attempt log: artifacts/containment-full-tests-restricted-attempt.log
- Restricted-attempt SHA-256: 1aa4181b9ed7f58a82b54443c44831d4c43634cfd68114cf2419e12c7ecea57a
- Raw output: artifacts/containment-full-tests-parent-rerun.log
- SHA-256: c99b3588d726ac877a77b0ea59d867d9bebe1fd3f8e83af82aecd6c07485da08
- Independent readback: source HEAD was 102a446ce5caac3f3860e5d0cb7d3d012277ef57 before replay; remote branch and main refs were read back at that same EXP commit and base.

## Scope and limits

The tests use fake Codex fixtures. No authenticated model request, paid API request, market request, prospective pilot, or efficacy measurement occurred. This verifies the deterministic source/test suite at the named commit, not live ModelPort compatibility, Linux containment, file isolation, or network isolation.

The Development agent separately reported a full-suite log with SHA-256 49cce960dc4029e1cb669e17383a64d687813d2fe48df13514c38652ea08296b. This parent replay has its own raw log and digest so the published evidence does not depend on that agent's local file.
