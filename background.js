/**
 * Form Field Find & Replace - background event page.
 *
 * Manifest V3 event page (not a service worker) - Firefox's MV3 support for
 * event pages is the safer path for this extension. This script is
 * intentionally minimal in phase 1: no content-script logic lives here yet
 * (that arrives in phase 2). Its job is to react to the toolbar action and
 * make sure the content script is present in the active tab before the
 * popup tries to talk to it, using only the activeTab + scripting
 * permissions (no host_permissions, no persistent background page).
 *
 * No network calls, no telemetry, no analytics - ever.
 */

"use strict";

const CONTENT_SCRIPT_PATH = "content/find-replace.js";

/**
 * Ensure the content script is injected into the given tab. Safe to call
 * repeatedly - if the script is already present it should be idempotent
 * (guarded by the content script itself in phase 2). Injection is done via
 * browser.scripting.executeScript against activeTab, never a broad host
 * permission.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function ensureContentScript(tabId) {
  if (typeof tabId !== "number") {
    return;
  }

  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT_PATH],
    });
  } catch (error) {
    // The content script file does not exist until phase 2, and injection
    // can also legitimately fail against privileged pages (about:, the
    // add-ons manager, etc.). Fail quietly - the popup surfaces its own
    // status message when messaging the tab fails.
    console.warn("Form Field Find & Replace: content script injection failed", error);
  }
}

// Re-injecting on toolbar click keeps behavior predictable if the tab
// navigated since the last run, without requiring any persistent listener
// state or host permissions.
browser.action.onClicked.addListener((tab) => {
  ensureContentScript(tab.id);
});

// Exposed for the popup (and, in later phases, for direct invocation) via
// runtime messaging rather than a shared module, since MV3 event pages are
// not guaranteed to stay alive between calls.
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  if (message.action === "ensure-content-script" && sender.tab) {
    ensureContentScript(sender.tab.id).then(() => sendResponse({ ok: true }));
    return true; // keep the message channel open for the async response
  }

  return undefined;
});
