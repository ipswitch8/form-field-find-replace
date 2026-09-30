// @ts-check
/**
 * Popup-level tests for the remembered find/replace history dropdown.
 *
 * WHY POPUP-LEVEL
 * ---------------
 * This feature lives entirely in popup/popup.js and popup/popup.html. The
 * content script knows nothing about it. Tests that drive window.__ffr
 * directly - which is most of this suite - cannot see it at all, and that
 * blind spot has already hidden two whole-extension defects on this project
 * (the onClicked-never-fires activation bug and the undo desync). So these
 * mount the real popup document, with a fake `browser` whose storage.local is
 * a genuine in-memory store rather than a stub that returns {}.
 *
 * THE DESIGN THESE TESTS PIN is written down in README.md, "Remembered
 * find/replace history". The load-bearing parts:
 *
 *   - ONE shared list of paired entries. Each entry is find + replace + all
 *     four option flags + the whole fieldTypes map, captured together.
 *     Selecting any entry restores the entire tuple, because a remembered
 *     regex pattern without its `regex` flag would silently search literally.
 *   - storage.local key "formFieldFindReplaceHistory", distinct from the
 *     existing "formFieldFindReplace" last-typed-state key.
 *   - Bounded at 20 entries, most-recently-used: newest at index 0, an exact
 *     duplicate re-save moves to front instead of duplicating, and the tail
 *     is evicted past the bound.
 *   - Saved only on Count matches / Replace all with a non-empty find - never
 *     on keystrokes, which would fill the list with prefixes of what you were
 *     still typing.
 *   - The listbox is an absolutely-positioned overlay, so opening it cannot
 *     change the document's scrollHeight. (Measured in
 *     test/popup-layout.spec.js, not here.)
 *
 * Rows are asserted by reading the LIVE DOM - element counts, roles,
 * textContent - never by string-matching markup, so a future implementation
 * that reached for innerHTML would not be able to satisfy these by accident
 * while violating the policy in .claude-security.json.
 */
const path = require("path");
const { test, expect } = require("@playwright/test");

const POPUP_PATH = path.join(__dirname, "..", "popup", "popup.html");

/** Must match popup.js's history storage key. See README.md. */
const HISTORY_KEY = "formFieldFindReplaceHistory";
/** Must match popup.js's MAX_HISTORY_ENTRIES. See README.md. */
const MAX_HISTORY_ENTRIES = 20;

const DEFAULT_FIELD_TYPES = {
  text: true,
  search: true,
  url: true,
  tel: true,
  email: true,
  number: false,
  date: false,
  "datetime-local": false,
  month: false,
  week: false,
  time: false,
  textarea: true,
  contenteditable: true,
};

/**
 * Build a history entry. Anything not overridden takes a default, so a test
 * only has to state the part it cares about.
 * @param {Partial<{find: string, replace: string, options: object, fieldTypes: object}>} over
 */
function entry(over = {}) {
  return {
    find: "needle",
    replace: "thread",
    options: {
      matchCase: false,
      wholeWord: false,
      regex: false,
      includeIframes: false,
    },
    fieldTypes: { ...DEFAULT_FIELD_TYPES },
    ...over,
  };
}

/**
 * Mount popup.html against a fake `browser` whose storage.local really
 * stores. Returns nothing; use readStorage()/readHistory() to inspect.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{history?: any[], state?: object, replaced?: number}} [opts]
 */
async function mountPopup(page, opts = {}) {
  const seed = {};
  if (opts.history !== undefined) {
    seed[HISTORY_KEY] = opts.history;
  }
  if (opts.state !== undefined) {
    seed["formFieldFindReplace"] = opts.state;
  }

  await page.addInitScript(
    ({ seed, replaced }) => {
      // A real in-memory store. A stub returning {} would make every
      // persistence assertion below vacuous.
      const store = JSON.parse(JSON.stringify(seed));
      // @ts-ignore - test-only global so assertions can read what was stored.
      window.__store = store;
      // @ts-ignore
      window.__sent = [];

      // @ts-ignore
      window.browser = {
        storage: {
          local: {
            get: (keys) => {
              const out = {};
              const list =
                keys === null || keys === undefined
                  ? Object.keys(store)
                  : Array.isArray(keys)
                  ? keys
                  : [keys];
              for (const k of list) {
                if (Object.prototype.hasOwnProperty.call(store, k)) {
                  out[k] = JSON.parse(JSON.stringify(store[k]));
                }
              }
              return Promise.resolve(out);
            },
            set: (items) => {
              for (const [k, v] of Object.entries(items)) {
                store[k] = JSON.parse(JSON.stringify(v));
              }
              // @ts-ignore - keep the inspectable copy in sync.
              window.__store = store;
              return Promise.resolve();
            },
          },
        },
        scripting: { executeScript: () => Promise.resolve([]) },
        tabs: {
          query: () => Promise.resolve([{ id: 1 }]),
          sendMessage: (_tabId, message) => {
            // @ts-ignore
            window.__sent.push(message);
            if (message.action === "ping") {
              return Promise.resolve({
                ok: true,
                undoAvailable: false,
                undoCount: 0,
              });
            }
            if (message.action === "count") {
              return Promise.resolve({
                ok: true,
                matches: 3,
                fields: 3,
                totalFields: 3,
                undoAvailable: false,
                undoCount: 0,
              });
            }
            if (message.action === "replace") {
              return Promise.resolve({
                ok: true,
                matches: 3,
                fields: 3,
                replaced,
                skipped: 0,
                timedOut: 0,
                wallMs: 4,
                undoAvailable: true,
                error: null,
              });
            }
            return Promise.resolve({ ok: true });
          },
        },
        runtime: { onMessage: { addListener: () => {} } },
      };
    },
    { seed, replaced: opts.replaced ?? 3 }
  );

  await page.goto("file://" + POPUP_PATH.replace(/\\/g, "/"));
  // init() is async (it awaits restoreState) - wait for it to have settled so
  // tests never race the restore, which is the shape of a prior bug on this
  // project (restoreState overwriting typed input).
  await page.waitForFunction(() => document.getElementById("undo-btn") !== null);
  await page.waitForFunction(
    () => document.getElementById("count-btn")?.disabled === false
  );
}

/** @param {import('@playwright/test').Page} page */
function readHistory(page) {
  return page.evaluate((key) => {
    // @ts-ignore
    const v = window.__store[key];
    return v === undefined ? null : v;
  }, HISTORY_KEY);
}

/**
 * Fill in the form to a known, fully-specified state.
 * @param {import('@playwright/test').Page} page
 */
async function fillForm(page, { find, replace, options = {}, fieldTypes = {} }) {
  await page.locator("#find-input").fill(find);
  await page.locator("#replace-input").fill(replace);
  for (const [id, key] of [
    ["#match-case-checkbox", "matchCase"],
    ["#whole-word-checkbox", "wholeWord"],
    ["#regex-checkbox", "regex"],
    ["#include-iframes-checkbox", "includeIframes"],
  ]) {
    await page.locator(id).setChecked(Boolean(options[key]));
  }
  for (const [type, checked] of Object.entries(fieldTypes)) {
    await page.locator(`#fieldtype-${type}`).setChecked(Boolean(checked));
  }
}

// =========================================================================
// (a) The entry is recorded, with its settings, on a real action
// =========================================================================

test.describe("history persistence", () => {
  test("Replace all records a paired entry carrying find, replace, options and fieldTypes", async ({
    page,
  }) => {
    await mountPopup(page);

    await fillForm(page, {
      find: "(\\$\\d+),[\\d,.]+",
      replace: "~$1k",
      options: { matchCase: true, regex: true },
      fieldTypes: { number: true },
    });

    await page.locator("#replace-all-btn").click();
    await expect(page.locator("#status-line")).toContainText(/Replaced/i);

    const history = await readHistory(page);
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBe(1);

    const saved = history[0];
    expect(saved.find).toBe("(\\$\\d+),[\\d,.]+");
    expect(saved.replace).toBe("~$1k");
    // The settings must travel WITH the entry - a remembered regex source
    // recalled without its regex flag would silently search literally.
    expect(saved.options.regex).toBe(true);
    expect(saved.options.matchCase).toBe(true);
    expect(saved.options.wholeWord).toBe(false);
    expect(saved.options.includeIframes).toBe(false);
    // ...and so must the field-type selection.
    expect(saved.fieldTypes.number).toBe(true);
    expect(saved.fieldTypes.text).toBe(true);
    expect(saved.fieldTypes.date).toBe(false);
  });

  test("Count matches also records an entry (it is the rehearsal for a replace)", async ({
    page,
  }) => {
    await mountPopup(page);
    await fillForm(page, { find: "alpha", replace: "beta" });

    await page.locator("#count-btn").click();
    await expect(page.locator("#status-line")).toContainText(/matches/i);

    const history = await readHistory(page);
    expect(history).not.toBeNull();
    expect(history.length).toBe(1);
    expect(history[0].find).toBe("alpha");
    expect(history[0].replace).toBe("beta");
  });

  test("history is stored under its own key, leaving the last-typed-state key intact", async ({
    page,
  }) => {
    await mountPopup(page);
    await fillForm(page, { find: "alpha", replace: "beta" });
    await page.locator("#count-btn").click();
    await expect(page.locator("#status-line")).toContainText(/matches/i);

    const keys = await page.evaluate(() => Object.keys(window.__store));
    expect(keys).toContain(HISTORY_KEY);
    expect(keys).toContain("formFieldFindReplace");
  });

  test("typing alone records nothing - only an invoked action does", async ({
    page,
  }) => {
    await mountPopup(page);

    // Type a whole word one character at a time, the way a user does. If
    // history were saved on `input`, this alone would leave prefixes behind.
    await page.locator("#find-input").click();
    await page.keyboard.type("invoice");
    await page.locator("#replace-input").click();
    await page.keyboard.type("bill");

    const history = await readHistory(page);
    // Either absent entirely, or present and empty - both mean "nothing was
    // recorded". What must not happen is prefixes accumulating.
    expect(history === null || history.length === 0).toBe(true);
  });

  test("an empty find value is never recorded", async ({ page }) => {
    await mountPopup(page);
    await page.locator("#replace-input").fill("something");

    await page.locator("#count-btn").click();
    await expect(page.locator("#status-line")).toContainText(/matches/i);

    const history = await readHistory(page);
    expect(history === null || history.length === 0).toBe(true);
  });
});

// =========================================================================
// (d) The bound, and its eviction rule
// =========================================================================

test.describe("history bound", () => {
  test(`the list is capped at ${MAX_HISTORY_ENTRIES}, evicting the least recently used`, async ({
    page,
  }) => {
    // Seed a full list: find-0 is newest (index 0), find-19 is the LRU tail.
    const seeded = Array.from({ length: MAX_HISTORY_ENTRIES }, (_, i) =>
      entry({ find: `find-${i}`, replace: `rep-${i}` })
    );
    await mountPopup(page, { history: seeded });

    await fillForm(page, { find: "brand-new", replace: "fresh" });
    await page.locator("#count-btn").click();
    await expect(page.locator("#status-line")).toContainText(/matches/i);

    const history = await readHistory(page);
    expect(history.length).toBe(MAX_HISTORY_ENTRIES);
    // Newest at the front...
    expect(history[0].find).toBe("brand-new");
    // ...and the least recently used one is gone, not some arbitrary entry.
    expect(history.map((e) => e.find)).not.toContain(
      `find-${MAX_HISTORY_ENTRIES - 1}`
    );
    expect(history.map((e) => e.find)).toContain("find-0");
  });

  test("re-running an identical search moves it to the front instead of duplicating it", async ({
    page,
  }) => {
    const seeded = [
      entry({ find: "older", replace: "o" }),
      entry({ find: "target", replace: "t" }),
      entry({ find: "oldest", replace: "x" }),
    ];
    await mountPopup(page, { history: seeded });

    await fillForm(page, { find: "target", replace: "t" });
    await page.locator("#count-btn").click();
    await expect(page.locator("#status-line")).toContainText(/matches/i);

    const history = await readHistory(page);
    expect(history.length).toBe(3);
    expect(history[0].find).toBe("target");
    expect(history.filter((e) => e.find === "target").length).toBe(1);
  });

  test("the same find with different settings is a distinct entry, not a duplicate", async ({
    page,
  }) => {
    const seeded = [
      entry({
        find: "same",
        replace: "r",
        options: {
          matchCase: false,
          wholeWord: false,
          regex: false,
          includeIframes: false,
        },
      }),
    ];
    await mountPopup(page, { history: seeded });

    // Identical strings, but regex is now on. Collapsing these would lose the
    // very thing history is supposed to remember.
    await fillForm(page, { find: "same", replace: "r", options: { regex: true } });
    await page.locator("#count-btn").click();
    await expect(page.locator("#status-line")).toContainText(/matches/i);

    const history = await readHistory(page);
    expect(history.length).toBe(2);
    expect(history[0].options.regex).toBe(true);
  });
});

// =========================================================================
// (b) The dropdown renders, from the live DOM
// =========================================================================

test.describe("history dropdown rendering", () => {
  const THREE = [
    entry({ find: "first", replace: "1st" }),
    entry({ find: "second", replace: "2nd" }),
    entry({ find: "third", replace: "3rd" }),
  ];

  test("clicking the find input opens a listbox of prior entries", async ({
    page,
  }) => {
    await mountPopup(page, { history: THREE });

    const listbox = page.locator("#find-history-listbox");
    await expect(listbox).toBeHidden();

    await page.locator("#find-input").click();
    await expect(listbox).toBeVisible();

    // Read the live DOM: roles and counts, not markup text.
    const shape = await page.evaluate(() => {
      const lb = document.getElementById("find-history-listbox");
      if (!lb) return null;
      const options = Array.from(lb.querySelectorAll('[role="option"]'));
      return {
        role: lb.getAttribute("role"),
        testid: lb.getAttribute("data-testid"),
        count: options.length,
        ids: options.map((o) => o.id),
        testids: options.map((o) => o.getAttribute("data-testid")),
        texts: options.map((o) => (o.textContent || "").trim()),
      };
    });

    expect(shape).not.toBeNull();
    expect(shape.role).toBe("listbox");
    expect(shape.testid).toBe("find-history-listbox");
    expect(shape.count).toBe(3);
    // Stable, addressable ids for automation - not position-dependent XPath.
    expect(shape.ids).toEqual([
      "find-history-option-0",
      "find-history-option-1",
      "find-history-option-2",
    ]);
    expect(shape.testids).toEqual([
      "find-history-option-0",
      "find-history-option-1",
      "find-history-option-2",
    ]);
    // Newest first, and each row shows its find value.
    expect(shape.texts[0]).toContain("first");
    expect(shape.texts[2]).toContain("third");
  });

  test("the replace input opens its own listbox over the same shared entries", async ({
    page,
  }) => {
    await mountPopup(page, { history: THREE });

    await page.locator("#replace-input").click();
    await expect(page.locator("#replace-history-listbox")).toBeVisible();

    const texts = await page.evaluate(() =>
      Array.from(
        document
          .getElementById("replace-history-listbox")
          .querySelectorAll('[role="option"]')
      ).map((o) => (o.textContent || "").trim())
    );
    expect(texts.length).toBe(3);
    // Same list, shown replace-value-first.
    expect(texts[0]).toContain("1st");
  });

  test("the inputs are wired as ARIA comboboxes pointing at their listboxes", async ({
    page,
  }) => {
    await mountPopup(page, { history: THREE });

    const before = await page.evaluate(() => {
      const el = document.getElementById("find-input");
      return {
        role: el.getAttribute("role"),
        expanded: el.getAttribute("aria-expanded"),
        controls: el.getAttribute("aria-controls"),
      };
    });
    expect(before.role).toBe("combobox");
    expect(before.expanded).toBe("false");
    expect(before.controls).toBe("find-history-listbox");

    await page.locator("#find-input").click();
    await expect(page.locator("#find-input")).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  test("no listbox is shown when there is no history to show", async ({
    page,
  }) => {
    await mountPopup(page, { history: [] });
    await page.locator("#find-input").click();
    await expect(page.locator("#find-history-listbox")).toBeHidden();
    await expect(page.locator("#find-input")).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });

  test("rows are built as elements, not parsed from markup", async ({ page }) => {
    // A remembered value is arbitrary text the user may have copied off a
    // page. If a row were ever assembled by assigning markup, this angle
    // bracket would become an element instead of visible text.
    await mountPopup(page, {
      history: [entry({ find: "<img src=x onerror=1>", replace: "safe" })],
    });

    await page.locator("#find-input").click();
    const row = page.locator("#find-history-option-0");
    await expect(row).toBeVisible();

    const probe = await page.evaluate(() => {
      const el = document.getElementById("find-history-option-0");
      return {
        text: el.textContent,
        childElements: el.querySelectorAll("*").length,
        images: el.querySelectorAll("img").length,
      };
    });
    expect(probe.text).toContain("<img src=x onerror=1>");
    expect(probe.images).toBe(0);
  });
});

// =========================================================================
// (c) Selecting an entry restores the whole tuple
// =========================================================================

test.describe("selecting a history entry", () => {
  const RICH = [
    entry({
      find: "\\bcat\\b",
      replace: "dog",
      options: {
        matchCase: true,
        wholeWord: false,
        regex: true,
        includeIframes: true,
      },
      fieldTypes: { ...DEFAULT_FIELD_TYPES, date: true, textarea: false },
    }),
    entry({ find: "other", replace: "thing" }),
  ];

  /** Assert the form now matches RICH[0] in full. */
  async function expectRichRestored(page) {
    await expect(page.locator("#find-input")).toHaveValue("\\bcat\\b");
    await expect(page.locator("#replace-input")).toHaveValue("dog");
    await expect(page.locator("#match-case-checkbox")).toBeChecked();
    await expect(page.locator("#whole-word-checkbox")).not.toBeChecked();
    await expect(page.locator("#regex-checkbox")).toBeChecked();
    await expect(page.locator("#include-iframes-checkbox")).toBeChecked();
    // Field types travel too - both a turned-on and a turned-off one, so a
    // partial implementation that only ever sets `true` cannot pass.
    await expect(page.locator("#fieldtype-date")).toBeChecked();
    await expect(page.locator("#fieldtype-textarea")).not.toBeChecked();
  }

  test("clicking an entry restores find, replace, every option and the field types", async ({
    page,
  }) => {
    await mountPopup(page, { history: RICH });

    await page.locator("#find-input").click();
    await page.locator("#find-history-option-0").click();

    await expectRichRestored(page);
    await expect(page.locator("#find-history-listbox")).toBeHidden();
  });

  test("ArrowDown then Enter restores the same entry by keyboard alone", async ({
    page,
  }) => {
    await mountPopup(page, { history: RICH });

    await page.locator("#find-input").click();
    await expect(page.locator("#find-history-listbox")).toBeVisible();

    await page.keyboard.press("ArrowDown");
    // The active option must be indicated programmatically, not only visually.
    await expect(page.locator("#find-input")).toHaveAttribute(
      "aria-activedescendant",
      "find-history-option-0"
    );

    await page.keyboard.press("Enter");
    await expectRichRestored(page);
    await expect(page.locator("#find-history-listbox")).toBeHidden();
  });

  test("ArrowDown twice reaches the second entry", async ({ page }) => {
    await mountPopup(page, { history: RICH });
    await page.locator("#find-input").click();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("#find-input")).toHaveAttribute(
      "aria-activedescendant",
      "find-history-option-1"
    );
    await page.keyboard.press("Enter");
    await expect(page.locator("#find-input")).toHaveValue("other");
  });

  test("ArrowUp from the first option wraps to the last", async ({ page }) => {
    await mountPopup(page, { history: RICH });
    await page.locator("#find-input").click();
    await page.keyboard.press("ArrowUp");
    await expect(page.locator("#find-input")).toHaveAttribute(
      "aria-activedescendant",
      "find-history-option-1"
    );
  });

  test("selecting from the replace dropdown restores the same full tuple", async ({
    page,
  }) => {
    await mountPopup(page, { history: RICH });
    await page.locator("#replace-input").click();
    await page.locator("#replace-history-option-0").click();
    await expectRichRestored(page);
  });

  test("a restored entry is persisted as the new last-typed state", async ({
    page,
  }) => {
    await mountPopup(page, { history: RICH });
    await page.locator("#find-input").click();
    await page.locator("#find-history-option-0").click();
    await expectRichRestored(page);

    const state = await page.evaluate(
      () => window.__store["formFieldFindReplace"]
    );
    expect(state).toBeTruthy();
    expect(state.find).toBe("\\bcat\\b");
    expect(state.options.regex).toBe(true);
    expect(state.fieldTypes.date).toBe(true);
  });
});

// =========================================================================
// Escape scoping, and the restoreState race
// =========================================================================

test.describe("dropdown interaction safety", () => {
  test("Escape closes the dropdown without closing the popup", async ({
    page,
  }) => {
    // popup.js has a global keydown handler: Escape cancels an in-flight run,
    // otherwise calls window.close(). While the dropdown is open, the first
    // Escape must belong to the dropdown - otherwise dismissing a dropdown
    // throws away everything the user has typed.
    await mountPopup(page, {
      history: [entry({ find: "first", replace: "1st" })],
    });

    await page.evaluate(() => {
      // @ts-ignore - record close() attempts rather than letting the page go.
      window.__closed = 0;
      // @ts-ignore
      window.close = () => {
        // @ts-ignore
        window.__closed += 1;
      };
    });

    await page.locator("#find-input").click();
    await expect(page.locator("#find-history-listbox")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator("#find-history-listbox")).toBeHidden();
    // @ts-ignore
    expect(await page.evaluate(() => window.__closed)).toBe(0);

    // A second Escape, with the dropdown already closed, is the popup's again.
    await page.keyboard.press("Escape");
    // @ts-ignore
    expect(await page.evaluate(() => window.__closed)).toBe(1);
  });

  test("clicking outside closes the dropdown and leaves the input untouched", async ({
    page,
  }) => {
    await mountPopup(page, {
      history: [entry({ find: "first", replace: "1st" })],
    });

    await page.locator("#find-input").fill("mine");
    await page.locator("#find-input").click();
    await expect(page.locator("#find-history-listbox")).toBeVisible();

    await page.locator("#app-title").click();
    await expect(page.locator("#find-history-listbox")).toBeHidden();
    await expect(page.locator("#find-input")).toHaveValue("mine");
  });

  test("opening the dropdown immediately after mount never blanks the restored value", async ({
    page,
  }) => {
    // The prior restoreState() race on this project was an async restore
    // landing on top of what was already in the field. Clicking the input the
    // instant the popup mounts is the sharpest version of that timing.
    await mountPopup(page, {
      history: [entry({ find: "first", replace: "1st" })],
      state: {
        find: "persisted",
        replace: "value",
        options: {
          matchCase: false,
          wholeWord: false,
          regex: false,
          includeIframes: false,
        },
        fieldTypes: { ...DEFAULT_FIELD_TYPES },
      },
    });

    await page.locator("#find-input").click();

    // Sample repeatedly: a transient blank would be a real defect even if the
    // final value is correct.
    for (let i = 0; i < 10; i += 1) {
      await expect(page.locator("#find-input")).toHaveValue("persisted");
    }
  });
});
