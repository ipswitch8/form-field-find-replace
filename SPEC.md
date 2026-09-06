# Claude Code Prompt — Firefox "Form Field Find & Replace" Extension

Copy everything below the line into Claude Code.

---

## Step 0 — Security pass before any code (do this first, every session)

Run these in the project directory and report the results before writing anything:

```bash
find . -name ".git" -exec ls -ld {} \;
find . -name ".git" -exec chmod -R 700 {} \;
find . -name "*.swp" -o -name "*.tmp" -o -name "*~" -delete
grep -ri "password\|api.key\|secret\|token" . | head -5
```

Log the findings to `security-findings.log`. If anything CRITICAL turns up (committed
credentials, world-writable `.git`, keys in tracked files), stop and tell me — do not
continue to the build.

Because this is a new project, also create:

- `security-audit.sh` — repeatable scanner covering the checks above plus permission
  review of `manifest.json`, a scan for `eval`/`innerHTML`/`Function()` in extension
  code, and a check that no host permissions broader than needed are requested. Make it
  executable and exit non-zero on findings.
- `.claude-security.json` — project security config: paths to scan, ignore globs,
  severity thresholds, required manifest permissions allowlist.
- `CLAUDE.md` — security documentation: threat model for a browser extension that reads
  and writes page form fields, the permission rationale, what data the extension must
  never touch (password fields, autofill credentials), and the rule that nothing leaves
  the browser (no network calls, no telemetry, no analytics).

Flag any vulnerability you notice as you go rather than waiting until the end.

## Step 1 — What to build

A Firefox extension that finds and replaces text across the editable fields of the
current page. Name it **Form Field Find & Replace**.

### Manifest

- Manifest V3.
- `browser_specific_settings.gecko.id` set to `find-replace@example.local`, with
  `strict_min_version` of `115.0`.
- Permissions: `activeTab`, `scripting`, `storage`. No broad host permissions — inject
  the content script on demand via `browser.scripting.executeScript` from the popup.
- Background as an event page (`background.scripts`), not a service worker — Firefox's
  MV3 support for event pages is the safer path.
- No remote code, no CDN imports, no `eval`. Vanilla JS, no build step, no bundler.

### Popup UI

- Find field, Replace field.
- Checkboxes: match case, whole word, regular expression, include iframes.
- A collapsible **Field types** section — a checkbox per targetable type, so the user can
  restrict a run to, say, only textareas, or only date fields. Group them:
  - *Text*: `text`, `search`, `url`, `tel`, `email`
  - *Numeric and date*: `number`, `date`, `datetime-local`, `month`, `week`, `time`
  - *Multi-line*: `textarea`
  - *Rich text*: `contenteditable`
  Include "select all" / "select none" links and default to the *Text*, *Multi-line*, and
  *Rich text* groups checked, numeric/date unchecked (they're the ones most likely to be
  damaged by a careless replace).
- Buttons: **Count matches**, **Replace all**, **Undo last replace**, **Cancel**.
- A status line showing "N matches in M fields" or the regex compile error.
- A progress bar plus "field 1,240 of 8,715" counter, visible during long runs. Cancel
  is enabled only while a run is in flight.
- Persist the last-used find/replace strings, option states, and field-type selections in
  `storage.local`.
- Keyboard: Enter runs Replace all, Escape cancels a run in progress or otherwise closes.
- Style it plainly — system font stack, respects `prefers-color-scheme`. No frameworks.

### Content script behavior — this is where the real difficulty is

**Which elements to target** (filtered further by the popup's field-type checkboxes):

- `<textarea>`
- `<input>` where type is `text`, `search`, `url`, `tel`, `email`, `number`, `date`,
  `datetime-local`, `month`, `week`, or `time`
- Elements with `contenteditable` that is `""` or `"true"`

Treat a missing or unrecognized `type` attribute as `text`, matching how the browser
does. Expose the resolved type on each collected field so the filter and the reporting
can both use it.

**Value-format constraints on the non-text types.** `number`, `date`, `datetime-local`,
`month`, `week`, and `time` inputs reject anything that isn't a valid value for that
type — the assignment silently leaves `value` as the empty string. So for those types:
read `el.value` (the normalized form, e.g. `2026-03-14`), run the replacement, assign,
then immediately read `el.value` back. If it doesn't equal what you assigned, restore the
original and record the field as *skipped: invalid format*. Report the skipped count in
the status line so the user knows the run wasn't fully applied. Never leave a date field
blanked as a side effect of a failed replace.

**Which to skip, always:**

- `type="password"`, `type="hidden"`, `type="file"`
- Anything `disabled`, `readonly`, or `aria-readonly="true"`
- Elements inside a closed shadow root (unreachable — don't try to force it)
- Fields with zero rendered size (`offsetParent === null` and not `position: fixed`)

**Setting values so JS frameworks actually notice.** Assigning `el.value = x` directly
is silently ignored by React and by anything with a controlled-input pattern. Use the
native prototype setter, then fire events:

```js
const proto = el instanceof HTMLTextAreaElement
  ? HTMLTextAreaElement.prototype
  : HTMLInputElement.prototype;
Object.getOwnPropertyDescriptor(proto, "value").set.call(el, newValue);
el.dispatchEvent(new InputEvent("input", { bubbles: true }));
el.dispatchEvent(new Event("change", { bubbles: true }));
```

For `contenteditable`, walk text nodes and replace `nodeValue` per node rather than
rewriting `innerHTML` — rewriting the HTML destroys nested markup and any editor state.
Dispatch a bubbling `input` event on the host element afterward.

**Shadow DOM:** recurse into every open `shadowRoot` you encounter while walking the
tree. Write a single `collectFields(root)` generator that handles document, shadow
roots, and same-origin iframe documents uniformly.

**Iframes:** when the option is on, recurse into same-origin frames only. Wrap frame
access in try/catch and skip cross-origin frames quietly.

**Matching:**

- Plain mode: escape the needle, build a `RegExp` with `g` and conditional `i`.
- Whole word: wrap in `\b...\b`.
- Regex mode: compile the user's pattern inside try/catch, surface the error message in
  the popup instead of throwing.
- Guard against catastrophic backtracking: if a single field takes over 100ms to
  process, abort that field and report it.

**Backreferences.** In regex mode the replacement string is passed through to
`String.prototype.replace`, so the full substitution grammar works. Support and document
all of it:

- `$1` … `$99` — numbered capture groups
- `$<name>` — named groups, paired with `(?<name>...)` in the pattern
- `$&` — the whole match; `` $` `` and `$'` — text before and after the match
- `$$` — a literal dollar sign

Two things to get right. First, in *plain* (non-regex) mode the replacement must be
treated as a literal: escape `$` to `$$` before handing it to `replace`, otherwise a user
typing `$5.00` gets a mangled result. Second, validate that every numbered backreference
in the replacement has a corresponding group in the pattern, and that every `$<name>`
matches a declared named group — if not, warn in the popup before running rather than
silently substituting an empty string. Show a live preview of the first match's
substitution in the popup so the user can verify the groups landed where they expected.
- Count matches without mutating anything — the count path and the replace path should
  share one matcher function.

**Undo:** before the first mutation of a replace operation, snapshot each touched
element's original value into a module-level `Map` keyed by an element reference (use a
`WeakRef` or a plain array of `{el, value}` — the script's lifetime is the page's).
Undo restores those values through the same native-setter-plus-events path. One level of
undo is enough; say so in the UI.

### Scale — assume thousands of fields

Some pages are generated tables with several thousand inputs. The whole pipeline has to
stay linear and stay responsive.

- **Collect once.** Walk the DOM a single time into a flat array of field descriptors
  (`{el, kind, type, originalValue}`). Don't re-query the document per operation, don't
  build nested structures, and don't call `getComputedStyle` on every element — cache the
  visibility check and only fall back to computed style when `offsetParent` is null.
- **One linear pass.** Iterate the array with a plain indexed `for` loop. No recursion
  over the field list, no `Array.prototype.map` chains that allocate copies of it, and
  no per-field regex construction — compile the `RegExp` once outside the loop and reset
  `lastIndex` per field (a `/g/` regex is stateful and will skip matches otherwise).
- **Chunk and yield.** Process in batches of ~200 fields, then yield to the event loop
  with `await new Promise(r => setTimeout(r, 0))` before the next batch. This keeps the
  page from locking up and lets cancellation actually take effect. Tune the batch size
  against the fixture and note the chosen number in a comment.
- **Progress.** After each chunk, send `{type: "progress", done, total, replaced,
  skipped}` to the popup. Throttle to at most ~10 updates per second so the messaging
  itself doesn't become the bottleneck.
- **Cancellation.** Check a module-level `cancelled` flag at the top of each chunk. On
  cancel, stop cleanly and leave already-replaced fields in place — then report how many
  were changed, and keep the undo snapshot valid so the partial run can be reversed.
- **Undo at scale.** Store snapshots as a flat array of `{el, value}` pushed during the
  same pass, not a per-field object graph. Cap it (say 50,000 entries); past the cap,
  disable undo for that run and tell the user up front, before they hit Replace all.
- **Don't touch the DOM more than necessary.** Skip fields with no match entirely — no
  setter call, no events. Firing `input` on thousands of untouched fields will trigger
  every framework listener on the page for no reason.
- Report total wall time in the final status line so slow pages are visible.

### Message passing

Popup sends `{action: "count" | "replace" | "undo" | "cancel", find, replace, options,
fieldTypes}` and the content script responds `{ok, matches, fields, replaced, skipped,
error}`, with `{type: "progress", ...}` messages streamed in between. Validate the message shape on
the receiving end and ignore anything from an unexpected sender. Never `eval` or
`new Function` on anything that came across the wire — regex compilation via `new RegExp`
on a user-typed string is acceptable, but nothing else.

## Step 2 — Test fixtures

Create `test/fixture.html` containing, on one page:

1. A plain `<form>` with text input, email input, textarea, and a password field that
   must be left untouched.
2. A `contenteditable` div with nested `<b>` and `<span>` markup.
3. A field inside an open shadow root.
4. A same-origin iframe with its own form, plus a cross-origin iframe that should be
   skipped without error.
5. A disabled input and a readonly input.
6. A minimal controlled-input widget (a small vanilla imitation of React's pattern that
   reverts `value` unless a proper `input` event fires) to prove the native-setter path
   works.
7. One of each non-text type — `number`, `date`, `datetime-local`, `month`, `week`,
   `time` — prefilled with valid values, to exercise both a replace that produces a valid
   value and one that produces an invalid one (which must be rolled back, not blanked).
8. A second fixture, `test/fixture-bulk.html`, that generates 5,000 inputs via a script
   tag on load, with a known number of matches seeded among them. Use it to verify the
   progress counter increments, the UI stays interactive, cancel works mid-run, and undo
   restores the full set. Record the observed timings in the README.

## Step 3 — Deliverables

```
manifest.json
background.js
popup/popup.html, popup.js, popup.css
content/find-replace.js
test/fixture.html
security-audit.sh
.claude-security.json
CLAUDE.md
README.md
```

`README.md` covers: loading via `about:debugging` → This Firefox → Load Temporary
Add-on → pick `manifest.json`; how to run the fixture; known limitations (closed shadow
roots, cross-origin iframes, canvas- or CodeMirror-style editors that don't use real
form fields).

Run `npx web-ext lint` and fix everything it reports. Then run `./security-audit.sh` and
show me the clean output before you call it done.

## Step 4 — Working style

Build in this order and pause after each for me to check: manifest + popup shell →
content script field collection with counting only → field-type filtering → replacement
path with the native-setter and format-validation handling → regex backreferences and
the match preview → chunked loop with progress and cancel → shadow DOM and iframes →
undo → tests and audit. Don't write the whole thing in one shot.

Test against `fixture-bulk.html` as soon as the chunked loop exists, not at the end —
scale problems are much cheaper to fix before the shadow DOM and iframe traversal is
layered on top.