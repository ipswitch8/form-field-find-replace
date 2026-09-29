// @ts-check
/**
 * Regression tests for whitespace matching in rich-text (contenteditable)
 * fields.
 *
 * THE BUG
 * -------
 * Searching a contenteditable for "   to a brief" (three leading ASCII spaces)
 * found nothing, while "to a brief" matched immediately.
 *
 * Whitespace is not being stripped. When you type consecutive spaces into a
 * contenteditable, the browser substitutes U+00A0 (NBSP) for some of them so
 * HTML does not collapse the run. Typing three spaces yields NBSP, space,
 * NBSP — verified by dumping codepoints from a field typed with real key
 * events. The needle is three U+0020, which never equals U+00A0.
 *
 * WHY THESE TESTS TYPE INSTEAD OF SETTING HTML
 * --------------------------------------------
 * This is the trap the bug hid behind. Hand-authored HTML like
 * `<div>   to a brief</div>` contains real U+0020 spaces and matches fine even
 * against the broken code. Only content produced by actual keystrokes contains
 * the substituted NBSPs. A test that sets innerHTML would pass either way and
 * prove nothing — so the repro cases below all use page.keyboard.type().
 *
 * THE DECISION, recorded in README.md's "Spaces in rich-text fields"
 * -----------------------------------------------------------------
 * A literal space in a PLAIN or WHOLE-WORD needle matches U+0020 and U+00A0
 * only. U+2007 (figure space), U+202F (narrow no-break space) and U+2009 (thin
 * space) are deliberately NOT matched: they are typographic characters someone
 * inserted on purpose, and having a plain space silently hit them would make a
 * destructive replace touch text the user never meant. Tests below pin both
 * the inclusions and the exclusions.
 *
 * REGEX mode is untouched — JavaScript's \s already matches U+00A0.
 */
const path = require("path");
const { test, expect } = require("@playwright/test");

const CONTENT_SCRIPT_PATH = path.join(__dirname, "..", "content", "find-replace.js");


const PLAIN = { matchCase: false, wholeWord: false, regex: false };
const WHOLE_WORD = { matchCase: false, wholeWord: true, regex: false };
const REGEX = { matchCase: false, wholeWord: false, regex: true };

const ALL_TYPES = {
  text: true, search: true, url: true, tel: true, email: true,
  number: false, date: false, "datetime-local": false,
  month: false, week: false, time: false,
  textarea: true, contenteditable: true,
};

async function load(page, html) {
  await page.setContent(html);
  await page.addScriptTag({ path: CONTENT_SCRIPT_PATH });
}

/** Run the shared matcher against a string and report whether it matched. */
async function matches(page, haystack, needle, options) {
  return page.evaluate(
    ({ haystack, needle, options }) => {
      const m = window.__ffr.buildMatcher(needle, options);
      if (m.error) return { error: m.error };
      m.regex.lastIndex = 0;
      return { matched: m.regex.test(haystack), error: null };
    },
    { haystack, needle, options }
  );
}

test.describe("whitespace matching in rich-text fields", () => {
  // ---- The repro, at the level the bug actually lives ------------------

  test("typed leading spaces are found by a plain-space needle", async ({ page }) => {
    await load(page, '<div id="rt" contenteditable="true"></div>');
    await page.click("#rt");
    await page.keyboard.type("   to a brief");

    // Precondition: prove the browser really did substitute NBSPs, otherwise
    // this test is not exercising the bug at all.
    const codes = await page.evaluate(() =>
      Array.from(document.getElementById("rt").textContent).map((c) => c.codePointAt(0))
    );
    expect(codes.slice(0, 3)).toEqual([0x00a0, 0x20, 0x00a0]);

    const text = await page.evaluate(() => document.getElementById("rt").textContent);
    const r = await matches(page, text, "   to a brief", PLAIN);
    expect(r.error).toBeNull();
    expect(r.matched).toBe(true);
  });

  test("typed leading spaces are found in whole-word mode", async ({ page }) => {
    await load(page, '<div id="rt" contenteditable="true"></div>');
    await page.click("#rt");
    // A word precedes the run so the leading \b in whole-word mode has a word
    // character to sit against - \b before a space at the very start of the
    // string would never match, fix or no fix.
    await page.keyboard.type("word   to a brief");

    const text = await page.evaluate(() => document.getElementById("rt").textContent);
    const r = await matches(page, text, "   to a brief", WHOLE_WORD);
    expect(r.error).toBeNull();
    expect(r.matched).toBe(true);
  });

  // ---- Controls: these must pass BEFORE and AFTER the fix --------------

  test("hand-authored HTML with real spaces still matches (unbroken by the fix)", async ({
    page,
  }) => {
    await load(page, '<div id="rt" contenteditable="true">   to a brief</div>');
    const text = await page.evaluate(() => document.getElementById("rt").textContent);
    expect(Array.from(text).slice(0, 3).map((c) => c.codePointAt(0))).toEqual([0x20, 0x20, 0x20]);

    const r = await matches(page, text, "   to a brief", PLAIN);
    expect(r.matched).toBe(true);
  });

  test("regex mode already handles NBSP and must stay untouched", async ({ page }) => {
    await load(page, '<div id="rt" contenteditable="true"></div>');
    await page.click("#rt");
    await page.keyboard.type("   to a brief");
    const text = await page.evaluate(() => document.getElementById("rt").textContent);

    // JavaScript's \s matches U+00A0, so this works with or without the fix.
    const r = await matches(page, text, "\\s+to a brief", REGEX);
    expect(r.error).toBeNull();
    expect(r.matched).toBe(true);
  });

  // ---- The decision, pinned per codepoint -------------------------------

  // Built from String.fromCodePoint rather than a pasted character, and
  // guarded with codePointAt, exactly as the exclusion tests below are. These
  // characters render identically to a plain space, so a pasted constant could
  // silently be the wrong codepoint and the test would still look right - which
  // is precisely the confusion this whole bug is made of.
  for (const [name, code] of [
    ["U+0020 space", 0x20],
    ["U+00A0 no-break space", 0x00a0],
  ]) {
    test(`a plain-space needle matches ${name} (included by decision)`, async ({
      page,
    }) => {
      await load(page, "<div></div>");
      const haystack = "a" + String.fromCodePoint(code) + "b";
      // Guard the fixture: prove we really placed that codepoint.
      expect(haystack.codePointAt(1)).toBe(code);

      const r = await matches(page, haystack, "a b", PLAIN);
      expect(r.error).toBeNull();
      expect(r.matched).toBe(true);
    });
  }

  for (const [name, code] of [
    ["U+2007 figure space", 0x2007],
    ["U+202F narrow no-break space", 0x202f],
    ["U+2009 thin space", 0x2009],
  ]) {
    test(`a plain-space needle does NOT match ${name} (excluded by decision)`, async ({
      page,
    }) => {
      await load(page, "<div></div>");
      const haystack = "a" + String.fromCodePoint(code) + "b";
      // Guard the fixture itself: prove we really placed that codepoint.
      expect(haystack.codePointAt(1)).toBe(code);

      const r = await matches(page, haystack, "a b", PLAIN);
      // Excluded on purpose - see README "Spaces in rich-text fields". This is
      // what stops an over-broad fix that maps a space to \s.
      expect(r.matched).toBe(false);
    });
  }

  // ---- The replace-time consequence -------------------------------------

  test("replacing a match containing NBSP writes the replacement literally, collapsing the NBSPs", async ({
    page,
  }) => {
    await load(page, '<div id="rt" contenteditable="true"></div>');
    await page.click("#rt");
    await page.keyboard.type("   to a brief");

    const before = await page.evaluate(() =>
      Array.from(document.getElementById("rt").textContent).map((c) => c.codePointAt(0))
    );
    expect(before.slice(0, 3)).toEqual([0x00a0, 0x20, 0x00a0]);

    const after = await page.evaluate(async (fieldTypes) => {
      await window.__ffr.handleReplace({
        action: "replace",
        find: "   to a brief",
        replace: "   to a summary",
        options: { matchCase: false, wholeWord: false, regex: false },
        fieldTypes,
      });
      const el = document.getElementById("rt");
      return {
        codes: Array.from(el.textContent).map((c) => c.codePointAt(0)),
        text: el.textContent,
      };
    }, ALL_TYPES);

    // Documented behaviour (README, "What happens to the non-breaking spaces
    // when you replace"): the replacement is inserted exactly as typed, so the
    // NBSPs are gone and three plain spaces stand in their place. HTML will
    // then render that run collapsed. Asserted on codepoints, not on a
    // string that looks the same either way.
    expect(after.codes.slice(0, 3)).toEqual([0x20, 0x20, 0x20]);
    expect(after.text).toContain("to a summary");
    expect(after.codes).not.toContain(0x00a0);
  });
});
