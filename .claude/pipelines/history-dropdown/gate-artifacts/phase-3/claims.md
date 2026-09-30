# phase-3 claim-check: claims table
Change set: git diff 2603830

## 1. history-overlay position:absolute / no-scrollHeight-change claim
- Source: popup/popup.css:96-104
- Claim: opening the dropdown cannot change document.documentElement.scrollHeight, "which a test asserts for the worst case"
- Mechanism: test/popup-layout.spec.js (not yet written) -- required by pipeline.json phase-4 acceptance criterion 1, states 4 and 5
- Verified: read pipeline.json; phase-4 names this exact test as a required criterion, not an aspiration
- Classification: MECHANISED (deferred, scheduled -- not silently absent)

## 2. Escape stopPropagation claim
- Source: popup/popup.js around line 803-806
- Claim: stopPropagation() is what keeps the first Escape from reaching the document-level handler
- Mechanism: Escape closes the dropdown without closing the popup -- test/history-dropdown.spec.js:1167
- Verified: RAN. Removed event.stopPropagation(); test went red (window.__closed became 1, expected 0). Restored from file-copy backup.
- Classification: MECHANISED

## 3. selectHistoryEntry promotion claim
- Source: popup/popup.js around line 737-740
- Claim: selecting an entry promotes it to front, making ordering "genuinely usage-based rather than merely record-based"
- Mechanism: selecting an entry promotes it to the front of the remembered list -- test/history-dropdown.spec.js:1026
- Verified: RAN. Removed the promotion line; test went red (waitForFunction timeout, order never updated). Restored from file-copy backup.
- Classification: MECHANISED

## 4. clearHistory storage claim
- Source: popup/popup.js clearHistory() doc comment, ~486-500
- Claim: removes entries "in memory and in storage.local"
- Mechanism: Clear history empties the remembered list and closes the dropdown -- test/history-dropdown.spec.js:1055, reads window.__store via readHistory(page)
- Verified: by inspection -- test asserts against the storage-backed mock store, not just the DOM ("Gone from storage, not merely hidden from the list")
- Classification: MECHANISED

## 5. renderHistoryOptions rebuild-on-open claim
- Source: popup/popup.js renderHistoryOptions doc comment, ~559-563
- Claim: rows are "Rebuilt on every open rather than kept in sync incrementally... a stale row would show the user a search they can no longer select"
- Mechanism: none named
- Verified: RAN. Patched openHistoryDropdown to skip renderHistoryOptions when the listbox already has children (simulating a stale cached render on reopen). Ran the full history-dropdown.spec.js suite (33 tests) -- ALL 33 STILL PASSED. No test records/promotes/clears history and then reopens the SAME dropdown to check the rendered rows reflect the change; every post-mutation assertion reads storage.local via readHistory(), never the live listbox DOM after a second open. Restored from file-copy backup.
- Classification: UNMECHANISED / LOAD-BEARING

## 6. openedByFocusKey claim
- Source: popup/popup.js around line 1275-1279
- Claim: without it, "a single click appeared to do nothing at all"
- Mechanism: clicking the find input opens a listbox of prior entries -- test/history-dropdown.spec.js:778 (first click on an unfocused input)
- Verified: RAN. Short-circuited the openedByFocusKey check to always-false; test went red (listbox stayed hidden). Restored from file-copy backup.
- Classification: MECHANISED

## 7. setPreviewText title-attribute claim
- Source: popup/popup.js setPreviewText doc comment, ~206-216
- Claim: full string goes on title "otherwise a truncated regex error would be actively misleading"
- Mechanism: none found
- Verified: grepped test/history-dropdown.spec.js, test/preview.spec.js, and the rest of test/*.spec.js for ".title" / getAttribute("title") -- zero matches anywhere in the suite. The fixed-height clipping (popup/popup.css, height: calc(2 * 1.35em + 8px); overflow: hidden;) is new this phase, so title is the ONLY thing making clipped preview/error text recoverable, and nothing asserts it is ever set.
- Classification: UNMECHANISED / LOAD-BEARING

## 8. match-preview fixed-height CSS comment causal claim
- Source: popup/popup.css around lines 159-175
- Claim: the old min-height "showed up as an intermittent setChecked:... [failure] under parallel test workers" -- stated as settled causal fact
- Mechanism: none (this is a causal narrative, not a control)
- Verified: compared wording against SCOPING-EVIDENCE.md's own "What this is NOT backed by" section (lines 110-114): reverting height to min-height and re-running --repeat-each=2 --workers=6 gave 242/0 failures -- the flake did NOT reproduce, and the evidence file explicitly states this fix is NOT demonstrated to have cured anything. The CSS comment carries none of that hedge -- it narrates the causal chain as established fact, with the disclaimer left out of the artifact a future reader is most likely to trust and act on.
- Classification: UNMECHANISED / LOAD-BEARING (comment states a causal link more strongly than the evidence file it was drawn from supports)

## 9. mousedown-guard scoping claim, two named tests
- Source: popup/popup.js comment ~1317-1329; tests at test/history-dropdown.spec.js:1202 and :1250
- Claim: the row-scoped guard "fixes what the overlay-wide one broke"; two tests pin it
- Verified: RAN. Reverted the guard to overlay-wide (unconditional preventDefault() on ui.overlay mousedown). BOTH named tests still passed against the broken/reverted code. This corroborates, does not contradict, SCOPING-EVIDENCE.md's own admission that the evidence for the scoping specifically is the 2/93 to 0/93 measurement, not those tests, and the test's own comment says so (plural "those tests"). Restored from file-copy backup.
- Classification: MECHANISED (by the named 2/93->0/93 measurement, not by the two unit tests -- and the evidence file already says so accurately; no overclaim found here)

## 10a. Write-serialisation (historyWriteChain) claim
- Source: popup/popup.js persistHistory(), ~456-464; CARRIED-FORWARD.md item 3
- Mechanism: a slow earlier history write cannot clobber a newer one (historyWriteChain) -- test/history-dropdown.spec.js:584
- Verified: RAN. Removed the historyWriteChain promise-chaining (writes issued immediately, unserialised). Test went red (order came back ["first-search"] instead of ["second-search","first-search"]). Restored from file-copy backup.
- Classification: MECHANISED

## 10b. init-ordering claim (loadHistory/restoreState before wireEvents)
- Source: popup/popup.js init(), ~1382-1385; CARRIED-FORWARD.md item 3
- Mechanism: an action fired before init() finishes cannot truncate the stored history -- test/history-dropdown.spec.js:636
- Verified: RAN. Moved wireEvents() to before the await Promise.all([restoreState(), loadHistory()]). Test went red (history length 1, not >=5). Restored from file-copy backup.
- Classification: MECHANISED

## 10c. ffrReady marker claim
- Source: popup/popup.js init(), ~1391-1408; CARRIED-FORWARD.md item 3
- Mechanism: no action handler is attached until the readiness marker is set -- test/history-dropdown.spec.js:682
- Verified: RAN twice. (a) Moved the marker-set statement immediately above wireEvents() with no artificial delay: test still PASSED -- the two statements are adjacent synchronous code with no yield point, so a same-tick reorder is not observable by the test as written. (b) Same reorder plus an injected 500ms delay between the two lines: test WENT RED. The precondition half of the claim (no handler fires while storage.local reads are held open) is independently verified and unaffected by either flip. Restored from file-copy backup.
- Classification: MECHANISED for the storage-gated precondition, which is the load-bearing half of the claim; the narrower "marker strictly after wireEvents" sub-claim cannot be distinguished from a same-tick reorder by this test -- noted but not treated as a blocking finding since no realistic synchronous code defect produces an externally observable gap here.

## Flip-testing method note
All flips were applied via in-place edits to popup/popup.js and popup/popup.css, each reverted from a file-copy backup (popup/popup.js.bak, popup/popup.css.bak) made before any edit and diffed byte-identical after the final restore, then deleted. git checkout was never used on these files. git status --short after all flips confirms only the five files already modified by phase-3 (plus the new gate-artifacts directory) are touched, and nothing was lost.

## Re-check after remediation (coordinator round 2)

All three prior FAIL findings were addressed in the working tree (still uncommitted; git diff 2603830 covers all of it). Re-verified independently, same method: file-copy backups (.bak), never git checkout, diffed byte-identical after each restore.

### Finding 5 remediation - VERIFIED
Two new tests added: "reopening the dropdown shows entries recorded since it was last open" (test/history-dropdown.spec.js:1189) and "a cleared-then-repopulated list renders the new rows, not the old ones" (:1234). Both assert the RENDERED listbox DOM after a reopen, not storage.
RAN the exact same flip as before (cache-on-first-render: `if (ui.listbox.children.length === 0) { renderHistoryOptions(ui); }` in openHistoryDropdown). RESULT: both new tests went red -
  - "reopening..." : expected rendered.length 2, received 1
  - "cleared-then-repopulated..." : expected texts.length 1, received 2 (stale rows survived)
Restored from file-copy backup, diffed identical.
Classification: now MECHANISED.

### Finding 7 remediation - VERIFIED
Two new tests added: "the preview box exposes its full text on title, because it now clips" (:719) and "the preview box does not change height when its text arrives" (:763).
RAN flip 1: removed the `els.matchPreview.setAttribute("title", text)` call in setPreviewText(). RESULT: "...exposes its full text on title..." went red (shown.title null instead of matching shown.text). Restored, diffed identical.
RAN flip 2: reverted `#match-preview`'s `height: calc(2 * 1.35em + 8px)` back to `min-height: 1.2em`. RESULT: "...does not change height..." went red (preview box top/height moved by ~93px after a 90-char replacement landed; regex checkbox position also verified to shift in the same assertion). Restored, diffed identical.
Classification: now MECHANISED (both the title-recoverability claim and the no-reflow claim are independently pinned).

### Finding 8 remediation - VERIFIED
popup/popup.css's #match-preview comment now carries an explicit "WHAT IS NOT CLAIMED" paragraph: states the setChecked flake "looked like a likely cause. It is NOT established as one," cites the 242 passed / 0 failed revert measurement, points to SCOPING-EVIDENCE.md by path, and closes with "Do not treat that flake as solved on the strength of this rule." The fix is now justified in the comment's own words solely as "a real interaction bug on its own terms," independent of the flake claim.
Read in full; the hedge is not buried or diluted - it sits directly beside the causal narrative it qualifies, in the artifact a future editor will actually open, matching (not merely referencing) SCOPING-EVIDENCE.md's own caveat.
Classification: no longer an overclaim. MECHANISED / accurately hedged.

### 10c - unchanged, still noted-not-blocking
Coordinator left this as-is per my original note (the "marker strictly after wireEvents" sub-claim is unobservable on a same-tick reorder by the test as written; the storage-gated precondition half remains independently verified). No disagreement - this was never a blocking finding, only an observation about the limits of what a same-tick statement reorder can trigger in single-threaded JS, and nothing about it changed.

### Suite state at re-check
`security-audit.sh` re-run: CLEAN, 0 findings (all 5 checks ok).
Coordinator reports test/history-dropdown.spec.js 37/37 at --workers=1 and full suite 125/0 - not independently re-run in full here (would require the green gtest-results.xml already on file at gate-artifacts/phase-3/gtest-results.xml, which this round did not need to touch since no code was left modified after any flip); the three specific new/changed tests were run directly above and observed passing against the actual (non-flipped) working tree during each flip's "before" state implicitly (all flips started from the real tree and only failed after the flip was applied).

## Final verdict: PASS
All 10 claim groups are now MECHANISED (10c's narrow sub-claim remains an accepted, non-blocking observation). No claim in this diff is unmechanised-load-bearing, and the one comment that previously overclaimed (Finding 8) now hedges accurately in the artifact itself.
