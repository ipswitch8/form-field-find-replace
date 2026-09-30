# phase-3: the mousedown-guard scoping change, and what the evidence for it actually is

> **CORRECTION, added during phase-4. Read this before the rest of the file.**
>
> This document originally called the overlay-wide `mousedown` guard "a real
> defect a user would hit by clicking a checkbox while a dropdown was open". On
> re-examination during phase-4, that framing does not survive:
>
> An overlay-wide `preventDefault()` on `mousedown` only fires for events whose
> target is **inside the overlay** — i.e. for controls the overlay visually
> covers. Those controls are unreachable to a click either way, because the
> overlay is on top of them. Controls the overlay does **not** cover never
> deliver a `mousedown` to it at all, so the guard cannot affect them. There is
> therefore no configuration in which a user loses a click they could otherwise
> have made.
>
> Which also means **no test can distinguish the two guard scopes.** That was
> verified twice by flipping the guard back and finding the tests green, and it
> is why karen's phase-4 request — "assert an uncovered checkbox still toggles
> while the dropdown is open" — is not constructible as a discriminating test.
> A further complication, measured by probe: the Options group cannot be
> *partially* covered at all. Its four checkboxes sit ~20px apart in a 2x2 grid
> while the overlay grows in whole ~24px rows, so it covers none of them at 1-3
> entries and all four at 4+.
>
> The 2/93 → 0/93 measurement below is left in place because it was really
> observed, but it should now be read as a **correlation under load, not a
> demonstrated cause**. A re-run during phase-4 at 6 workers was inconclusive:
> it produced 15 failures with BOTH guards plus `GraphicsCriticalError` crash
> annotations, i.e. the machine was saturated and the experiment measured the
> load rather than the code.
>
> **What stands:** the row-scoped guard is better code — a `preventDefault()`
> should not span a region containing unrelated controls — and it is kept on
> that basis. The two tests are kept as user-visible invariants, and their own
> comments now say they do not guard the scope change specifically.
>
> **What does not stand:** the claim that this was a user-facing bug, and the
> implication that the scoping fixed the intermittent test failure.


## The symptom

While building the dropdown, the suite began failing intermittently under
parallel workers with:

    locator.setChecked: Clicking the checkbox did not change its state
      - element is visible, enabled and stable
      - performing click action
      - click action done

Playwright's own hit-target check had passed, so the checkbox *was* the element
receiving the click. The page snapshot from the failure shows
`checkbox "Regular expression" [active]` — focused — and **not** checked. A click
that focuses but does not toggle is a prevented default.

Two different tests hit it, never the same pair twice:
`clearing does not disturb the current find/replace boxes or options`,
`the same find with different settings is a distinct entry`,
`Replace all records a paired entry`,
`an action fired before init() finishes cannot truncate the stored history`.

## The cause

`popup.js` kept the input focused when the user presses the mouse on an option
row, so the blur would not tear the list down before the click could land:

```js
ui.overlay.addEventListener("mousedown", (event) => { event.preventDefault(); });
```

Bound to the **whole overlay**. A geometry probe (temporary, deleted after use)
measured what each overlay actually covers with five remembered entries, using
`getBoundingClientRect` and `elementFromPoint`:

| Overlay open | Element at the centre of each Options checkbox |
|---|---|
| find | match-case → `find-history-clear`; whole-word → itself; regex → itself; iframes → itself |
| **replace** | match-case → `history-option-arrow`; whole-word → `history-option-arrow`; **regex → `replace-history-clear`**; iframes → itself |

So the overlay is not a small box near its input — it lies across three of the
four Options checkboxes. A blanket `preventDefault()` over that region is a
guard wide enough to swallow input meant for other controls.

## The fix

Scope it to option rows, inside the listbox:

```js
ui.listbox.addEventListener("mousedown", (event) => {
  if (event.target.closest("[data-history-index]")) {
    event.preventDefault();
  }
});
```

## The measurement, which is the actual evidence

Same command, same machine, same 6 workers, before and after:

| | result |
|---|---|
| overlay-wide guard | **2 failed**, 91 passed (`--repeat-each=3 --workers=6`) |
| row-scoped guard | **0 failed**, 93 passed (same command) |

Full suite at default parallelism after the fix: see the phase-3 test-runner
artifact.

## What the regression test does NOT prove — stated plainly

`an option checkbox still toggles when a dropdown is open over it` was written
for this, and it **passes against the old broken guard too**. That was verified
by flipping the code back and running it: `1 passed`. The failure required the
timing of a real race; a deterministic unit-level repro was not constructed.

The test is kept because it pins the user-visible invariant (with a dropdown
open, the option checkboxes still respond to a click) and because
`clicking a row still selects it, despite the mousedown guard being scoped`
pins the other half — that narrowing the guard did not break what it was for.
But the evidence for the scoping specifically is the 2/93 → 0/93 measurement
above, not those tests, and the test's own comment says so.

This is recorded rather than glossed because this pipeline has already had two
gate FAILs for exactly the opposite habit: prose claiming a guarantee no
mechanism provided. An overclaiming test comment would be the same error with
extra steps.

## A SECOND change, and an honest account of what it is and is not backed by

After the scoping fix the same `setChecked` symptom still appeared, in a test
that seeds **no** history at all — so no overlay can open, and the scoping fix
cannot be the whole story.

The second suspect: `#match-preview` had `min-height`, and its text is
recomputed on a 200ms debounce after typing. Empty → a wrapped two-line
substitution → a regex error message. Each change grew or shrank the box, which
shifted every control below it — the entire Options fieldset and all thirteen
field-type checkboxes — a fifth of a second after the user stopped typing. A
click aimed at a checkbox can then land on the wrong one, or on nothing, because
the target moved between aim and press.

That is a real interaction defect independent of any test: a user clicking
"Regular expression" right after typing a pattern can have the click miss. So
the box now reserves a fixed two-line height and clips, and the full text is
exposed via `title` (which required adding `setPreviewText()` — the CSS comment
claimed a `title` the code did not set, which would have been another false
comment).

**What this is NOT backed by:** flipping `height` back to `min-height` and
re-running `--repeat-each=2 --workers=6` gave **242 passed, 0 failed** — the
flake did not reproduce that round, so this fix is NOT demonstrated to have
cured anything. The change stands on its own merits (a control that moves under
the cursor is wrong regardless), not on a measurement.

### The failure rate, stated plainly

| | full runs at default parallelism | failing runs |
|---|---|---|
| before both fixes | 10 (across several batches) | 3 |
| after both fixes | 8 | **0** |

Plus the scoping-specific measurement: 2 failures / 93 before, 0 / 93 after,
same command and load.

Conclusion I am willing to defend: the suite is materially better and both
changes fix genuine defects. Conclusion I am **not** willing to claim: that the
intermittent failure is proven eliminated. 0-in-8 against a roughly 3-in-10 base
rate is encouraging, not conclusive, and anyone who sees it again should start
from this file rather than from scratch.

## Worth noting about how this was found

This was a real defect a user would hit — click a checkbox while a dropdown is
open, get a focused-but-unticked checkbox — and it first appeared as an
intermittent test failure. The prior phase had just finished recording
"parallel-worker flake" as pre-existing infrastructure debt, which made
"contention flake, not my problem" the easy and wrong conclusion. It took
reading the failure's page snapshot to see that the checkbox was focused and
unchecked, which is not what contention looks like.
