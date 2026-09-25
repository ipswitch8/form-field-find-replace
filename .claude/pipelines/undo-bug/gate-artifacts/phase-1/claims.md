# Claim table — phase-1 (undo-bug)

| # | Claim | Source | Mechanism | Verified how |
|---|---|---|---|---|
| 1 | Content script's replace/undo algorithm is correct; bug is not there | test/popup-undo-desync.spec.js:8-13 (comment) | test/repro-sequence.spec.js — 4 tests, content-script-direct via window.__ffr | RAN: playwright test with grep-invert "popup undo desync" gives 69 passed incl. all 4 repro-sequence tests |
| 2 | Content script returns ok:true, restored:0, error:null on empty undo snapshot | test/popup-undo-desync.spec.js:18-19 (comment) | test/repro-sequence.spec.js:107-124 "handleUndo reports ok:true with restored:0 when the snapshot is empty" - calls real window.__ffr.handleUndo directly, asserts exact shape | RAN: included in the 69-pass run above; pins the shape the popup mock (lines 104-111) is faithful to |
| 3 | popup.js reports "Undo complete." even when restored is 0 (Defect A) | popup/popup.js:578 setStatus("Undo complete.") unconditional after any non-error response | test/popup-undo-desync.spec.js:128-165, two tests against real popup.js via addInitScript-mocked browser, real DOM buttons | RAN: playwright test on test/popup-undo-desync.spec.js - both FAIL against current code |
| 4 | hasUndoableChange (module-level let, popup.js:102) resets on every popup reopen, disabling Undo despite a valid content-script snapshot (Defect B) | popup/popup.js:102, :291, :548, :576 | test/popup-undo-desync.spec.js:169-186 - remounts popup (destroys module state), mocked ping reports undoAvailable true, asserts real undo-btn enabled | RAN: FAILS against current code - toBeEnabled received disabled |
| 5 | The negative-control test prevents a lazy phase-2 fix that simply enables Undo unconditionally on mount | test/popup-undo-desync.spec.js:188-196 | Same file, test "Undo stays disabled after reopen when the content script really has no snapshot" - mounts with replaced 0, undoAvailable false, no replace ever run, asserts undo-btn disabled. Named wrong implementation it rejects: an init/updateButtonStates that sets hasUndoableChange true (or otherwise enables the button) unconditionally on mount/reopen instead of consulting the content script's real undoAvailable value would leave the button enabled here and fail this assertion. | VERIFIED BY INSPECTION, not by flipping: source files are explicitly off-limits this phase (acceptance criterion 5), so the wrong fix was not built to watch it go red. Test currently passes trivially (button starts disabled and nothing changes that) - expected for a negative control before the fix exists. |
| 6 | Adding the new test files caused no regression to the pre-existing suite | test-results/gtest-results.xml (claimed tests 69, failures 0) | Full suite minus the new desync file: playwright test with grep-invert "popup undo desync", junit reporter to test-results/gtest-results.xml | RAN (regenerated during this gate after an earlier single-file run had overwritten the evidence file): xml header shows tests=69 failures=0 skipped=0 errors=0; console tail confirms 69 passed |
| 7 | The new tests fail against the current unmodified code, i.e. genuinely capture the defects | test/popup-undo-desync.spec.js (whole file) | Direct run of the file | RAN: playwright test on test/popup-undo-desync.spec.js - 3 failed / 1 passed exactly as claimed (2x Defect A, 1x Defect B fail; negative control passes) |

## Inverse-failure-mode check (false-but-uncorrected comment)

popup/popup.js:379-380 still asserts the popup's own hasUndoableChange state
persists independently - confirmed FALSE by grep (popup.js:102, a module-level
let reset on every script reload/popup reopen) and by test 3 above going red
for exactly this reason. This is left uncorrected on purpose: phase-2's
acceptance criteria (pipeline.json phase-2 item 4) explicitly requires removing
or correcting this comment. Confirmed scheduled, not forgotten - not a phase-1
finding.

## No source-file modification

git status --porcelain popup/ content/ is empty. git diff --stat popup/
content/ is empty. Acceptance criterion 5 (no popup/ or content/ files modified
this phase) holds.

## Verdict

All 7 claims MECHANISED. No UNMECHANISED/LOAD-BEARING findings.
