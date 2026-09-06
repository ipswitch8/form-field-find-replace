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

test.describe("phase 4: literal-dollar escaping in plain mode", () => {
  test("finding/replacing literal text containing '$5.00' produces exactly '$5.00' unmangled", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const result = await page.evaluate((fieldTypes) => {
      const el = document.createElement("input");
      el.type = "text";
      el.id = "dollar-test-input";
      el.value = "The old price was TBD.";
      document.body.appendChild(el);

      const response = window.__ffr.handleReplace({
        action: "replace",
        find: "TBD",
        replace: "$5.00",
        options: { matchCase: false, wholeWord: false, regex: false },
        fieldTypes,
      });

      return { value: el.value, response };
    }, ALL_FIELD_TYPES);

    expect(result.response.ok).toBe(true);
    expect(result.response.error).toBeNull();
    expect(result.value).toBe("The old price was $5.00.");
  });

  test("plain mode treats $& as literal text, never the whole-match token", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    // If "$" were not escaped to "$$" before being handed to
    // String.prototype.replace, "$&" here would be silently reinterpreted
    // as "insert the whole match" (i.e. "TBD"), not kept as literal text.
    const result = await page.evaluate((fieldTypes) => {
      const el = document.createElement("input");
      el.type = "text";
      el.id = "dollar-amp-test-input";
      el.value = "The old price was TBD.";
      document.body.appendChild(el);

      const response = window.__ffr.handleReplace({
        action: "replace",
        find: "TBD",
        replace: "cost is $&, literally",
        options: { matchCase: false, wholeWord: false, regex: false },
        fieldTypes,
      });

      return { value: el.value, response };
    }, ALL_FIELD_TYPES);

    expect(result.response.ok).toBe(true);
    expect(result.value).toBe("The old price was cost is $&, literally.");
  });
});

test.describe("phase 4: full substitution grammar in regex mode", () => {
  test("supports numbered capture groups ($1, $2, ...)", async ({ page }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const result = await page.evaluate((fieldTypes) => {
      const el = document.createElement("input");
      el.type = "text";
      el.id = "numbered-group-test-input";
      el.value = "foobar";
      document.body.appendChild(el);

      const response = window.__ffr.handleReplace({
        action: "replace",
        find: "(foo)(bar)",
        replace: "$2-$1",
        options: { matchCase: false, wholeWord: false, regex: true },
        fieldTypes,
      });

      return { value: el.value, response };
    }, ALL_FIELD_TYPES);

    expect(result.response.ok).toBe(true);
    expect(result.value).toBe("bar-foo");
  });

  test("supports named capture groups ($<name>) paired with (?<name>...)", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const result = await page.evaluate((fieldTypes) => {
      const el = document.createElement("input");
      el.type = "text";
      el.id = "named-group-test-input";
      el.value = "hello world";
      document.body.appendChild(el);

      const response = window.__ffr.handleReplace({
        action: "replace",
        find: "(?<word>hello)",
        replace: "[$<word>]",
        options: { matchCase: false, wholeWord: false, regex: true },
        fieldTypes,
      });

      return { value: el.value, response };
    }, ALL_FIELD_TYPES);

    expect(result.response.ok).toBe(true);
    expect(result.value).toBe("[hello] world");
  });

  test("supports $& (whole match)", async ({ page }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const result = await page.evaluate((fieldTypes) => {
      const el = document.createElement("input");
      el.type = "text";
      el.id = "amp-test-input";
      el.value = "hello world";
      document.body.appendChild(el);

      const response = window.__ffr.handleReplace({
        action: "replace",
        find: "world",
        replace: "<$&>",
        options: { matchCase: false, wholeWord: false, regex: true },
        fieldTypes,
      });

      return { value: el.value, response };
    }, ALL_FIELD_TYPES);

    expect(result.response.ok).toBe(true);
    expect(result.value).toBe("hello <world>");
  });

  test("supports $` (text before the match)", async ({ page }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const result = await page.evaluate((fieldTypes) => {
      const el = document.createElement("input");
      el.type = "text";
      el.id = "backtick-test-input";
      el.value = "hello world";
      document.body.appendChild(el);

      const response = window.__ffr.handleReplace({
        action: "replace",
        find: "world",
        replace: "$`",
        options: { matchCase: false, wholeWord: false, regex: true },
        fieldTypes,
      });

      return { value: el.value, response };
    }, ALL_FIELD_TYPES);

    expect(result.response.ok).toBe(true);
    expect(result.value).toBe("hello hello ");
  });

  test("supports $' (text after the match)", async ({ page }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const result = await page.evaluate((fieldTypes) => {
      const el = document.createElement("input");
      el.type = "text";
      el.id = "quote-test-input";
      el.value = "hello world!";
      document.body.appendChild(el);

      const response = window.__ffr.handleReplace({
        action: "replace",
        find: "world",
        replace: "$'",
        options: { matchCase: false, wholeWord: false, regex: true },
        fieldTypes,
      });

      return { value: el.value, response };
    }, ALL_FIELD_TYPES);

    expect(result.response.ok).toBe(true);
    expect(result.value).toBe("hello !!");
  });

  test("supports $$ (literal dollar sign)", async ({ page }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const result = await page.evaluate((fieldTypes) => {
      const el = document.createElement("input");
      el.type = "text";
      el.id = "double-dollar-test-input";
      el.value = "hello world";
      document.body.appendChild(el);

      const response = window.__ffr.handleReplace({
        action: "replace",
        find: "world",
        replace: "$$5",
        options: { matchCase: false, wholeWord: false, regex: true },
        fieldTypes,
      });

      return { value: el.value, response };
    }, ALL_FIELD_TYPES);

    expect(result.response.ok).toBe(true);
    expect(result.value).toBe("hello $5");
  });
});

test.describe("phase 4: backreference validation blocks the replace run", () => {
  test("a valid backreference within the pattern's actual group count is NOT blocked", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const result = await page.evaluate((fieldTypes) => {
      const el = document.createElement("input");
      el.type = "text";
      el.id = "valid-backref-test-input";
      el.value = "hello";
      document.body.appendChild(el);

      const response = window.__ffr.handleReplace({
        action: "replace",
        find: "(hello)",
        replace: "$1$1",
        options: { matchCase: false, wholeWord: false, regex: true },
        fieldTypes,
      });

      return { value: el.value, response };
    }, ALL_FIELD_TYPES);

    expect(result.response.ok).toBe(true);
    expect(result.response.code).toBeUndefined();
    expect(result.value).toBe("hellohello");
  });

  test("a numbered backreference beyond the pattern's group count blocks the run without touching or firing events on ANY field", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const result = await page.evaluate((fieldTypes) => {
      const fields = Array.from(window.__ffr.collectFields(document));
      let eventCount = 0;
      for (const f of fields) {
        f.el.addEventListener("input", () => {
          eventCount++;
        });
        f.el.addEventListener("change", () => {
          eventCount++;
        });
      }
      const valuesBefore = fields.map((f) =>
        f.kind === "contenteditable" ? f.el.textContent : f.el.value
      );

      // "hello" appears in several fixture fields (text-input, email-input,
      // textarea-input, contenteditable-div) - if the replace loop below
      // ran at all, at least one of those would be mutated and fire events.
      const response = window.__ffr.handleReplace({
        action: "replace",
        find: "(hello)",
        replace: "$2",
        options: { matchCase: false, wholeWord: false, regex: true },
        fieldTypes,
      });

      const valuesAfter = fields.map((f) =>
        f.kind === "contenteditable" ? f.el.textContent : f.el.value
      );

      return { response, eventCount, valuesBefore, valuesAfter };
    }, ALL_FIELD_TYPES);

    expect(result.response.ok).toBe(false);
    expect(result.response.code).toBe("backreference-mismatch");
    // A distinct shape from a normal 0-match response: matches/fields are
    // null because the counting/replace loop was never entered at all.
    expect(result.response.matches).toBeNull();
    expect(result.response.fields).toBeNull();
    expect(result.response.replaced).toBe(0);
    expect(typeof result.response.error).toBe("string");
    expect(result.response.error).toContain("$2");

    expect(result.eventCount).toBe(0);
    expect(result.valuesAfter).toEqual(result.valuesBefore);
  });

  test("a named backreference with no matching declared group blocks the run", async ({
    page,
  }) => {
    await loadFixtureWithContentScript(page, FIXTURE_PATH);

    const result = await page.evaluate((fieldTypes) => {
      const el = document.createElement("input");
      el.type = "text";
      el.id = "bad-named-backref-test-input";
      const before = el.value;
      document.body.appendChild(el);

      const response = window.__ffr.handleReplace({
        action: "replace",
        find: "(?<word>hello)",
        replace: "[$<missingName>]",
        options: { matchCase: false, wholeWord: false, regex: true },
        fieldTypes,
      });

      return { before, after: el.value, response };
    }, ALL_FIELD_TYPES);

    expect(result.response.ok).toBe(false);
    expect(result.response.code).toBe("backreference-mismatch");
    expect(result.response.error).toContain("missingName");
    expect(result.after).toBe(result.before);
  });
});
