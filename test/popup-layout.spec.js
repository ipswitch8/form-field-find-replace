// @ts-check
/**
 * Does the popup fit without scrolling?
 *
 * WHY THIS IS MEASURED AND NOT EYEBALLED
 * -------------------------------------
 * "It looks fine on my screen" is not a check. The popup has several disclosure
 * states - the field-types section expanded, the undo-cap warning banner
 * showing, a long multi-part status line, a history dropdown open - and the one
 * that overflows is whichever one nobody happened to look at. Each state below
 * is measured with document.documentElement.scrollHeight <= clientHeight, with
 * zero tolerance.
 *
 * THE FIREFOX CAP
 * ---------------
 * A WebExtension popup cannot grow past 800x600; Firefox scrolls it instead.
 * So "make the CSS taller" is not available as a fix and the real work is
 * density - a multi-column grid for the thirteen field-type checkboxes, a
 * tighter vertical rhythm, and a history overlay that is out of flow so opening
 * it adds nothing to the document's height. Every state here is also asserted
 * to fit inside 600px with room to spare, not merely to fit the viewport
 * Playwright happens to give it.
 *
 * WHY THE VIEWPORT IS SET EXPLICITLY
 * ----------------------------------
 * Playwright's default viewport is far taller than a Firefox popup, so a naive
 * scrollHeight <= clientHeight check would pass on a document that overflows a
 * real popup badly. Each test pins the viewport to the popup's own declared CSS
 * width and to the 600px cap, which is the geometry the browser actually gives
 * it.
 */
const path = require("path");
const { test, expect } = require("@playwright/test");

const POPUP_PATH = path.join(__dirname, "..", "popup", "popup.html");

/** Firefox's hard ceiling for a browser_action popup. */
const POPUP_MAX_WIDTH = 800;
const POPUP_MAX_HEIGHT = 600;

const DEFAULT_FIELD_TYPES = {
  text: true, search: true, url: true, tel: true, email: true,
  number: false, date: false, "datetime-local": false,
  month: false, week: false, time: false,
  textarea: true, contenteditable: true,
};

function entry(find, replace) {
  return {
    find,
    replace,
    options: { matchCase: false, wholeWord: false, regex: false, includeIframes: false },
    fieldTypes: { ...DEFAULT_FIELD_TYPES },
  };
}

/**
 * The longest realistic status line the popup can produce. Built from the same
 * pieces handleReplaceAll assembles: the replaced/total clause plus skipped and
 * timed-out counts and the wall time. Numbers are deliberately wide - a user
 * with a bulk page really can see five figures here.
 */
const LONGEST_STATUS =
  "Replaced 12,345 of 67,890 fields, 1,234 skipped, 567 timed out (98765ms)";

/**
 * The undo-cap warning, with the widest numbers it can carry. This is the
 * literal shape popup.js builds in handleReplaceAll's preflight.
 */
const LONGEST_UNDO_WARNING =
  "Warning: 123456 fields were found, which exceeds the 50,000-entry undo " +
  "limit. Undo will be disabled for this run.";

/**
 * Mount the popup at the geometry a real Firefox popup gets: the document's own
 * declared CSS width, and the 600px cap for height.
 * @param {import('@playwright/test').Page} page
 * @param {{history?: any[]}} [opts]
 */
async function mountPopup(page, opts = {}) {
  const seed = {};
  if (opts.history) {
    seed["formFieldFindReplaceHistory"] = opts.history;
  }

  await page.addInitScript((seedIn) => {
    const store = JSON.parse(JSON.stringify(seedIn));
    // @ts-ignore
    window.browser = {
      storage: {
        local: {
          get: (keys) => {
            const out = {};
            const list = Array.isArray(keys) ? keys : [keys];
            for (const k of list) {
              if (Object.prototype.hasOwnProperty.call(store, k)) {
                out[k] = JSON.parse(JSON.stringify(store[k]));
              }
            }
            return Promise.resolve(out);
          },
          set: (items) => {
            Object.assign(store, JSON.parse(JSON.stringify(items)));
            return Promise.resolve();
          },
        },
      },
      scripting: { executeScript: () => Promise.resolve([]) },
      tabs: {
        query: () => Promise.resolve([{ id: 1 }]),
        sendMessage: () => Promise.resolve({ ok: true, undoAvailable: false, undoCount: 0 }),
      },
      runtime: { onMessage: { addListener: () => {} } },
    };
  }, seed);

  await page.goto("file://" + POPUP_PATH.split(path.sep).join("/"));
  await page.waitForFunction(() => document.body.dataset.ffrReady === "true");

  // Read the width the stylesheet actually asks for, then give the page exactly
  // that - and the popup height cap. Reading it rather than hardcoding means
  // this suite cannot silently drift out of step with popup.css.
  const declaredWidth = await page.evaluate(
    () => document.body.getBoundingClientRect().width
  );
  await page.setViewportSize({
    width: Math.ceil(declaredWidth),
    height: POPUP_MAX_HEIGHT,
  });

  return { declaredWidth };
}

/** Measure vertical overflow of the document. */
async function measure(page) {
  return page.evaluate(() => {
    const el = document.documentElement;
    return {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      // The height the popup would actually want, independent of the viewport
      // it was given - this is what Firefox compares against its 600px cap.
      contentHeight: document.body.getBoundingClientRect().height,
      width: document.body.getBoundingClientRect().width,
    };
  });
}

/**
 * Assert the document does not scroll vertically AND that its content fits
 * inside Firefox's popup cap. Both, because passing the first alone can be an
 * artefact of a generous test viewport.
 */
async function expectNoVerticalOverflow(page, label) {
  const m = await measure(page);
  expect(
    m.scrollHeight,
    `${label}: document scrolls vertically (scrollHeight ${m.scrollHeight} > clientHeight ${m.clientHeight})`
  ).toBeLessThanOrEqual(m.clientHeight);
  expect(
    m.contentHeight,
    `${label}: content is ${Math.round(m.contentHeight)}px tall, past Firefox's ${POPUP_MAX_HEIGHT}px popup cap`
  ).toBeLessThanOrEqual(POPUP_MAX_HEIGHT);
  expect(
    m.width,
    `${label}: popup is ${Math.round(m.width)}px wide, past Firefox's ${POPUP_MAX_WIDTH}px cap`
  ).toBeLessThanOrEqual(POPUP_MAX_WIDTH);
  return m;
}

test.describe("the popup fits without scrolling", () => {
  // ---- State 1: the default, field types expanded ------------------------

  test("state 1: default mount with the field-types section expanded", async ({
    page,
  }) => {
    await mountPopup(page);
    // Its default state is expanded - confirm that rather than assuming, since
    // the whole point of this state is that it is what a user sees on first
    // open.
    await expect(page.locator("#field-types-toggle")).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    await expect(page.locator("#field-types-content")).toBeVisible();
    await expect(page.locator("#status-line")).toHaveText("");

    await expectNoVerticalOverflow(page, "state 1 (default, expanded)");
  });

  // ---- State 2: the undo-cap warning banner ------------------------------

  test("state 2: the undo-cap warning banner at its longest", async ({ page }) => {
    await mountPopup(page);
    await page.evaluate((msg) => {
      const el = document.getElementById("undo-warning");
      el.textContent = msg;
      el.hidden = false;
    }, LONGEST_UNDO_WARNING);

    await expect(page.locator("#undo-warning")).toBeVisible();
    await expectNoVerticalOverflow(page, "state 2 (undo warning visible)");
  });

  // ---- State 3: the longest status line ----------------------------------

  test("state 3: the status line showing its longest realistic message", async ({
    page,
  }) => {
    await mountPopup(page);
    await page.evaluate((msg) => {
      document.getElementById("status-line").textContent = msg;
    }, LONGEST_STATUS);

    await expect(page.locator("#status-line")).toContainText("timed out");
    await expectNoVerticalOverflow(page, "state 3 (long status line)");
  });

  // ---- State 4: a history dropdown open ---------------------------------

  test("state 4: the find history dropdown open with more than five entries", async ({
    page,
  }) => {
    const history = Array.from({ length: 8 }, (_, i) =>
      entry("remembered-search-number-" + i, "replacement-value-" + i)
    );
    await mountPopup(page, { history });

    await page.locator("#find-input").click();
    await expect(page.locator("#find-history-listbox")).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document
            .getElementById("find-history-listbox")
            .querySelectorAll('[role="option"]').length
      )
    ).toBe(8);

    await expectNoVerticalOverflow(page, "state 4 (dropdown open)");
  });

  // ---- State 5: the worst case -----------------------------------------

  test("state 5: field types expanded AND a dropdown open, the worst case", async ({
    page,
  }) => {
    const history = Array.from({ length: 20 }, (_, i) =>
      entry("a-fairly-long-remembered-search-" + i, "and-its-replacement-" + i)
    );
    await mountPopup(page, { history });

    await expect(page.locator("#field-types-content")).toBeVisible();
    await page.locator("#replace-input").click();
    await expect(page.locator("#replace-history-listbox")).toBeVisible();

    // Also with the longest status line and the warning banner up: if any
    // combination is going to overflow, it is this one.
    await page.evaluate(
      ({ status, warning }) => {
        document.getElementById("status-line").textContent = status;
        const el = document.getElementById("undo-warning");
        el.textContent = warning;
        el.hidden = false;
      },
      { status: LONGEST_STATUS, warning: LONGEST_UNDO_WARNING }
    );

    await expectNoVerticalOverflow(page, "state 5 (everything at once)");
  });

  // ---- The overlay's contribution to document height --------------------

  test("opening a dropdown does not change the document's height at all", async ({
    page,
  }) => {
    // This is the mechanism behind states 4 and 5, asserted directly. The
    // history overlay is position:absolute specifically so that opening it
    // cannot add to the document's height - see README.md, "Why the dropdown is
    // an absolutely-positioned overlay". If it were ever put back in flow,
    // states 4 and 5 would start failing for a reason nobody would connect to a
    // CSS change; this test names the cause.
    const history = Array.from({ length: 20 }, (_, i) =>
      entry("remembered-" + i, "replacement-" + i)
    );
    await mountPopup(page, { history });

    const before = await measure(page);
    await page.locator("#find-input").click();
    await expect(page.locator("#find-history-listbox")).toBeVisible();
    const after = await measure(page);

    expect(after.scrollHeight).toBe(before.scrollHeight);
    expect(after.contentHeight).toBe(before.contentHeight);
  });

  // ---- Collapsing must not be the fix ----------------------------------

  test("the fit does not depend on the field-types section being collapsed", async ({
    page,
  }) => {
    // Guards against a tempting non-fix: defaulting the section to collapsed so
    // the popup fits, which would hide the problem and change the documented
    // default at the same time. Expanded is the default and must fit.
    await mountPopup(page);

    const expanded = await expectNoVerticalOverflow(page, "expanded");

    await page.locator("#field-types-toggle").click();
    await expect(page.locator("#field-types-content")).toBeHidden();
    const collapsed = await measure(page);

    // Collapsing genuinely saves height (so the toggle is doing something)...
    expect(collapsed.contentHeight).toBeLessThan(expanded.contentHeight);
    // ...but the expanded state was already within the cap, asserted above.
  });

  // ---- No horizontal overflow either -----------------------------------

  test("no horizontal overflow at the declared width", async ({ page }) => {
    // A multi-column field-type grid is the main tool for saving height, and
    // the way it goes wrong is sideways. Checked for the worst-case row too:
    // "datetime-local" is the longest label in the set.
    await mountPopup(page);
    const h = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(h.scrollWidth).toBeLessThanOrEqual(h.clientWidth);
  });
});
