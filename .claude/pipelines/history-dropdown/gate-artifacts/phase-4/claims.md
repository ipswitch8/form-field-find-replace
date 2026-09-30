# phase-4 claim check

Change set: `git diff 2c487f1` — popup/popup.css, popup/popup.html, test/history-dropdown.spec.js,
new test/popup-layout.spec.js, CORRECTION block prepended to phase-3/SCOPING-EVIDENCE.md.
All flip-tests below were done via in-place edits to the WORKING TREE files (already uncommitted
phase-4 changes), never `git checkout`; each was reverted immediately after and `git status --short`
confirmed only the expected phase-4 files remain modified at the end.

| # | Claim | Source | Mechanism | Verified how | Class |
|---|---|---|---|---|---|
| 1 | "At the previous 320px the popup was 1032px tall ... 432px past the cap" | popup/popup.css:58-59 | Historical fact about the OLD (pre-phase) layout; no ongoing mechanism needed | RAN: mounted `git show 2c487f1:popup/{html,css,js}` at declared width with field types expanded. Measured height = 1032.1999...px. Matches exactly; 1032-600=432 matches too. | MECHANISED |
| 2 | field-types section "still expanded by default" | popup/popup.css:66; test/popup-layout.spec.js:174-189 | `expect(#field-types-toggle).toHaveAttribute("aria-expanded","true")` in state-1 | RAN: flipped default aria-expanded true to false in popup.html, reverted after. Test went RED. | MECHANISED |
| 3a | viewport "reads the width popup.css declares rather than hardcoding" | test/popup-layout.spec.js:120-129 | reads `getBoundingClientRect().width` at runtime | RAN: changed body width 620px to 780px, ran full spec. All 8 tests passed - viewport tracked automatically. | MECHANISED |
| 3b | 620px specifically, "180px of headroom" | popup/popup.css:50-52 | None - only the 800px cap is asserted, not the 620 value or 180 margin | RAN: same 780px flip - all tests still pass; nothing pins 620. | UNMECHANISED / COSMETIC - decorative rationale, the operative cap has its own mechanism |
| 4 | opening dropdown "does not change the document's height at all" | popup/popup.css:160-168; test/popup-layout.spec.js:274-295 | exact-equality scrollHeight/contentHeight assertion | RAN: flipped `.history-overlay` position absolute to static. Test went RED (600 vs 679). | MECHANISED |
| 5 | within-group multi-column "becomes two short rows instead of five" | popup/popup.css:407-416 | None found | RAN: flipped `.field-type-group` grid-template-columns to 1fr. All 8 fit tests still passed; measured height 481px, 119px of slack under cap. | UNMECHANISED / COSMETIC - true today, but nothing depends on it; the aggregate fit is guaranteed by a broader test |
| 6 | HONEST LIMIT comment: guard test stays green when flipped back to overlay-wide (verified, not assumed) | test/history-dropdown.spec.js:1349-1451 | self-referential, test behaviour under the old guard | RAN: patched popup.js guard back to old overlay-wide unconditional preventDefault. Ran the 3 related tests at workers=1 - all 3 stayed green, matching the claim exactly. | MECHANISED |
| 7 | Options group "cannot be PARTIALLY covered": none at 1-3 entries, all four at 4+ | test/history-dropdown.spec.js:1401-1412 | geometry probe in the test | RAN: independent probe n=0..8. n=0-3 all-false, n=4-8 all-true, exact jump at 4, no intermediate state. | MECHANISED |
| 8 | CORRECTION block retracts "real defect a user would hit" framing | phase-3/SCOPING-EVIDENCE.md correction | pixel-level event-targeting argument + empirical check | Checked 4 edge cases: (a) keyboard activation never fires mousedown, guard irrelevant either way; (b) partial overlap - guard is per-click-target, a click on a checkbox's own uncovered pixel always reaches the checkbox regardless of guard scope, and no partial-coverage state exists anyway (claim 7); (c) no `pointer-events: none` anywhere in popup.css (grepped, zero matches); (d) RAN: with overlay-wide guard restored, "Clear history" test still passed - clear button unaffected by either guard scope. Retraction holds under all four; not an over-retraction. | MECHANISED / VERIFIED-SOUND |
| 9 | criterion 2: fit not achieved via max-height/overflow:auto dodge | popup/popup.css (whole file) | diff against pre-phase file | RAN: grepped max-height/overflow in current file and `git show 2c487f1:popup/popup.css`. Every occurrence in the new file pre-dates this phase, same selectors and values. No `overflow: auto` anywhere, none apply to #app or body. | MECHANISED |

## Findings (UNMECHANISED / LOAD-BEARING)

None. The two unmechanised claims (3b: the specific 620px/180px figure; 5: the within-group
multi-column sub-mechanism) are both COSMETIC - reverting either breaks nothing a test, user,
or the security/functional contract would notice, because the operative guarantees (width cap
800px, content-height cap 600px across all 5 disclosure states) are independently enforced by
tests that do not depend on either specific implementation detail.

## Verdict: PASS

All load-bearing behavioural claims in this phase have a verified mechanism. The two cosmetic
gaps are reported, not failed, per the classification rule in the gate procedure.


---

## SECOND PASS (post-karen-fail remediation, comments-only update)

Context: after the first PASS on this gate, claim 5 was "fixed" once by inference
(swapping which sub-mechanism was called load-bearing, without measuring), karen
caught that and FAILED the phase, and the author then measured every candidate
override individually and rewrote the comment block in popup/popup.css
(lines ~42-101, ~407-416) to report the measured table instead of an inferred
ranking. This pass re-examines that table and re-examines the first-pass
verdict on claims 3b and 5.

### 1. Claim 3b (620px width) - first-pass COSMETIC verdict was WRONG

First pass flip-tested 620px to 780px (wider), which of course still passes -
that direction never actually tests the claim. The new comment's own measured
table states the width 620 to 320 row shows 493 over 642, OVER in the worst
case. I re-ran that flip:

  - copied popup/popup.css to a file-local backup (popup/popup.css.gatebak,
    deleted after), edited only the body width declaration from 620px to
    320px via a targeted Node string-replace (checked the replacement fired).
  - RAN: npx playwright test test/popup-layout.spec.js --workers=1.
    State 5 (worst case) went RED: scrollHeight 642 greater than clientHeight
    600, content 642px past the 600px cap - matching the tables 642 exactly.
    State 2 (undo-cap banner) also went RED at 611px, a failure the tables
    two-column summary does not surface but is consistent with it (the table
    only reports default and worst-case, not all 5 states).
  - Reverted from the backup; git diff on popup/popup.css afterward showed no
    changes.

So the 620px value is load-bearing for at least one state (worst case, and
incidentally state 2). The first-pass classification of 3b as COSMETIC was a
genuine miss, reached by flipping the wrong direction - exactly the failure
mode this gate exists to catch. Corrected classification below.

### 2. Claim 5 / the width comments "necessary on its own" language

The comment now separates two claims instead of conflating them:
  (a) the outer #find-replace-form two-column grid-template-areas is
      necessary on its own - reverting it alone breaks BOTH default and
      worst case (635/689, both OVER);
  (b) the 620px width is necessary for the worst case specifically -
      reverting it alone breaks only the worst case (493 still fits, 642
      does not).

I flip-tested (a) directly. The first attempt at flattening the outer grid was
methodologically sloppy: clearing grid-template-columns and
grid-template-areas but leaving the childrens grid-area name declarations in
place produced neither two columns nor a clean single column - Firefox
synthesized three implicit columns from the orphaned named-line references
(computed grid-template-columns came back as three tracks summing to the form
width), collapsed #app to 343px, and broke click hit-testing badly enough that
three unrelated tests (state 4, the dropdown-height test, and the collapse
test) started timing out on element interception rather than on height. That
result does not match what the comment describes, and it nearly became a
false the-table-is-wrong finding - a reminder that a flip-test producing
incoherent side effects is a bad flip-test, not a refutation.

Redone properly: changed only #find-replace-form from display: grid plus the
template rules to display: block (the child grid-area rules become inert once
the container is not a grid, which is the correct single-column flip), via the
same backup/edit/revert discipline. RAN the same spec: state 1 measured 635
over 635 (scrollHeight/contentHeight) and state 5 measured 689 over 689 - an
exact match to the tables 635/689 OVER in both. Reverted; the file diffed
identical to the backup afterward.

So the tables outer-grid row is verified correct, and by extension so is the
width row (independently confirmed in step 1) - these are two separate,
correctly scoped necessity claims, not one claim wearing two numbers.

Is necessary on its own the right reading of a single-override experiment?
Yes, narrowly: each row reverts exactly one override with all other phase-4
changes held in place, which supports a claim of the form X is necessary
GIVEN the rest of this change set - that is what necessary on its own means
here (necessary in isolation from the other reversions under consideration),
not sufficient on its own (this one change alone, starting from the pre-phase
baseline, would have fixed it). The comment never makes the sufficiency
claim - it does not assert the outer grid alone, with width still at 320,
would fit - and the very next sentence correctly narrows the width claim to
necessary for the worst case specifically rather than folding it into not
necessary. Read in full, the paragraph is measured, not inferred. Read as a
standalone soundbite (the ONE change that is necessary on its own), a
skimming reader could conclude only the outer grid matters and the 620px
width is decoration - which step 1 shows is false for the worst case. That
ambiguity is real but is resolved within the same comment block by the
following sentence, so this is noted as a phrasing risk worth tightening, not
treated as a load-bearing overreach that blocks the gate.

### 3. popup.css diff since the first pass

popup/popup.css was modified after the first-pass artifacts were written (it
was edited during the karen-fail remediation), so it did change since the
first pass - expected, since that is what this second pass exists to
re-check. No exact snapshot of the file as it stood at the first pass exists
(no commit, no stash was taken), so a literal byte diff against that moment
is not possible. Instead:
  - git diff against the last commit (2c487f1) shows the CSS rule bodies
    (selectors, property values: 620px, minmax(0,1fr) minmax(0,1fr), the
    8-row grid-template-areas, the field-type-group grid-template-columns
    repeat(auto-fill, minmax(88px,1fr)), the options-fieldset 2x2 grid, etc.)
    are exactly the selectors and values the first-pass claims table already
    referenced by content (claims 3a/3b cite the 620px width; claim 5 cites
    the within-group multi-column mechanism) - i.e. structurally the same
    declarations analyzed then.
  - The two flip-tests above (width, outer grid) reproduce the tables numbers
    to the pixel, which would not happen if a rule body had silently drifted
    from what the table describes.
  - Full npx playwright test --workers=1: 134 passed, matching the expected
    count exactly - a strong low-level check against an accidental rule-value
    change, since this suite is pixel-measurement based rather than
    screenshot based, so a shifted padding or grid value would surface as a
    changed height instead of being silently absorbed.
  Net: confident only the comment prose changed, but this is inference from
  converging evidence (diff-against-HEAD content match, reproduced
  measurements, full green suite) rather than a literal before/after diff at
  the exact first-pass timestamp, because no such snapshot exists.

### 4. SCOPING-EVIDENCE.md retraction block

git diff --stat shows the files only change is the same plus40/minus1
CORRECTION block already present at the first pass. Its modify time
(00:17:20) predates every first-pass gate-artifact file (00:47 onward) and
every later one (test-runner/karen/validator, 01:02-01:27). Unchanged since
it was approved.

### 5. Full suite and security audit

RAN npx playwright test --workers=1 (backgrounded past the 120s tool timeout,
output read after completion): 134 passed, 0 failed.
RAN bash security-audit.sh: CLEAN, 0 findings (all five checks ok).

### Revised classification (supersedes first-pass row 3b; row 5 unchanged in
### outcome, reasoning tightened)

| # | Claim | Revised class | Why |
|---|---|---|---|
| 3b | 620px width, chosen-deliberately / headroom rationale | MECHANISED, corrected from COSMETIC | Reverting to 320px flips state 5 (and state 2) RED, confirmed by running the suite. The mechanism is test/popup-layout.spec.js state 5 (and state 2), which reads the live declared width per mountPopup's own comment. |
| 5 | within-group multi-column grid, two short rows instead of five | UNMECHANISED / COSMETIC, unchanged | The tables own row confirms: flipping this alone gives 481/481, identical to baseline - genuinely no effect at current content lengths. Not re-flipped this pass since the new comment already states the same result explicitly (the no-effect-at-all row) and it matches the first pass. |
| new | the outer two-column grid-template-areas is the one change that is necessary on its own | MECHANISED, verified by running (635/689 exact match); phrasing flagged as a minor clarity risk, not a blocking overreach, since the same paragraph separately and correctly scopes widths necessity |

## Verdict (second pass): PASS

Claim 3b is corrected from COSMETIC to MECHANISED - a claim missed on the
first pass is in fact backed by the test suite, so the correction moves a
claim INTO the mechanised column rather than surfacing a new unmechanised
load-bearing one. Claim 5 remains correctly COSMETIC, and the new comment
accurately reports that instead of overclaiming a ranking between the two
field-type sub-mechanisms. The outer-grid necessary-on-its-own claim is
measured and its numbers reproduce exactly; the phrasing is narrow enough to
be defensible when the comment is read in full. Full suite green (134/134),
security audit clean, only the expected phase-4 files remain modified, and
the SCOPING-EVIDENCE.md retraction block is unchanged since approval.
