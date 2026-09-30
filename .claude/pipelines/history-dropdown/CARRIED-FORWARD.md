# Gate findings deferred to a named later phase

Recorded so they cannot be lost between phases. Each entry names the gate that
raised it, the phase that must close it, and what "closed" looks like.

## 1. A "Clear history" control — PHASE 3

**Raised by:** security-audit, phase-2 (first pass as informational, ruled on
explicitly in the second pass).

**The finding:** this phase did not introduce a new data class — the popup's own
typed text already went to `storage.local` under `formFieldFindReplace` — but it
did increase the *retention depth* of it from one entry to twenty. A secret
pasted into the Find box now persists across up to 20 entries, and there is no
way for the user to clear them.

**The ruling:** non-blocking for phase-2, because phase-2 built no UI at all and
there was nothing for such a control to attach to. Phase-3 builds the dropdown
and is therefore the first phase with a surface to put it on.

**Closed when:** phase-3 adds a user-reachable way to clear the remembered list,
with a test, OR phase-5 documents the absence as a considered decision.
security-audit's words: "silence in both phases would leave the exposure-window
gap undocumented rather than closed."

## 2. `CLAUDE.md`'s storage-permission rationale is stale — PHASE 5

**Raised by:** security-audit, phase-2 second pass.

**The finding:** `CLAUDE.md`'s permission table says `storage` persists "the
last-used find/replace strings, checkbox states, and field-type selections".
That is now incomplete: a bounded 20-entry history of the same data is persisted
under a second key.

**Why it was not a phase-2 blocker:** `CLAUDE.md` says a threat-model change
requires the document updated first. security-audit ruled that this is not a
threat-model change — the data class, the storage area, the permission set and
the zero-network guarantee are all unchanged and were mechanically re-verified
clean. What changed is retention depth of an already-documented data class, which
is the kind of thing the phase structure exists to sequence.

**Closed when:** phase-5 updates that table to name the bounded history and its
key, as part of its documentation criterion.

## 3. Parallel-worker flake, including in THIS feature's new tests — PHASE 3

**Raised by:** validator (phase-2 second pass), then sharpened materially by
test-runner (phase-2 second pass).

**First reading, which was too kind:** validator saw default parallel runs drop
ONE unrelated pre-existing test, a different one each time (a checkbox-click
race; an unrelated whitespace-matching test), and `--workers=1` clean. That read
as pre-existing infrastructure debt unrelated to this work.

**What test-runner actually found:** the flake also hits the tests added by THIS
feature. Across its runs, at default parallelism it dropped `history persistence`
(the typing-alone guard), `history bound`, and one of the new
`claimed mechanisms, actually pinned` tests — the readiness-marker one. Under
`--workers=1` every one of those passed, repeatedly (the readiness-marker test
5/5 in isolation).

**Why, and why it is ours to fix:** the four new mechanism tests deliberately use
wall-clock storage delays — 4s for the write-serialisation race, 800ms and 900ms
for the two init-gap tests. Wall-clock margins are exactly what worker contention
eats. A test whose correctness depends on "the click happens before the 900ms
timer fires" is not deterministic on a loaded machine, and calling that
"pre-existing flake" would be passing the blame for tests written in this
pipeline.

**This blocks phase-5.** Phase-5 criterion 1 requires `npm test` — the full suite
at its configured parallelism — to report ZERO failures. A suite that drops a
random test per run cannot satisfy that, and papering over it by pinning
`--workers=1` in the config would be hiding the problem rather than fixing it.

**Closed when:** phase-3 (which edits this same spec file anyway) replaces the
wall-clock delays in the four mechanism tests with explicit test-controlled
gates — the fake `storage.local.get`/`set` should block on a promise the test
resolves when it is ready, rather than on `setTimeout`. That removes the timing
assumption entirely instead of widening the margin and hoping. The mechanism
being pinned does not need real time to pass; it needs a write to still be
in-flight, which a held promise expresses directly.

Then re-confirm by running the full suite at default parallelism several times.

**Do not** close this by pinning `workers: 1` in `playwright.config.js`, by
adding retries, or by loosening the assertions. Each of those makes the number
green without making the tests deterministic.
