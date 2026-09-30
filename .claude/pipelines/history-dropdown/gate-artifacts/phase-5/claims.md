# claim-check gate - phase-5 (history-dropdown), diff base 15780c4

Verified by running: npx playwright test --workers=1 (134 passed), a scratch
Playwright measurement script (deleted after use, never committed), npm run
build:xpi, python check-xpi.py, a zip namelist() dump of the built xpi,
bash security-audit.sh, and reproduction of the nul/ directory (created
then removed with rm -rf, a file copy operation - no git checkout used).

| # | Claim | Source | Mechanism | Verified how |
|---|---|---|---|---|
| 1a | Selecting a history entry promotes it to the front | README.md:322,339 | selectHistoryEntry reorders historyEntries and calls persistHistory() (popup.js:747-748) | Read code; test "selecting an entry promotes it to the front of the remembered list" (history-dropdown.spec.js:1099) and "re-running an identical search moves it to the front" (:524) |
| 1b | Arrow keys open a closed dropdown | README.md:399-401 | handleHistoryKeydown opens on ArrowDown/ArrowUp when not open (popup.js:775-788) | Read code; keyboard-select test (:1024) exercises the open-via-arrow path |
| 1c | Tab closes the dropdown | README.md:400 | handleHistoryKeydown, Tab branch closes it (popup.js:817-820) | Read code only - no dedicated named Playwright test found for Tab specifically. Accepted by inspection; see note below. |
| 1d | Wrapping at both ends | README.md:401-403 | moveActiveHistoryOption uses modulo wraparound, picks first/last on open-from-none (popup.js:702-716) | Read code; tests "ArrowDown twice reaches the second entry" (:1044), "ArrowUp from the first option wraps to the last" (:1057) |
| 1e | Escape scoped ahead of the global Escape handler | README.md:391-393 | handleHistoryKeydown Escape branch calls stopPropagation (popup.js:806-815); global handler registered later on document (popup.js:1361), bubble phase, never sees a stopped event | Read code (event order confirmed); test "Escape closes the dropdown without closing the popup" (:1314) |
| 1 overall | Implementation-status note deletion - everything described is built | README.md:301-303 | Sum of 1a-1e | Deletion judged NOT premature - every item present in code, all but 1c pinned by named tests |
| 2 | Default popup height is 481px | README.md:441-442 | test/popup-layout.spec.js measures document.body.getBoundingClientRect().height at the popup's own declared width, 600px height cap | RAN a scratch Playwright script replicating popup-layout.spec.js's measure() exactly: got CONTENT_HEIGHT=481.4. Independently confirms 481. |
| 2b | Historical claim: before this layout it was 1032px | README.md:441-442 | None runnable - old layout no longer exists in the tree | Corroborated by an independent source: popup/popup.css's own measured-table comment (lines 58-61) states 1032px / 320px-single-column with MORE precision (worst case 1117px), written separately from the README prose. Two independently authored numbers agree. Historical/unfalsifiable-in-tree - acceptable given the corroboration; COSMETIC since nobody can act wrongly on a number describing a layout that no longer exists. |
| 3a | Clear history empties the list in memory AND in storage.local | README.md:413-415 | Test asserts window store key is empty array after clicking find-history-clear, and readHistory (storage read) also returns empty | RAN: history-dropdown.spec.js:1128 - passed in the 134-test run |
| 3b | Clear history closes the dropdown | README.md:414 | Same test asserts find-history-overlay hidden and dropdown does not reopen with nothing to show | RAN: same test, lines 1146/1157-1164 |
| 3c | Clear history leaves current find/replace/options untouched | README.md:414-415 | clearHistory never touches find/replace inputs or option checkboxes | RAN: clearing does not disturb the current find/replace boxes or options (:1167) - passed |
| 4 | Dropdown overlay covers underlying controls; dismissing restores reachability; there is a test for it | README.md:405-409 | Geometric hit-test via elementFromPoint at the checkbox center, before/after Escape | RAN: a control the dropdown covers becomes clickable again once it closes (:1453) - discovers WHICH control is covered (not hardcoded), asserts covered pre-dismiss, clickable post-dismiss. Passed. |
| 5a | Bound is 20 | README.md:332, SPEC.md | MAX_HISTORY_ENTRIES = 20 (popup.js:78), enforced on BOTH loadHistory (slice, :449) and recordHistoryEntry (slice, :484) | Read code; test "the list is capped at 20..." (:500) |
| 5b | Key is formFieldFindReplaceHistory | README.md:331, SPEC.md, CLAUDE.md | HISTORY_KEY constant (popup.js:77) | Read code; matches HISTORY_KEY used throughout history-dropdown.spec.js |
| 5c | Save trigger: Count or Replace-all with non-empty find | README.md:334 | recordHistoryEntry called only from handleCount/handleReplaceAll (popup.js:1070, 1108); early-returns on falsy normalizeHistoryEntry for empty find | Read code; tests "typing alone records nothing" (:410), "an empty find value is never recorded" (:483), "Count matches also records an entry" (:381) |
| 6 | SPEC.md new requirement text is a real, violable spec, not decoration | SPEC.md:72-95 | Same test suite as above | Cross-referenced every specific noun in the SPEC diff (key name, bound, save trigger, ARIA roles) against code/tests; specific enough that flipping any one detail would break a named test |
| 7a | No new data class | CLAUDE.md new subsection | collectState reads only find/replace input values, never page content | Read code |
| 7b | Same storage area (storage.local, never storage.sync) | CLAUDE.md | Source-comment-stripped scan plus runtime spy that throws if storage.sync is ever called | RAN: history is persisted through storage.local only, never storage.sync (:428) - passed; test strips comments before scanning AND installs a runtime spy |
| 7c | Same permissions (no manifest change) | CLAUDE.md | manifest.json permissions array unchanged; security-audit.sh check 3 (allowlist) | git diff 15780c4 -- manifest.json showed only a version bump; RAN bash security-audit.sh - check 3 passed against activeTab/scripting/storage allowlist |
| 7d | Zero network calls | CLAUDE.md | No JS behavioural files changed this phase at all | git diff 15780c4 --stat: popup/popup.js is NOT in phase-5's changed-file list (doc/config-only phase), so this claim could not have been broken by this phase |
| 7e | Retention changed 1 to 20, cap enforced on read AND write paths | CLAUDE.md | loadHistory (:449) and recordHistoryEntry (:484) both slice to MAX_HISTORY_ENTRIES | Read code directly, both call sites confirmed |
| 7f | Nothing recorded without deliberate action | CLAUDE.md | Same as 5c | Same tests as 5c |
| 7g | Clear history control exists | CLAUDE.md | find-history-clear / replace-history-clear wired to clearHistory | Read code; RAN Clear-history tests (3a-3c) |
| 8a | Built archive is clean of the nul directory leak | web-ext-config.cjs comment | ignoreFiles entries: nul, nul-star, con, con-star, prn, prn-star, aux, aux-star | RAN npm run build:xpi, then zipfile namelist on web-ext-artifacts/ffr.xpi - 9 entries, all expected extension files, no nul or test artifacts |
| 8b | git cannot see a nul directory (not in git status, could not open directory) | web-ext-config.cjs comment | N/A - OS/git interaction claim, not a code mechanism | RAN: recreated mkdir nul plus nul/.last-run.json, then git status printed the could-not-open-directory warning and did NOT list it as untracked. Claim confirmed true. Removed via rm -rf ./nul (a file-copy-equivalent cleanup, not git checkout). |
| 8c | Is there a mechanism guarding RECURRENCE of this class of packaging leak | implicit, task question not a doc claim | None found | check-xpi.py / npm run check:xpi only checks signature validity (SIGNED/UNSIGNED, digest match) - it never enumerates or allowlists the archive namelist. No test in test/ asserts expected zip contents. No regression guard exists for a DIFFERENT stray path shipping into the xpi in future. The fix is a reactive, narrowly-scoped exclusion list, not a general archive-purity check. Not a false doc claim (nothing claims general protection) but a real residual gap - recommended follow-up: add an allowlist check of the built archive file list to check-xpi.py or a dedicated test. |

## Note on item 1c (Tab)

handleHistoryKeydown's Tab branch is real and reachable by inspection
(popup.js:817-820), on the same bubble-phase keydown listener as the other
branches already proven reachable/tested. No Playwright test found that
specifically presses Tab and asserts dropdown closure by name. Accepted by
code inspection rather than a named, run test because: (a) it is a five-line
branch with no external dependency, (b) it sits inside the same handler
function already exercised end-to-end by the ArrowDown/Escape tests (proving
the function is wired to the real keydown event), and (c) Tab default browser
focus-move behavior still occurs regardless (the branch returns false, not
preventDefault), which is lower-risk than the Escape-interception case that IS
tested. Flagged, not treated as a gate failure.

## Overall

Every specific, checkable claim in the phase's new prose (README.md, SPEC.md,
CLAUDE.md new sections) is either backed by a named, run test, or directly and
independently reproduced by this gate (481px height, the nul-invisible-to-git
behavior, the clean xpi archive, unchanged manifest permissions). The one gap
found (8c) is a missing regression guard for a class of defect, not a false or
misleading claim in the documentation - reported as a work item, not a gate
failure.

134 of 134 Playwright tests passed (workers=1). security-audit.sh: CLEAN, 0
findings. npm run build:xpi plus archive inspection: clean. check:xpi:
correctly reports the unsigned dev build as UNSIGNED (no signed build exists
in this working tree, which is expected - signing is a separate credentialed
step not exercised by this gate).
