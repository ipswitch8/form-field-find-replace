// @ts-check
const path = require("path");
const { test, expect } = require("@playwright/test");

const FIXTURE_PATH = path.join(__dirname, "fixture.html");
const FIXTURE_BULK_PATH = path.join(__dirname, "fixture-bulk.html");
const POPUP_PATH = path.join(__dirname, "..", "popup", "popup.html");
const CONTENT_SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "content",
  "find-replace.js"
);

/**
 * @param {import('@playwright/test').Page} page
 */
async function loadFixtureWithContentScript(page) {
  await page.goto("file://" + FIXTURE_PATH.replace(/\\/g, "/"));
  // Wait for the same-origin iframe's srcdoc to finish loading before any
  // test that touches it runs (mirrors test/shadow-iframe.spec.js).
  await page.evaluate(() => {
    const iframe = /** @type {HTMLIFrameElement} */ (
      document.getElementById("same-origin-iframe")
    );
    if (
      iframe.contentDocument &&
      iframe.contentDocument.readyState === "complete"
    ) {
      return Promise.resolve();
    }
    return new Promise((resolve) =>
      iframe.addEventListener("load", resolve, { once: true })
    );
  });
  await page.addScriptTag({ path: CONTENT_SCRIPT_PATH });
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function loadBulkFixtureWithContentScript(page) {
  await page.goto("file://" + FIXTURE_BULK_PATH.replace(/\\/g, "/"));
  await page.addScriptTag({ path: CONTENT_SCRIPT_PATH });
}

/** Field-types payload with every group enabled. */
const ALL_FIELD_TYPES = {
  text: true,
  search: true,
  url: true,
  tel: true,
  email: true,
  number: true,
  date: true,
  "datetime-local": true,
  month: true,
  week: true,
  time: true,
  textarea: true,
  contenteditable: true,
};

const PLAIN_OPTIONS = { matchCase: false, wholeWord: false, regex: false };

test.describe("phase 7: undo - full run restores everything", () => {
  test("full-run undo restores all changed fields, including contenteditable nested markup", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page);

    const before = await page.evaluate(() => ({
      text: document.getElementById("text-input").value,
      email: document.getElementById("email-input").value,
      textarea: document.getElementById("textarea-input").value,
      ceText: document.getElementById("contenteditable-div").textContent,
      ceHtml: document.getElementById("contenteditable-div").innerHTML,
    }));

    const result = await page.evaluate(
      async ({ fieldTypes, options }) => {
        const replaceResponse = await window.__ffr.handleReplace({
          action: "replace",
          find: "hello",
          replace: "HELLO",
          options,
          fieldTypes,
        });

        const afterReplace = {
          text: document.getElementById("text-input").value,
          email: document.getElementById("email-input").value,
          textarea: document.getElementById("textarea-input").value,
          ceText: document.getElementById("contenteditable-div").textContent,
          ceHtml: document.getElementById("contenteditable-div").innerHTML,
        };

        const undoResponse = window.__ffr.handleUndo();

        const afterUndo = {
          text: document.getElementById("text-input").value,
          email: document.getElementById("email-input").value,
          textarea: document.getElementById("textarea-input").value,
          ceText: document.getElementById("contenteditable-div").textContent,
          ceHtml: document.getElementById("contenteditable-div").innerHTML,
        };

        return { replaceResponse, afterReplace, undoResponse, afterUndo };
      },
      { fieldTypes: ALL_FIELD_TYPES, options: PLAIN_OPTIONS }
    );

    expect(result.replaceResponse.ok).toBe(true);
    expect(result.replaceResponse.replaced).toBeGreaterThan(0);

    // Sanity: the run actually mutated these fields.
    expect(result.afterReplace.text).toBe("HELLO world HELLO");
    expect(result.afterReplace.email).toBe("HELLO@example.com");
    expect(result.afterReplace.textarea).toBe("HELLO there, HELLO again");
    expect(result.afterReplace.ceText).toBe("HELLO world HELLO there");

    expect(result.undoResponse.ok).toBe(true);
    expect(result.undoResponse.restored).toBe(result.replaceResponse.replaced);

    // Every changed field is restored exactly to its pre-replace value...
    expect(result.afterUndo.text).toBe(before.text);
    expect(result.afterUndo.email).toBe(before.email);
    expect(result.afterUndo.textarea).toBe(before.textarea);
    expect(result.afterUndo.ceText).toBe(before.ceText);

    // ...and the contenteditable's nested markup (<b>, <span>) is intact,
    // not flattened - the crux of the "restore per text node, never via
    // textContent" requirement.
    expect(result.afterUndo.ceHtml).toBe(before.ceHtml);
    expect(result.afterUndo.ceHtml).toContain("<b>");
    expect(result.afterUndo.ceHtml).toContain("<span>");
  });

  test("full-run undo restores a field inside an open shadow root and a same-origin iframe (cross-realm prototype path)", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page);

    const before = await page.evaluate(() => ({
      shadow: document
        .getElementById("shadow-host")
        .shadowRoot.getElementById("shadow-input").value,
      iframe: document
        .getElementById("same-origin-iframe")
        .contentDocument.getElementById("iframe-input").value,
    }));
    expect(before.shadow).toBe("shadow value");
    expect(before.iframe).toBe("iframe value");

    const result = await page.evaluate(
      async ({ fieldTypes }) => {
        const shadowResponse = await window.__ffr.handleReplace({
          action: "replace",
          find: "shadow value",
          replace: "SHADOW REPLACED",
          options: { matchCase: false, wholeWord: false, regex: false },
          fieldTypes,
        });
        const shadowAfterReplace = document
          .getElementById("shadow-host")
          .shadowRoot.getElementById("shadow-input").value;
        window.__ffr.handleUndo();
        const shadowAfterUndo = document
          .getElementById("shadow-host")
          .shadowRoot.getElementById("shadow-input").value;

        const iframeResponse = await window.__ffr.handleReplace({
          action: "replace",
          find: "iframe value",
          replace: "IFRAME REPLACED",
          options: {
            matchCase: false,
            wholeWord: false,
            regex: false,
            includeIframes: true,
          },
          fieldTypes,
        });
        const iframeAfterReplace = document
          .getElementById("same-origin-iframe")
          .contentDocument.getElementById("iframe-input").value;
        window.__ffr.handleUndo();
        const iframeAfterUndo = document
          .getElementById("same-origin-iframe")
          .contentDocument.getElementById("iframe-input").value;

        return {
          shadowResponse,
          shadowAfterReplace,
          shadowAfterUndo,
          iframeResponse,
          iframeAfterReplace,
          iframeAfterUndo,
        };
      },
      { fieldTypes: ALL_FIELD_TYPES }
    );

    expect(result.shadowResponse.ok).toBe(true);
    expect(result.shadowResponse.replaced).toBeGreaterThanOrEqual(1);
    expect(result.shadowAfterReplace).toBe("SHADOW REPLACED");
    // The crux: undo resolves the native setter via the shadow-root
    // element's OWN ownerDocument.defaultView (same window here, but this
    // proves the path works, not just top-level assignment).
    expect(result.shadowAfterUndo).toBe("shadow value");

    expect(result.iframeResponse.ok).toBe(true);
    expect(result.iframeResponse.replaced).toBeGreaterThanOrEqual(1);
    expect(result.iframeAfterReplace).toBe("IFRAME REPLACED");
    // The crux: the iframe element belongs to a DIFFERENT window/realm than
    // the top document - undo must resolve HTMLInputElement.prototype via
    // THAT element's own ownerDocument.defaultView, not the top window's
    // constructor, or this write would throw "Illegal invocation" (wrong
    // prototype) or be silently ignored.
    expect(result.iframeAfterUndo).toBe("iframe value");
  });

  test("a second replace run replaces the snapshot rather than stacking (one level only)", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page);

    const result = await page.evaluate(
      async ({ fieldTypes, options }) => {
        // Run 1: change text-input and email-input.
        await window.__ffr.handleReplace({
          action: "replace",
          find: "hello",
          replace: "HELLO",
          options,
          fieldTypes,
        });
        const lenAfterRun1 = window.__ffr.getUndoSnapshotLength();

        // Run 2: a DIFFERENT, non-overlapping replace against the
        // already-mutated text - this must overwrite (not stack onto) the
        // run-1 snapshot.
        await window.__ffr.handleReplace({
          action: "replace",
          find: "HELLO",
          replace: "GREETING",
          options,
          fieldTypes,
        });
        const lenAfterRun2 = window.__ffr.getUndoSnapshotLength();

        const beforeUndo = {
          text: document.getElementById("text-input").value,
          email: document.getElementById("email-input").value,
        };

        const undoResponse = window.__ffr.handleUndo();

        const afterUndo = {
          text: document.getElementById("text-input").value,
          email: document.getElementById("email-input").value,
        };

        return { lenAfterRun1, lenAfterRun2, undoResponse, beforeUndo, afterUndo };
      },
      { fieldTypes: ALL_FIELD_TYPES, options: PLAIN_OPTIONS }
    );

    expect(result.lenAfterRun1).toBeGreaterThan(0);
    expect(result.lenAfterRun2).toBeGreaterThan(0);

    // Undo restores run 2's changes (HELLO -> GREETING reverted to HELLO),
    // NOT run 1's changes (hello -> HELLO) - proving there is exactly one
    // level of undo, not a stack that would restore all the way to the
    // original "hello".
    expect(result.beforeUndo.text).toBe("GREETING world GREETING");
    expect(result.afterUndo.text).toBe("HELLO world HELLO");
    expect(result.afterUndo.text).not.toBe("hello world hello");
  });
});

test.describe("phase 7: undo - partial (cancelled) run", () => {
  test("undo after a cancelled run restores exactly the changed subset; untouched fields receive no events", async ({
    page,
  }) => {
    await loadBulkFixtureWithContentScript(page);

    const replaceResponse = await page.evaluate(
      async ({ fieldTypes, options }) => {
        const unsubscribe = window.__ffr.onProgress((msg) => {
          if (msg.done > 0) {
            window.__ffr.requestCancel();
          }
        });
        const result = await window.__ffr.handleReplace({
          action: "replace",
          find: "hello",
          replace: "HELLO",
          options,
          fieldTypes,
        });
        unsubscribe();
        return result;
      },
      { fieldTypes: ALL_FIELD_TYPES, options: PLAIN_OPTIONS }
    );

    expect(replaceResponse.ok).toBe(true);
    expect(replaceResponse.cancelled).toBe(true);
    expect(replaceResponse.replaced).toBeGreaterThan(0);
    expect(replaceResponse.replaced).toBeLessThan(500);

    const undoResult = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input"));
      const eventCounts = inputs.map(() => 0);
      inputs.forEach((el, i) => {
        el.addEventListener("input", () => {
          eventCounts[i] += 1;
        });
      });

      const beforeUndo = inputs.map((el) => el.value);
      const undoResponse = window.__ffr.handleUndo();
      const afterUndo = inputs.map((el) => el.value);

      const changedDuringUndo = inputs.map(
        (_, i) => beforeUndo[i] !== afterUndo[i]
      );

      return { undoResponse, changedDuringUndo, eventCounts, afterUndo };
    });

    const numChangedDuringUndo = undoResult.changedDuringUndo.filter(
      Boolean
    ).length;
    // Exactly the subset actually changed before cancellation - not the
    // full originally-collected/seeded set (500), and not zero.
    expect(numChangedDuringUndo).toBe(replaceResponse.replaced);
    expect(undoResult.undoResponse.restored).toBe(replaceResponse.replaced);

    // No field beyond the ones actually restored received an `input` event
    // during undo - an untouched field gets no setter call, no events.
    const numFieldsWithEvent = undoResult.eventCounts.filter(
      (c) => c > 0
    ).length;
    expect(numFieldsWithEvent).toBe(replaceResponse.replaced);

    // Nothing left over reads "HELLO" - the whole page is back to its
    // pre-replace seeded/filler state.
    expect(undoResult.afterUndo.some((v) => v.includes("HELLO"))).toBe(false);
  });

  // The other undo tests all target plain inputs, where a direct `el.value = x`
  // assignment would ALSO appear to work - so none of them actually discriminate
  // between the native-setter path and a plain write. #controlled-input does:
  // the fixture's widget silently reverts any write that is not followed by a
  // real `input` event. This is the only undo test that fails if handleUndo
  // regresses to a plain assignment.
  test("undo restores a controlled input through the native-setter path, not a plain assignment", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page);

    const result = await page.evaluate(
      async ({ fieldTypes, options }) => {
        const el = document.getElementById("controlled-input");
        const before = el.value;

        const replaceResponse = await window.__ffr.handleReplace({
          action: "replace",
          find: "state one",
          replace: "state two",
          options,
          fieldTypes,
        });
        const afterReplace = el.value;

        const undoResponse = await window.__ffr.handleUndo({ action: "undo" });
        const afterUndo = el.value;

        return {
          before,
          afterReplace,
          afterUndo,
          replaceResponse,
          undoResponse,
        };
      },
      { fieldTypes: ALL_FIELD_TYPES, options: PLAIN_OPTIONS }
    );

    // Preconditions: the replace itself must have really taken effect, or the
    // undo assertion below would pass trivially.
    expect(result.before).toBe("state one");
    expect(result.replaceResponse.ok).toBe(true);
    expect(result.afterReplace).toBe("state two");

    // The crux: the controlled widget reverts writes that bypass the native
    // setter + input event. If handleUndo used `el.value = entry.value`, the
    // widget would snap back to "state two" and this would fail.
    expect(result.undoResponse.ok).toBe(true);
    expect(result.afterUndo).toBe("state one");
  });
});

test.describe("phase 7: undo - popup wiring (Undo button enabled/disabled transitions)", () => {
  /**
   * Load popup.html standalone (file://, no real extension context) with a
   * fake `browser` API installed via an init script BEFORE any page script
   * runs, so popup.js's tabs/storage/runtime calls resolve deterministically
   * instead of throwing/rejecting. The fake `tabs.sendMessage` lets this test
   * drive the exact run -> cancel -> undo message sequence and control
   * exactly when the in-flight "replace" call resolves, so the UI's
   * intermediate (mid-run, mid-cancel) button states can be asserted, not
   * just the final one.
   * @param {import('@playwright/test').Page} page
   */
  async function loadPopupWithFakeBrowser(page) {
    await page.addInitScript(() => {
      /** @type {(value: any) => void} */
      let resolveReplace;
      // @ts-ignore - test-only global.
      window.__resolveReplace = (value) => resolveReplace && resolveReplace(value);

      // @ts-ignore - test-only global.
      window.browser = {
        storage: {
          local: {
            get: () => Promise.resolve({}),
            set: () => Promise.resolve(),
          },
        },
        tabs: {
          query: () => Promise.resolve([{ id: 1 }]),
          sendMessage: (_tabId, message) => {
            if (message.action === "count") {
              return Promise.resolve({ ok: true, matches: 0, fields: 0, totalFields: 5 });
            }
            if (message.action === "replace") {
              return new Promise((resolve) => {
                resolveReplace = resolve;
              });
            }
            if (message.action === "cancel") {
              return Promise.resolve({ ok: true });
            }
            if (message.action === "undo") {
              return Promise.resolve({ ok: true, restored: 1, error: null });
            }
            return Promise.resolve({ ok: true });
          },
        },
        runtime: {
          onMessage: {
            addListener: () => {},
          },
        },
      };
    });
    await page.goto("file://" + POPUP_PATH.replace(/\\/g, "/"));
    await page.waitForFunction(() => document.getElementById("undo-btn") !== null);
  }

  test("Undo button transitions correctly across a replace run -> cancel -> undo cycle", async ({
    page,
  }) => {
    await loadPopupWithFakeBrowser(page);

    // Initial state: no run, nothing to undo.
    await expect(page.locator("#undo-btn")).toBeDisabled();
    await expect(page.locator("#cancel-btn")).toBeDisabled();
    await expect(page.locator("#replace-all-btn")).toBeEnabled();

    await page.fill("#find-input", "x");
    await page.click("#replace-all-btn");

    // Mid-run: cancel is enabled, count/replace are disabled, undo remains
    // disabled (no completed/cancelled run has reported a change yet).
    await expect(page.locator("#cancel-btn")).toBeEnabled();
    await expect(page.locator("#replace-all-btn")).toBeDisabled();
    await expect(page.locator("#count-btn")).toBeDisabled();
    await expect(page.locator("#undo-btn")).toBeDisabled();

    // Cancel the in-flight run.
    await page.click("#cancel-btn");
    await expect(page.locator("#cancel-btn")).toBeDisabled();
    // Undo still disabled - the "replace" message hasn't resolved yet, so no
    // run outcome has been reported to the popup.
    await expect(page.locator("#undo-btn")).toBeDisabled();

    // Now let the in-flight "replace" message resolve, reporting a
    // cancelled run that DID change one field before cancellation.
    await page.evaluate(() => {
      // @ts-ignore - test-only global.
      window.__resolveReplace({
        ok: true,
        matches: 1,
        fields: 1,
        replaced: 1,
        skipped: 0,
        timedOut: 0,
        cancelled: true,
        total: 5,
        done: 2,
        undoAvailable: true,
        wallMs: 3,
        error: null,
      });
    });

    // Undo is now enabled - a cancelled run with at least one changed field.
    await expect(page.locator("#undo-btn")).toBeEnabled();
    await expect(page.locator("#replace-all-btn")).toBeEnabled();
    await expect(page.locator("#count-btn")).toBeEnabled();

    // Invoke undo - it disables itself again.
    await page.click("#undo-btn");
    await expect(page.locator("#undo-btn")).toBeDisabled();
  });

  test("a completed run with zero changed fields leaves Undo disabled", async ({
    page,
  }) => {
    await loadPopupWithFakeBrowser(page);

    await page.fill("#find-input", "nonexistent");
    await page.click("#replace-all-btn");

    await page.evaluate(() => {
      // @ts-ignore - test-only global.
      window.__resolveReplace({
        ok: true,
        matches: 0,
        fields: 0,
        replaced: 0,
        skipped: 0,
        timedOut: 0,
        cancelled: false,
        total: 5,
        done: 5,
        undoAvailable: true,
        wallMs: 1,
        error: null,
      });
    });

    await expect(page.locator("#undo-btn")).toBeDisabled();
  });
});

test.describe("phase 7: UI text states one level of undo is supported", () => {
  test("popup.html contains text stating one level of undo is supported", async ({
    page,
  }) => {
    await page.goto("file://" + POPUP_PATH.replace(/\\/g, "/"));
    const text = await page.evaluate(
      () => document.body.textContent || ""
    );
    expect(text.toLowerCase()).toContain("one level of undo");
  });
});
