# claims.md - phase-2 (history persistence layer), pipeline history-dropdown — RE-GATE

Re-gate of phase-2 remediation. Previous FAIL (3 findings + 2 softer) is
superseded below; each remediated claim was independently flip-tested by this
gate, not accepted from FLIP-TEST-EVIDENCE.md on trust. A new finding was
surfaced during the instructed re-check of the corrected prose.

## Remediated claims — flip-tested by this gate

1. `historyWriteChain` serialises history writes so a slow earlier write cannot
   clobber a newer one.
   Source: popup/popup.js lines 441-448 (persistHistory).
   Mechanism: test/history-dropdown.spec.js:532 "a slow earlier history write
   cannot clobber a newer one (historyWriteChain)".
   Verified: FLIP-TESTED by this gate. Changed
   `historyWriteChain = historyWriteChain` to
   `historyWriteChain = Promise.resolve()` → test failed
   (`Expected second-search,first-search; Received first-search only`). Reverted
   via file copy, diff-confirmed clean. Baseline (unflipped) passes.
   Classification: MECHANISED.

2. Both storage reads happen before `wireEvents()` in `init()`, so no handler
   can run against an empty `historyEntries` and truncate the stored list.
   Source: popup/popup.js lines 944-961 (init).
   Mechanism: test/history-dropdown.spec.js:579 "an action fired before init()
   finishes cannot truncate the stored history".
   Verified: FLIP-TESTED by this gate. Moved `wireEvents();` above the
   `await Promise.all([restoreState(), loadHistory()])` line → test failed
   (`Expected >= 5, Received 1`), matching the evidence note exactly. Reverted,
   diff-confirmed clean. Baseline passes. Confirmed the test types a non-empty
   Find value inside the held-open gap (not just a click), so it does not
   repeat the recorded false start where an empty Find made the assertion
   vacuous.
   Classification: MECHANISED.

3. The `ffrReady` marker is required before any handler is reachable; a click
   before it is set reaches no handler.
   Source: popup/popup.js lines 944-986 (init), comment narrowed to what the
   test actually shows (no longer claims the specific "form submit" failure
   mode).
   Mechanism: test/history-dropdown.spec.js:622 "no action handler is attached
   until the readiness marker is set (why the marker exists)".
   Verified: FLIP-TESTED by this gate. Set
   `document.body.dataset.ffrReady = "true"` at the top of `init()` → test
   failed (`expect(received).toBeUndefined(); Received: "true"`), matching the
   evidence note exactly. Reverted, diff-confirmed clean. Baseline passes
   (flaked once under concurrent CPU load when run in parallel with an
   unrelated script; reran 4x in isolation/full-suite context with 0 failures
   — a test-robustness observation, not a mechanism failure).
   Classification: MECHANISED.

4. `normalizeHistoryEntry` coerces malformed stored data rather than throwing
   or passing junk through (non-string `replace` becomes `""`, non-object
   `options`/`fieldTypes` fall back to defaults, unknown keys dropped).
   Source: popup/popup.js lines 350-386.
   Mechanism: test/history-dropdown.spec.js:660 "malformed stored history is
   coerced, not thrown on (normalizeHistoryEntry)".
   Verified: FLIP-TESTED by this gate. Relaxed the return to pass
   `raw.replace`/`raw.options`/`raw.fieldTypes` straight through → test failed
   (`Expected: ""; Received: 7`), matching the evidence note exactly. Reverted,
   diff-confirmed clean. Baseline passes.
   Classification: MECHANISED.

## Prose correction (finding 2c) — re-checked, and it introduced a NEW defect

5. "Newest-first", not "most-recently-used" — popup.js comment (lines 51-62).
   Verified: Inspected. Correctly narrowed; explicitly states selection-driven
   promotion "arrives with the dropdown, NOT here" and "at this point in the
   file's history there is no select path at all." Matches the codebase: grep
   for dropdown/select handling in popup.js finds none.
   Classification: now accurate — the prior COSMETIC finding is resolved.

6. README.md eviction row (line 331, part of this remediation's diff):
   "...moves that entry to the front rather than adding a duplicate;
   **selecting an entry from the dropdown promotes it the same way.** ..."
   Source: README.md line 331 (git diff confirms this clause is NEW in this
   remediation, not pre-existing).
   Mechanism: none. No dropdown UI exists — `grep -i "history|dropdown"
   popup/popup.html` returns zero matches. No selection handler exists in
   popup.js (grep confirms). No test exercises it (the dropdown is phase-3,
   not yet built).
   Verified: Grepped popup.html and popup.js for any dropdown/selection code —
   none exists. This directly contradicts the sibling comment written in the
   same edit in popup.js lines 60-62, which explicitly warns: "Do not read
   this comment as describing something that already happens on select; at
   this point in the file's history there is no select path at all." The
   README states in plain present tense that selecting an entry already
   promotes it. A reader of README.md alone, without cross-referencing
   popup.js, would believe dropdown-selection promotion ships today. It does
   not.
   Classification: UNMECHANISED / LOAD-BEARING — new finding. This is the same
   defect shape the original FAIL was issued for (a description that outran
   the mechanism), reintroduced by the very fix meant to correct the prior
   instance of it, in the same file-pair, in the same diff.

## Suite / audit re-checks

- `npx playwright test --grep-invert "history dropdown rendering|selecting a
  history entry|dropdown interaction safety"` → 101 passed, 0 failed (88
  pre-existing + 13 phase-2), confirmed by this gate.
- `bash security-audit.sh` → CLEAN, 0 findings, confirmed by this gate.
- `.git/popup.js.bak` diff-confirmed identical to popup/popup.js both before
  and after all four flip experiments (clean revert, no residue).

## Verdict basis

Findings 1, 2, 3, 8 (renumbered 1-4 above) from the prior FAIL are now
MECHANISED and independently flip-verified by this gate — not accepted from
the evidence note on trust. Finding 2c is resolved in popup.js. But the same
edit that resolved it in popup.js introduced an unmechanised, load-bearing,
present-tense claim in README.md (item 6) describing a mechanism (dropdown
selection promoting an entry) that does not exist anywhere in the current
codebase. That is a new work item, not a documentation nit: either delete the
"selecting an entry from the dropdown promotes it the same way" clause (and
its parenthetical "Selection-driven promotion is what makes the ordering
genuinely usage-based" sentence, which is fine on its own as forward-looking
but should not be adjacent to a present-tense "Eviction" fact row without a
phase-3/not-yet-built qualifier) or mark it explicitly as not-yet-implemented,
matching the discipline already applied to the sibling comment in popup.js.

## Second re-check (coordinator's "fix" for finding 6) — relocated, not resolved

Coordinator added: (a) a lead-in sentence stating the whole section is
"written in the present tense throughout, describing the finished feature",
(b) an "Implementation status" blockquote immediately after, explicitly
naming the dropdown as not-built and calling out selection-promotion prose as
design intent, (c) moved the MRU/FIFO parenthetical out of the Eviction table
cell into prose below the table.

`git diff -- README.md` confirms the actual offending sentence in the
Eviction table cell was NOT changed to remove or qualify the claim. It reads,
unchanged in force, still inside the "Decision | Value" fact table:

  "Selecting an entry from the dropdown also promotes it to the front."

This is the same present-tense, unmechanised, false claim as before, now
merely disclaimed at a distance (a note ~40 lines above the table, prose
inserted below the table cell). A reader who goes straight to the fact table
- which is exactly the failure mode the original finding was about, and
exactly why popup.js's OWN comment was edited in place rather than disclaimed
elsewhere - still reads a table cell asserting current behaviour that does
not exist. The status note is a reasonable thing to have in addition, but it
is not a substitute for fixing the specific sentence that is wrong.

Secondary, mechanical defect from the same edit: the inserted prose paragraph
sits inside the markdown table (between the Eviction row and the Save
trigger row), which breaks table parsing - the Save trigger row is now
orphaned outside the table it was written to be part of.

Classification: UNMECHANISED / LOAD-BEARING — unresolved. Work item unchanged
from before: delete or qualify the specific clause "Selecting an entry from
the dropdown also promotes it to the front." in the Eviction table cell
itself (not just nearby prose), and restore the table's markdown structure.

Verdict: FAIL (second time), for the same underlying claim.

## Third re-check — resolved, in place

`git diff`/direct read confirms the `Eviction` table cell no longer contains
"Selecting an entry from the dropdown also promotes it to the front." —
deleted outright, not relocated. `grep -n "promotes it" README.md
popup/popup.js` returns no matches. The table (README.md lines 338-344) is
now well-formed: header, separator, and five contiguous data rows (Storage
area, Key, Maximum entries, Eviction, Save trigger); the MRU/FIFO prose sits
after the table, not inside it. That prose now correctly frames
selection-driven promotion as future/design-intent ("it is the dropdown's
job; until the dropdown exists there is no select path to promote from"),
matching the discipline already applied in popup.js. The "Implementation
status" blockquote is a reasonable addition, not itself an unmechanised
claim — it explicitly labels clicking/keyboard-nav/selecting prose elsewhere
in the section as design intent, not current behaviour. `popup/popup.js`
confirmed byte-identical to the flip-tested version (`diff .git/popup.js.bak
popup/popup.js` empty) — no code changed in this fix.

Classification: resolved. No unmechanised load-bearing claims remain from
this gate's review.

Verdict: PASS (third pass).
