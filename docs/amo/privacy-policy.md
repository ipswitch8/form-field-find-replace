# Privacy policy — Form Field Find & Replace

**Contact: inquiries@itwerx.net**

Last updated: 30 September 2026. Applies to version 0.5.0 onwards.

## The short version

This extension collects nothing, transmits nothing, and makes no network
requests of any kind.

## What it stores, and where

Two things, both in `browser.storage.local`, which is local to your Firefox
profile on your own device:

1. **Your last-used settings** — the contents of the Find and Replace boxes,
   the four option checkboxes, and which field types are selected, so the popup
   opens as you left it.
2. **Your recent searches** — up to 20 previous find/replace pairs, each with
   the option and field-type settings that were in use at the time, so they can
   be offered back to you in a dropdown.

Both are written only in response to something you did: typing in the popup,
or pressing **Count matches** or **Replace all**.

## What it does not store

It does not store, copy, or retain the contents of any web page. The extension
reads a page's form fields only while a find, count or replace is actually
running, and only on the tab where you clicked its toolbar button. Those values
are used to compute the result and are not written to storage.

The one exception worth stating plainly, because it is the only way your own
typing could contain something sensitive: **what you type into the Find and
Replace boxes is what gets remembered.** If you paste a password, a customer
record, or anything else confidential into those boxes and then run a search,
that text is saved in your recent-searches list on your own machine. Use
**Clear history**, in either dropdown, to remove it. That empties the list in
storage, not merely on screen.

## What is never sent anywhere

Nothing. There is no server, no API, no analytics, no telemetry, no crash
reporting, and no update ping beyond whatever Firefox itself does for every
installed add-on.

The extension contains no `fetch`, `XMLHttpRequest`, `navigator.sendBeacon`,
`WebSocket` or `EventSource` call. It uses `storage.local` exclusively and
never `storage.sync`, so nothing is copied to a Mozilla account or to any of
your other devices.

## Permissions, and why each is needed

| Permission | Why |
|---|---|
| `activeTab` | Temporary access to the one tab you are on, granted only when you click the toolbar button, and gone again on navigation. |
| `scripting` | Lets the popup inject the find/replace code into that tab at the moment you invoke it. |
| `storage` | The local storage described above. |

There is deliberately **no host permission**. The extension has no standing
access to any site: it cannot see or touch a page until you click its button on
that page, and that access does not persist.

## Fields it will never read or write

Fields of type `password`, `hidden` and `file` are excluded before any matching
runs, as are `disabled`, `readonly` and `aria-readonly` fields. It does not read
saved passwords, autofill data, cookies, browsing history, or anything outside
the form fields of the page you invoked it on.

## Removing your data

- **Clear history** in either dropdown removes the remembered searches.
- Uninstalling the extension removes everything it stored, as Firefox discards
  an add-on's `storage.local` on removal.

## Questions

inquiries@itwerx.net
