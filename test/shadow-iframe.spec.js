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
 * @param {import('@playwright/test').Page} page
 * @param {string} fixturePath
 */
async function loadFixtureWithContentScript(page, fixturePath) {
  await page.goto("file://" + fixturePath.replace(/\\/g, "/"));
  // The same-origin iframe (#same-origin-iframe) loads its `srcdoc` content
  // asynchronously - wait for it to finish before any test relies on its
  // contentDocument being populated, so a flaky "not loaded yet" false
  // negative never masquerades as a real collectFields bug.
  await page.evaluate(() => {
    const iframe = /** @type {HTMLIFrameElement} */ (
      document.getElementById("same-origin-iframe")
    );
    if (iframe.contentDocument && iframe.contentDocument.readyState === "complete") {
      return Promise.resolve();
    }
    return new Promise((resolve) => iframe.addEventListener("load", resolve, { once: true }));
  });
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

test.describe("phase 6: shadow DOM and iframe traversal", () => {
  test("a shadow-root field is found and correctly replaced", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const before = await page.evaluate(() => {
      const host = document.getElementById("shadow-host");
      return host.shadowRoot.getElementById("shadow-input").value;
    });
    expect(before).toBe("shadow value");

    const response = await page.evaluate((fieldTypes) => {
      return window.__ffr.handleReplace({
        action: "replace",
        find: "shadow value",
        replace: "SHADOW REPLACED",
        options: { matchCase: false, wholeWord: false, regex: false },
        fieldTypes,
      });
    }, ALL_FIELD_TYPES);

    expect(response.ok).toBe(true);
    expect(response.error).toBeNull();
    expect(response.replaced).toBeGreaterThanOrEqual(1);

    const after = await page.evaluate(() => {
      const host = document.getElementById("shadow-host");
      return host.shadowRoot.getElementById("shadow-input").value;
    });
    expect(after).toBe("SHADOW REPLACED");
  });

  test("closed shadow roots are skipped without error", async ({ page }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    // Sanity: the closed shadow root really is unreachable via the standard
    // accessor, and a field genuinely lives inside it.
    const closedRootIsNull = await page.evaluate(
      () => document.getElementById("closed-shadow-host").shadowRoot === null
    );
    expect(closedRootIsNull).toBe(true);

    const result = await page.evaluate(async (fieldTypes) => {
      let threw = false;
      let errorMessage = null;
      let fields;
      try {
        fields = Array.from(window.__ffr.collectFields(document));
      } catch (error) {
        threw = true;
        errorMessage = String(error);
      }

      const response = await window.__ffr.handleReplace({
        action: "replace",
        find: "closed shadow value",
        replace: "SHOULD NEVER APPEAR",
        options: { matchCase: false, wholeWord: false, regex: false },
        fieldTypes,
      });

      return {
        threw,
        errorMessage,
        ids: fields ? fields.map((f) => f.el.id) : null,
        response,
      };
    }, ALL_FIELD_TYPES);

    // No exception anywhere in the walk or the replace run.
    expect(result.threw).toBe(false);
    expect(result.errorMessage).toBeNull();
    expect(result.response.ok).toBe(true);
    expect(result.response.error).toBeNull();

    // The closed-shadow field was never even collected, so nothing matched
    // it and nothing was replaced inside it.
    expect(result.ids).not.toContain("closed-shadow-input");
    expect(result.response.matches).toBe(0);
    expect(result.response.replaced).toBe(0);
  });

  test("a same-origin iframe field is NOT found when include-iframes is unchecked", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const response = await page.evaluate((fieldTypes) => {
      return window.__ffr.handleCount({
        action: "count",
        find: "iframe value",
        options: {
          matchCase: false,
          wholeWord: false,
          regex: false,
          includeIframes: false,
        },
        fieldTypes,
      });
    }, ALL_FIELD_TYPES);

    expect(response.ok).toBe(true);
    expect(response.matches).toBe(0);
    expect(response.fields).toBe(0);

    const iframeInputUnchanged = await page.evaluate(() => {
      const iframe = /** @type {HTMLIFrameElement} */ (
        document.getElementById("same-origin-iframe")
      );
      return iframe.contentDocument.getElementById("iframe-input").value;
    });
    expect(iframeInputUnchanged).toBe("iframe value");
  });

  test("a same-origin iframe field is found and correctly replaced when include-iframes is checked - exercising the cross-document constructor path", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    // This is the crux of the phase-6 bug called out in the brief: the
    // iframe's <input> belongs to a DIFFERENT document/window than the top
    // page, so `el instanceof HTMLInputElement` checked against the TOP
    // window's constructor is false for it. If describeField/setNativeValue
    // still used that check, this element would either never be classified
    // as an input at all (never collected) or would throw "Illegal
    // invocation" when the native setter is invoked - either way this
    // replace would silently fail. Asserting the value actually changed is
    // what proves the fix.
    const before = await page.evaluate(() => {
      const iframe = /** @type {HTMLIFrameElement} */ (
        document.getElementById("same-origin-iframe")
      );
      return iframe.contentDocument.getElementById("iframe-input").value;
    });
    expect(before).toBe("iframe value");

    const response = await page.evaluate((fieldTypes) => {
      return window.__ffr.handleReplace({
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
    }, ALL_FIELD_TYPES);

    expect(response.ok).toBe(true);
    expect(response.error).toBeNull();
    expect(response.replaced).toBeGreaterThanOrEqual(1);

    const after = await page.evaluate(() => {
      const iframe = /** @type {HTMLIFrameElement} */ (
        document.getElementById("same-origin-iframe")
      );
      return iframe.contentDocument.getElementById("iframe-input").value;
    });
    expect(after).toBe("IFRAME REPLACED");
  });

  test("collectFields directly: includeIframes toggles whether the iframe field is enumerated at all", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const withoutIframes = await page.evaluate(() =>
      Array.from(window.__ffr.collectFields(document)).map((f) => f.el.id)
    );
    expect(withoutIframes).not.toContain("iframe-input");
    // Shadow-root field is present regardless - shadow recursion is not
    // gated by includeIframes at all.
    expect(withoutIframes).toContain("shadow-input");

    const withIframes = await page.evaluate(() =>
      Array.from(
        window.__ffr.collectFields(document, { includeIframes: true })
      ).map((f) => f.el.id)
    );
    expect(withIframes).toContain("iframe-input");
    expect(withIframes).toContain("shadow-input");
  });

  test("the cross-origin iframe causes no thrown error and does not abort the run, even with include-iframes checked", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const result = await page.evaluate(async (fieldTypes) => {
      let threw = false;
      let errorMessage = null;
      let fields = null;
      try {
        fields = Array.from(
          window.__ffr.collectFields(document, { includeIframes: true })
        ).map((f) => f.el.id);
      } catch (error) {
        threw = true;
        errorMessage = String(error);
      }

      // A real replace run, with include-iframes on, must also survive the
      // cross-origin frame without throwing or aborting - and must still
      // reach every OTHER field in the tree (proving collection didn't stop
      // partway through when it hit the cross-origin iframe).
      const response = await window.__ffr.handleReplace({
        action: "replace",
        find: "hello",
        replace: "hello",
        options: {
          matchCase: false,
          wholeWord: false,
          regex: false,
          includeIframes: true,
        },
        fieldTypes,
      });

      return { threw, errorMessage, fields, response };
    }, ALL_FIELD_TYPES);

    expect(result.threw).toBe(false);
    expect(result.errorMessage).toBeNull();
    expect(result.response.ok).toBe(true);
    expect(result.response.error).toBeNull();

    // The cross-origin iframe's own field was never reachable.
    expect(result.fields).not.toContain("cross-origin-input");
    // But collection was not aborted by it - the same-origin iframe field,
    // the shadow-root field, and the top-level "hello" fields are all still
    // present/counted.
    expect(result.fields).toContain("iframe-input");
    expect(result.fields).toContain("shadow-input");
    expect(result.fields).toContain("text-input");
    // The "hello" -> "hello" no-op replace still finds the same 4 top-level
    // matching fields it always has (see fixture.html's header comment).
    expect(result.response.fields).toBe(4);
  });

  // The password-exclusion rule is the most security-relevant behavior in the
  // extension, and this phase is where it is most likely to regress: a refactor
  // that special-cased shadow-root or iframe traversal could bypass
  // describeField's skip rules entirely. Top-level coverage does not catch
  // that, so assert it at both nesting levels with a DESTRUCTIVE replace.
  test("password fields nested in a shadow root and a same-origin iframe are never collected or touched", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const result = await page.evaluate(async (fieldTypes) => {
      const shadowPw = document
        .getElementById("shadow-host")
        .shadowRoot.getElementById("shadow-password-input");
      const iframePw = document
        .getElementById("same-origin-iframe")
        .contentDocument.getElementById("iframe-password-input");

      const before = { shadow: shadowPw.value, iframe: iframePw.value };

      const ids = Array.from(
        window.__ffr.collectFields(document, { includeIframes: true })
      ).map((f) => f.el.id);

      const response = await window.__ffr.handleReplace({
        action: "replace",
        find: "hello",
        replace: "PWNED",
        options: {
          matchCase: false,
          wholeWord: false,
          regex: false,
          includeIframes: true,
        },
        fieldTypes,
      });

      return {
        ids,
        response,
        before,
        after: { shadow: shadowPw.value, iframe: iframePw.value },
      };
    }, ALL_FIELD_TYPES);

    // Sanity: the fixture fields really exist and really contain the needle,
    // so a failure to exclude them would genuinely have been destructive.
    expect(result.before.shadow).toBe("hello shadow secret");
    expect(result.before.iframe).toBe("hello iframe secret");

    // Never collected...
    expect(result.ids).not.toContain("shadow-password-input");
    expect(result.ids).not.toContain("iframe-password-input");
    // ...and byte-identical afterwards.
    expect(result.response.ok).toBe(true);
    expect(result.after.shadow).toBe("hello shadow secret");
    expect(result.after.iframe).toBe("hello iframe secret");
    expect(result.after.shadow).not.toContain("PWNED");
    expect(result.after.iframe).not.toContain("PWNED");
  });

  // COVERAGE NOTE: the #cross-origin-iframe fixture uses sandbox="", which in
  // this Firefox/Playwright harness yields contentDocument === null rather
  // than THROWING a SecurityError. That exercises collectFields's
  // `if (iframeDoc)` null guard but leaves its `catch` block uncovered.
  //
  // Real Firefox does throw on some cross-origin contentDocument accesses, so
  // the catch is not dead code - it is simply unreachable through the fixture.
  // These tests force it directly by redefining contentDocument to a throwing
  // getter, which is the only way to drive that branch without a live
  // cross-origin server.
  test("a frame whose contentDocument getter THROWS is skipped quietly and the run continues", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const result = await page.evaluate(async (fieldTypes) => {
      const iframe = document.getElementById("same-origin-iframe");

      // Replace the same-origin frame's contentDocument with a getter that
      // throws the way a genuine cross-origin access does. Using the
      // SAME-ORIGIN frame matters: it would otherwise be traversed
      // successfully, so if the catch did not swallow this the run would
      // abort and the assertions below would fail.
      let getterCalls = 0;
      Object.defineProperty(iframe, "contentDocument", {
        configurable: true,
        get() {
          getterCalls += 1;
          const err = new Error("Permission denied to access property");
          err.name = "SecurityError";
          throw err;
        },
      });

      let threw = false;
      let response = null;
      let ids = [];
      try {
        ids = Array.from(
          window.__ffr.collectFields(document, { includeIframes: true })
        ).map((f) => f.el.id);
        response = await window.__ffr.handleReplace({
          action: "replace",
          find: "hello",
          replace: "hello",
          options: {
            matchCase: false,
            wholeWord: false,
            regex: false,
            includeIframes: true,
          },
          fieldTypes,
        });
      } catch (e) {
        threw = true;
      }

      return { threw, response, ids, getterCalls };
    }, ALL_FIELD_TYPES);

    // The throwing getter was actually reached - otherwise this test proves
    // nothing about the catch branch.
    expect(result.getterCalls).toBeGreaterThan(0);

    // Nothing escaped collectFields or handleReplace.
    expect(result.threw).toBe(false);
    expect(result.response.ok).toBe(true);
    expect(result.response.error).toBeNull();

    // The run continued past the throwing frame: every other field, including
    // the one in the OPEN SHADOW ROOT that is walked after it, is still found.
    expect(result.ids).toContain("text-input");
    expect(result.ids).toContain("shadow-input");
    // ...and the frame's own field is correctly absent, since it was skipped.
    expect(result.ids).not.toContain("iframe-input");
    expect(result.response.fields).toBe(4);
  });
});
