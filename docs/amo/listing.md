# AMO listing copy — Form Field Find & Replace

**Contact for all AMO fields: `inquiries@itwerx.net`**

## Status: submitted, awaiting review

Version **0.6.0** was submitted to the **listed** channel on 30 September 2026
and is in Mozilla's review queue.

| | |
|---|---|
| Add-on id | `inquiries@itwerx.net` |
| Slug | `form-field-find-replace` |
| Version record | https://addons.mozilla.org/en-US/developers/addon/form-field-find-replace/versions/6529414 |
| Public page (live once approved) | https://addons.mozilla.org/en-US/firefox/addon/form-field-find-replace/ |

Most of this listing was submitted through the API, from
`docs/amo/amo-metadata.json`, rather than typed into the web UI — summary,
description, category, support contact and privacy policy all went up with the
package. The copy below is the source of truth for that file.

**Still to do by hand in the Developer Hub**, because the API does not carry
them: upload the **icon** and the **screenshots** from `docs/amo/assets/`. See
the Assets section for which file goes where and the suggested captions.

`npm run sign -- listed` will report an "Approval: timeout exceeded" error at
the end. That is not a failure — it is web-ext giving up on *waiting* for a
human reviewer, long after the upload itself succeeded. The version URL it
prints is the proof the submission landed.

---

## Add-on name

```
Form Field Find & Replace
```

## Summary

AMO caps this at 250 characters. This is 238.

```
Find and replace text across every editable form field on a page - plain text, whole word, or regular expressions with backreferences. Preview before you replace, undo after, and it remembers your previous searches along with the settings they used.
```

## Categories

```
search-tools
```

**There is no "Productivity" category for Firefox extensions.** An earlier draft
of this file said Productivity/Other from memory; the real list was then read
from `https://addons.mozilla.org/api/v5/addons/categories/` and contains exactly
fifteen extension slugs:

```
alerts-updates  appearance  bookmarks  download-management
feeds-news-blogging  games-entertainment  language-support  other
photos-music-videos  privacy-security  search-tools  shopping
social-communication  tabs  web-development
```

`search-tools` is the honest fit — this is a search-and-replace tool. Not
`privacy-security`: it makes no security claim, and filing it there invites
expectations it does not meet. Not `web-development` either: developers are a
likely audience but the tool is not about building sites.

## Tags

```
find, replace, forms, regex, search-and-replace, productivity, text-editing
```

## Support email

```
inquiries@itwerx.net
```

## Support site / homepage

```
https://github.com/ipswitch8/form-field-find-replace
```

The repository was made **public** for this submission, so that link resolves
for anyone who clicks it from the listing.

Before it was made public, every blob in all 35 commits of history was scanned
for credential-shaped content — a public repo exposes its whole history, not
just its tip. The scan is `git grep` over `git rev-list --all` for AMO JWT
issuer shapes, secret assignments, long hex runs, AWS keys, private-key
headers, and GitHub/Slack tokens. Three shapes matched and all three were
verified benign:

1. the `user:12345678:123` placeholder in `sign.sh` and `README.md`;
2. the SHA-256 bookkeeping values in the pipeline state files under
   `.claude/pipelines/`;
3. `.amo-upload-uuid` — web-ext's upload-correlation cache, which was tracked
   until commit `528112a` untracked it.

The third is a real historical artefact but not a credential: it identifies a
prior upload and authorises nothing without the JWT key and secret. Those were
never committed — `.amo-credentials` has been gitignored from the start and
appears in no commit in the repository's history.

## License

MIT — see `LICENSE` in the repository root. Select "MIT License" in AMO's
licence dropdown rather than pasting custom text.

---

## Description

AMO accepts limited HTML here. Plain paragraphs and lists render fine.

```
Find and replace text across the editable form fields of whatever page you are looking at.

It works on text inputs, textareas, and rich-text (contenteditable) editors, and it can reach inside same-origin iframes and open shadow DOM. Plain text, whole-word, and full regular expressions with backreferences ($1, $2, $&, named groups) are all supported.

WHAT IT DOES

• Preview before you commit. A live preview shows exactly what your pattern would produce, including backreference substitution, before a single field is touched. Count matches tells you how many fields would change.

• Undo. One level, applied through the same path a real edit would take, so frameworks notice. If a run would exceed the undo limit you are warned BEFORE it starts, not after.

• Remembers your searches - with their settings. Click the Find or Replace box and pick from your previous searches. Each remembered entry restores the find text, the replace text, all four option checkboxes and the field-type selection together. That matters: a remembered pattern recalled without its "regular expression" flag would be searched for literally and quietly report no matches.

• Choose what it touches. Thirteen field-type checkboxes let you restrict a run to, say, only textareas, or only date fields.

WHAT IT WILL NOT TOUCH

Password, hidden and file fields are never read or written - they are excluded before matching even runs, not filtered afterwards. Neither are disabled, readonly or aria-readonly fields: those are the page telling you the value is not meant to be edited.

Number, date and time fields are checked after writing and rolled back to their original value if the result would be invalid, rather than being left blank. Those are reported as skipped so you know the run was not fully applied.

NOTHING LEAVES YOUR BROWSER

No network requests of any kind. No telemetry, no analytics, no crash reporting. Your searches are remembered in local browser storage only, never synced, and a Clear history button removes them.

PERMISSIONS

It asks for exactly three: activeTab, scripting, and storage.

There is deliberately no host permission. The extension has no access to any page until you click its toolbar button on that tab, and that access does not persist across navigation. It is not running in the background on every site you visit, because it cannot be.

KNOWN LIMITATIONS

A deliberately pathological regular expression can still freeze the tab; there is a per-field time budget, but JavaScript cannot interrupt a regex already running. Closed shadow roots and cross-origin iframes are unreachable by design. Editors that do not use real form fields - canvas-based ones, or CodeMirror-style editors that keep their state elsewhere - are not supported.
```

---

## Version notes for 0.5.0

Paste into the version's release-notes field.

```
Remembers your previous searches, with the settings they used.

• Click the Find or Replace box for a dropdown of previous searches. Picking one refills both boxes and restores all four option checkboxes plus the field-type selection - so a remembered regular expression comes back with regex still switched on, rather than being searched for literally.
• Up to 20 entries, newest first. Saved when you press Count matches or Replace all, never on keystrokes. Clear history empties the list without disturbing what you are typing.
• Fully keyboard operable: arrows to open and move, Enter to select, Escape to dismiss the list without closing the popup.
• The popup no longer scrolls. It was 1032px tall against Firefox's 600px popup cap; it is now 481px, in a two-column layout.

Also fixes two interaction bugs: an option checkbox could be focused without being ticked while a dropdown was open, and controls could shift under the cursor a fifth of a second after you stopped typing.
```

---

## Notes for the reviewer

AMO gives you a private field for this. It is worth filling in — this add-on
requests `scripting` and rewrites form values, which is the profile that draws
a closer look.

```
Source is plain, unminified, unbundled vanilla JavaScript with no build step. What is in the package is exactly what is in the repository - there is no compilation stage and no third-party runtime dependency.

On permissions: there is no host permission by design. Injection is performed by the popup via scripting.executeScript at the moment the user clicks the toolbar button, using the activeTab grant that click creates. The manifest has no content_scripts entry and no matches pattern, so the extension is not present on any page until explicitly invoked, and the grant does not survive navigation.

On data: data_collection_permissions is declared as {"required": ["none"]}, which is accurate. There are no network calls anywhere in the extension - no fetch, XMLHttpRequest, sendBeacon, WebSocket or EventSource. Persistence is storage.local only; storage.sync is never used, and the test suite asserts that both by scanning the shipped source and by installing a spy that fails if the sync area is ever touched.

On DOM safety: no eval, no new Function, and no innerHTML anywhere in popup/ or content/. History dropdown rows are built with createElement and textContent, and a test feeds an <img onerror=...> string in as a remembered value and asserts no element is created from it.

Fields that are password, hidden, file, disabled, readonly or aria-readonly are excluded at collection time, before any matching runs.

The repository contains CLAUDE.md, which documents the full threat model and the rationale for each permission, and security-audit.sh, which mechanically enforces the permission allowlist and scans for dangerous constructs.
```

---

## Assets

Generated by `node tools/make-amo-assets.js` into `docs/amo/assets/`.
They are excluded from the packaged `.xpi` by `web-ext-config.cjs`.

### Icon

| File | Size | Use |
|---|---|---|
| `icon-128.png` | 128×128 | **Upload this one.** AMO's preferred add-on icon size. |
| `icon-64.png` | 64×64 | AMO's stated minimum, if 128 is rejected for any reason. |
| `icon-16/32/48/96.png` | — | Generated for completeness; not needed by AMO. |

Transparent background, so AMO can composite on a light or dark card.

### Screenshots

Upload in this order — AMO shows the first one as the primary image.

| File | Shows |
|---|---|
| `screenshot-1-popup.png` | A regex with backreferences reformatting a phone number, with the live preview showing the result |
| `screenshot-2-history.png` | The remembered-searches dropdown, with each entry's settings visible on its row |
| `screenshot-3-preview.png` | A plain-text replacement previewed before anything is touched |

Suggested captions:

1. `Preview exactly what a pattern will do - including backreferences - before touching a single field.`
2. `Previous searches come back with the settings they used, not just the text.`
3. `Plain text, whole word, or regular expressions. Count first, undo after.`

---

## Before you submit — the checklist

- [ ] Decide the **repository visibility** question above. A listed add-on
      pointing at a private repo is a broken support link.
- [ ] Confirm the **MIT licence** and the copyright line in `LICENSE`
      (currently "Michael Hasse (itwerx.net)").
- [x] **Add-on id** — changed to `inquiries@itwerx.net` at v0.6.0. See below.
- [ ] Run `npm run sign -- listed` (the script already accepts the channel
      argument and validates it).

### The add-on id was changed at v0.6.0 — what that cost

`browser_specific_settings.gecko.id` is now `inquiries@itwerx.net`. It was
`mhasse@itwerx.net` up to and including v0.5.0.

The id looks like an email address because that is the conventional format, but
it is an **identifier**, not a contact — Mozilla never mails it and users never
write to it. Changing it is therefore not a rename: it creates a **different
add-on** as far as Firefox and AMO are concerned. The signed v0.5.0 does not
upgrade to v0.6.0; anything running the old build has to be removed and
reinstalled.

That was acceptable here for one reason only: at the time of the change there
were no installations outside the development machine, so there was nothing to
strand. **That will not be true again.** Once this is listed and has users, the
id is effectively permanent — changing it would abandon every installed copy
without so much as an update prompt, and AMO will not let the old id be reused.

The version was bumped 0.5.0 → 0.6.0 in the same change, so that the two signed
artifacts are never both called 0.5.0. This project has already lost time once
to two `.xpi` files that differed only by a suffix.
