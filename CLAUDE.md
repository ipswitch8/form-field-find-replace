# CLAUDE.md — Security Documentation

Security documentation for the **Form Field Find & Replace** Firefox extension
(`inquiries@itwerx.net`). This file is the authoritative record of the
threat model, permission rationale, and the hard rules the codebase must never
violate. `security-audit.sh` mechanically enforces a subset of this; the rest
is enforced by code review against this document.

---

## Threat model

This extension reads and rewrites the values of editable form fields on
**whatever page the user is currently viewing**, on demand. That capability is
the entire attack surface, and it breaks into three actors:

1. **The extension itself**, if it were malicious or compromised (supply-chain
   risk — but there is no supply chain here: no npm runtime dependencies are
   shipped, no CDN imports, no build step, no bundler; the shipped code is
   exactly the vanilla JS files in this repository).
2. **The web page**, which the extension must not trust. A page can install
   getters/setters, proxy `Object.prototype`, run inside an iframe designed to
   look like part of the extension's own UI, or contain deliberately
   pathological regex-bait content designed to hang a naive replace loop.
3. **The user**, who can type an arbitrary regular expression (including a
   catastrophically backtracking one) or an arbitrary replacement string
   containing backreference syntax. User input is treated as data for
   `RegExp`/`String.prototype.replace`, never as code.

**What the extension can do to a page:** read the text content of visible,
enabled, non-password/hidden/file form fields and contenteditable regions, and
overwrite it via the same native-setter-plus-events path a real user
interaction would trigger. That is a real capability for harm — it can
silently corrupt page data — which is why scope is deliberately narrow (see
below) and why every destructive path (regex compile, replace, undo) fails
closed rather than open.

**What the extension explicitly does NOT defend against:** a browser or OS
already compromised, a malicious `about:debugging` load of a tampered copy of
this code, or the user intentionally running a destructive find/replace on
their own data. Those are out of scope for a client-side content script.

---

## Permission rationale

`manifest.json` requests exactly three permissions and nothing else:

| Permission | Why it is needed | Why nothing broader |
|---|---|---|
| `activeTab` | Grants temporary access to the tab the user is currently interacting with, only after an explicit user gesture (clicking the toolbar action). | This is what makes `host_permissions` unnecessary. `activeTab` never persists across navigations or tabs, so there is no ambient access sitting in the background. |
| `scripting` | Lets the **popup** call `browser.scripting.executeScript` to inject `content/find-replace.js` into the active tab, on demand, at the moment the user invokes the extension. | Injection is per-invocation, not declarative. The manifest has no `content_scripts` entry and no `matches` pattern — the extension is not present on any page until the user asks for it. |

| `storage` | Persists, in `storage.local`, two things under two separate keys: (a) `formFieldFindReplace` — the last-used find/replace strings, checkbox states, and field-type selections, so the popup reopens as you left it; and (b) `formFieldFindReplaceHistory` — a **bounded list of at most 20 previous searches**, each pairing a find value, a replace value, all four option flags and the complete field-type map, which the Find/Replace dropdowns offer back to you. | `storage.local` is local to the browser profile. Nothing is synced, nothing is remote — the extension never touches the `sync` area, and a test scans `popup/popup.js`'s own source and installs a runtime spy to prove it. |

### What the remembered history does and does not change about the threat model

This is called out explicitly because it was reviewed and the review's reasoning
is worth keeping.

The history introduces **no new data class**. It stores the same thing the
last-used-state key already stored — text the user typed into the popup's own
boxes — in the same place, `storage.local`, reachable by the same permission,
with the same zero network calls. It is not page content: `collectState()` reads
`els.find.value` and `els.replace.value`, never a field on the page.

What it does change is **retention depth**: from one entry to twenty. That is a
real difference. A password or a customer record pasted into the Find box now
persists across up to twenty entries instead of being overwritten by the next
search. Three things bound that:

- **The list is capped at 20**, enforced on both the write path
  (`recordHistoryEntry`) and the read path (`loadHistory`), so a hand-tampered
  oversized array cannot survive a load or be written back oversized.
- **Nothing is recorded without a deliberate action.** Only `Count matches` and
  `Replace all`, and only with a non-empty find. Typing records nothing.
- **A `Clear history` control exists** on both dropdowns, which empties the list
  in memory and in `storage.local`. Added because the absence of one was raised
  as a finding: increasing retention without offering a way to undo it would have
  left the user no recourse short of clearing their profile.

Values come back out through `normalizeHistoryEntry`, which treats stored data
as untrusted in *shape* — a hand-edited or half-written value cannot throw during
startup — and emits strings and booleans only. A remembered value is inert data:
nothing reads it as markup, and nothing compiles it as a regex unless the user's
own `regex` checkbox says so.

### Why injection is popup-driven, not background-driven

`manifest.json` sets `action.default_popup`, and per the WebExtension spec
`browser.action.onClicked` **never fires** when a popup is configured — the
browser opens the popup instead of dispatching a click event. An earlier version
wired injection to that listener in `background.js`; it was dead code, and the
extension could not reach any page at all. Injection now happens from
`popup.js`, which is the correct place: the click that opened the popup is
itself the user gesture that grants `activeTab`, so the popup holds the grant.

The popup pings the content script before injecting and injects only if the ping
gets no answer. Re-injecting would re-run the content script's IIFE and reset
its module-level state — including the undo snapshot — so a user who ran a
replace, closed the popup and reopened it would silently lose Undo.

`background.js` remains as the MV3 event page required by the spec, but it does
not perform injection.

### The content script owns undo state, not the popup

The popup document is destroyed every time the popup closes, so **every
module-level variable in `popup.js` is reinitialised on each open**. It
therefore cannot be trusted to remember whether an undo snapshot exists. Only
the content script, which lives as long as the page, actually knows.

So the `ping` and `count` responses carry `undoAvailable` and `undoCount`,
derived from the snapshot's real length, and the popup sets its Undo button
from those rather than from its own boolean. `count` doubles as a resync point:
the popup can sit open while the tab navigates away, destroying the snapshot,
and without that resync Undo would keep rendering enabled until the user
clicked it and got "Nothing was restored".

`handleUndo` in the popup reads `response.restored` and treats `0` as a
failure. The content script answers `{ok: true, restored: 0}` on an empty
snapshot — `ok` means "the message was handled", not "your text came back" —
and conflating the two is what made an earlier version report "Undo complete."
while the user's original text was gone for good.

An earlier revision of this file claimed the popup's own state "persists
independently" across open/close. It does not, and that false sentence is
precisely how the bug stayed hidden. Comments asserting a data flow that a grep
would disprove have now cost this project three defects; prefer a statement a
test pins down.

**No `host_permissions` entry exists, on purpose.** A host permission would
grant the extension standing access to page content on every navigation,
whether or not the user ever opens the popup. `activeTab` + on-demand
`scripting.executeScript` achieves the same functional result — the content
script only ever runs when the user has just clicked the extension — with a
strictly smaller ambient footprint. `security-audit.sh` fails the build if
`host_permissions` is ever added or if `permissions` gains a wildcard
(`<all_urls>` or any pattern containing `*`).

`browser_specific_settings.gecko.data_collection_permissions` is declared as
`{"required": ["none"]}` — an accurate statement, since this extension collects
nothing and makes no network calls. That key is required for new
addons.mozilla.org submissions, so signing fails validation without it.

It is not supported at the spec-mandated `strict_min_version: "115.0"`, so
declaring it trades the `MISSING_DATA_COLLECTION_PERMISSIONS` warning for two
`KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION` warnings. That is the correct trade:
the key is forward-compatible (Firefox 115 ignores manifest keys it does not
recognise), errors stay at zero, and the alternative is a package that cannot
be signed. An earlier revision omitted the key for exactly the opposite reason,
when the only target was temporary local loading.

---

## What the extension must NEVER touch

- **`type="password"` fields** — always skipped at the field-collection stage
  (`collectFields`), before any matching or replacement logic runs. This is
  not a filter applied after collection; the field is never added to the flat
  descriptor array in the first place.
- **`type="hidden"` and `type="file"` fields** — same always-skip treatment.
  Hidden fields frequently carry CSRF tokens, session identifiers, or other
  security-relevant state that has no business being touched by a find/replace
  tool; file inputs cannot be usefully "replaced" and attempting to manipulate
  their value is a browser security violation regardless.
- **Autofill credential data** — the extension never reads
  `browser.storage.sync`, never queries saved-password stores, never inspects
  autofill suggestion dropdowns, and has no permission (`nativeMessaging`,
  broad host access, etc.) that could reach them even if it wanted to.
- **`disabled`, `readonly`, and `aria-readonly="true"` fields** — skipped even
  though they are not credential-bearing, because a disabled/readonly field is
  a signal from the page author that this value is not meant to be edited
  right now, and overwriting it anyway would be a correctness bug as well as a
  trust violation.
- **Closed shadow roots** — genuinely unreachable from content-script
  JavaScript by browser design; the extension does not attempt to force
  access (there is no supported way to, and trying would itself be a red
  flag for a security reviewer).
- **Cross-origin iframe documents** — access is wrapped in `try`/`catch` and
  skipped silently on `SecurityError`. The extension never attempts to
  work around the same-origin policy.

---

## The absolute rule: nothing leaves the browser

This extension makes **zero network requests**, ever:

- No `fetch`, `XMLHttpRequest`, `navigator.sendBeacon`, `WebSocket`, or
  `EventSource` calls anywhere in `background.js`, `content/find-replace.js`,
  or `popup/popup.js`.
- No telemetry, no analytics, no crash reporting, no update-check pings beyond
  whatever Firefox's own extension-update mechanism does at the platform
  level (which this extension does not configure or opt into).
- No remote code: no CDN script tags, no dynamically fetched code, no
  `eval`, no `new Function(...)` on any value — user-typed regex source is
  compiled only via `new RegExp(userPattern)`, which is data, not code
  execution. `security-audit.sh` scans `popup/` and `content/` for live
  `eval(`, `.innerHTML =`, and `Function(` usage (distinguishing comments
  that document their absence from actual invocations) and fails the build if
  any are found.
- `storage.local` is the only persistence mechanism, and it never syncs off
  the device (that would require the `storage` API's *sync* area, which this
  extension does not use — it uses `storage.local` exclusively).

If a future change ever needs to add a network call of any kind, that is a
threat-model change requiring this document to be updated first and the
security-audit reviewed accordingly — it is not a drive-by addition.

---

## How this is enforced

- `security-audit.sh` — automated, run before every release and checked into
  CI-equivalent process. Exits non-zero on any finding. See its header comment
  for the exact five checks it performs.
- `.claude-security.json` — the machine-readable policy `security-audit.sh`
  reads: scan paths, ignore globs, secret-pattern list, the
  eval/innerHTML/Function( scan target directories, the manifest permissions
  allowlist (`activeTab`, `scripting`, `storage`), and severity thresholds.
- This file (`CLAUDE.md`) — the human-readable rationale behind those
  mechanical checks, so a reviewer understands *why* a given check exists
  before deciding whether to loosen it (the answer should almost always be
  "fix the code, not the check").
