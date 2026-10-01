# Form Field Find & Replace

A Firefox Manifest V3 extension that finds and replaces text across the
editable form fields of the current page — plain text, whole-word, or full
regular expressions with backreferences — without ever leaving the browser.
See `CLAUDE.md` for the full security threat model and permission rationale.

## Getting the extension package

A **Mozilla-signed** `.xpi` is attached to each tagged release:

**https://github.com/ipswitch8/form-field-find-replace/releases/latest**

It is signed by addons.mozilla.org on the *unlisted* channel (self-distributed,
not published in the public add-on directory), so it installs permanently in
ordinary release Firefox with signature enforcement left on.

Build artifacts are gitignored, so no package lives in the source tree.

It is signed on the **unlisted** channel, which means self-distribution: it is
not listed in the public add-on directory and is not found by searching
addons.mozilla.org. `docs/amo/` holds the groundwork for a listed submission —
copy, privacy policy, and generated icons and screenshots — if that ever
becomes wanted. Nothing there has been submitted.

Questions: **inquiries@itwerx.net**

## Licence

MIT — see `LICENSE`. It is deliberately not shipped inside the `.xpi`; see the
comment in `web-ext-config.cjs` for why.

## Installing

### Permanent — any Firefox, including release (recommended)

1. Download the signed `.xpi` from the release above.
2. Open `about:addons`.
3. Gear icon → **Install Add-on From File…**.
4. Select the `.xpi` and confirm.

No `about:config` changes are needed. The add-on persists across restarts.

> **"This add-on could not be installed because it has not been verified"**
>
> That message almost always means an *unsigned* build was selected, not that
> signing failed. `npm run build:xpi` leaves unsigned dev builds in
> `web-ext-artifacts/` next to the signed release, and the names differ only by
> a `-signed` suffix — easy to pick the wrong one.
>
> To see which is which, without launching Firefox:
>
> ```bash
> npm run check:xpi
> ```
>
> It prints SIGNED/UNSIGNED, the add-on id, the SHA256, and verifies that every
> file digest still matches the signature, for each `.xpi` it finds. Only a file
> it reports as `SIGNED` will install permanently.

### Temporary — for development, removed on restart

1. Open `about:debugging`.
2. Click **This Firefox** in the left sidebar.
3. Click **Load Temporary Add-on…**.
4. Select an `.xpi`, or `manifest.json` from the root of this repository.

Either way, the toolbar button appears under the puzzle-piece extensions icon;
pin it to the toolbar if you want it one click away. Click it to open the popup
on the current tab.

## Building and signing it yourself

```bash
npm run build:xpi     # unsigned package -> web-ext-artifacts/
bash sign.sh          # submit to AMO, download the signed .xpi
```

`build:xpi` writes `web-ext-artifacts/form_field_find_replace-<version>.zip`
plus a copy at `web-ext-artifacts/ffr.xpi` (the Selenium suite installs that
copy). A Firefox `.xpi` is just a zip, so renaming the `.zip` is sufficient for
a temporary load.

`sign.sh` needs AMO API credentials from
https://addons.mozilla.org/en-US/developers/addon/api/key/ , placed in a
`.amo-credentials` file in the repository root:

```
WEB_EXT_API_KEY=user:12345678:123
WEB_EXT_API_SECRET=<the long secret>
```

That filename is gitignored **and** excluded from the packaged archive — worth
being deliberate about, since `web-ext sign` uploads the built archive to
Mozilla, so anything not excluded leaves the machine.

To confirm a signed build really is valid, `python
test/selenium/verify_signed.py` performs a **permanent** install into a real
Firefox with `xpinstall.signatures.required` left **on**. A temporary install
accepts anything and proves nothing; only the permanent path exercises
signature enforcement.

Note that the add-on id (`inquiries@itwerx.net`) binds permanently to the AMO
account on first submission and cannot be reused, so change it before your
first signing run, not after.

It was `mhasse@itwerx.net` up to and including v0.5.0. Changing it makes this a
**different add-on** to Firefox and AMO — v0.5.0 does not upgrade to v0.6.0,
and anyone running the older build must remove it and install the new one. That
was an acceptable break here only because there were no installations outside
this machine at the time. Do not repeat it casually once the add-on is listed.

## Running the tests

The test suite uses [Playwright](https://playwright.dev/) driving real
Firefox against the fixture pages in `test/`.

```bash
npm install
npm test
```

`npm test` runs the full Playwright suite (currently 61 tests) against
`test/fixture.html` (small, feature-focused fixture: password/hidden/disabled/
readonly fields, contenteditable, shadow DOM, same-origin and cross-origin
iframes, a controlled-input widget, and one of each numeric/date input type)
and `test/fixture-bulk.html` (5,000 generated inputs with a known seeded
match count, used for the chunked-processing/progress/cancel/undo-at-scale
tests). Results are written to `test-results/gtest-results.xml` in JUnit
format.

To open the fixtures directly for manual poking, load `test/fixture.html` or
`test/fixture-bulk.html` in a browser tab, then run the extension against
that tab.

### Selenium end-to-end tests (the actually-loaded extension)

The Playwright suite deliberately does **not** load the extension — Playwright
cannot install a Firefox add-on, so those tests inject `content/find-replace.js`
into a fixture page and call its functions directly. That is thorough coverage
of the logic, but it means the real add-on plumbing is not exercised there.

The Selenium suite closes that gap. It installs the built `.xpi` into a real
Firefox as a temporary add-on and covers what Playwright structurally cannot:

```bash
npm run test:selenium          # builds the .xpi, then runs the suite
npm run test:selenium:smoke    # quick "does Firefox + the add-on start" probe
```

Requires real Firefox and `selenium >= 4.11` (Selenium Manager fetches
geckodriver automatically). Set `FFR_HEADLESS=0` to watch it run.

| Test | What it proves that Playwright cannot |
|---|---|
| extension loads, popup renders | the manifest is accepted by a real Firefox, not merely lint-clean |
| `browser.*` present in popup | popup.js runs against the real WebExtension APIs (the Playwright popup tests load `popup.html` over `file://`, where `browser` is undefined) |
| field-type defaults | the shipped popup's defaults, in the real extension context |
| storage.local round trip | persistence really survives a popup reload through the actual storage API |
| injection without a gesture is refused | **security**: with no host permissions, Firefox refuses `scripting.executeScript` with "Missing host permission for the tab" until the user invokes the extension. If this ever stops failing, permissions have been widened and the extension can read every open page. |
| toolbar action registered and clickable | the real entry point exists in Firefox's unified extensions panel and can be invoked |
| **real toolbar click injects the content script** | clicking the actual button opens the popup, which injects into the page without error. This is the test that caught the extension being completely non-functional — see below. |

### The bug this suite exists for

An earlier version of this extension did not work at all. `manifest.json` sets
`action.default_popup`, so `browser.action.onClicked` never fires, so the
injection wired to that listener in `background.js` was dead code and the popup
messaged a content script nobody had injected. Every real click produced
"Could not reach the page".

All 61 Playwright tests passed throughout, because every one of them injects
`content/find-replace.js` itself — by construction they can never exercise the
extension's own activation path. Only clicking the real button in a real Firefox
found it.

The fix then hit a second, subtler bug of the same family: `executeScript`'s
`files` path was `"content/find-replace.js"`, which Firefox resolved against the
popup's base URI as `/popup/content/find-replace.js` and failed to load. The
mocked Playwright test asserted the exact string it had been handed, so it
agreed with the bug and passed. The leading slash in
`popup.js`'s `CONTENT_SCRIPT_PATH` is load-bearing; both the Playwright
assertion and the Selenium test now guard it.

**Known boundary.** The suite verifies that the real click injects cleanly, but
does not then drive the popup's own buttons to complete a replace: the popup is
an out-of-process `browser` element in browser chrome and its document is not
reachable from Marionette's chrome context. Note also that a real content script
runs in an **isolated world**, so `window.__ffr` is deliberately invisible to
page-context `execute_script` — the Selenium test asserts on the absence of
extension errors in Firefox's console service instead, which is what actually
distinguishes a successful injection from a failed one. Closing the last gap
would need a WebDriver BiDi session against the popup's browsing context.

Two environment notes, both specific to this host rather than the extension:

- `install_addon` raises `NS_ERROR_FILE_ACCESS_DENIED` because endpoint
  protection briefly locks the temp `.xpi` Firefox writes into its profile, so
  Firefox's post-install cleanup fails. The add-on installs fine; the suite
  tolerates that specific error and then *proves* the add-on is live by loading
  a page that only exists inside it.
- Chrome context needs `geckodriver --allow-system-access`. Firefox 142 rejects
  the equivalent `-remote-allow-system-access` when passed via capabilities.

## Backreference / substitution grammar (regex mode)

When **Regular expression** is checked, the replacement string is passed
through to `String.prototype.replace` untouched, so the full native
substitution grammar is available:

| Token | Meaning |
|---|---|
| `$1` … `$99` | Numbered capture group — text matched by the *n*th `(...)` group in the pattern. |
| `$<name>` | Named capture group — pairs with `(?<name>...)` in the pattern. |
| `$&` | The entire matched substring. |
| `` $` `` | Everything in the field's text *before* the match. |
| `$'` | Everything in the field's text *after* the match. |
| `$$` | A literal `$` character. |

Before a replace run starts, every `$N` and `$<name>` token in the
replacement string is checked against the compiled pattern's actual group
count and names. A mismatch (e.g. `$3` when the pattern only has two capture
groups, or `$<foo>` when no `(?<foo>...)` group exists) blocks the run and
shows a warning in the status line instead of silently substituting an empty
string. The popup also shows a live preview of the first match's substitution
result as you type, computed by the same matcher function used for the real
run — there is exactly one matching implementation shared by count, replace,
and preview.

**Plain (non-regex) mode treats the replacement as a literal.** Any `$` you
type is escaped to `$$` before being handed to `replace`, so typing `$5.00`
as the replacement produces exactly `$5.00` — it is not accidentally
interpreted as a backreference.

## Performance: the 5,000-field bulk run

`test/fixture-bulk.html` generates 5,000 input fields with a known number of
seeded matches (documented as a constant in that file) and is the basis for
every timing claim below. Numbers are wall-clock, measured end-to-end from
`replace all` to the final `{done: total}` progress/status message, in
Firefox via this project's own Playwright harness (3 runs per configuration).

| Chunk size | Chunk-boundary yields | Observed wall time |
|---|---|---|
| 50 | 100 | 414–418 ms |
| **200 (shipped)** | **25** | **99–108 ms** |
| 1000 | 5 | 16–20 ms |

The shipped `CHUNK_SIZE` in `content/find-replace.js` is **200**, chosen
between `~200 fields/chunk` per SPEC.md and confirmed empirically against
this fixture.

**This is not the fastest configuration — it is a deliberate tradeoff.**
Wall time tracks the *number* of event-loop yields, not per-field work,
because Firefox clamps `setTimeout(0)` to roughly 4 ms regardless of how
little work is queued behind it. Fewer, bigger chunks (1000/chunk) finish
faster in raw wall-clock terms specifically because there are fewer 4 ms
floors to pay — but cancellation can only take effect at a chunk boundary,
so a 1000-field chunk means up to 1000 fields can still be mutated after the
user clicks **Cancel**, and the page goes unresponsive for longer between
progress updates. 200 keeps that window small (worst case ~100 ms, which is
imperceptible as a single frame) while keeping total overhead low. This
number is recorded as a comment at the `CHUNK_SIZE` declaration in
`content/find-replace.js` alongside the same measurements.

## Spaces in rich-text fields

When you type two or more consecutive spaces into a rich-text
(`contenteditable`) field, the browser does not store them as plain spaces. It
substitutes **U+00A0**, the non-breaking space, for some of them — otherwise
HTML would collapse the run down to a single visible space. Typing three spaces
typically yields the sequence `NBSP, space, NBSP`.

This is invisible to you: the field looks like three spaces, and copying the
text out reads back as three space-looking characters. But a search for three
*plain* spaces is three `U+0020` characters, and those do not equal `U+00A0` —
so the search finds nothing, while the same phrase without leading spaces
matches immediately.

In **plain** and **whole word** modes, each literal space you type in the Find
box therefore matches either a plain space or a non-breaking space:

| Codepoint | | Matched by a typed space? |
|---|---|---|
| `U+0020` | space | **Yes** |
| `U+00A0` | no-break space | **Yes** — this is what the browser substitutes |
| `U+2007` | figure space | No |
| `U+202F` | narrow no-break space | No |
| `U+2009` | thin space | No |

The last three are deliberate typographic characters — someone inserted them on
purpose. A plain space silently matching them would make a destructive replace
touch text you never meant to touch, so they are excluded. If you do want to
match them, use **regular expression** mode, where JavaScript's `\s` covers all
of them.

**Regex mode is unaffected.** Your pattern is passed through exactly as written,
and `\s` already matches `U+00A0`.

### What happens to the non-breaking spaces when you replace

If a match containing non-breaking spaces is replaced, the replacement is
inserted exactly as you typed it. So replacing `"   to a brief"` with
`"   to a summary"` writes three *plain* spaces where the browser had put
non-breaking ones — and HTML will then collapse them to a single visible space.

That is a real, visible change to the document's spacing, and it is deliberate:
the alternative is second-guessing which of your replacement's characters ought
to become non-breaking, which would be worse. If you need the indentation
preserved, type non-breaking spaces into the Replace box, or use regex mode.

## Remembered find/replace history

The Find and Replace boxes remember what you have run before. Clicking (or
focusing) either box opens a dropdown of previous entries; picking one refills
*both* boxes and restores the option checkboxes that were in effect at the time.

This section is the design decision, written down before the code was built,
because several of its choices are load-bearing and would otherwise look
arbitrary to the next reader. Everything it describes is now implemented — the
"implementation status" note that sat here while the dropdown was still being
built has been deleted, which is what it asked to have happen.

### One shared list of paired entries, not two independent lists

History is **one list**. Each entry records, as a single unit:

- the Find value,
- the Replace value,
- all four option flags — `matchCase`, `wholeWord`, `regex`, `includeIframes`,
- the complete `fieldTypes` selection map (all thirteen checkboxes).

There is deliberately **no** separate find-only list and replace-only list.
The settings have to travel with the entry to be useful: a remembered Find
value of `(\$\d+),[\d,.]+` means nothing without `regex` turned on, and
recalling it into a popup with `regex` off would silently search for that text
literally and report no matches. Splitting find and replace into independent
lists would make "which settings belong to this value" unanswerable, since a
find from one run could be paired with a replace from another.

So selecting *any* entry — from either box's dropdown — restores the whole
tuple. Both dropdowns list the same entries; they differ only in which value
each row shows first.

### Where it is stored, and the bound

| Decision | Value |
|---|---|
| Storage area | `browser.storage.local` — never `storage.sync`, same as the rest of the extension |
| Key | `formFieldFindReplaceHistory` |
| Maximum entries | **20** |
| Eviction | Newest-first. Index 0 is the most recent. Re-saving an entry whose find, replace, options and fieldTypes are all identical to an existing one *moves that entry to the front* rather than adding a duplicate. When the list would exceed 20, the tail entry is dropped. |
| Save trigger | Only when **Count matches** or **Replace all** is invoked with a non-empty Find value. |

Stated as "newest-first" rather than "most-recently-used" on purpose. With
re-recording as the only promotion trigger, MRU and plain FIFO-with-dedup are
indistinguishable — a gate rightly objected to the stronger word claiming a
distinction no test could observe. Selection-driven promotion is what makes the
ordering genuinely usage-based, and it is the dropdown's job; until the dropdown
exists there is no select path to promote from.

The key is deliberately **separate** from the existing
`formFieldFindReplace` state key, which holds only the last-typed values. Two
keys means the two concerns can be read, reasoned about, and cleared
independently — clearing your history does not reset your current options, and
vice versa.

The bound is not decoration. `storage.local` has no per-key quota the
extension can rely on, and a remembered value is arbitrary text the user may
have copied off a page, so it can be long. An unbounded list would grow with
every run for the life of the profile. 20 is enough to cover a working
session's worth of patterns while keeping the worst case small.

**Why the save trigger is an action and not a keystroke.** Persisting on every
`input` event would fill the list with prefixes of what you were typing —
`f`, `fo`, `foo` — and evict the entries you actually wanted within a few
seconds of typing. Recording only on Count or Replace all means an entry
represents a search you *meant*, and it is the same gesture in both cases:
Count is the read-only rehearsal for a replace, and a pattern worth counting
is worth remembering.

Remembered values are stored as inert strings. Nothing reads them back as
code, as markup, or as a regex source without the user's own `regex`
checkbox saying so.

### Why the dropdown is an absolutely-positioned overlay

Each dropdown is rendered as an `position: absolute` overlay anchored under
its input, **not** inserted into the popup's normal document flow.

That is a requirement, not a style preference. The popup must display every
element without vertical scrolling (see below), and a dropdown that occupied
real layout space would add its own height to the document the moment it
opened — turning a popup that fits into one that does not, in exactly the
state where the user is mid-interaction and least able to tolerate the content
jumping. Taking the overlay out of flow means opening the dropdown cannot
change `document.documentElement.scrollHeight` at all. A test asserts that
for the worst-case state: field types expanded *and* a dropdown open.

Every row is built with `document.createElement` and `textContent`. No
`innerHTML`, anywhere — `security-audit.sh` fails the build on it, and a
remembered value is precisely the kind of user-supplied text that makes that
rule matter rather than being theoretical.

### Keyboard and automation

The dropdown implements the ARIA combobox/listbox pattern: the input carries
`role="combobox"` with `aria-expanded` and `aria-controls`; the overlay is a
`role="listbox"` of `role="option"` rows. `ArrowDown`/`ArrowUp` move the
active option, `Enter` selects it, and `Escape` closes the dropdown
*without* falling through to the popup's global Escape handler (which cancels
a run or closes the popup) — the first Escape belongs to the dropdown.

Listbox containers and option rows both carry stable `id` and `data-testid`
attributes, so Selenium and Playwright can address them without relying on
position or text.

`ArrowDown` and `ArrowUp` also *open* a closed dropdown and land on the first
or last entry, so the whole feature is reachable without a mouse. `Tab` closes
it and moves on normally. Wrapping is deliberate: `ArrowUp` from nothing goes
straight to the oldest remembered search, which on a twenty-entry list is one
keystroke instead of nineteen.

A dropdown, being an overlay, covers what is beneath it while open. In the
two-column layout that means the Options checkboxes sit under the Find
dropdown. Dismiss it — `Escape`, a click elsewhere, or picking an entry — and
they are reachable again. That is ordinary combobox behaviour rather than a
quirk, and there is a test for it.

### Clearing the remembered list

Each dropdown has a **Clear history** button at its foot. It empties the list
in memory and in `storage.local`, closes the dropdown, and leaves whatever you
are currently typing — find, replace, and every option — untouched.

There is no confirmation prompt. Forgetting a past search destroys nothing, and
a prompt in front of a harmless action just trains people to click through
prompts.

It exists because a security review pointed out something the feature's own
design had glossed over: this extension already put the popup's typed text in
`storage.local`, but bounding history at twenty entries took *retention* from
one entry to twenty. Someone who pastes a password or a customer record into
the Find box needs a way to get rid of it that does not involve clearing their
whole browser profile.

## Popup size: why it is 620px wide and cannot be taller

A Firefox extension popup cannot exceed **800x600**. Past that Firefox does not
grow the panel, it scrolls it — so the popup's height is not something the
stylesheet gets to choose, and "make it taller" is not a fix available for a
layout that does not fit.

The popup is 620px wide, which leaves 180px of headroom under the cap for a
longer translated label or a wider system font, and is wide enough for two
columns. The columns are what buys the height back: Find beside Replace,
Options beside Field types, and the thirteen field-type checkboxes flowing into
a grid instead of thirteen stacked rows.

In its default state — field types expanded, as a user first sees it — the
popup is 481px tall. Before this layout it was 1032px, i.e. it scrolled
immediately, on every open, with nothing to be done about it from inside the
popup.

`test/popup-layout.spec.js` holds that. It measures
`scrollHeight <= clientHeight` with zero tolerance, and the content height
against the 600px cap, in five states: the default; the undo-cap banner at its
longest; the longest realistic status line; a dropdown open; and all of those
at once. It also asserts that opening a dropdown changes the document's height
by exactly zero, and that the fit does not depend on the field-types section
being collapsed — because defaulting that section to collapsed would have made
the numbers pass while leaving the popup as unhelpful as before.

The same spec deliberately does **not** rely on Playwright's default viewport,
which is far taller than a real popup and would let an overflowing document
look fine. It reads the width the stylesheet declares and pins the height to
the 600px cap.

`popup/popup.css` carries a measured table showing which parts of the layout
actually do the work, because two earlier versions of that comment guessed and
were wrong both times.

## Known limitations

- **Closed shadow roots are unreachable by design.** There is no supported
  way for content-script JavaScript to access a closed shadow root's
  contents, and the extension does not attempt to work around that — fields
  inside a closed shadow root are simply never found.
- **Cross-origin iframes are skipped silently.** Accessing a cross-origin
  frame's document throws a `SecurityError`; the extension catches it and
  moves on without surfacing an error to the popup or aborting the run.
- **Canvas-based and CodeMirror-style editors are not supported.** Anything
  that renders its own text via `<canvas>`, or a rich editor (CodeMirror,
  Monaco, ProseMirror, etc.) that keeps its authoritative state outside a
  real `<textarea>`/`contenteditable` DOM node, does not expose a form field
  the extension can find or safely mutate. Only genuine `<textarea>`,
  recognized `<input>` types, and `contenteditable` regions are targeted.
- **The catastrophic-backtracking guard bounds *repeat* damage, not the
  first freeze.** The 100 ms per-field time budget is measured *after* the
  synchronous `RegExp` call returns — vanilla JavaScript cannot preempt a
  running regex mid-execution without moving the work into a Web Worker,
  which this extension deliberately does not do (no build step, no extra
  message-passing surface). In practice this means: a genuinely pathological
  user-supplied regex (nested quantifiers like `(a+)+b` against a
  non-matching string) can still freeze the page for the duration of that one
  field's `replace()` call — potentially seconds, not milliseconds — before
  the guard detects the overrun and skips that field for the rest of the run.
  The guard prevents a bad regex from freezing the *entire* run field-by-field
  after the first hit; it does not and cannot prevent that first hit.
- **One level of undo only, and it is capped.** `Undo last replace` restores
  the fields touched by the most recent replace run (or the fields touched
  before a cancel), through the same native-setter-plus-events path as a
  replace — starting a new replace run discards the previous undo snapshot.
  Undo snapshots are capped at 50,000 entries; if the collected field count
  for a run would exceed that cap, undo is disabled for that run and the
  popup warns the user *before* Replace all begins, not after.

## Packaging: what is and isn't reviewed by `web-ext`

`web-ext-config.cjs` sets `ignoreFiles` so `npx web-ext lint` and
`npx web-ext build` only ever see shipped extension code — `test/`,
`test-results/`, `playwright.config.js`, `node_modules/`, the security
tooling, and this documentation are excluded. (A plain `.web-ext-ignore` file
is *not* auto-discovered by `web-ext` 10.x — only a `web-ext-config.{js,cjs}`
CommonJS config, or the `--ignore-files` CLI flag, actually changes what
`lint`/`build` see. This was verified empirically against the installed
version before relying on it.)

### The exclusion list is not the whole guard

`ignoreFiles` only excludes what someone thought of, and something once got
through it. A shell redirect to the Windows reserved device name `nul` does not
discard output — it creates a real directory called `nul`. Git cannot stat such
a path, so `.gitignore` never applied and `git status` never mentioned it, and
`web-ext` happily packaged `nul/.last-run.json`, a Playwright run cache, inside
the shipped `.xpi`. A security review found it there. The contents were inert,
but it had no business in a file a user installs.

`nul`, `con`, `prn` and `aux` are now in `ignoreFiles`, which fixes that name.
The general fix is that **`npm run check:xpi` now asserts an allowlist**: the
archive must contain exactly the seven files the extension ships (plus
`META-INF/*` on a signed build) and nothing else, whatever it is called. A stray
entry exits `3` — distinct from the `1` that merely means "this dev build is not
signed yet" — so a packaging defect reads differently from a missing signing
step.

That check was verified by reproducing the original leak: injecting
`nul/.last-run.json` into a built archive makes it fail and name the file.

With the exclusions in place, `npx web-ext lint` reports **0 errors and 2
warnings**, both `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION` (desktop and Android),
for `data_collection_permissions`.

That key is declared as `{"required": ["none"]}` — accurate, since nothing here
collects data (see `CLAUDE.md`'s "nothing leaves the browser" rule). It is
unsupported at the spec-mandated `strict_min_version: "115.0"`, so declaring it
trades the single `MISSING_DATA_COLLECTION_PERMISSIONS` warning for those two.

An earlier revision omitted the key for exactly that reason, and that was the
right call while the only target was temporary local loading. It is the wrong
call for a distributable build: the key is **required for new
addons.mozilla.org submissions**, so signing fails validation without it. The
key is forward-compatible — Firefox ignores manifest keys it does not
recognise — and errors remain at zero, so the trade is worth making.

### The four options, measured

Each alternative was tried and linted rather than reasoned about:

| manifest | errors | warnings | which |
|---|---|---|---|
| **115.0 + the key** (as shipped) | 0 | **2** | `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION`, desktop and Android |
| 115.0, no key | 0 | 1 | `MISSING_DATA_COLLECTION_PERMISSIONS` |
| 140.0 + the key | 0 | 1 | Android only — Android did not get the key until 142 |
| no `strict_min_version` + the key | 0 | **0** | — |

Zero warnings is available, and is not taken. Dropping `strict_min_version`
only stops *declaring* a floor; it does not create compatibility. AMO would
then infer one from the manifest, which is a worse answer than a deliberate
one. Raising it to 140 would abandon every Firefox from 115 to 139 to silence a
cosmetic warning — and would still leave the Android one, since Android did not
get the key until 142.

So the two warnings stand. They are AMO saying "you support back to 115, but
this key does nothing before 140" — a feature absent on old versions, not a
fault.

### What is *not* verified: the 115 floor itself

`strict_min_version: "115.0"` comes from `SPEC.md`, and **nothing in this
project tests it.** The suites run against whatever Firefox is installed:
Playwright uses 155, Selenium uses the system Firefox, 142 at the time of
writing. Both are past 140, so no test has ever exercised a Firefox that
*lacks* `data_collection_permissions`, and none has exercised 115.

Every API the extension uses (`scripting`, `storage`, `tabs`, `runtime`,
`action`) predates 115 comfortably, and MV3 event pages have been supported
since 109, so 115 is *plausible*. It is not *demonstrated*. Treat it as a
declared intention rather than a tested guarantee, and if it ever matters,
test it on an actual 115 ESR before relying on it.

## Security tooling

Run `bash security-audit.sh` (works regardless of the executable bit, which
is cosmetic on this project's NTFS host and is instead recorded via
`git update-index --chmod=+x`) to run the automated scanner: credential/secret
grep, `.git` permission review, manifest permission review against
`.claude-security.json`'s allowlist, a live-code (not comment) scan for
`eval`/`innerHTML`/`Function(` under `popup/` and `content/`, and a
host-permission breadth check. It exits non-zero if it finds anything. See
`CLAUDE.md` for the reasoning behind each check.
