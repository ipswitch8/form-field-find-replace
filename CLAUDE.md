# CLAUDE.md — Security Documentation

Security documentation for the **Form Field Find & Replace** Firefox extension
(`find-replace@example.local`). This file is the authoritative record of the
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
| `storage` | Persists the last-used find/replace strings, checkbox states, and field-type selections in `storage.local` between popup opens. | `storage.local` is local to the browser profile. Nothing is synced, nothing is remote. |

**No `host_permissions` entry exists, on purpose.** A host permission would
grant the extension standing access to page content on every navigation,
whether or not the user ever opens the popup. `activeTab` + on-demand
`scripting.executeScript` achieves the same functional result — the content
script only ever runs when the user has just clicked the extension — with a
strictly smaller ambient footprint. `security-audit.sh` fails the build if
`host_permissions` is ever added or if `permissions` gains a wildcard
(`<all_urls>` or any pattern containing `*`).

`MISSING_DATA_COLLECTION_PERMISSIONS` (`browser_ext_web-ext lint`) is the one
warning intentionally left unresolved — see README.md "Known limitations" for
why adding `data_collection_permissions` at `strict_min_version: "115.0"`
makes things worse, not better.

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
