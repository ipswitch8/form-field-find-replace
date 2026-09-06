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
 * Load a fixture file and inject content/find-replace.js into it, exactly
 * as the real extension does via browser.scripting.executeScript, except
 * here it is Playwright's addScriptTag against a plain (non-extension)
 * page. content/find-replace.js guards its browser.runtime.onMessage
 * registration behind an extension-API existence check, so this is safe.
 * @param {import('@playwright/test').Page} page
 * @param {string} fixturePath
 */
async function loadFixtureWithContentScript(page, fixturePath) {
  await page.goto("file://" + fixturePath.replace(/\\/g, "/"));
  await page.addScriptTag({ path: CONTENT_SCRIPT_PATH });
}

test.describe("collectFields (phase 2)", () => {
  test("finds exactly the non-skipped fields in fixture.html", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const result = await page.evaluate(() => {
      // @ts-ignore - window.__ffr is exposed by content/find-replace.js
      const fields = Array.from(window.__ffr.collectFields(document));
      return fields.map((f) => ({
        id: f.el.id,
        kind: f.kind,
        type: f.type,
      }));
    });

    expect(result).toHaveLength(4);

    const ids = result.map((f) => f.id).sort();
    expect(ids).toEqual(
      [
        "text-input",
        "email-input",
        "textarea-input",
        "contenteditable-div",
      ].sort()
    );

    // Confirm password/disabled/readonly are genuinely excluded, not just
    // absent by coincidence.
    expect(ids).not.toContain("password-input");
    expect(ids).not.toContain("disabled-input");
    expect(ids).not.toContain("readonly-input");

    // Resolved kind/type sanity per field.
    const byId = Object.fromEntries(result.map((f) => [f.id, f]));
    expect(byId["text-input"]).toMatchObject({ kind: "input", type: "text" });
    expect(byId["email-input"]).toMatchObject({
      kind: "input",
      type: "email",
    });
    expect(byId["textarea-input"]).toMatchObject({
      kind: "textarea",
      type: "textarea",
    });
    expect(byId["contenteditable-div"]).toMatchObject({
      kind: "contenteditable",
      type: "contenteditable",
    });
  });

  test("resolves a missing/unrecognized input type to 'text'", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const resolved = await page.evaluate(() => {
      const input = document.createElement("input");
      // no type attribute at all
      document.body.appendChild(input);
      const noType = window.__ffr.resolveInputType(input);

      input.setAttribute("type", "banana");
      const unrecognized = window.__ffr.resolveInputType(input);

      input.remove();
      return { noType, unrecognized };
    });

    expect(resolved.noType).toBe("text");
    expect(resolved.unrecognized).toBe("text");
  });

  test("count action returns matches and fields without mutating anything", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const before = await page.evaluate(() => ({
      text: document.getElementById("text-input").value,
      password: document.getElementById("password-input").value,
    }));

    const response = await page.evaluate(() => {
      return window.__ffr.handleCount({
        action: "count",
        find: "hello",
        replace: "",
        options: { matchCase: false, wholeWord: false, regex: false },
        fieldTypes: {
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
        },
      });
    });

    expect(response.ok).toBe(true);
    expect(response.error).toBeNull();
    // See test/fixture.html's header comment for the derivation of these.
    expect(response.matches).toBe(7);
    expect(response.fields).toBe(4);

    const after = await page.evaluate(() => ({
      text: document.getElementById("text-input").value,
      password: document.getElementById("password-input").value,
    }));
    expect(after).toEqual(before);
  });

  test("field-type filtering excludes unchecked groups before counting", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const response = await page.evaluate(() => {
      return window.__ffr.handleCount({
        action: "count",
        find: "hello",
        replace: "",
        options: { matchCase: false, wholeWord: false, regex: false },
        // Only textarea enabled - everything else off.
        fieldTypes: {
          text: false,
          search: false,
          url: false,
          tel: false,
          email: false,
          number: false,
          date: false,
          "datetime-local": false,
          month: false,
          week: false,
          time: false,
          textarea: true,
          contenteditable: false,
        },
      });
    });

    expect(response.ok).toBe(true);
    // Only #textarea-input ("hello there, hello again") should count.
    expect(response.matches).toBe(2);
    expect(response.fields).toBe(1);
  });

  test("isValidMessage rejects malformed messages", async ({ page }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const results = await page.evaluate(() => {
      const v = window.__ffr.isValidMessage;
      return {
        nullMsg: v(null),
        notObject: v("count"),
        badAction: v({ action: "delete-everything" }),
        missingFind: v({ action: "count", options: {}, fieldTypes: {} }),
        missingOptions: v({ action: "count", find: "x", fieldTypes: {} }),
        missingFieldTypes: v({ action: "count", find: "x", options: {} }),
        valid: v({ action: "count", find: "x", options: {}, fieldTypes: {} }),
        validCancel: v({ action: "cancel" }),
      };
    });

    expect(results.nullMsg).toBe(false);
    expect(results.notObject).toBe(false);
    expect(results.badAction).toBe(false);
    expect(results.missingFind).toBe(false);
    expect(results.missingOptions).toBe(false);
    expect(results.missingFieldTypes).toBe(false);
    expect(results.valid).toBe(true);
    expect(results.validCancel).toBe(true);
  });
});
