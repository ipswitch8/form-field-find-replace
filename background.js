/**
 * Form Field Find & Replace - background event page.
 *
 * Manifest V3 event page (not a service worker) - Firefox's MV3 support for
 * event pages is the safer path for this extension.
 *
 * Content-script injection is deliberately NOT done here. manifest.json sets
 * `action.default_popup`, and per the WebExtension spec that means
 * `browser.action.onClicked` NEVER fires - the browser opens the popup
 * instead of dispatching the click event. A listener on that event would be
 * permanently dead code.
 *
 * Injection is popup-driven instead (see popup/popup.js's
 * ensureContentScriptInjected): the popup already holds the activeTab grant
 * from the very click that opened it, and `scripting` is already declared in
 * manifest.json, so `browser.scripting.executeScript` can be called directly
 * from the popup with no additional permission and no round trip through
 * this file.
 *
 * This file remains as the MV3 event page background.scripts entry point
 * (required by SPEC.md) but currently has no work of its own to do - no
 * persistent state, no listeners, no network calls, no telemetry, no
 * analytics, ever.
 */

"use strict";
