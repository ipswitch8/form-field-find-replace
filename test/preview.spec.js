// @ts-check
const path = require("path");
const { test, expect } = require("@playwright/test");

const POPUP_PATH = path.join(__dirname, "..", "popup", "popup.html");

/**
 * Load popup/popup.html directly as a plain file:// page - not inside an
 * actual extension. popup.js only touches the `browser` extension API
 * inside try/catch blocks (storage restore, tab messaging), so it degrades
 * gracefully with no extension context present, which makes it possible to
 * test the live-preview wiring (DOM events -> debounce -> render) end to
 * end without mocking the whole WebExtension API surface.
 * @param {import('@playwright/test').Page} page
 */
async function loadPopup(page) {
  await page.goto("file://" + POPUP_PATH.replace(/\\/g, "/"));
  // Wait for init() (which awaits restoreState()) to finish and the initial
  // (empty-find) preview render to complete.
  await page.waitForFunction(() => {
    const el = document.getElementById("match-preview");
    return el !== null;
  });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} value
 */
async function typeFind(page, value) {
  await page.fill("#find-input", value);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} value
 */
async function typeReplace(page, value) {
  await page.fill("#replace-input", value);
}

/** Wait long enough for the popup's preview debounce (200ms) to fire. */
async function waitForDebounce(page) {
  await page.waitForTimeout(350);
}

test.describe("phase 4: live first-match preview", () => {
  test("computeFirstMatchPreview is exposed via the shared content-script matcher, loaded by popup.html", async ({
    page,
  }) => {
    await loadPopup(page);

    const hasSharedMatcher = await page.evaluate(() => {
      return (
        typeof window.__ffr === "object" &&
        typeof window.__ffr.computeFirstMatchPreview === "function" &&
        typeof window.__ffr.buildMatcher === "function"
      );
    });

    expect(hasSharedMatcher).toBe(true);
  });

  test("an empty find field shows no preview text", async ({ page }) => {
    await loadPopup(page);
    await waitForDebounce(page);

    const text = await page.textContent("#match-preview");
    expect(text).toBe("");
  });

  test("plain-mode typing updates the preview (debounced) with the substituted sample text", async ({
    page,
  }) => {
    await loadPopup(page);

    await typeFind(page, "Jane Doe");
    await typeReplace(page, "John Smith");
    await waitForDebounce(page);

    const text = await page.textContent("#match-preview");
    expect(text).toBe(
      "Contact John Smith at jane.doe@example.com or 555-123-4567. " +
        "Order #12345 for $5.00 was placed on 2026-03-14."
    );
  });

  test("a find string with no match in the sample text is reported as no match", async ({
    page,
  }) => {
    await loadPopup(page);

    await typeFind(page, "this-text-does-not-appear-anywhere");
    await waitForDebounce(page);

    const text = await page.textContent("#match-preview");
    expect(text).toBe("No match in sample text.");
  });

  test("an invalid regex is reported as an error, not thrown", async ({
    page,
  }) => {
    await loadPopup(page);

    await page.check("#regex-checkbox");
    await typeFind(page, "(unclosed");
    await waitForDebounce(page);

    const [text, hasErrorClass] = await Promise.all([
      page.textContent("#match-preview"),
      page.evaluate(() =>
        document.getElementById("match-preview").classList.contains("status-error")
      ),
    ]);

    expect(text && text.length).toBeGreaterThan(0);
    expect(hasErrorClass).toBe(true);
  });

  test("regex mode preview reflects numbered capture-group substitution using the shared matcher", async ({
    page,
  }) => {
    await loadPopup(page);

    await page.check("#regex-checkbox");
    await typeFind(page, "(\\d{3})-(\\d{3})-(\\d{4})");
    await typeReplace(page, "$1.$2.$3");
    await waitForDebounce(page);

    const text = await page.textContent("#match-preview");
    expect(text).toBe(
      "Contact Jane Doe at jane.doe@example.com or 555.123.4567. " +
        "Order #12345 for $5.00 was placed on 2026-03-14."
    );
  });

  test("a backreference/group mismatch surfaces as an error in the preview before Replace all is ever run", async ({
    page,
  }) => {
    await loadPopup(page);

    await page.check("#regex-checkbox");
    await typeFind(page, "(\\d+)");
    await typeReplace(page, "$2");
    await waitForDebounce(page);

    const [text, hasErrorClass] = await Promise.all([
      page.textContent("#match-preview"),
      page.evaluate(() =>
        document.getElementById("match-preview").classList.contains("status-error")
      ),
    ]);

    expect(text).toContain("$2");
    expect(hasErrorClass).toBe(true);
  });

  test("rapid keystrokes are debounced - preview does not thrash and settles on the final input", async ({
    page,
  }) => {
    await loadPopup(page);

    // Simulate rapid typing well under the 200ms debounce window between
    // keystrokes; only the final value should ever be rendered.
    await page.type("#find-input", "Jane", { delay: 10 });
    await page.type("#find-input", " Doe", { delay: 10 });
    await typeReplace(page, "Someone Else");
    await waitForDebounce(page);

    const text = await page.textContent("#match-preview");
    expect(text).toBe(
      "Contact Someone Else at jane.doe@example.com or 555-123-4567. " +
        "Order #12345 for $5.00 was placed on 2026-03-14."
    );
  });
});
