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

/**
 * @param {import('@playwright/test').Page} page
 */
async function loadBulkFixtureWithContentScript(page) {
  await page.goto("file://" + FIXTURE_BULK_PATH.replace(/\\/g, "/"));
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

const PLAIN_OPTIONS = { matchCase: false, wholeWord: false, regex: false };

test.describe("phase 5: chunked replace loop against fixture-bulk.html (5,000 fields)", () => {
  test("(a) a full replace run reports the pre-seeded match count", async ({
    page,
  }) => {
    await loadBulkFixtureWithContentScript(page);

    const response = await page.evaluate(
      async (fieldTypes) =>
        window.__ffr.handleReplace({
          action: "replace",
          find: "hello",
          replace: "HELLO",
          options: { matchCase: false, wholeWord: false, regex: false },
          fieldTypes,
        }),
      ALL_FIELD_TYPES
    );

    expect(response.ok).toBe(true);
    expect(response.cancelled).toBe(false);
    // window.__EXPECTED_MATCHES = 500, one match per seeded field, and each
    // seeded field contains the needle exactly once - so matches, fields,
    // and replaced are all 500 here.
    expect(response.matches).toBe(500);
    expect(response.fields).toBe(500);
    expect(response.replaced).toBe(500);
    expect(response.total).toBe(5000);
    expect(response.done).toBe(5000);
    expect(response.timedOut).toBe(0);
    // Total wall-clock time is reported in the final status (criterion 5).
    expect(typeof response.wallMs).toBe("number");
    expect(response.wallMs).toBeGreaterThanOrEqual(0);
  });

  test("(b) received progress messages show monotonically increasing `done` values", async ({
    page,
  }) => {
    await loadBulkFixtureWithContentScript(page);

    const result = await page.evaluate(async (fieldTypes) => {
      const log = [];
      const unsubscribe = window.__ffr.onProgress((msg) => log.push(msg));

      const response = await window.__ffr.handleReplace({
        action: "replace",
        find: "hello",
        replace: "HELLO",
        options: { matchCase: false, wholeWord: false, regex: false },
        fieldTypes,
      });

      unsubscribe();
      return { response, log };
    }, ALL_FIELD_TYPES);

    expect(result.response.ok).toBe(true);
    // 5000 fields / CHUNK_SIZE (~200) => multiple progress posts, not one.
    expect(result.log.length).toBeGreaterThan(1);

    for (const msg of result.log) {
      expect(msg.type).toBe("progress");
      expect(msg.total).toBe(5000);
    }

    for (let i = 1; i < result.log.length; i++) {
      expect(result.log[i].done).toBeGreaterThan(result.log[i - 1].done);
    }

    // The last progress message must reflect the run's true completion.
    expect(result.log[result.log.length - 1].done).toBe(5000);
    expect(result.log[result.log.length - 1].replaced).toBe(500);
  });

  test("(c) cancelling mid-run halts further replacement and reports a partial count strictly less than the total", async ({
    page,
  }) => {
    await loadBulkFixtureWithContentScript(page);

    const response = await page.evaluate(async (fieldTypes) => {
      // Deterministic in-page cancellation: request cancel the moment the
      // very first chunk's progress lands, rather than racing a second
      // Node-side page.evaluate() call against real wall-clock chunk
      // timing (which would be flaky).
      const unsubscribe = window.__ffr.onProgress((msg) => {
        if (msg.done > 0) {
          window.__ffr.requestCancel();
        }
      });

      const result = await window.__ffr.handleReplace({
        action: "replace",
        find: "hello",
        replace: "HELLO",
        options: { matchCase: false, wholeWord: false, regex: false },
        fieldTypes,
      });

      unsubscribe();
      return result;
    }, ALL_FIELD_TYPES);

    expect(response.ok).toBe(true);
    expect(response.cancelled).toBe(true);
    // Only the first chunk (CHUNK_SIZE fields) should have been processed
    // before the cancellation flag was observed at the top of the next one.
    expect(response.done).toBeGreaterThan(0);
    expect(response.done).toBeLessThan(response.total);
    expect(response.total).toBe(5000);
    // Already-replaced fields are left in place - report how many changed,
    // strictly less than the full seeded total of 500/5000.
    expect(response.replaced).toBeGreaterThan(0);
    expect(response.replaced).toBeLessThan(500);
    expect(response.replaced).toBeLessThan(response.total);

    // Verify the page itself: exactly `replaced` fields actually changed,
    // and nothing beyond the cancelled point was touched.
    const domState = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input"));
      return {
        changedCount: inputs.filter((el) => el.value.includes("HELLO")).length,
        untouchedRemainderStillLowercase: inputs
          .slice(4990)
          .every((el) => !el.value.includes("HELLO")),
      };
    });
    expect(domState.changedCount).toBe(response.replaced);
    expect(domState.untouchedRemainderStillLowercase).toBe(true);
  });

  test("(d) undo snapshots are capped, and disabled for a run exceeding the cap", async ({
    page,
  }) => {
    await loadBulkFixtureWithContentScript(page);

    // Total collected/filtered field count on this fixture is exactly 5000
    // (see fixture-bulk.html). Cap it just below that so this run must
    // disable undo.
    const overCapResponse = await page.evaluate(async (fieldTypes) => {
      window.__ffr.setUndoSnapshotCapForTesting(4999);
      const result = await window.__ffr.handleReplace({
        action: "replace",
        find: "hello",
        replace: "HELLO",
        options: { matchCase: false, wholeWord: false, regex: false },
        fieldTypes,
      });
      const snapshotLength = window.__ffr.getUndoSnapshotLength();
      window.__ffr.resetUndoSnapshotCapForTesting();
      return { result, snapshotLength };
    }, ALL_FIELD_TYPES);

    expect(overCapResponse.result.ok).toBe(true);
    expect(overCapResponse.result.undoAvailable).toBe(false);
    expect(overCapResponse.result.replaced).toBe(500);
    // Disabling undo must never block the replace itself from happening.
    expect(overCapResponse.snapshotLength).toBe(0);
  });

  test("(d) undo snapshot is built (and not capped) for a run within the cap", async ({
    page,
  }) => {
    await loadBulkFixtureWithContentScript(page);

    const withinCapResponse = await page.evaluate(async (fieldTypes) => {
      window.__ffr.setUndoSnapshotCapForTesting(5000); // exactly the total
      const result = await window.__ffr.handleReplace({
        action: "replace",
        find: "hello",
        replace: "HELLO",
        options: { matchCase: false, wholeWord: false, regex: false },
        fieldTypes,
      });
      const snapshotLength = window.__ffr.getUndoSnapshotLength();
      window.__ffr.resetUndoSnapshotCapForTesting();
      return { result, snapshotLength };
    }, ALL_FIELD_TYPES);

    expect(withinCapResponse.result.ok).toBe(true);
    expect(withinCapResponse.result.undoAvailable).toBe(true);
    expect(withinCapResponse.result.replaced).toBe(500);
    // One flat {el, value} entry per actually-replaced field - not one per
    // collected field, and never more than the cap.
    expect(withinCapResponse.snapshotLength).toBe(500);
  });

  test("(d) handleCount reports totalFields independent of match count, for the popup's pre-run undo warning", async ({
    page,
  }) => {
    await loadBulkFixtureWithContentScript(page);

    const response = await page.evaluate((fieldTypes) =>
      window.__ffr.handleCount({
        action: "count",
        find: "this-does-not-appear-anywhere",
        options: { matchCase: false, wholeWord: false, regex: false },
        fieldTypes,
      }),
    ALL_FIELD_TYPES);

    expect(response.ok).toBe(true);
    expect(response.matches).toBe(0);
    expect(response.fields).toBe(0);
    // Even with zero matches, the full collected field count is reported -
    // this is what the popup compares against the undo cap BEFORE Replace
    // all is ever clicked.
    expect(response.totalFields).toBe(5000);
  });
});

test.describe("phase 5: catastrophic-backtracking per-field time budget", () => {
  test("a field whose matching takes over the time budget is reported as timedOut, not replaced or skipped", async ({
    page,
  }) => {
    await loadBulkFixtureWithContentScript(page);

    // A genuinely pathological regex's real running time is inherently
    // machine-dependent (exponential backtracking scales wildly across CPUs
    // and regex engines), which makes it unsuitable for a deterministic CI
    // assertion. Instead, this exercises the exact same guard mechanism
    // (processField's FIELD_TIME_BUDGET_MS check) with a fake "regex"
    // object whose `exec` deterministically takes 150ms - well over the
    // 100ms budget - every time, no real backtracking involved.
    const result = await page.evaluate(() => {
      const el = document.createElement("input");
      el.type = "text";
      el.id = "slow-field";
      el.value = "some value";
      document.body.appendChild(el);

      const fakeSlowRegex = {
        lastIndex: 0,
        exec() {
          const start = Date.now();
          while (Date.now() - start < 150) {
            // Deterministic busy-wait standing in for a pathologically
            // slow real regex engine call.
          }
          return null;
        },
      };

      const field = { el, kind: "input", type: "text", originalValue: el.value };
      const outcome = window.__ffr.processField(field, fakeSlowRegex, "replacement");

      return { outcome, valueAfter: el.value };
    });

    expect(result.outcome.timedOut).toBe(true);
    expect(result.outcome.replaced).toBe(false);
    expect(result.outcome.skippedReason).toBeNull();
    // A timed-out field must never be left mutated by a match it never
    // finished evaluating.
    expect(result.valueAfter).toBe("some value");
  });
});

test.describe("phase 5: regex lastIndex reset across fields (regression guard)", () => {
  test("(e) a field with multiple matches has ALL of them replaced, and a short field immediately after a long matching field is not skipped", async ({
    page,
  }) => {
    // Deliberately NOT the bulk fixture here - it seeds 500 of its own
    // "hello" matches, which would swamp this test's exact match-count
    // assertions. A blank page with only the three fields created below
    // isolates the lastIndex-reset behavior under test.
    await page.setContent("<!DOCTYPE html><html><body></body></html>");
    await page.addScriptTag({ path: CONTENT_SCRIPT_PATH });

    const response = await page.evaluate((fieldTypes) => {
      // Field 1: several matches AND long enough that, if the shared /g/
      // regex's lastIndex were left dangling past the end of this string
      // instead of being reset before the NEXT field is processed, the
      // following short field's `regex.exec()`/`.test()` call would start
      // searching from an out-of-range index and immediately find nothing.
      const multiMatchField = document.createElement("input");
      multiMatchField.type = "text";
      multiMatchField.id = "lastindex-multi-match";
      multiMatchField.value = "hello hello hello";
      document.body.appendChild(multiMatchField);

      const longThenMatchField = document.createElement("input");
      longThenMatchField.type = "text";
      longThenMatchField.id = "lastindex-long-tail-match";
      // 60 non-matching characters, THEN a match right at the very end -
      // whatever lastIndex a stateful, un-reset /g/ regex would be left at
      // after this field, it will be at or near this field's own length.
      longThenMatchField.value = "z".repeat(60) + "hello";
      document.body.appendChild(longThenMatchField);

      // Field 3 is intentionally SHORT (5 chars) and placed immediately
      // after the long field above. If lastIndex leaked from field 2
      // (~65) into field 3's own exec/test call, `regex.exec("hello")`
      // would start past the end of this 5-character string and return
      // null, silently skipping this field's only match.
      const shortField = document.createElement("input");
      shortField.type = "text";
      shortField.id = "lastindex-short-after-long";
      shortField.value = "hello";
      document.body.appendChild(shortField);

      return window.__ffr.handleReplace({
        action: "replace",
        find: "hello",
        replace: "HELLO",
        options: { matchCase: false, wholeWord: false, regex: false },
        fieldTypes,
      });
    }, ALL_FIELD_TYPES);

    expect(response.ok).toBe(true);
    // 3 (multi-match field) + 1 (long-tail field) + 1 (short field) = 5.
    expect(response.matches).toBe(5);
    expect(response.fields).toBe(3);
    expect(response.replaced).toBe(3);

    const values = await page.evaluate(() => ({
      multi: document.getElementById("lastindex-multi-match").value,
      longTail: document.getElementById("lastindex-long-tail-match").value,
      short: document.getElementById("lastindex-short-after-long").value,
    }));

    expect(values.multi).toBe("HELLO HELLO HELLO");
    expect(values.longTail).toBe("z".repeat(60) + "HELLO");
    // THE critical assertion: this field's match must not have been
    // skipped by a leaked lastIndex from the previous, longer field.
    expect(values.short).toBe("HELLO");
  });
});
