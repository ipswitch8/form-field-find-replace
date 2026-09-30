# phase-2 remediation: flip-test evidence for the three FAIL findings

claim-check FAILED phase-2. It flip-tested three claims by deleting the
mechanism and re-running, found every test still green, and was right: those
were comments, not guarantees. It also noted two softer items. All five are
addressed below, and each fix was itself flip-tested — the exact failure the
gate performed is now reproduced against the new tests and confirmed to go RED.

## Finding 1 — `historyWriteChain` configured nothing any test checked

`popup/popup.js` `persistHistory()`.

**New test:** "a slow earlier history write cannot clobber a newer one
(historyWriteChain)".

The fake `storage.local.set` now snapshots its payload at call time and applies
it at *resolve* time, which is how a real backend behaves, and delays the first
**history** write by 4s. Two searches are recorded. Unserialised, the slow
one-entry write lands last and overwrites the two-entry one.

**Two false starts, both recorded because they are the interesting part:**

1. The delay was first applied positionally to "the Nth `set` call". That was
   wrong: typing into the form fires `persistState`, so the raw call sequence is
   mostly last-typed-state writes and the delay landed on one of those instead
   of the write under test. The delay is now matched against writes carrying the
   history key.
2. The delay was first 600ms, which the second click sometimes beat, so the
   first write had already landed and there was nothing to race. Now 4s.

With either false start present the test passed *with serialisation removed* —
i.e. it was itself an unmechanised claim. Fixed and re-verified.

**Flip result:** changing `historyWriteChain = historyWriteChain` to
`historyWriteChain = Promise.resolve()` → **1 failed**. Mechanism present →
**1 passed**.

## Finding 2 — the read-before-`wireEvents()` ordering in `init()`

`popup/popup.js` `init()`.

**New test:** "an action fired before init() finishes cannot truncate the stored
history". Seeds 5 entries, holds `storage.local.get` open for 800ms, and acts
inside that window.

**One false start, and it is the same class of error the gate caught:** the
first version only clicked Count. Under the reversed ordering `restoreState()`
has not run either, so the Find box is empty and `recordHistoryEntry` declines
on the empty-find rule — the test passed for the wrong reason and proved
nothing. It now types a non-empty find into the box first, inside the gap.

**Flip result:** moving `wireEvents()` above the `await Promise.all([...])` →
**1 failed, `Expected: >= 5  Received: 1`** — the five stored entries really are
replaced by one. Correct ordering → **1 passed**.

## Finding 3 — the `ffrReady` marker's protective claim

`popup/popup.js` `init()`, and the mount helper in
`test/history-dropdown.spec.js`.

**New test:** "no action handler is attached until the readiness marker is set
(why the marker exists)". Holds storage open 900ms, then asserts the
precondition a naive wait would have keyed on — `#count-btn` exists and is
`disabled === false` — while `data-ffr-ready` is still absent, clicks it, and
asserts **zero** messages were sent and an empty status line. Then waits for the
marker and shows the same click working.

The comment in `popup.js` was also narrowed. It previously claimed a premature
click on `#replace-all-btn` "would hit the form's default submit behaviour and
read as a mystery flake". The premise is true but that specific consequence was
not demonstrated, so the comment now describes what the test actually shows: the
click reaches no handler, sends nothing, and writes no status.

**Flip result:** setting `document.body.dataset.ffrReady = "true"` at the top of
`init()` → **1 failed, `expect(received).toBeUndefined()  Received: "true"`**.

## Finding 2c — "most-recently-used" claimed a distinction no test could see

The gate was right. With recording as the only promotion trigger, the behaviour
is indistinguishable from FIFO-with-move-to-front-on-re-record.

Both the `popup.js` comment and README.md's eviction row now say
**newest-first** and state explicitly that selection-driven promotion — the
thing that would make the ordering genuinely usage-based — arrives with the
dropdown and does **not** exist at this point in the file's history. The comment
says so in as many words, so it cannot be misread as describing current
behaviour.

## Finding 8 — `normalizeHistoryEntry` "cannot throw", inspection only

**New test:** "malformed stored history is coerced, not thrown on
(normalizeHistoryEntry)". Seeds a deliberately hostile array — `null`, a bare
string, a number, `{}`, `{find: ""}`, an entry with a numeric `replace` and a
string `options`, and an entry with a truthy-non-boolean flag and an unknown
field-type key — then asserts the popup still starts, junk is dropped, valid
entries survive, a non-string `replace` becomes `""`, flags are real booleans,
and the unknown key is **not** carried into storage.

**Flip result:** relaxing the return to pass `raw.replace` / `raw.options` /
`raw.fieldTypes` straight through → **1 failed, `Expected: ""  Received: 7`**.

## Summary

| Finding | Fix | Flip verified red |
|---|---|---|
| 1 `historyWriteChain` | new test + delay keyed to history writes, 4s | yes |
| 2 `init()` ordering | new test, types a find inside the gap | yes |
| 3 `ffrReady` | new test + comment narrowed to what is shown | yes |
| 2c "MRU" prose | corrected in popup.js and README.md | n/a (prose) |
| 8 `normalizeHistoryEntry` | new test with hostile stored input | yes |

All flip edits were reverted from a file copy (`.git/popup.js.bak`), not with
`git checkout` — on this project a `git checkout` during remediation once
destroyed an entire uncommitted fix, because HEAD was a previous phase.
