#!/usr/bin/env node
/**
 * Generate the raster assets addons.mozilla.org's LISTED channel asks for, from
 * the sources already in this repo. Run:
 *
 *     node tools/make-amo-assets.js
 *
 * Output goes to docs/amo/assets/ and is NOT packaged - web-ext-config.cjs
 * ignores docs/ and tools/, so the shipped .xpi keeps its seven files and
 * `npm run check:xpi`'s allowlist stays meaningful.
 *
 * WHY PLAYWRIGHT AND NOT AN IMAGE TOOL
 * ------------------------------------
 * There is no ImageMagick, Inkscape, rsvg-convert or cairosvg on this machine.
 * `convert` exists on PATH but it is Windows' own convert.exe (a filesystem
 * utility) - running it prints "Invalid drive specification", which is a
 * genuinely confusing way to fail an icon build. Playwright with Firefox is
 * already a devDependency, and it has a second advantage: it renders the icon
 * through the SAME engine that will display it, so what lands in the PNG is
 * what a Firefox user sees.
 *
 * ABOUT THE ICON COLOUR
 * ---------------------
 * icons/icon.svg is stroked `context-stroke #7c8b9e`. On the toolbar Firefox
 * recolours it to match the theme via -moz-context-properties; everywhere that
 * supplies no context properties - about:addons, and an AMO listing card - the
 * literal #7c8b9e fallback is used. Rendering it standalone here therefore
 * produces exactly what AMO will show, which is the point. Backgrounds are
 * transparent.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { firefox } = require("@playwright/test");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "docs", "amo", "assets");

/**
 * `python` on this host is the Windows launcher and works; `python3` is not
 * always present. Probe rather than assume, and fail with a clear message
 * instead of a confusing exec error inside the icon loop.
 */
function pythonExe() {
  for (const candidate of ["python", "python3"]) {
    const probe = spawnSync(candidate, ["-c", "import PIL"], { encoding: "utf8" });
    if (probe.status === 0) {
      return candidate;
    }
  }
  throw new Error(
    "no python with Pillow found on PATH - needed to recover icon " +
      "transparency (see tools/recover-alpha.py for why)"
  );
}

// AMO uses 64x64 as its minimum for the add-on icon and prefers 128x128. The
// smaller sizes are here because they are the ones a manifest would reference
// if the PNGs ever replaced the SVG, and generating them costs nothing.
const ICON_SIZES = [16, 32, 48, 64, 96, 128];

const FIELD_TYPES = {
  text: true, search: true, url: true, tel: true, email: true,
  number: false, date: false, "datetime-local": false,
  month: false, week: false, time: false,
  textarea: true, contenteditable: true,
};

/** A remembered-history entry, in the shape popup.js stores. */
function entry(find, replace, options) {
  return {
    find,
    replace,
    options: Object.assign(
      { matchCase: false, wholeWord: false, regex: false, includeIframes: false },
      options || {}
    ),
    fieldTypes: Object.assign({}, FIELD_TYPES),
  };
}

// Plausible content for the screenshots. Deliberately not lorem ipsum: a
// listing screenshot is the only chance to show what the thing is FOR, and
// "what a real search looks like" communicates that better than placeholders.
//
// Two constraints learned by looking at the first attempt rather than assuming:
//
//   1. The live preview runs against popup.js's PREVIEW_SAMPLE_TEXT - a fixed
//      string containing a name, an email, a phone number, an order number, a
//      dollar amount and a date. A demo pattern that does not match it renders
//      "No match in sample text.", so the hero screenshot advertised the tool
//      failing. Patterns below are chosen to actually hit that sample.
//   2. A history entry whose find/replace are whitespace renders as a row with
//      nothing legible in it - honest, but in a listing it reads as a rendering
//      bug. Dropped.
const DEMO_HISTORY = [
  entry("(\\d{3})-(\\d{3})-(\\d{4})", "($1) $2-$3", { regex: true }),
  entry("Acme Corporation", "Acme Corp."),
  entry("\\bcolour\\b", "color", { regex: true, wholeWord: true }),
  entry("jane.doe@example.com", "j.doe@example.com"),
  entry("2025-", "2026-"),
  entry("draft", "final", { matchCase: true }),
];

async function ensureOut() {
  fs.mkdirSync(OUT, { recursive: true });
}

/**
 * Render the icon at one size on a given background colour.
 *
 * Firefox's Playwright build does not implement `omitBackground` ("page
 * screenshot: Not implemented"), and it is the only browser installed - so a
 * transparent PNG cannot be had directly. Each size is instead rendered twice,
 * on white and on black, and tools/recover-alpha.py derives the exact alpha
 * from the pair. See that file for the arithmetic.
 */
async function renderIconOn(browser, svg, size, background, file) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    colorScheme: "light",
  });

  // The SVG declares width/height 16; strip those so the CSS size wins, and
  // drop the page's margins so the glyph fills the frame exactly.
  await page.setContent(
    "<!DOCTYPE html><html><head><style>" +
      "html,body{margin:0;padding:0;background:" + background + "}" +
      "svg{display:block;width:" + size + "px;height:" + size + "px}" +
      "</style></head><body>" +
      svg.replace(/width="16"\s+height="16"/, "") +
      "</body></html>"
  );

  await page.screenshot({ path: file });
  await page.close();
}

async function renderIcons(browser) {
  const svg = fs.readFileSync(path.join(ROOT, "icons", "icon.svg"), "utf8");
  const tmp = path.join(OUT, ".pair");
  fs.mkdirSync(tmp, { recursive: true });
  const written = [];

  for (const size of ICON_SIZES) {
    const onWhite = path.join(tmp, "w-" + size + ".png");
    const onBlack = path.join(tmp, "b-" + size + ".png");
    await renderIconOn(browser, svg, size, "#ffffff", onWhite);
    await renderIconOn(browser, svg, size, "#000000", onBlack);

    const out = path.join(OUT, "icon-" + size + ".png");
    const res = spawnSync(
      pythonExe(),
      [path.join(ROOT, "tools", "recover-alpha.py"), onWhite, onBlack, out],
      { encoding: "utf8" }
    );
    if (res.status !== 0) {
      throw new Error(
        "recover-alpha.py failed for " + size + "px:\n" +
          (res.stderr || res.stdout || "(no output)")
      );
    }
    written.push((res.stdout || "").trimEnd());
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  return written;
}

/** Mount popup.html with a faked `browser` so it renders standalone. */
async function mountPopup(browser, { history, find, replace, options, scale }) {
  const page = await browser.newPage({
    viewport: { width: 700, height: 620 },
    deviceScaleFactor: scale || 2,
    colorScheme: "light",
  });

  await page.addInitScript((seed) => {
    const store = {
      formFieldFindReplaceHistory: seed.history,
      formFieldFindReplace: {
        find: seed.find,
        replace: seed.replace,
        options: seed.options,
        fieldTypes: seed.fieldTypes,
      },
    };
    // @ts-ignore - the popup only needs these four namespaces to start.
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
        sendMessage: () =>
          Promise.resolve({ ok: true, undoAvailable: false, undoCount: 0 }),
      },
      runtime: { onMessage: { addListener: () => {} } },
    };
  }, {
    history,
    find,
    replace,
    options: Object.assign(
      { matchCase: false, wholeWord: false, regex: false, includeIframes: false },
      options || {}
    ),
    fieldTypes: FIELD_TYPES,
  });

  const popup = path.join(ROOT, "popup", "popup.html");
  await page.goto("file://" + popup.split(path.sep).join("/"));
  await page.waitForFunction(() => document.body.dataset.ffrReady === "true");
  return page;
}

/** Screenshot just the popup's own box, at its declared width. */
async function shotPopup(page, file) {
  const app = page.locator("#app");
  await app.screenshot({ path: file });
}

async function renderScreenshots(browser) {
  const written = [];

  // 1. Hero: a regex with backreferences, and the preview showing the actual
  //    substitution it would make. Reformatting a phone number is the clearest
  //    one-glance demonstration of $1/$2/$3 that also matches the preview's
  //    built-in sample text.
  {
    const page = await mountPopup(browser, {
      history: DEMO_HISTORY,
      find: "(\\d{3})-(\\d{3})-(\\d{4})",
      replace: "($1) $2-$3",
      options: { regex: true },
    });
    await page.waitForFunction(
      () =>
        (document.getElementById("match-preview").textContent || "").includes("555")
    );
    const file = path.join(OUT, "screenshot-1-popup.png");
    await shotPopup(page, file);
    await page.close();
    written.push(path.relative(ROOT, file) + "  (hero: regex backreferences, previewed)");
  }

  // 2. The feature this release is about: the history dropdown open, showing
  //    that each remembered entry carries its own settings.
  {
    const page = await mountPopup(browser, {
      history: DEMO_HISTORY,
      find: "",
      replace: "",
    });
    await page.locator("#find-input").click();
    await page.waitForSelector("#find-history-listbox", { state: "visible" });
    const file = path.join(OUT, "screenshot-2-history.png");
    await shotPopup(page, file);
    await page.close();
    written.push(
      path.relative(ROOT, file) + "  (remembered searches, with their settings)"
    );
  }

  // 3. The plain-text case, which is what most people will actually use, with
  //    the preview confirming the substitution before anything is touched.
  //    Kept deliberately different from shot 1 so the two are not near-
  //    identical pictures of the same feature.
  {
    const page = await mountPopup(browser, {
      history: DEMO_HISTORY,
      find: "Jane Doe",
      replace: "Joan Doe",
    });
    await page.waitForFunction(
      () =>
        (document.getElementById("match-preview").textContent || "").includes("Joan")
    );
    const file = path.join(OUT, "screenshot-3-preview.png");
    await shotPopup(page, file);
    await page.close();
    written.push(path.relative(ROOT, file) + "  (plain text, previewed before replacing)");
  }

  return written;
}

(async () => {
  await ensureOut();
  const browser = await firefox.launch();
  try {
    const icons = await renderIcons(browser);
    const shots = await renderScreenshots(browser);

    console.log("Icons:");
    icons.forEach((l) => console.log("  " + l));
    console.log("Screenshots:");
    shots.forEach((l) => console.log("  " + l));
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
