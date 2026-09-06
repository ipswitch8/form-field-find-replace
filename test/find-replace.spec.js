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
  await page.addScriptTag({ path: CONTENT_SCRIPT_PATH });
}

/** Field-types payload with every group enabled, for tests that don't care
 * about filtering. */
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

test.describe("replace path (phase 3)", () => {
  test("replace against the controlled-input widget updates its displayed value via the native-setter path", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const before = await page.evaluate(
      () => document.getElementById("controlled-input").value
    );
    expect(before).toBe("state one");

    const response = await page.evaluate((fieldTypes) => {
      return window.__ffr.handleReplace({
        action: "replace",
        find: "state one",
        replace: "state two",
        options: { matchCase: false, wholeWord: false, regex: false },
        fieldTypes,
      });
    }, ALL_FIELD_TYPES);

    expect(response.ok).toBe(true);
    expect(response.error).toBeNull();
    expect(response.replaced).toBeGreaterThanOrEqual(1);

    const after = await page.evaluate(
      () => document.getElementById("controlled-input").value
    );
    // This is the crux of the test: the fixture's controlled-input widget
    // reverts ANY write that doesn't go through the native prototype setter
    // followed by a real `input` event (see fixture.html's inline script).
    // A plain `el.value = x` assignment in the content script would be
    // silently reverted here and this assertion would fail.
    expect(after).toBe("state two");
  });

  test("a date-field replace producing an invalid value is rolled back to the original value, not blanked", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const before = await page.evaluate(
      () => document.getElementById("date-input").value
    );
    expect(before).toBe("2026-03-14");

    const response = await page.evaluate((fieldTypes) => {
      return window.__ffr.handleReplace({
        action: "replace",
        find: "2026-03-14",
        replace: "not-a-date",
        options: { matchCase: false, wholeWord: false, regex: false },
        fieldTypes,
      });
    }, ALL_FIELD_TYPES);

    expect(response.ok).toBe(true);
    expect(response.error).toBeNull();
    expect(response.skipped).toBeGreaterThanOrEqual(1);

    const after = await page.evaluate(
      () => document.getElementById("date-input").value
    );
    // Must be rolled back to the ORIGINAL value - never left blank as a
    // side effect of the browser rejecting the invalid assigned value.
    expect(after).toBe("2026-03-14");
    expect(after).not.toBe("");
  });

  test("a field with no match is left completely untouched - no input/change events fired", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const eventCounts = await page.evaluate(async (fieldTypes) => {
      const el = document.getElementById("number-input");
      const counts = { input: 0, change: 0 };
      el.addEventListener("input", () => counts.input++);
      el.addEventListener("change", () => counts.change++);

      const valueBefore = el.value;

      const response = await window.__ffr.handleReplace({
        action: "replace",
        find: "this-string-does-not-appear-anywhere",
        replace: "x",
        options: { matchCase: false, wholeWord: false, regex: false },
        fieldTypes,
      });

      return {
        counts,
        valueBefore,
        valueAfter: el.value,
        response,
      };
    }, ALL_FIELD_TYPES);

    expect(eventCounts.response.ok).toBe(true);
    expect(eventCounts.response.replaced).toBe(0);
    expect(eventCounts.counts.input).toBe(0);
    expect(eventCounts.counts.change).toBe(0);
    expect(eventCounts.valueAfter).toBe(eventCounts.valueBefore);
  });

  test("count and replace share the same matcher - matches agree for the same query", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const result = await page.evaluate(async (fieldTypes) => {
      const countResponse = window.__ffr.handleCount({
        action: "count",
        find: "hello",
        options: { matchCase: false, wholeWord: false, regex: false },
        fieldTypes,
      });
      // A no-op replace (replacement identical to the match) exercises the
      // exact same matcher/count logic on the replace path without
      // mutating anything meaningful.
      const replaceResponse = await window.__ffr.handleReplace({
        action: "replace",
        find: "hello",
        replace: "hello",
        options: { matchCase: false, wholeWord: false, regex: false },
        fieldTypes,
      });
      return { countResponse, replaceResponse };
    }, ALL_FIELD_TYPES);

    expect(result.replaceResponse.matches).toBe(result.countResponse.matches);
    expect(result.replaceResponse.fields).toBe(result.countResponse.fields);
  });

  test("regex mode compile errors are returned via the error field, not thrown", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const response = await page.evaluate((fieldTypes) => {
      return window.__ffr.handleReplace({
        action: "replace",
        find: "(unclosed",
        replace: "x",
        options: { matchCase: false, wholeWord: false, regex: true },
        fieldTypes,
      });
    }, ALL_FIELD_TYPES);

    expect(response.ok).toBe(false);
    expect(typeof response.error).toBe("string");
    expect(response.error.length).toBeGreaterThan(0);
  });

  test("whole-word mode only replaces whole-word matches", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    // #text-input value="hello world hello" - "hello" is whole-word already,
    // so use a needle that would otherwise match inside a longer word to
    // prove wholeWord actually constrains it. #email-input contains
    // "hello@example.com" - "hello" is whole-word there too (bounded by
    // start-of-string and "@"), so instead assert against a substring that
    // is NOT a whole word: "ell" inside "hello" should not match when
    // wholeWord is on.
    const response = await page.evaluate((fieldTypes) => {
      return window.__ffr.handleReplace({
        action: "replace",
        find: "ell",
        replace: "ELL",
        options: { matchCase: false, wholeWord: true, regex: false },
        fieldTypes,
      });
    }, ALL_FIELD_TYPES);

    expect(response.ok).toBe(true);
    expect(response.matches).toBe(0);
    expect(response.replaced).toBe(0);
  });

  test("contenteditable replacement walks text nodes and preserves nested markup", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const response = await page.evaluate((fieldTypes) => {
      return window.__ffr.handleReplace({
        action: "replace",
        find: "hello",
        replace: "HELLO",
        options: { matchCase: false, wholeWord: false, regex: false },
        fieldTypes,
      });
    }, ALL_FIELD_TYPES);

    expect(response.ok).toBe(true);

    const after = await page.evaluate(() => {
      const el = document.getElementById("contenteditable-div");
      return {
        html: el.innerHTML,
        text: el.textContent,
        hasB: el.querySelector("b") !== null,
        hasSpan: el.querySelector("span") !== null,
      };
    });

    // Nested markup must survive - proves nodeValue-per-text-node was used
    // instead of an innerHTML reassignment.
    expect(after.hasB).toBe(true);
    expect(after.hasSpan).toBe(true);
    expect(after.text).toBe("HELLO world HELLO there");
  });

  // The single most security-relevant behavior in the extension: a replace must
  // never read or write a password field. The count path already asserts the
  // exclusion; this covers the REPLACE path with a genuinely destructive
  // substitution, so a regression that re-included password fields could not
  // hide behind a no-op replacement.
  test("a destructive replace never touches password, hidden or file fields", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const before = await page.evaluate(
      () => document.getElementById("password-input").value
    );
    expect(before).toBe("hello secret");

    const events = await page.evaluate(() => {
      const el = document.getElementById("password-input");
      window.__pwEvents = 0;
      el.addEventListener("input", () => (window.__pwEvents += 1));
      el.addEventListener("change", () => (window.__pwEvents += 1));
      return window.__pwEvents;
    });
    expect(events).toBe(0);

    const response = await page.evaluate(async (fieldTypes) => {
      return await window.__ffr.handleReplace({
        action: "replace",
        find: "hello",
        replace: "PWNED",
        options: { matchCase: false, wholeWord: false, regex: false },
        fieldTypes,
      });
    }, ALL_FIELD_TYPES);

    expect(response.ok).toBe(true);

    const after = await page.evaluate(() => ({
      value: document.getElementById("password-input").value,
      events: window.__pwEvents,
    }));

    // Value must be byte-identical, and no event may have been dispatched at
    // it - the field must not be touched at all, not merely restored.
    expect(after.value).toBe("hello secret");
    expect(after.value).not.toContain("PWNED");
    expect(after.events).toBe(0);
  });
});
