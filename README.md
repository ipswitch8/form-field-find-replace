# Form Field Find & Replace

A Firefox Manifest V3 extension that finds and replaces text across the
editable form fields of the current page — plain text, whole-word, or full
regular expressions with backreferences — without ever leaving the browser.
See `CLAUDE.md` for the full security threat model and permission rationale.

## Loading the extension

1. Open `about:debugging` in Firefox.
2. Click **This Firefox** in the left sidebar.
3. Click **Load Temporary Add-on…**.
4. Select `manifest.json` from the root of this repository.
5. The toolbar icon appears; click it to open the popup on the current tab.

This is a temporary install — it is removed when Firefox restarts. There is
no packaged `.xpi` to sign for local development; `npx web-ext build` (see
below) produces one for distribution testing.

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

With that in place, `npx web-ext lint` reports exactly one warning:
`MISSING_DATA_COLLECTION_PERMISSIONS`. This is left as-is intentionally —
Firefox's `data_collection_permissions` manifest key is unsupported below a
strict_min_version that post-dates this extension's spec-mandated `115.0`.
Adding the key at `strict_min_version: "115.0"` does not clear the warning;
it *replaces one warning with two* (`KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION`),
which is strictly worse. The single `MISSING_DATA_COLLECTION_PERMISSIONS`
warning is accepted as-is; nothing in this extension collects data in the
first place (see `CLAUDE.md`'s "nothing leaves the browser" rule), so the key
would be declaring an empty policy for a capability that doesn't exist.

## Security tooling

Run `bash security-audit.sh` (works regardless of the executable bit, which
is cosmetic on this project's NTFS host and is instead recorded via
`git update-index --chmod=+x`) to run the automated scanner: credential/secret
grep, `.git` permission review, manifest permission review against
`.claude-security.json`'s allowlist, a live-code (not comment) scan for
`eval`/`innerHTML`/`Function(` under `popup/` and `content/`, and a
host-permission breadth check. It exits non-zero if it finds anything. See
`CLAUDE.md` for the reasoning behind each check.
