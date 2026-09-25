// @ts-check
// Reproduction probe for the reported bug: replace -> undo -> replace loses
// the original text instead of replacing it.
const path = require("path");
const { test, expect } = require("@playwright/test");

const FIXTURE_PATH = path.join(__dirname, "fixture.html");
const CONTENT_SCRIPT_PATH = path.join(__dirname, "..", "content", "find-replace.js");

async function load(page) {
  await page.goto("file://" + FIXTURE_PATH.replace(/\\/g, "/"));
  await page.evaluate(() => {
    const iframe = document.getElementById("same-origin-iframe");
    if (iframe.contentDocument && iframe.contentDocument.readyState === "complete") {
      return Promise.resolve();
    }
    return new Promise((r) => iframe.addEventListener("load", r, { once: true }));
  });
  await page.addScriptTag({ path: CONTENT_SCRIPT_PATH });
}

const ALL = {
  text: true, search: true, url: true, tel: true, email: true,
  number: false, date: false, "datetime-local": false,
  month: false, week: false, time: false,
  textarea: true, contenteditable: true,
};
const PLAIN = { matchCase: false, wholeWord: false, regex: false };

test.describe("REPRO: replace -> undo -> replace", () => {
  test("input field survives a second replace after undo", async ({ page }) => {
    await load(page);

    const trace = await page.evaluate(async ({ fieldTypes, options }) => {
      const el = document.getElementById("text-input");
      const snap = () => el.value;
      const out = { start: snap() };

      const r1 = await window.__ffr.handleReplace({
        action: "replace", find: "hello", replace: "HELLO", options, fieldTypes });
      out.afterReplace1 = snap();
      out.r1 = { ok: r1.ok, replaced: r1.replaced, matches: r1.matches };

      const u1 = await window.__ffr.handleUndo({ action: "undo" });
      out.afterUndo = snap();
      out.u1 = { ok: u1.ok, restored: u1.restored };

      const r2 = await window.__ffr.handleReplace({
        action: "replace", find: "hello", replace: "HELLO", options, fieldTypes });
      out.afterReplace2 = snap();
      out.r2 = { ok: r2.ok, replaced: r2.replaced, matches: r2.matches };

      return out;
    }, { fieldTypes: ALL, options: PLAIN });

    console.log("INPUT TRACE:", JSON.stringify(trace, null, 2));

    expect(trace.afterReplace1).not.toBe(trace.start);
    expect(trace.afterUndo).toBe(trace.start);
    // The crux: the second replace must produce the same result as the first,
    // not empty and not the untouched original.
    expect(trace.afterReplace2).toBe(trace.afterReplace1);
  });

  test("contenteditable survives a second replace after undo", async ({ page }) => {
    await load(page);

    const trace = await page.evaluate(async ({ fieldTypes, options }) => {
      const el = document.getElementById("contenteditable-div");
      const snap = () => ({ text: el.textContent, html: el.innerHTML,
                            b: !!el.querySelector("b"), span: !!el.querySelector("span") });
      const out = { start: snap() };

      const r1 = await window.__ffr.handleReplace({
        action: "replace", find: "hello", replace: "HELLO", options, fieldTypes });
      out.afterReplace1 = snap();
      out.r1 = { replaced: r1.replaced };

      const u1 = await window.__ffr.handleUndo({ action: "undo" });
      out.afterUndo = snap();

      const r2 = await window.__ffr.handleReplace({
        action: "replace", find: "hello", replace: "HELLO", options, fieldTypes });
      out.afterReplace2 = snap();
      out.r2 = { replaced: r2.replaced };

      return out;
    }, { fieldTypes: ALL, options: PLAIN });

    console.log("CONTENTEDITABLE TRACE:", JSON.stringify(trace, null, 2));

    expect(trace.afterUndo.text).toBe(trace.start.text);
    expect(trace.afterReplace2.text).toBe(trace.afterReplace1.text);
    expect(trace.afterReplace2.b).toBe(true);
    expect(trace.afterReplace2.span).toBe(true);
  });

  // This is the empirical basis for the mock used in
  // test/popup-undo-desync.spec.js. That suite simulates a content script
  // whose snapshot has been wiped by a re-injection, and asserts the popup
  // must not call that a success. If the content script ever stopped
  // returning ok:true here - e.g. started reporting ok:false on an empty
  // snapshot - the popup-level mock would be modelling a state that can no
  // longer occur, and those tests would be guarding nothing. This pins the
  // real behaviour so that drift is caught here rather than silently
  // invalidating the popup tests.
  test("handleUndo reports ok:true with restored:0 when the snapshot is empty", async ({ page }) => {
    await load(page);

    const out = await page.evaluate(async () => {
      const el = document.getElementById("text-input");
      const before = el.value;
      // No replace has run in this instance, so lastUndoSnapshot is empty -
      // exactly the state a re-injection leaves behind.
      const r = await window.__ffr.handleUndo({ action: "undo" });
      return { before, after: el.value, response: r };
    });

    expect(out.response.ok).toBe(true);
    expect(out.response.restored).toBe(0);
    expect(out.response.error).toBeNull();
    // And nothing on the page changed, because there was nothing to restore.
    expect(out.after).toBe(out.before);
  });

  test("three replaces in a row without undo keep compounding correctly", async ({ page }) => {
    await load(page);

    const trace = await page.evaluate(async ({ fieldTypes, options }) => {
      const el = document.getElementById("text-input");
      const out = { start: el.value, steps: [] };
      for (let i = 0; i < 3; i++) {
        const r = await window.__ffr.handleReplace({
          action: "replace", find: "hello", replace: "HELLO", options, fieldTypes });
        out.steps.push({ i, value: el.value, replaced: r.replaced, matches: r.matches });
      }
      return out;
    }, { fieldTypes: ALL, options: PLAIN });

    console.log("REPEAT TRACE:", JSON.stringify(trace, null, 2));
    // First run replaces; subsequent runs find nothing (already replaced) and
    // must leave the value alone rather than clearing it.
    expect(trace.steps[1].value).toBe(trace.steps[0].value);
    expect(trace.steps[2].value).toBe(trace.steps[0].value);
  });
});
