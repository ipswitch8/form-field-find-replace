# Phase-1 Claim Check — whitespace-bug

| # | Claim | Source | Mechanism | Verified how |
|---|-------|--------|-----------|---------------|
| 1 | NBSP substitution produces codepoints [0x00A0,0x20,0x00A0] | test/whitespace-matching.spec.js:81-84 | precondition assertion in test 1 | RAN LIVE — passed |
| 2 | Repro tests type via real key events (not pasted text) | test/whitespace-matching.spec.js (test 1 canary) + :113 (hand-authored-HTML control) | codepoint precondition guard (canary) / inverse control at :113 | RAN LIVE — both passed |
| 3 | Only U+0020 is treated as matchable whitespace; NBSP/other space variants are excluded | test/whitespace-matching.spec.js:138-174 (5 per-codepoint tests, String.fromCodePoint + codePointAt fixture guards) | 5 named per-codepoint tests | RAN LIVE — U+0020 passes, U+00A0 correctly fails pre-fix, all 3 exclusions pass |
| 4 | Regex mode matches whitespace correctly | test/whitespace-matching.spec.js:119 | regex-mode pin test | RAN LIVE — passes against unmodified code |
| 5 | Replace should collapse to plain spaces, not retain NBSP | test/whitespace-matching.spec.js:178 | codepoint assertion ([0x20,0x20,0x20], not.toContain(0x00A0)) | RAN LIVE — currently red, shows [160,32,160] (expected: phase-1 does not fix code, only adds repro) |
| 6 | Pre-existing behaviour is unaffected by this phase | full suite minus new spec, via --grep-invert | 75 pre-existing tests | RAN LIVE — 75 pass, 0 fail, 0 error (test-results/gtest-results.xml) |
| 7 | New spec demonstrates the bug (some pass, some fail as expected) | test/whitespace-matching.spec.js (full file) | test run count | RAN LIVE — exactly 4 failed / 6 passed |
| 8 | No literal pasted whitespace characters (NBSP etc.) hide in spec/README source, masking the bug | test/whitespace-matching.spec.js, README | grep for literal U+00A0 and other whitespace-variant bytes | RAN LIVE — grep found zero occurrences |
| — | content/find-replace.js has zero diff this phase (scope: repro only, no fix) | git diff content/find-replace.js | git diff | RAN LIVE — empty diff confirmed |
| — | No README/comment claim contradicts a grep or test | CLAUDE.md, README | cross-check via grep/test | RAN LIVE — no contradiction found |

## Observation (not a finding)
The whole-word test at test/whitespace-matching.spec.js:92 has no independent codepoint
precondition guard of its own; it relies transitively on test 1's guard passing in the
same run. This is noted for the record but is not classified as an unmechanised
load-bearing claim, since test 1's guard runs first in the same suite and would fail
the build before test 92's result could be misread.

## Verdict
All 8 claims plus the two supplementary checks are MECHANISED, verified live (not by
inspection). No UNMECHANISED / LOAD-BEARING claims found. content/find-replace.js is
unchanged, consistent with phase-1 scope (reproduction only, no fix).

VERDICT: PASS
