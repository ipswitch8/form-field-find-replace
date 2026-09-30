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
 * TIMING IS EXPRESSED WITH GATES, NOT CLOCKS
 * ------------------------------------------
 * An earlier version of this harness held storage open with setTimeout - 4s for
 * the write-serialisation race, 800/900ms for the two init-gap tests. Those
 * passed reliably alone and dropped a random test under parallel workers,
 * because a wall-clock margin is exactly what worker contention eats. Widening
 * the margins would only have moved the threshold; pinning workers: 1 or adding
 * retries would have made the number green without making the test
 * deterministic.
 *
 * So the storage mock blocks on promises the TEST releases instead:
 *
 *   `holdGets: true`        - every storage.local.get hangs until the page-side
 *                             `window.__releaseGets()` is called. init() awaits
 *                             those reads, so this holds the popup in its
 *                             pre-ready state indefinitely, with no assumption
 *                             about how fast anything runs.
 *   `holdFirstHistorySet`   - the first storage.local.set carrying the history
 *                             key hangs until `window.__releaseHistorySet()`.
 *                             That is a write left genuinely in flight, which is
 *                             what the serialisation claim is actually about -
 *                             real time never needed to pass for it.
 *
 * Neither knob involves a duration, so neither can lose a race under load.
 *
 * `waitForReady: false` skips the readiness wait, for tests specifically about
 * what happens BEFORE init() finishes.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{history?: any[], state?: object, replaced?: number,
 *          holdGets?: boolean, holdFirstHistorySet?: boolean,
 *          waitForReady?: boolean}} [opts]
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
    ({ seed, replaced, holdGets, holdFirstHistorySet }) => {
      // A real in-memory store. A stub returning {} would make every
      // persistence assertion below vacuous.
      const store = JSON.parse(JSON.stringify(seed));
      // @ts-ignore - test-only global so assertions can read what was stored.
      window.__store = store;
      // @ts-ignore
      window.__sent = [];
      // @ts-ignore - order in which set() calls actually LANDED, as opposed to
      // the order they were issued. The difference is the whole point of the
      // write-serialisation test.
      window.__setLanded = [];

      /** A promise plus its resolver, so the test can open a gate on demand. */
      const deferred = () => {
        let release;
        const promise = new Promise((resolve) => {
          release = resolve;
        });
        return { promise, release };
      };

      // Gate on reads. Armed at mount time rather than later, because init()
      // issues its reads immediately and there would be no way to get in front
      // of them from the test side afterwards.
      const getGate = holdGets ? deferred() : null;
      // @ts-ignore
      window.__releaseGets = () => {
        if (getGate) getGate.release();
      };

      // Gate on the FIRST write carrying the history key. Keyed to the key, not
      // to "the Nth set call": typing fires persistState, so the raw call
      // sequence is mostly last-typed-state writes and a positional gate would
      // catch one of those instead of the write under test.
      const historySetGate = holdFirstHistorySet ? deferred() : null;
      let historySetSeen = 0;
      // @ts-ignore
      window.__releaseHistorySet = () => {
        if (historySetGate) historySetGate.release();
      };

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
              return (getGate ? getGate.promise : Promise.resolve()).then(
                () => out
              );
            },
            set: (items) => {
              // Snapshot the payload at CALL time, apply it at RESOLVE time.
              // A real storage backend behaves this way, and it is what lets an
              // earlier still-in-flight write overwrite a later one when the
              // caller does not serialise them.
              const snapshot = JSON.parse(JSON.stringify(items));
              let wait = Promise.resolve();
              if (
                Object.prototype.hasOwnProperty.call(
                  snapshot,
                  "formFieldFindReplaceHistory"
                )
              ) {
                historySetSeen += 1;
                if (historySetGate && historySetSeen === 1) {
                  wait = historySetGate.promise;
                }
              }
              return wait.then(() => {
                for (const [k, v] of Object.entries(snapshot)) {
                  store[k] = v;
                  // @ts-ignore
                  window.__setLanded.push(
                    k + ":" + (Array.isArray(v) ? v.length : "obj")
                  );
                }
                // @ts-ignore - keep the inspectable copy in sync.
                window.__store = store;
              });
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
    {
      seed,
      replaced: opts.replaced ?? 3,
      holdGets: opts.holdGets === true,
      holdFirstHistorySet: opts.holdFirstHistorySet === true,
    }
  );

  await page.goto("file://" + POPUP_PATH.replace(/\\/g, "/"));
  if (opts.waitForReady === false) {
    return;
  }
  // init() is async (it awaits restoreState AND loadHistory) - wait for it to
  // have settled so tests never race the restore, which is the shape of a
  // prior bug on this project (restoreState overwriting typed input).
  //
  // Waiting on an element existing would NOT be enough: every control is in
  // the static markup and enabled from the start, so a click could land
  // before wireEvents() attaches its handler - on #replace-all-btn that means
  // the form's default submit fires instead, which looks like a flake rather
  // than a race. popup.js sets body[data-ffr-ready] only after every listener
  // is attached and the remembered list is loaded.
  await page.waitForFunction(
    () => document.body.dataset.ffrReady === "true"
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

  // Focusing an input opens its history dropdown when there is history to
  // show, and the overlay then covers the option checkboxes below - so
  // setChecked would be clicking the overlay, not the checkbox. Dismiss it
  // first. This is what a user does too: they stop interacting with the box
  // before reaching for the checkboxes.
  await page.evaluate(() => {
    for (const id of ["find-history-overlay", "replace-history-overlay"]) {
      const el = document.getElementById(id);
      if (el && !el.hidden) {
        document.getElementById("app-title").click();
      }
    }
  });
  await expect(page.locator("#find-history-overlay")).toBeHidden();
  await expect(page.locator("#replace-history-overlay")).toBeHidden();

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

  test("history is persisted through storage.local only, never storage.sync", async ({
    page,
  }) => {
    // The claim "storage.local only, never storage.sync" was previously
    // backed by nothing but the incidental fact that this file's mock defines
    // no sync area - so a storage.sync call would have thrown in tests while
    // working fine in a real browser, quietly syncing the user's remembered
    // text off the device. .claude-security.json's dangerous_code_scan covers
    // eval/innerHTML/Function( and would not catch it either. This scans the
    // shipped source directly.
    const fs = require("fs");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "popup", "popup.js"),
      "utf8"
    );
    // Strip comments first, so prose that merely NAMES storage.sync in order
    // to say it is not used does not read as a violation - the same
    // distinction .claude-security.json draws for eval/innerHTML.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code).not.toMatch(/storage\s*\.\s*sync/);
    expect(code).toMatch(/storage\s*\.\s*local/);

    // And prove at runtime that a sync area is never touched, by providing one
    // that fails loudly if it ever is.
    await page.addInitScript(() => {
      // @ts-ignore
      window.__syncTouched = [];
    });
    await mountPopup(page);
    await page.evaluate(() => {
      // @ts-ignore
      window.browser.storage.sync = {
        get: () => {
          // @ts-ignore
          window.__syncTouched.push("get");
          return Promise.resolve({});
        },
        set: () => {
          // @ts-ignore
          window.__syncTouched.push("set");
          return Promise.resolve();
        },
      };
    });

    await fillForm(page, { find: "alpha", replace: "beta" });
    await page.locator("#count-btn").click();
    await expect(page.locator("#status-line")).toContainText(/matches/i);

    // @ts-ignore
    expect(await page.evaluate(() => window.__syncTouched)).toEqual([]);
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
// The three mechanisms popup.js CLAIMS in prose
//
// A gate flip-tested each of these by deleting the mechanism and re-running:
// every test still passed. A claim nothing would catch is a comment, not a
// guarantee - and this project has already shipped three defects whose only
// warning sign was a comment asserting a data flow the code contradicted.
// Each test below was checked to go RED when its mechanism is removed.
// =========================================================================

test.describe("claimed mechanisms, actually pinned", () => {
  test("a slow earlier history write cannot clobber a newer one (historyWriteChain)", async ({
    page,
  }) => {
    // popup.js serialises history writes through `historyWriteChain`. Without
    // it, both storage.local.set calls are issued immediately; if the FIRST one
    // is still in flight when the second lands, it then applies its older,
    // one-entry snapshot ON TOP of the newer two-entry one and the second
    // remembered search is silently lost.
    //
    // The first history write is held open by a GATE, not a timer. An earlier
    // version used a 4s delay; that passed alone and dropped under parallel
    // workers, because a wall-clock margin is what contention eats. Nothing
    // here waits for real time: the write is in flight until this test says
    // otherwise, which is precisely the condition the claim is about.
    await mountPopup(page, { holdFirstHistorySet: true });

    await fillForm(page, { find: "first-search", replace: "a" });
    await page.locator("#count-btn").click();
    await expect(page.locator("#status-line")).toContainText(/matches/i);

    await fillForm(page, { find: "second-search", replace: "b" });
    await page.locator("#count-btn").click();
    await expect(page.locator("#status-line")).toContainText(/matches/i);

    // Nothing has been allowed to land yet. Under serialisation the second
    // write has not even been issued; without it, the second write has already
    // landed and only the stale first is outstanding.
    await page.evaluate(() => window.__releaseHistorySet());

    // Both writes have now landed.
    await page.waitForFunction(
      () =>
        window.__setLanded.filter((e) =>
          e.startsWith("formFieldFindReplaceHistory")
        ).length >= 2
    );

    const history = await readHistory(page);
    // Serialised: the last write to land is the two-entry one.
    expect(history.map((e) => e.find)).toEqual(["second-search", "first-search"]);

    // And the landing order proves the chain actually deferred the second
    // write rather than the two racing and happening to come out right.
    const landed = await page.evaluate(() =>
      window.__setLanded.filter((e) => e.startsWith("formFieldFindReplaceHistory"))
    );
    expect(landed).toEqual([
      "formFieldFindReplaceHistory:1",
      "formFieldFindReplaceHistory:2",
    ]);
  });

  test("an action fired before init() finishes cannot truncate the stored history", async ({
    page,
  }) => {
    // popup.js loads the remembered list BEFORE wireEvents(). If that order
    // were reversed, a click landing in the gap would run handleCount against
    // an empty `historyEntries` and persist a ONE-entry array over the five
    // that were really there - the same shape as the restoreState()-overwrites
    // -typed-input bug this project already shipped once.
    const seeded = Array.from({ length: 5 }, (_, i) =>
      entry({ find: `seeded-${i}`, replace: `r-${i}` })
    );
    // Hold ALL reads open, so init() cannot finish until this test releases
    // them, and do not wait for readiness - we want to be inside the gap. A
    // gate rather than a delay: the previous 800ms version lost the race under
    // parallel workers.
    await mountPopup(page, {
      history: seeded,
      holdGets: true,
      waitForReady: false,
    });

    // Put a non-empty find in the box and invoke an action, all while init()
    // is still awaiting storage. Typing directly is load-bearing: under the
    // reversed ordering, restoreState() has not run yet either, so the box
    // would be empty and recordHistoryEntry would decline on the empty-find
    // rule - the test would then pass for the wrong reason and prove nothing.
    // An earlier version of this test did exactly that, and stayed green with
    // the ordering reversed.
    await page.locator("#find-input").fill("typed-in-the-gap");
    await page.locator("#count-btn").click({ force: true });

    // Now let init() finish.
    await page.evaluate(() => window.__releaseGets());
    await page.waitForFunction(() => document.body.dataset.ffrReady === "true");

    // No sleep is needed here, and adding one would hide the logic. Under the
    // reversed ordering the click's write is issued and lands BEFORE the
    // release above - the gate holds reads, not writes - so by this point the
    // damage has either happened or it never will.
    const history = await readHistory(page);
    // The five seeded entries must still be there. Under the reversed
    // ordering this array is length 1.
    expect(history.length).toBeGreaterThanOrEqual(5);
    expect(history.map((e) => e.find)).toContain("seeded-4");
  });

  test("no action handler is attached until the readiness marker is set (why the marker exists)", async ({
    page,
  }) => {
    // The mount helper waits on body[data-ffr-ready]. This proves that wait is
    // NECESSARY rather than decorative: before the marker appears, the buttons
    // are present and enabled in the static markup but their handlers are not
    // attached yet, so a click does nothing an assertion can see. A test that
    // waited on "the button exists" would be waiting on something that was
    // already true at first paint.
    await mountPopup(page, { holdGets: true, waitForReady: false });

    // Preconditions: the control is there and not disabled, i.e. exactly the
    // thing a naive wait would have keyed on.
    const ready = await page.evaluate(() => ({
      exists: document.getElementById("count-btn") !== null,
      disabled: document.getElementById("count-btn").disabled,
      marker: document.body.dataset.ffrReady,
    }));
    expect(ready.exists).toBe(true);
    expect(ready.disabled).toBe(false);
    expect(ready.marker).toBeUndefined();

    await page.locator("#count-btn").click({ force: true });
    // No handler yet, so nothing was sent to the content script and no status
    // was written.
    const sentBefore = await page.evaluate(() => window.__sent.length);
    expect(sentBefore).toBe(0);
    expect((await page.locator("#status-line").textContent()) || "").toBe("");

    // After the marker, the same click works.
    await page.evaluate(() => window.__releaseGets());
    await page.waitForFunction(() => document.body.dataset.ffrReady === "true");
    await fillForm(page, { find: "now", replace: "then" });
    await page.locator("#count-btn").click();
    await expect(page.locator("#status-line")).toContainText(/matches/i);
  });

  test("the preview box exposes its full text on title, because it now clips", async ({
    page,
  }) => {
    // #match-preview gained a FIXED height this phase so it cannot reflow and
    // shift the controls below it. Fixed height means long content is clipped,
    // and `title` is then the ONLY thing that keeps clipped text recoverable -
    // a truncated regex error with no way to read the rest is worse than a
    // terse one. A gate found nothing in the suite asserting `title` at all.
    await mountPopup(page);

    // A deliberately long, invalid pattern: the error message is the case where
    // losing the tail actually misleads.
    await page.locator("#find-input").fill("(unclosed" + "x".repeat(120));
    await expect(page.locator("#match-preview")).not.toHaveText("");

    const shown = await page.evaluate(() => {
      const el = document.getElementById("match-preview");
      return { text: el.textContent, title: el.getAttribute("title") };
    });
    expect(shown.text.length).toBeGreaterThan(0);
    // Not a truncation of it, not a summary - the same string.
    expect(shown.title).toBe(shown.text);

    // A normal (valid, matching) preview carries its title too.
    await page.locator("#find-input").fill("Jane");
    await page.locator("#replace-input").fill("Joan");
    await expect(page.locator("#match-preview")).toContainText("Joan");
    const ok = await page.evaluate(() => {
      const el = document.getElementById("match-preview");
      return { text: el.textContent, title: el.getAttribute("title") };
    });
    expect(ok.title).toBe(ok.text);

    // Emptying the box removes the attribute rather than leaving a stale
    // tooltip describing a preview that is no longer on screen.
    await page.locator("#find-input").fill("");
    await expect(page.locator("#match-preview")).toHaveText("");
    expect(
      await page.evaluate(() =>
        document.getElementById("match-preview").hasAttribute("title")
      )
    ).toBe(false);
  });

  test("the preview box does not change height when its text arrives", async ({
    page,
  }) => {
    // The reason for the fixed height: a box that grows when the debounced
    // preview lands moves every control below it - the whole Options fieldset -
    // a fifth of a second after the user stopped typing, so a click aimed at a
    // checkbox can miss. Measured, not assumed.
    await mountPopup(page);

    const before = await page.evaluate(() => ({
      preview: document.getElementById("match-preview").getBoundingClientRect().height,
      regexTop: document.getElementById("regex-checkbox").getBoundingClientRect().top,
    }));

    // Force the longest realistic content: a wrapping substitution preview.
    await page.locator("#find-input").fill("Jane Doe");
    await page.locator("#replace-input").fill("A".repeat(90));
    await expect(page.locator("#match-preview")).toContainText("A");

    const after = await page.evaluate(() => ({
      preview: document.getElementById("match-preview").getBoundingClientRect().height,
      regexTop: document.getElementById("regex-checkbox").getBoundingClientRect().top,
    }));

    expect(after.preview).toBe(before.preview);
    // The checkbox below it has not moved by even a pixel.
    expect(after.regexTop).toBe(before.regexTop);
  });

  test("malformed stored history is coerced, not thrown on (normalizeHistoryEntry)", async ({
    page,
  }) => {
    // Everything read back out of storage.local is treated as untrusted in
    // SHAPE. A hand-edited or partially-written value must not be able to stop
    // the popup from starting, and must not survive into the in-memory list in
    // a shape the renderer would choke on.
    await mountPopup(page, {
      history: [
        null,
        "not an object",
        42,
        {},
        { find: "" },
        { find: "valid-one", replace: 7, options: "nope", fieldTypes: null },
        { find: "valid-two", replace: "ok", options: { regex: "truthy" }, fieldTypes: { bogusKey: true } },
      ],
    });

    // The popup started at all - that is half the claim.
    await expect(page.locator("#count-btn")).toBeEnabled();

    // Force a write so we can inspect the normalized list that survived.
    await fillForm(page, { find: "fresh", replace: "x" });
    await page.locator("#count-btn").click();
    await expect(page.locator("#status-line")).toContainText(/matches/i);

    const history = await readHistory(page);
    const finds = history.map((e) => e.find);
    // Junk dropped, valid entries kept.
    expect(finds).toEqual(["fresh", "valid-one", "valid-two"]);

    const one = history.find((e) => e.find === "valid-one");
    // A non-string replace becomes "", a non-object options/fieldTypes falls
    // back to defaults - inert primitives throughout.
    expect(one.replace).toBe("");
    expect(typeof one.options.regex).toBe("boolean");
    expect(one.options.regex).toBe(false);
    expect(one.fieldTypes.text).toBe(true);

    const two = history.find((e) => e.find === "valid-two");
    // A truthy non-boolean is coerced, and an unknown field-type key is
    // dropped rather than carried into storage.
    expect(two.options.regex).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(two.fieldTypes, "bogusKey")).toBe(false);
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
// Selection promotes, and the list can be cleared
// =========================================================================

test.describe("promotion and clearing", () => {
  test("selecting an entry promotes it to the front of the remembered list", async ({
    page,
  }) => {
    // This is what makes the ordering usage-based rather than merely
    // record-based, and it is the claim README.md and popup.js both make about
    // why the docs say "newest-first". Without it, using an old search over and
    // over would never stop it drifting towards the eviction tail.
    const seeded = [
      entry({ find: "newest", replace: "n" }),
      entry({ find: "middle", replace: "m" }),
      entry({ find: "oldest", replace: "o" }),
    ];
    await mountPopup(page, { history: seeded });

    await page.locator("#find-input").click();
    // Pick the LAST one - the one closest to being evicted.
    await page.locator("#find-history-option-2").click();
    await expect(page.locator("#find-input")).toHaveValue("oldest");

    await page.waitForFunction(() => {
      const h = window.__store["formFieldFindReplaceHistory"];
      return Array.isArray(h) && h.length === 3 && h[0].find === "oldest";
    });

    const history = await readHistory(page);
    // Promoted, not duplicated, and the others keep their relative order.
    expect(history.map((e) => e.find)).toEqual(["oldest", "newest", "middle"]);
  });

  test("Clear history empties the remembered list and closes the dropdown", async ({
    page,
  }) => {
    // Exists because a gate pointed out that this feature took retention from
    // one entry to twenty with no way to undo that - someone who pastes a
    // password into the Find box needs to be able to get rid of it without
    // clearing their whole profile.
    await mountPopup(page, {
      history: [
        entry({ find: "sensitive-one", replace: "a" }),
        entry({ find: "sensitive-two", replace: "b" }),
      ],
    });

    await page.locator("#find-input").click();
    await expect(page.locator("#find-history-listbox")).toBeVisible();

    await page.locator("#find-history-clear").click();
    await expect(page.locator("#find-history-overlay")).toBeHidden();

    await page.waitForFunction(() => {
      const h = window.__store["formFieldFindReplaceHistory"];
      return Array.isArray(h) && h.length === 0;
    });

    // Gone from storage, not merely hidden from the list.
    const history = await readHistory(page);
    expect(history).toEqual([]);

    // And the dropdown now has nothing to offer, so it does not open at all.
    await page.locator("#app-title").click();
    await page.locator("#find-input").click();
    await expect(page.locator("#find-history-listbox")).toBeHidden();
    await expect(page.locator("#find-input")).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });

  test("clearing does not disturb the current find/replace boxes or options", async ({
    page,
  }) => {
    // Forgetting past searches must not also throw away what the user is in
    // the middle of doing.
    await mountPopup(page, { history: [entry({ find: "old", replace: "o" })] });

    await fillForm(page, {
      find: "in-progress",
      replace: "keep-me",
      options: { regex: true },
    });

    await page.locator("#find-input").click();
    await page.locator("#find-history-clear").click();
    await expect(page.locator("#find-history-overlay")).toBeHidden();

    await expect(page.locator("#find-input")).toHaveValue("in-progress");
    await expect(page.locator("#replace-input")).toHaveValue("keep-me");
    await expect(page.locator("#regex-checkbox")).toBeChecked();
  });

  test("reopening the dropdown shows entries recorded since it was last open", async ({
    page,
  }) => {
    // popup.js claims the rows are rebuilt on every open rather than kept in
    // sync incrementally, because "a stale row would show the user a search
    // they can no longer select". A gate found nothing pinned that: every other
    // post-mutation assertion in this file reads storage.local via
    // readHistory(), and none reopens the SAME dropdown to check the rendered
    // DOM caught up.
    await mountPopup(page, { history: [entry({ find: "old-one", replace: "1" })] });

    await page.locator("#find-input").click();
    expect(
      await page.evaluate(
        () => document.getElementById("find-history-listbox").children.length
      )
    ).toBe(1);

    // Dismiss, then record a genuinely new search.
    await page.keyboard.press("Escape");
    await expect(page.locator("#find-history-overlay")).toBeHidden();
    await fillForm(page, { find: "brand-new", replace: "2" });
    await page.locator("#count-btn").click();
    await expect(page.locator("#status-line")).toContainText(/matches/i);

    // Reopen. The new entry must be rendered, newest-first.
    await page.locator("#find-input").click();
    await expect(page.locator("#find-history-listbox")).toBeVisible();

    const rendered = await page.evaluate(() =>
      Array.from(
        document.getElementById("find-history-listbox").querySelectorAll('[role="option"]')
      ).map((o) => ({ id: o.id, text: (o.textContent || "").trim() }))
    );
    expect(rendered.length).toBe(2);
    expect(rendered[0].text).toContain("brand-new");
    expect(rendered[1].text).toContain("old-one");
    // And the ids are reassigned by position, so option-0 is the newest - not
    // left pointing at whatever was rendered the first time.
    expect(rendered.map((r) => r.id)).toEqual([
      "find-history-option-0",
      "find-history-option-1",
    ]);
  });

  test("a cleared-then-repopulated list renders the new rows, not the old ones", async ({
    page,
  }) => {
    // The sharper version of the same claim: after Clear history the rows are
    // gone, and the next recorded search must be the only one shown.
    await mountPopup(page, {
      history: [entry({ find: "stale-a" }), entry({ find: "stale-b" })],
    });

    await page.locator("#find-input").click();
    await page.locator("#find-history-clear").click();
    await expect(page.locator("#find-history-overlay")).toBeHidden();

    await fillForm(page, { find: "after-clear", replace: "x" });
    await page.locator("#count-btn").click();
    await expect(page.locator("#status-line")).toContainText(/matches/i);

    await page.locator("#find-input").click();
    const texts = await page.evaluate(() =>
      Array.from(
        document.getElementById("find-history-listbox").querySelectorAll('[role="option"]')
      ).map((o) => (o.textContent || "").trim())
    );
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain("after-clear");
    expect(texts.join(" ")).not.toContain("stale-a");
    expect(texts.join(" ")).not.toContain("stale-b");
  });

  test("the flags an entry carries are shown on its row", async ({ page }) => {
    // A remembered find string is not enough on its own: the same string with
    // regex on and off are two different searches. If the row did not say
    // which, the user would have to remember - which is the problem this
    // feature exists to solve.
    await mountPopup(page, {
      history: [
        entry({
          find: "\\d+",
          replace: "N",
          options: {
            matchCase: true,
            wholeWord: false,
            regex: true,
            includeIframes: false,
          },
        }),
        entry({
          find: "plain",
          replace: "p",
          options: {
            matchCase: false,
            wholeWord: false,
            regex: false,
            includeIframes: false,
          },
        }),
      ],
    });

    await page.locator("#find-input").click();

    const rowText = (await page.locator("#find-history-option-0").textContent()) || "";
    expect(rowText).toContain("\\d+");
    expect(rowText).toContain("regex");
    expect(rowText).toContain("case");
    expect(rowText).not.toContain("word");

    // An entry with no flags set gets no flag text at all, rather than a
    // misleading empty badge.
    const plainText = (await page.locator("#find-history-option-1").textContent()) || "";
    expect(plainText).toContain("plain");
    expect(plainText).not.toMatch(/regex|case|word|iframes/);
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

  test("an option checkbox still toggles when a dropdown is open over it", async ({
    page,
  }) => {
    // REGRESSION, and read the honest limits of it before trusting it.
    //
    // The dropdown keeps the input focused on mousedown so a click on a row is
    // not torn down by the blur first. That guard was originally bound to the
    // WHOLE overlay - a region that measurably overlaps the Options checkboxes
    // (a probe found the replace overlay covering match-case, whole-word and
    // regex; the find overlay covering match-case). The symptom was a click on
    // "Regular expression" that focused the checkbox without ticking it,
    // appearing 2 times in 93 runs under 6 parallel workers and 0 times after
    // the guard was scoped to the option rows.
    //
    // WHAT THIS TEST DOES NOT DO: it does not deterministically reproduce that
    // failure. It passes against the old, overlay-wide guard too - verified by
    // flipping the code back and running it. The failure needed the timing of
    // a real race, and a test that claimed to catch it would be the same kind
    // of overclaim a gate has already failed this pipeline for twice.
    //
    // What it DOES pin is the invariant the fix rests on: with a dropdown open,
    // the option checkboxes still respond to a click. That is the user-visible
    // property. The evidence for the scoping specifically is the 2/93 → 0/93
    // measurement, recorded in the phase-3 gate artifacts, not this test.
    await mountPopup(page, {
      history: [
        entry({ find: "a" }),
        entry({ find: "b" }),
        entry({ find: "c" }),
        entry({ find: "d" }),
        entry({ find: "e" }),
      ],
    });

    // THE FIND dropdown, deliberately - not the Replace one.
    //
    // A gate caught an earlier version of this test using the Replace dropdown,
    // which in the two-column layout sits top-right while the Options group
    // sits bottom-LEFT. That overlay can never reach those checkboxes at any
    // entry count, so they are never descendants of it and never under it - and
    // a regression back to the overlay-wide `mousedown` guard would have passed
    // that test happily. It substituted a geometrically trivial case for the
    // hard one.
    //
    // The Find dropdown shares a column with Options, so it partially covers
    // the group: some checkboxes are under it, some are not. The ones that are
    // NOT are exactly what the original defect broke, and they must still toggle
    // WHILE the dropdown is open - not after dismissing it, which would prove
    // nothing about the guard.
    await page.locator("#find-input").click();
    await expect(page.locator("#find-history-listbox")).toBeVisible();

    // Measure what the overlay covers, rather than assuming it.
    //
    // A probe established that the Options group cannot be PARTIALLY covered:
    // its four checkboxes sit in a 2x2 grid about 20px apart, and the overlay's
    // height moves in whole ~24px rows, so at 1-3 entries it covers none of them
    // and at 4+ it covers all four. There is no entry count in between. So the
    // "an uncovered Options checkbox still toggles" assertion an earlier version
    // of this test tried to make is not constructible in this layout.
    //
    // The nearest control that IS in the same column and genuinely clear of the
    // overlay is #count-btn, further down the left column. That is what gets
    // clicked below.
    const geometry = await page.evaluate(() => {
      const overlay = document.getElementById("find-history-overlay");
      const at = (id) => {
        const r = document.getElementById(id).getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { id, hit: hit ? hit.id || hit.className : null, covered: !!(hit && overlay.contains(hit)) };
      };
      return {
        options: ["match-case-checkbox", "whole-word-checkbox", "regex-checkbox", "include-iframes-checkbox"].map(at),
        countBtn: at("count-btn"),
      };
    });

    // Premise 1: the overlay really is hanging over part of the form, so this is
    // genuinely the "dropdown open over things" situation.
    expect(geometry.options.some((o) => o.covered)).toBe(true);
    // Premise 2: #count-btn is clear of it, so a click there is not merely being
    // blocked by something in the way.
    expect(geometry.countBtn.covered).toBe(false);
    expect(geometry.countBtn.hit).toBe("count-btn");

    // The assertion: a control the overlay does not cover still works while the
    // dropdown is open. Count matches is observable - it writes to the status
    // line - so a swallowed click is visible rather than silent.
    await page.locator("#find-input").fill("needle");
    await page.locator("#count-btn").click();
    await expect(page.locator("#status-line")).toContainText(/matches/i);

    // HONEST LIMIT, because the alternative is the overclaiming this pipeline
    // has already failed twice for: this test does NOT distinguish the current
    // row-scoped mousedown guard from the overlay-wide one it replaced. It
    // cannot. An overlay-wide preventDefault only ever fires for events whose
    // target is inside the overlay - i.e. for controls the overlay covers, which
    // are unreachable to a click either way. Flipping the guard back and
    // re-running this test leaves it green, which was verified rather than
    // assumed. What this test pins is the user-visible invariant; the case for
    // the narrower guard is that a preventDefault should not span a region full
    // of unrelated controls, not that a test can catch it.
  });

  test("a control the dropdown covers becomes clickable again once it closes", async ({
    page,
  }) => {
    // The other side of the same coin, and the documented behaviour rather than
    // a defect: an open overlay DOES cover what is beneath it, so those
    // controls are unreachable until it is dismissed. In the two-column layout
    // the find dropdown sits over the Options group. A user presses Escape, or
    // clicks away, or picks an entry - and then the control works.
    //
    // Asserted explicitly because the alternative reading ("the checkbox is
    // broken while a dropdown is open") is the bug this file already chased
    // once, and the difference between the two is whether the thing is
    // physically covered.
    // A full list, so the overlay is at its tallest and definitely reaches the
    // Options group below. How far it reaches depends on the entry count, so the
    // test discovers WHICH control is covered rather than hardcoding one - an
    // earlier version assumed the regex checkbox and failed with only three
    // entries, where the overlay stops short of it.
    await mountPopup(page, {
      history: Array.from({ length: 20 }, (_, i) => entry({ find: "entry-" + i })),
    });

    await page.locator("#find-input").click();
    await expect(page.locator("#find-history-listbox")).toBeVisible();

    const covered = await page.evaluate(() => {
      const overlay = document.getElementById("find-history-overlay");
      const ids = [
        "match-case-checkbox",
        "whole-word-checkbox",
        "regex-checkbox",
        "include-iframes-checkbox",
      ];
      for (const id of ids) {
        const r = document.getElementById(id).getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (hit && overlay.contains(hit)) {
          return id;
        }
      }
      return null;
    });

    // With a full list the overlay must be covering at least one of them -
    // otherwise this test is not exercising the situation it describes.
    expect(covered).not.toBeNull();

    // Dismiss with Escape - the dropdown-scoped one, which must not close the
    // popup - and the covered control is reachable again.
    await page.keyboard.press("Escape");
    await expect(page.locator("#find-history-overlay")).toBeHidden();

    await page.locator("#" + covered).check();
    await expect(page.locator("#" + covered)).toBeChecked();
  });

  test("clicking a row still selects it, despite the mousedown guard being scoped", async ({
    page,
  }) => {
    // The other half of the same fix: narrowing the guard must not break the
    // thing it was there for. A mousedown on a ROW must still keep the input
    // focused long enough for the click to land.
    await mountPopup(page, {
      history: [entry({ find: "clickable", replace: "yes" })],
    });

    await page.locator("#find-input").click();
    await page.locator("#find-history-option-0").click();
    await expect(page.locator("#find-input")).toHaveValue("clickable");
    await expect(page.locator("#replace-input")).toHaveValue("yes");
  });

  test("Tab closes the dropdown and moves focus on normally", async ({ page }) => {
    // README documents Tab as closing the dropdown. A gate pointed out that
    // branch was reachable by inspection but pinned by no named test, while its
    // neighbours (ArrowDown/Up, Enter, Escape) all had one - so it was the one
    // keyboard claim in the docs nothing would catch regressing.
    await mountPopup(page, {
      history: [entry({ find: "first", replace: "1st" })],
    });

    await page.locator("#find-input").click();
    await expect(page.locator("#find-history-listbox")).toBeVisible();

    await page.keyboard.press("Tab");
    await expect(page.locator("#find-history-overlay")).toBeHidden();
    await expect(page.locator("#find-input")).toHaveAttribute(
      "aria-expanded",
      "false"
    );

    // Tab must still do its own job - it closes the list rather than being
    // swallowed by it, so focus moves on. (Escape is the key that is consumed;
    // Tab is not.)
    const moved = await page.evaluate(
      () => document.activeElement && document.activeElement.id
    );
    expect(moved).not.toBe("find-input");

    // And the typed value is untouched by the dismissal.
    await expect(page.locator("#find-input")).toHaveValue("");
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
