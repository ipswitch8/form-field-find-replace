# phase-1 evidence note: why `gtest-results.xml` does not include this phase's own spec

Read this before concluding the evidence was rigged. Two independent agents
raised it, correctly, because the artifact set did not previously say so.

## What the XML contains

`gtest-results.xml` in this directory: 13 suites, **88 tests, 0 failures, 0
errors**. It is the **pre-existing** Playwright suite. `test/history-dropdown.spec.js`
— this phase's own deliverable — is deliberately **absent** from it. The run
that produced it used
`npx playwright test --grep-invert "history persistence|history bound|history dropdown rendering|selecting a history entry|dropdown interaction safety"`,
which are exactly the five `test.describe` titles in that file.

## Why

Phase-1 is a **red baseline by design**. Its acceptance criterion 6 *requires*
at least 3 of the new tests to fail against the unmodified `popup/`:

> Running `npx playwright test test/history-dropdown.spec.js` against the
> current unmodified popup/popup.js and popup/popup.html produces at least 3
> failing tests […] proving these are not vacuous pass-either-way tests

Meanwhile `phase-gate.sh`'s `validate_junit_xml` accepts an XML only when
`failures=0 && errors=0 && tests>0`. A full-suite XML for this phase therefore
**cannot exist**: the phase is only correct if part of the suite is red, and the
gate only accepts an XML that is wholly green. The two requirements are
mutually exclusive for exactly one phase — this one.

So the XML answers the question that *is* answerable here, and the one that
actually matters for a test-only phase: **did adding a spec file and a README
section break anything that was previously working?** Answer: no, all 88
pre-existing tests still pass.

## What is NOT being claimed

The green XML is **not** evidence that the history feature works. It cannot be;
the feature does not exist yet. Nothing in this phase claims otherwise.

## The red baseline, recorded

Run separately and independently reproduced by **three** agents (karen,
validator, test-runner) plus claim-check:

    npx playwright test test/history-dropdown.spec.js --reporter=list
    → 19 failed, 3 passed

The 3 that pass do so vacuously today — two negative save-trigger guards
("typing alone records nothing", "an empty find value is never recorded") and
the pre-existing `restoreState()`-race guard. They become load-bearing once the
save path (phase 2) and the dropdown wiring (phase 3) land. This is stated in
the phase's commit message rather than left for a reader to discover.

## What stops this from becoming a permanent exclusion

The exclusion is scoped to this phase and is closed out mechanically later:

- **phase-5 criterion 1** requires `npm test` — the **full** suite, the prior 88
  tests *plus* all new history/dropdown/layout tests — to report **zero
  failures**, with results written to `test-results/gtest-results.xml`.
- **phase-5 criterion 7** requires a `git diff` review confirming no test was
  deleted or weakened to make the suite pass.
- **phase-2 criterion 5** and **phase-3 criterion 6** name which specific
  sub-groups of this spec must be green by the end of each, so the red set has
  to shrink on a schedule rather than at someone's discretion.

If `test/history-dropdown.spec.js` were quietly deleted or its assertions
softened to make a later full-suite run green, phase-5's criteria are what
catch it.

## Open item carried forward

claim-check's report (`claims.md`) recorded one genuine gap, not a blocker here
because no storage code exists yet: **"storage.local only, never storage.sync"
has no explicit assertion.** `security-audit.sh`'s `dangerous_code_scan` covers
only `eval(` / `.innerHTML =` / `Function(`, not `storage.sync`, so today the
only thing standing against a `storage.sync` call is the incidental fact that
the test mock defines no sync area. Phase 2 must add an explicit check.
