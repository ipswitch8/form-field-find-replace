// @ts-check
const path = require("path");
const { test, expect } = require("@playwright/test");

const FIXTURE_BULK_PATH = path.join(__dirname, "fixture-bulk.html");
const CONTENT_SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "content",
  "find-replace.js"
);

// Phase 2 scope only: confirm the bulk fixture generates exactly 5,000
// fields with the declared, deterministic seeded match count, and that
// collectFields + the count path handle that volume correctly. The chunked
// loop, progress messages, and cancellation are phase 5 concerns.
test.describe("fixture-bulk.html (phase 2 smoke coverage)", () => {
  test("generates exactly 5000 inputs with a declared expected match count", async ({
    page,
  }) => {
    await page.goto(
      "file://" + FIXTURE_BULK_PATH.replace(/\\/g, "/")
    );
    await page.addScriptTag({ path: CONTENT_SCRIPT_PATH });

    const info = await page.evaluate(() => ({
      total: window.__TOTAL_FIELDS,
      expectedMatches: window.__EXPECTED_MATCHES,
      inputCount: document.querySelectorAll("input").length,
    }));

    expect(info.total).toBe(5000);
    expect(info.inputCount).toBe(5000);
    expect(info.expectedMatches).toBe(500);

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
    expect(response.matches).toBe(500);
    expect(response.fields).toBe(500);
  });
});
