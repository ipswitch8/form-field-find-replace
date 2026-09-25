# Claim table — phase-2 (undo-bug), re-judged after remediation

| # | Claim | Source | Mechanism | Verified how |
|---|---|---|---|---|
| 1 | Defect A (undo reported success with restored:0) is fixed: popup no longer prints "Undo complete." when nothing was restored | popup/popup.js handleUndo (~570-590) | test/popup-undo-desync.spec.js:128-165, 2 tests | RAN: playwright test — pass (part of 75 passed) |
| 2 | Defect B (hasUndoableChange resets on popup reopen, disabling Undo despite a valid snapshot) is fixed: init() consults ensureContentScriptInjected's ping response instead of a locally-remembered boolean | popup/popup.js:733-745 | test/popup-undo-desync.spec.js:169-186 | RAN: playwright test — pass |
| 3 | Negative control: a lazy "always enable Undo on mount" fix would be rejected | test/popup-undo-desync.spec.js:265-273 | Same test file | RAN: passes against current (correct) code; verified by phase-1 inspection that it is a real negative control (source was off-limits phase-1) |
| 4 | ensureContentScriptInjected's ping response is documented as the single source of truth for undo availability, and init() uses the RETURN VALUE rather than any locally-held boolean | popup/popup.js:384-397 (corrected comment) | popup/popup.js:745 `hasUndoableChange = Boolean(pingResponse && pingResponse.undoAvailable)` — reads the actual return value, not a stale module boolean | RAN + INSPECTED: grep confirms line 745 reads `pingResponse`, not a cached flag; test #2 above (169-186, "Undo is available after the popup is reopened while a snapshot still exists") exercises exactly this path via a real popup reopen (page remount) and passes |
| 5 | The old comment's claim that popup's own module state "persists independently" was false and has been removed | popup/popup.js:379-397 diff | Same as #4 — the corrected text explicitly states the opposite (module state does NOT persist; content script's snapshot is the sole source of truth) | INSPECTED: `git diff -- popup/popup.js` confirms the false sentence was deleted, not merely appended-to |
| 6 | No source-file modification restriction from phase-1 no longer applies to phase-2 (which is expected to touch popup/content) | pipeline.json phase-2 acceptance criteria | N/A — this is a phase-scoping statement, not a runtime claim | INSPECTED: phase-2 explicitly permits popup/content changes; not a claim about behaviour |
| 7 | Adding the new test file(s) caused no regression to the pre-existing suite | test-results/gtest-results.xml | Full suite: `npx playwright test` | RAN: 75 passed, 0 failed. XML header `tests="75" failures="0"` confirmed |
| 8 (NEW, this round) | content/find-replace.js's `count` response fields `undoAvailable`/`undoCount` are a real, consumed capability: they resync the popup's Undo button when the popup has been sitting open across a tab navigation that destroyed the content script's snapshot | content/find-replace.js:1390-1391, 1403-1404, 1425-1426 (count handler); popup/popup.js:512-523 (consumer + comment) | popup.js handleCount reads `response.undoAvailable` and calls `updateButtonStates()`; test/popup-undo-desync.spec.js:201-232 ("...OFF when the snapshot has since been lost") and :234-263 ("...ON when a snapshot exists the popup did not know about") | RAN TWICE: (a) agent's own claimed mutation (removal of the 3-line wiring block) reported 2 failed/4 passed in that file; (b) gate independently reproduced the mutation via `perl -0777` CRLF-safe substitution, ran full suite — exactly the 2 named tests failed (73 passed/2 failed), all other 73 tests (including the other 2 tests in the same spec file) passed. Wiring restored from backup; `git diff --stat -- popup/popup.js` shows 71+/13- matching the pre-mutation diff; no `MUTATION-TEST-REMOVED` marker remains; full suite re-run afterward: 75 passed, 0 failed |
| 9 (NEW) | The `count` handler's error branch (bad regex / `buildMatcher` failure, content/find-replace.js:1403-1404) also attaches `undoAvailable`/`undoCount` | content/find-replace.js:1403-1404 | None — `popup.js handleCount` returns early on `response.error` truthy (line 507-510), *before* reaching the resync block at line 520. This branch's fields are never read by any consumer. | INSPECTED (not run): grep confirms no other caller reads `count`'s error-path `undoAvailable`. Classified UNMECHANISED/COSMETIC, not load-bearing — the field is structurally present for response-shape symmetry across the three `count` return sites, but nobody documents or acts on "undoAvailable is present on error responses" as a feature. It does not configure or promise new behaviour; a reader could not act on it wrongly because the popup discards the whole response object in the error case. |

## Mutation-test verification (independent of the implementer's own run)

Performed by this gate agent, not accepted on the implementer's word alone:
1. Backed up `popup/popup.js`.
2. Removed the 3-line resync block at popup.js:520-523 (`MUTATION-TEST-REMOVED` marker).
3. `npx playwright test` → 2 failed (exactly the two claimed tests), 73 passed.
4. Restored from backup.
5. Confirmed no marker remains, line 520 wiring present, `git diff --stat -- popup/popup.js` = 71 insertions(+) / 13 deletions(-) (matches pre-mutation state — only the intended phase-2 changes remain).
6. Re-ran full suite: 75 passed, 0 failed.

## No other knob-wired-to-nothing found this round

Searched all `undoAvailable`/`undoCount` occurrences across popup/, content/, test/.
Every occurrence outside claim #9 above traces to a consumer that is itself
covered by a passing (and, for the two new resync tests, mutation-verified)
test. Claim #9 is the one genuinely-decorative field this round, and it is
COSMETIC (never surfaced to a human, never actable) rather than LOAD-BEARING.

## Verdict

Claims 1-8: MECHANISED (2, 3, 7 re-confirmed by re-run; 4 and 8 newly
mechanised and independently mutation-verified this round).
Claim 9: UNMECHANISED / COSMETIC — reported, not a blocking finding.

No UNMECHANISED/LOAD-BEARING claims found. PASS.
