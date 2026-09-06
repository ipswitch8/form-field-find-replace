// @ts-check
const path = require("path");
const { test, expect } = require("@playwright/test");

const POPUP_PATH = path.join(__dirname, "..", "popup", "popup.html");

/**
 * Form Field Find & Replace - activation wiring regression tests.
 *
 * THE BUG this file guards against: manifest.json sets `action.default_popup`,
 * which per the WebExtension spec means `browser.action.onClicked` NEVER
 * fires - the browser opens the popup instead. The old background.js wired
 * its only `browser.scripting.executeScript` call to that dead listener, and
 * popup.js's sendToContentScript() went straight to `browser.tabs.sendMessage`
 * assuming the content script was already present, which it never was. These
 * tests exercise the fix: popup.js's own `ensureContentScriptInjected`
 * (pinging before injecting, so undo state survives a popup close/reopen)
 * and `sendToContentScript`'s inject-and-retry-once fallback.
 *
 * Pattern follows test/undo.spec.js's loadPopupWithFakeBrowser: install a
 * fake `browser` global via addInitScript BEFORE popup.html's scripts run,
 * so popup.js's tabs/scripting/storage/runtime calls resolve deterministically.
 *
 * The fake browser's behavior is driven entirely by a plain, JSON-serializable
 * config object (never a serialized function/`new Function`/`eval`), since
 * addInitScript arguments must be data, not closures, and this project bans
 * eval/new Function outright.
 */

/**
 * @typedef {Object} FakeBrowserConfig
 * @property {"resolve"|"reject"|"resolveFirstThenReject"} pingMode
 * @property {"resolve"|"reject"|"rejectFirstThenResolve"} [countMode]
 * @property {object} [countResolveValue]
 * @property {boolean} [executeScriptRejects]
 */

/**
 * @param {import('@playwright/test').Page} page
 * @param {FakeBrowserConfig} config
 */
async function loadPopupWithFakeBrowser(page, config) {
  await page.addInitScript((cfg) => {
    // @ts-ignore - test-only globals.
    window.__callCounts = { ping: 0, count: 0 };
    // @ts-ignore
    window.__executeScriptCalls = [];

    /** @param {number} callNumber */
    function resolvesForPing(callNumber) {
      if (cfg.pingMode === "resolve") return true;
      if (cfg.pingMode === "reject") return false;
      // resolveFirstThenReject
      return callNumber === 1;
    }

    /** @param {number} callNumber */
    function resolvesForCount(callNumber) {
      if (cfg.countMode === "resolve") return true;
      if (cfg.countMode === "reject") return false;
      // rejectFirstThenResolve (default when unset - unused by ping-only tests)
      return callNumber !== 1;
    }

    // @ts-ignore
    window.browser = {
      storage: {
        local: {
          get: () => Promise.resolve({}),
          set: () => Promise.resolve(),
        },
      },
      tabs: {
        query: () => Promise.resolve([{ id: 42 }]),
        sendMessage: (_tabId, message) => {
          // @ts-ignore
          const counts = window.__callCounts;
          if (message.action === "ping") {
            counts.ping += 1;
            return resolvesForPing(counts.ping)
              ? Promise.resolve({ ok: true })
              : Promise.reject(new Error("no receiver"));
          }
          if (message.action === "count") {
            counts.count += 1;
            return resolvesForCount(counts.count)
              ? Promise.resolve(
                  cfg.countResolveValue || {
                    ok: true,
                    matches: 0,
                    fields: 0,
                    totalFields: 0,
                  }
                )
              : Promise.reject(new Error("no receiver"));
          }
          return Promise.resolve({ ok: true });
        },
      },
      scripting: {
        executeScript: (details) => {
          // @ts-ignore
          window.__executeScriptCalls.push(details);
          return cfg.executeScriptRejects
            ? Promise.reject(new Error("cannot script this page"))
            : Promise.resolve();
        },
      },
      runtime: {
        onMessage: {
          addListener: () => {},
        },
      },
    };
  }, config);

  await page.goto("file://" + POPUP_PATH.replace(/\\/g, "/"));
  await page.waitForFunction(() => document.getElementById("count-btn") !== null);
}

test.describe("activation wiring: content script injection is popup-driven", () => {
  test("when ping rejects, popup init injects the content script with the correct tabId and file", async ({
    page,
  }) => {
    await loadPopupWithFakeBrowser(page, { pingMode: "reject" });

    await page.waitForFunction(
      // @ts-ignore
      () => window.__executeScriptCalls.length > 0
    );

    const calls = await page.evaluate(() => window.__executeScriptCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      target: { tabId: 42 },
      // The LEADING SLASH is required and must not be "tidied away". Without
      // it Firefox resolves the path against the popup's own base URI and
      // tries to load moz-extension://<uuid>/popup/content/find-replace.js,
      // which 404s and leaves the page with no content script at all. This
      // assertion originally read "content/find-replace.js" and passed against
      // the broken code, because a mocked test only ever agrees with whatever
      // string it was handed - the real browser was the thing that disagreed.
      files: ["/content/find-replace.js"],
    });
  });

  test("when ping resolves, popup init does NOT re-inject the content script (preserves undo state)", async ({
    page,
  }) => {
    await loadPopupWithFakeBrowser(page, { pingMode: "resolve" });

    // Let init()'s ping round-trip resolve.
    await page.waitForFunction(
      // @ts-ignore
      () => window.__callCounts.ping >= 1
    );
    // Give any (incorrect) injection call a chance to fire before asserting
    // its absence.
    await page.waitForTimeout(200);

    const calls = await page.evaluate(() => window.__executeScriptCalls);
    expect(calls).toHaveLength(0);
  });
});

test.describe("activation wiring: sendToContentScript inject-and-retry", () => {
  test("a rejected send triggers exactly one injection and one retry, whose response is used", async ({
    page,
  }) => {
    // First ping (popup init's own check) resolves - present, no inject
    // needed there, isolating the executeScript count to the retry path
    // below. The SECOND ping (triggered inside sendToContentScript's retry)
    // rejects, forcing exactly one injection.
    await loadPopupWithFakeBrowser(page, {
      pingMode: "resolveFirstThenReject",
      countMode: "rejectFirstThenResolve",
      countResolveValue: { ok: true, matches: 7, fields: 2, totalFields: 2 },
    });

    // Wait for init's own ping to resolve before driving the user action.
    await page.waitForFunction(
      // @ts-ignore
      () => window.__callCounts.ping >= 1
    );

    await page.click("#count-btn");

    await expect(page.locator("#status-line")).toHaveText("7 matches in 2 fields");

    const [counts, execCalls] = await page.evaluate(() => [
      window.__callCounts,
      window.__executeScriptCalls,
    ]);
    expect(counts.count).toBe(2); // original send + exactly one retry
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toEqual({
      target: { tabId: 42 },
      // The LEADING SLASH is required and must not be "tidied away". Without
      // it Firefox resolves the path against the popup's own base URI and
      // tries to load moz-extension://<uuid>/popup/content/find-replace.js,
      // which 404s and leaves the page with no content script at all. This
      // assertion originally read "content/find-replace.js" and passed against
      // the broken code, because a mocked test only ever agrees with whatever
      // string it was handed - the real browser was the thing that disagreed.
      files: ["/content/find-replace.js"],
    });
  });

  test("a page that cannot be scripted surfaces a friendly status and never throws", async ({
    page,
  }) => {
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    // Every ping/count send fails (no receiver ever appears) and injection
    // itself also fails, e.g. an about: page or the add-ons manager.
    await loadPopupWithFakeBrowser(page, {
      pingMode: "reject",
      countMode: "reject",
      executeScriptRejects: true,
    });

    // Init's own ensureContentScriptInjected attempt resolves quietly (it
    // never throws even though both the ping and the injection fail).
    await page.waitForFunction(
      // @ts-ignore
      () => window.__executeScriptCalls.length >= 1
    );

    await page.click("#count-btn");

    await expect(page.locator("#status-line")).toHaveText(
      "Could not reach the page. (This page can't be scripted by an extension.)"
    );
    await expect(page.locator("#status-line")).toHaveClass(/status-error/);

    expect(pageErrors).toHaveLength(0);
  });
});
