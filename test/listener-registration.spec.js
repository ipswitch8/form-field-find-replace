// @ts-check
const path = require("path");
const { test, expect } = require("@playwright/test");

const FIXTURE_PATH = path.join(__dirname, "fixture.html");
const CONTENT_SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "content",
  "find-replace.js"
);

/**
 * popup.html loads content/find-replace.js to reuse the shared matcher for its
 * live preview, and inside the popup `browser.runtime` IS defined. Without a
 * guard the content script would register an onMessage handler there and answer
 * count/replace against the POPUP's own DOM instead of the page's.
 *
 * None of the other suites reach this branch: they all load file:// fixtures
 * where `browser` is undefined, so the API check short-circuits first. These
 * tests drive the predicate directly and with a stubbed browser API.
 */
test.describe("message listener registration guard (phase 4)", () => {
  test("does not register on an extension page even when the runtime API exists", async ({
    page,
  }) => {
    await page.goto("file://" + FIXTURE_PATH.replace(/\\/g, "/"));
    await page.addScriptTag({ path: CONTENT_SCRIPT_PATH });

    const results = await page.evaluate(() => {
      // The stub must be built INSIDE the page: functions cannot be serialized
      // across the evaluate boundary, so it cannot be passed in as an argument.
      const withListener = {
        runtime: { onMessage: { addListener: function () {} } },
      };
      return {
        mozExtension: window.__ffr.shouldRegisterMessageListener(
          "moz-extension:",
          withListener
        ),
        chromeExtension: window.__ffr.shouldRegisterMessageListener(
          "chrome-extension:",
          withListener
        ),
      };
    });

    expect(results.mozExtension).toBe(false);
    expect(results.chromeExtension).toBe(false);
  });

  test("does register on ordinary page schemes when the runtime API exists", async ({
    page,
  }) => {
    await page.goto("file://" + FIXTURE_PATH.replace(/\\/g, "/"));
    await page.addScriptTag({ path: CONTENT_SCRIPT_PATH });

    const results = await page.evaluate(() => {
      const withListener = {
        runtime: { onMessage: { addListener: function () {} } },
      };
      return {
        https: window.__ffr.shouldRegisterMessageListener(
          "https:",
          withListener
        ),
        http: window.__ffr.shouldRegisterMessageListener(
          "http:",
          withListener
        ),
        file: window.__ffr.shouldRegisterMessageListener(
          "file:",
          withListener
        ),
      };
    });

    // A real content script must still register on the pages it is injected
    // into - the guard must not over-reach and disable the extension.
    expect(results.https).toBe(true);
    expect(results.http).toBe(true);
    expect(results.file).toBe(true);
  });

  test("does not register when the runtime API is absent or incomplete", async ({
    page,
  }) => {
    await page.goto("file://" + FIXTURE_PATH.replace(/\\/g, "/"));
    await page.addScriptTag({ path: CONTENT_SCRIPT_PATH });

    const results = await page.evaluate(() => {
      const reg = window.__ffr.shouldRegisterMessageListener;
      return {
        nullApi: reg("https:", null),
        noRuntime: reg("https:", {}),
        noOnMessage: reg("https:", { runtime: {} }),
        noAddListener: reg("https:", { runtime: { onMessage: {} } }),
        addListenerNotCallable: reg("https:", {
          runtime: { onMessage: { addListener: "nope" } },
        }),
      };
    });

    // This is the standalone-injection case the test harness itself relies on:
    // the script must load without throwing when there is no extension API.
    expect(results.nullApi).toBe(false);
    expect(results.noRuntime).toBe(false);
    expect(results.noOnMessage).toBe(false);
    expect(results.noAddListener).toBe(false);
    expect(results.addListenerNotCallable).toBe(false);
  });

  test("a stubbed runtime API on a file:// page really receives an addListener call", async ({
    page,
  }) => {
    // End-to-end proof rather than predicate-only: define a fake browser global
    // BEFORE the content script loads, then confirm it registered exactly once.
    await page.goto("file://" + FIXTURE_PATH.replace(/\\/g, "/"));
    await page.evaluate(() => {
      window.__registrations = 0;
      window.browser = {
        runtime: {
          id: "find-replace@example.local",
          onMessage: {
            addListener: function () {
              window.__registrations += 1;
            },
          },
        },
      };
    });
    await page.addScriptTag({ path: CONTENT_SCRIPT_PATH });

    const registrations = await page.evaluate(() => window.__registrations);
    expect(registrations).toBe(1);
  });
});
