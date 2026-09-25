// @ts-check
/**
 * Popup-level regression tests for the undo state desync that loses the
 * user's original text.
 *
 * WHY THESE ARE POPUP-LEVEL AND WHY THAT MATTERS
 * ----------------------------------------------
 * All 65 pre-existing Playwright tests drive content/find-replace.js DIRECTLY
 * via window.__ffr. A probe doing replace -> undo -> replace that way passes
 * cleanly (see test/repro-sequence.spec.js): the content script's algorithm is
 * correct. The bug lives entirely in popup/popup.js, which those tests never
 * execute. That blind spot previously hid a defect that made the whole
 * extension non-functional, and it hid this one too.
 *
 * TWO OPPOSITE DESYNCS, BOTH OF WHICH DESTROY THE USER'S TEXT:
 *
 * Defect A - success reported for an undo that restored nothing.
 *   The content script returns {ok:true, restored:0, error:null} when its
 *   snapshot is empty (verified empirically). An empty snapshot is exactly
 *   what a re-injection leaves behind - a page navigation, or the popup's
 *   ping failing so ensureContentScriptInjected re-runs the IIFE. popup.js's
 *   handleUndo ignores `restored`, prints "Undo complete." and disables the
 *   button. The user is told their text came back. It did not.
 *
 * Defect B - undo refused while it is genuinely available.
 *   `hasUndoableChange` is a module-level `let` in popup.js, and the popup
 *   document is destroyed when the popup closes. It therefore resets to false
 *   on every reopen, leaving Undo disabled even though the content script
 *   still holds a valid snapshot. popup.js's own comment claims this state
 *   "persists independently", which is false.
 */
const path = require("path");
const { test, expect } = require("@playwright/test");

const POPUP_PATH = path.join(__dirname, "..", "popup", "popup.html");

/**
 * Mount popup.html with a fake `browser` API installed before any page script
 * runs. `undoResponse` and `undoStateResponse` let each test control exactly
 * what the content script appears to report back.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{undoRestored?: number, replaced?: number, undoAvailable?: boolean}} opts
 */
async function mountPopup(page, opts) {
  const config = {
    undoRestored: opts.undoRestored ?? 1,
    replaced: opts.replaced ?? 3,
    // Simulates a content script that still holds a usable snapshot. The
    // popup has no way to know this today - that is Defect B.
    undoAvailable: opts.undoAvailable ?? false,
  };

  await page.addInitScript((cfg) => {
    // @ts-ignore - test-only global, lets assertions inspect traffic.
    window.__sent = [];
    // @ts-ignore
    window.browser = {
      storage: {
        local: {
          get: () => Promise.resolve({}),
          set: () => Promise.resolve(),
        },
      },
      scripting: {
        executeScript: () => Promise.resolve([]),
      },
      tabs: {
        query: () => Promise.resolve([{ id: 1 }]),
        sendMessage: (_tabId, message) => {
          // @ts-ignore
          window.__sent.push(message);
          if (message.action === "ping") {
            // Content script is present - and it still holds a snapshot.
            return Promise.resolve({
              ok: true,
              undoAvailable: cfg.undoAvailable,
              undoCount: cfg.undoAvailable ? 3 : 0,
            });
          }
          if (message.action === "count") {
            return Promise.resolve({
              ok: true,
              matches: 3,
              fields: 3,
              totalFields: 5,
              undoAvailable: cfg.undoAvailable,
              undoCount: cfg.undoAvailable ? 3 : 0,
            });
          }
          if (message.action === "replace") {
            return Promise.resolve({
              ok: true,
              matches: 3,
              fields: 3,
              replaced: cfg.replaced,
              skipped: 0,
              timedOut: 0,
              wallMs: 5,
              undoAvailable: true,
              error: null,
            });
          }
          if (message.action === "undo") {
            // The crux of Defect A: ok:true, but nothing was restored.
            return Promise.resolve({
              ok: true,
              restored: cfg.undoRestored,
              error: null,
            });
          }
          return Promise.resolve({ ok: true });
        },
      },
      runtime: {
        onMessage: { addListener: () => {} },
      },
    };
  }, config);

  await page.goto("file://" + POPUP_PATH.replace(/\\/g, "/"));
  await page.waitForFunction(() => document.getElementById("undo-btn") !== null);
}

test.describe("popup undo desync (data-loss regression)", () => {
  // ---- Defect A ---------------------------------------------------------

  test("an undo that restored nothing must NOT be reported as success", async ({
    page,
  }) => {
    // restored:0 is what the content script really returns once its snapshot
    // has been wiped by a re-injection.
    await mountPopup(page, { undoRestored: 0, replaced: 3 });

    // Run a replace so the Undo button becomes enabled the normal way.
    await page.locator("#replace-all-btn").click();
    await expect(page.locator("#undo-btn")).toBeEnabled();

    await page.locator("#undo-btn").click();

    const status = (await page.locator("#status-line").textContent()) || "";

    // The user must not be told their text came back when it did not.
    expect(status).not.toMatch(/Undo complete/i);
    // ...and the message should say something true about the failure.
    expect(status.trim().length).toBeGreaterThan(0);
    expect(status).toMatch(/nothing|no .*restore|could not|unavailable|lost|failed/i);
  });

  test("an undo that restored nothing must not leave the UI claiming it succeeded", async ({
    page,
  }) => {
    await mountPopup(page, { undoRestored: 0, replaced: 3 });

    await page.locator("#replace-all-btn").click();
    await expect(page.locator("#undo-btn")).toBeEnabled();
    await page.locator("#undo-btn").click();

    // A real restore of 0 fields means the snapshot is gone. Silently
    // disabling the button hides that the text is unrecoverable; the status
    // line must carry the bad news either way (asserted above). Here we just
    // pin that the popup did not report a successful restore count.
    const status = (await page.locator("#status-line").textContent()) || "";
    expect(status).not.toMatch(/complete/i);
  });

  // ---- Defect B ---------------------------------------------------------

  test("Undo is available after the popup is reopened while a snapshot still exists", async ({
    page,
  }) => {
    // First mount: run a replace, so the content script holds a snapshot.
    await mountPopup(page, { replaced: 3, undoAvailable: false });
    await page.locator("#replace-all-btn").click();
    await expect(page.locator("#undo-btn")).toBeEnabled();

    // Now simulate the popup being CLOSED and REOPENED. The popup document is
    // destroyed and rebuilt, so every module-level variable in popup.js is
    // reset - while the content script in the tab keeps its snapshot.
    await mountPopup(page, { replaced: 3, undoAvailable: true });

    // The content script still has 3 undoable entries. The popup must find
    // that out and enable Undo, rather than assuming there is nothing to undo
    // because its own boolean was reinitialised.
    await expect(page.locator("#undo-btn")).toBeEnabled();
  });

  // ---- count-response resync ---------------------------------------------
  //
  // The content script reports undoAvailable/undoCount on its `count`
  // response as well as its `ping`. These two tests are what make that
  // load-bearing: without them the count-response fields would be a knob
  // wired to nothing, and a future reader would reasonably assume they were
  // doing something. A gate caught exactly that and rejected the phase.
  //
  // The behaviour they pin is real: the popup can sit open while the tab
  // navigates away, which destroys the content script and its snapshot. Undo
  // would keep rendering enabled until the user clicked it and got "Nothing
  // was restored" - a button promising something already gone.

  test("Count resyncs the Undo button OFF when the snapshot has since been lost", async ({
    page,
  }) => {
    // Replace succeeds, so Undo becomes enabled...
    await mountPopup(page, { replaced: 3, undoAvailable: false });
    await page.locator("#replace-all-btn").click();
    await expect(page.locator("#undo-btn")).toBeEnabled();

    // ...then the page navigates, wiping the content script's snapshot. The
    // next count round trip is the first chance the popup has to find out.
    await page.evaluate(() => {
      // @ts-ignore - retarget the mock to report the snapshot as gone.
      window.browser.tabs.sendMessage = (_tabId, message) => {
        if (message.action === "count") {
          return Promise.resolve({
            ok: true,
            matches: 3,
            fields: 3,
            totalFields: 5,
            undoAvailable: false,
            undoCount: 0,
          });
        }
        return Promise.resolve({ ok: true });
      };
    });

    await page.locator("#count-btn").click();

    // If the count response's undoAvailable were ignored, this stays enabled.
    await expect(page.locator("#undo-btn")).toBeDisabled();
  });

  test("Count resyncs the Undo button ON when a snapshot exists the popup did not know about", async ({
    page,
  }) => {
    // Fresh popup, nothing replaced in this session - Undo starts disabled.
    await mountPopup(page, { replaced: 0, undoAvailable: false });
    await expect(page.locator("#undo-btn")).toBeDisabled();

    // The content script in the tab does in fact hold a snapshot (e.g. from
    // an earlier popup session). Count is where the popup learns that.
    await page.evaluate(() => {
      // @ts-ignore
      window.browser.tabs.sendMessage = (_tabId, message) => {
        if (message.action === "count") {
          return Promise.resolve({
            ok: true,
            matches: 2,
            fields: 2,
            totalFields: 5,
            undoAvailable: true,
            undoCount: 2,
          });
        }
        return Promise.resolve({ ok: true });
      };
    });

    await page.locator("#count-btn").click();

    await expect(page.locator("#undo-btn")).toBeEnabled();
  });

  test("Undo stays disabled after reopen when the content script really has no snapshot", async ({
    page,
  }) => {
    // Negative control: without this, a fix that simply enables Undo
    // unconditionally on open would pass the test above.
    await mountPopup(page, { replaced: 0, undoAvailable: false });

    await expect(page.locator("#undo-btn")).toBeDisabled();
  });
});
