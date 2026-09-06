/**
 * Form Field Find & Replace - content script.
 *
 * Phase 2 scope: field collection, always-skip rules, field-type filtering,
 * and the "count" message action.
 *
 * Phase 3 scope: the replacement path. count and replace share ONE matcher
 * (buildMatcher + countMatches) - replace never builds its own RegExp.
 * Replacement writes go through the native prototype setter (so React and
 * other controlled-input patterns notice), contenteditable is mutated by
 * walking text nodes (never innerHTML), and the numeric/date input types
 * get a read-back-and-rollback pass so a rejected value never leaves the
 * field blank. Fields with zero matches are never touched - no setter call,
 * no events.
 *
 * Phase 4 scope: full String.prototype.replace substitution grammar in
 * regex mode ($1-$99, $<name>, $&, $`, $', $$), literal-dollar escaping in
 * plain mode (so "$5.00" round-trips unmangled), backreference validation
 * against the compiled pattern's actual group count/names BEFORE running a
 * replace (a mismatch is returned as a distinct error code without ever
 * entering the replace loop), and computeFirstMatchPreview() for the
 * popup's live first-match preview - which reuses buildMatcher(), never a
 * third matching implementation.
 *
 * Phase 5 scope: making the replace pipeline stay linear and responsive at
 * thousands of fields (see SPEC.md's "Scale - assume thousands of fields"
 * section). handleReplace() is now async and processes the pre-collected
 * flat field array in CHUNK_SIZE batches with an `await setTimeout(0)`
 * yield between batches, checks a module-level `cancelled` flag at the top
 * of every chunk, posts throttled `{type:"progress",...}` messages, guards
 * against catastrophic-backtracking regexes on a per-field time budget, and
 * builds the undo snapshot array (flat, capped, phase-7 wires the actual
 * Undo button/action to it). Shadow DOM/iframe recursion (phase 6) remains
 * out of scope here.
 *
 * Testability: Playwright cannot easily load a Firefox extension, so tests
 * inject this file into a fixture page directly via addScriptTag/evaluate.
 * To support both that and the real extension:
 *   - the browser.runtime.onMessage registration is guarded behind a check
 *     that the extension API actually exists, so injecting this file into a
 *     plain page never throws;
 *   - the pure, side-effect-free functions are exposed on `window.__ffr` so
 *     tests can call them directly without going through messaging.
 * This adds no network access, no eval/new Function, and no behavior change
 * in the real extension (the real extension never sets window.__ffr's
 * consumers, it just happens to be reachable there too).
 *
 * Vanilla JS only. No frameworks, no build step.
 */

"use strict";

(function () {
  // ---- Target element definitions ---------------------------------------

  const TEXT_INPUT_TYPES = ["text", "search", "url", "tel", "email"];
  const NUMERIC_DATE_INPUT_TYPES = [
    "number",
    "date",
    "datetime-local",
    "month",
    "week",
    "time",
  ];
  const TARGET_INPUT_TYPES = new Set([
    ...TEXT_INPUT_TYPES,
    ...NUMERIC_DATE_INPUT_TYPES,
  ]);
  const ALWAYS_SKIP_INPUT_TYPES = new Set(["password", "hidden", "file"]);

  /**
   * Resolve an <input>'s effective type, treating a missing or unrecognized
   * `type` attribute as "text" - matching how the browser itself falls back
   * for rendering/behavior purposes.
   * @param {HTMLInputElement} el
   * @returns {string}
   */
  function resolveInputType(el) {
    const raw = (el.getAttribute("type") || "").toLowerCase().trim();
    if (!raw) {
      return "text";
    }
    // Any attribute value the browser itself doesn't recognize as one of the
    // real input types also falls back to "text" (e.g. type="banana").
    if (!TARGET_INPUT_TYPES.has(raw) && !ALWAYS_SKIP_INPUT_TYPES.has(raw)) {
      // Only fold genuinely unrecognized values into "text"; leave the
      // always-skip types (password/hidden/file) alone so they're still
      // correctly skipped below, and leave other real HTML input types
      // (checkbox, radio, submit, etc.) alone too - they simply won't match
      // TARGET_INPUT_TYPES and will be excluded as not-a-target.
      const KNOWN_NON_TARGET_TYPES = new Set([
        "checkbox",
        "radio",
        "submit",
        "reset",
        "button",
        "image",
        "range",
        "color",
      ]);
      if (!KNOWN_NON_TARGET_TYPES.has(raw)) {
        return "text";
      }
      return raw;
    }
    return raw;
  }

  /**
   * Always-skip rules that apply regardless of kind: disabled, readonly,
   * aria-readonly="true". Identifiable as separate branches per the
   * acceptance criteria, rather than folded into one boolean expression.
   * @param {Element} el
   * @returns {boolean}
   */
  function isAlwaysSkippedElement(el) {
    if (el.disabled) {
      return true;
    }
    if (el.hasAttribute("readonly")) {
      return true;
    }
    if ((el.getAttribute("aria-readonly") || "").toLowerCase() === "true") {
      return true;
    }
    return false;
  }

  /**
   * Zero-rendered-size check. `offsetParent` is the cheap, non-layout-forcing
   * signal and is checked first; it is null both for genuinely hidden
   * elements and for `position: fixed` elements, so a `getComputedStyle`
   * call is only made as a documented fallback in that ambiguous case - this
   * function is never called unconditionally across the whole walk.
   * @param {HTMLElement} el
   * @returns {boolean}
   */
  function isRenderedVisible(el) {
    if (el.offsetParent !== null) {
      return true;
    }
    // Fallback path: offsetParent === null. Only here do we pay for
    // getComputedStyle, to distinguish "hidden" from "position: fixed".
    const style = getComputedStyle(el);
    return style.position === "fixed";
  }

  /**
   * Build a field descriptor for a single element, or return null if the
   * element is not a target at all, or is a target but hits an always-skip
   * rule. This is the single place kind/type resolution and skip rules are
   * applied, so collectFields stays a plain single-pass walk.
   * @param {Element} el
   * @returns {{el: Element, kind: string, type: string, originalValue: string} | null}
   */
  function describeField(el) {
    let kind;
    let type;

    if (el instanceof HTMLTextAreaElement) {
      kind = "textarea";
      type = "textarea";
    } else if (el instanceof HTMLInputElement) {
      const resolved = resolveInputType(el);
      if (ALWAYS_SKIP_INPUT_TYPES.has(resolved)) {
        return null; // type=password/hidden/file - always skip
      }
      if (!TARGET_INPUT_TYPES.has(resolved)) {
        return null; // not a targetable input type (checkbox, submit, etc.)
      }
      kind = "input";
      type = resolved;
    } else {
      const ceAttr = el.getAttribute && el.getAttribute("contenteditable");
      if (ceAttr === null || ceAttr === undefined) {
        return null;
      }
      const normalized = ceAttr.toLowerCase();
      if (normalized !== "" && normalized !== "true") {
        return null;
      }
      kind = "contenteditable";
      type = "contenteditable";
    }

    if (isAlwaysSkippedElement(el)) {
      return null; // disabled / readonly / aria-readonly="true"
    }
    if (!isRenderedVisible(el)) {
      return null; // zero rendered size
    }

    const originalValue = kind === "contenteditable" ? el.textContent : el.value;

    return { el, kind, type, originalValue };
  }

  /**
   * Single-pass walk over `root`, yielding a flat field descriptor for each
   * targetable, non-skipped element. Written as one generator so it can be
   * extended (phase 6) to recurse into open shadow roots and same-origin
   * iframe documents uniformly, without a second, duplicated walk function.
   * For phase 2, the document case is sufficient.
   *
   * Does not build nested structures and does not call getComputedStyle
   * except via the documented fallback inside isRenderedVisible.
   *
   * @param {Document|DocumentFragment} root
   * @returns {Generator<{el: Element, kind: string, type: string, originalValue: string}>}
   */
  function* collectFields(root) {
    if (!root) {
      return;
    }

    const doc = root.ownerDocument || root;
    if (!doc || typeof doc.createTreeWalker !== "function") {
      return;
    }

    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    let node = walker.nextNode();
    while (node) {
      const descriptor = describeField(node);
      if (descriptor) {
        yield descriptor;
      }

      // Phase 6 extension point: recurse into node.shadowRoot (if open) and,
      // when include-iframes is set, into same-origin iframe documents -
      // both via `yield* collectFields(...)` so this stays one generator.

      node = walker.nextNode();
    }
  }

  // ---- Field-type filtering ----------------------------------------------

  /**
   * Filter a flat array of field descriptors down to the ones enabled by
   * the popup's four field-type checkbox groups, before any count/replace
   * work happens on them.
   * @param {Array<{type: string}>} fields
   * @param {Record<string, boolean>} fieldTypes
   * @returns {Array}
   */
  function filterByTypes(fields, fieldTypes) {
    const types = fieldTypes || {};
    const out = [];
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (types[field.type]) {
        out.push(field);
      }
    }
    return out;
  }

  // ---- Matching -----------------------------------------------------------

  const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

  /**
   * Escape regex metacharacters so a plain-mode needle is matched literally.
   * @param {string} str
   * @returns {string}
   */
  function escapeRegExp(str) {
    return str.replace(REGEX_METACHARACTERS, "\\$&");
  }

  /**
   * Build the shared matcher RegExp used by both the count path and (in
   * phase 3) the replace path, from the popup's find string and options.
   * Never throws: a bad user regex is caught and surfaced as an error
   * string instead.
   * @param {string} find
   * @param {{matchCase?: boolean, wholeWord?: boolean, regex?: boolean}} options
   * @returns {{regex: RegExp|null, error: string|null}}
   */
  function buildMatcher(find, options) {
    const opts = options || {};
    const flags = "g" + (opts.matchCase ? "" : "i");
    let source = opts.regex ? find : escapeRegExp(find);

    if (opts.wholeWord) {
      source = opts.regex ? `\\b(?:${source})\\b` : `\\b${source}\\b`;
    }

    try {
      return { regex: new RegExp(source, flags), error: null };
    } catch (error) {
      return { regex: null, error: error.message };
    }
  }

  /**
   * Count matches of `regex` in `value` without mutating anything. The
   * regex is `g`-flagged and stateful, so lastIndex is reset before and
   * after use to keep this safe to call repeatedly across many fields.
   * @param {RegExp} regex
   * @param {string} value
   * @returns {number}
   */
  function countMatches(regex, value) {
    if (!regex || typeof value !== "string" || value === "") {
      return 0;
    }
    regex.lastIndex = 0;
    let count = 0;
    let match = regex.exec(value);
    while (match !== null) {
      count++;
      if (match[0] === "") {
        // Zero-width match (e.g. an optional group) - advance manually to
        // avoid an infinite loop, since lastIndex won't move on its own.
        regex.lastIndex++;
      }
      match = regex.exec(value);
    }
    regex.lastIndex = 0;
    return count;
  }

  // ---- Backreference validation --------------------------------------------

  /**
   * Walk a regex source string (the pattern actually compiled and used at
   * runtime - i.e. post buildMatcher() whole-word wrapping) and count
   * capturing groups, plus collect the names of any named capture groups
   * `(?<name>...)`. Skips character classes and escaped characters so a
   * literal `(` inside `[...]` or `\(` is never miscounted, and skips
   * non-capturing/lookaround groups (`(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`) -
   * only plain `(` and named `(?<name>` groups count.
   * @param {string} source
   * @returns {{count: number, names: string[]}}
   */
  function analyzeGroups(source) {
    let count = 0;
    const names = [];
    let inClass = false;

    for (let i = 0; i < source.length; i++) {
      const c = source[i];

      if (c === "\\") {
        i++; // skip the escaped character entirely
        continue;
      }

      if (inClass) {
        if (c === "]") {
          inClass = false;
        }
        continue;
      }

      if (c === "[") {
        inClass = true;
        continue;
      }

      if (c !== "(") {
        continue;
      }

      if (source[i + 1] !== "?") {
        count++; // plain capturing group
        continue;
      }

      // "(?" - could be non-capturing, a lookaround, or a named group.
      if (
        source[i + 2] === "<" &&
        source[i + 3] !== "=" &&
        source[i + 3] !== "!"
      ) {
        const end = source.indexOf(">", i + 3);
        if (end !== -1) {
          names.push(source.slice(i + 3, end));
          count++;
          i = end;
        }
      }
      // else: (?:...), (?=...), (?!...), (?<=...), (?<!...) - none of these
      // are capturing, nothing to count.
    }

    return { count, names };
  }

  /**
   * Scan a replacement string for `$N`/`$<name>` tokens that are meant to be
   * backreferences - as opposed to `$$`, `$&`, `` $` ``, `$'`, which never
   * need group validation, or a lone `$` with nothing special following,
   * which is just a literal character.
   * @param {string} template
   * @returns {Array<{type: "digits", one: string, two: string|null}|{type: "name", name: string}>}
   */
  function scanReplacementTokens(template) {
    const tokens = [];
    let i = 0;
    while (i < template.length) {
      if (template[i] !== "$") {
        i++;
        continue;
      }
      const c1 = template[i + 1];

      if (c1 === "$" || c1 === "&" || c1 === "`" || c1 === "'") {
        i += 2; // handled natively by String.prototype.replace, no group involved
        continue;
      }

      if (c1 === "<") {
        const end = template.indexOf(">", i + 2);
        if (end === -1) {
          i++; // stray "$<" with no closing ">" - literal, not a token
          continue;
        }
        tokens.push({ type: "name", name: template.slice(i + 2, end) });
        i = end + 1;
        continue;
      }

      if (c1 >= "0" && c1 <= "9") {
        const c2 = template[i + 2];
        const two = c2 >= "0" && c2 <= "9" ? c1 + c2 : null;
        tokens.push({ type: "digits", one: c1, two });
        i += 1;
        continue;
      }

      i++; // lone "$" - literal
    }
    return tokens;
  }

  /**
   * Resolve whether a `$N`/`$NN` digit token refers to a group that
   * actually exists, using the same "prefer two digits, fall back to one
   * digit" rule String.prototype.replace itself uses - so a token that
   * resolves here is guaranteed to behave as a real backreference at
   * runtime, and one that doesn't resolve is guaranteed to be silently
   * dropped (treated as literal text) instead.
   * @param {{one: string, two: string|null}} token
   * @param {number} groupCount
   * @returns {boolean}
   */
  function digitsTokenResolvesToGroup(token, groupCount) {
    if (token.two) {
      const n2 = parseInt(token.two, 10);
      if (n2 >= 1 && n2 <= groupCount) {
        return true;
      }
    }
    const n1 = parseInt(token.one, 10);
    return n1 >= 1 && n1 <= groupCount;
  }

  /**
   * Validate every `$N`/`$<name>` backreference token in `replaceStr`
   * against the actual capture groups compiled into `regex`. Called before
   * a regex-mode replace run so a mismatch is caught and the run is BLOCKED
   * instead of silently substituting an empty string (or, worse, a subtly
   * wrong smaller group).
   * @param {RegExp} regex
   * @param {string} replaceStr
   * @returns {{ok: boolean, error: string|null}}
   */
  function validateBackreferences(regex, replaceStr) {
    if (!regex) {
      return { ok: true, error: null };
    }

    const { count, names } = analyzeGroups(regex.source);
    const tokens = scanReplacementTokens(replaceStr);
    const problems = [];

    for (const token of tokens) {
      if (token.type === "digits") {
        if (!digitsTokenResolvesToGroup(token, count)) {
          problems.push("$" + (token.two || token.one));
        }
      } else if (token.type === "name") {
        if (!names.includes(token.name)) {
          problems.push("$<" + token.name + ">");
        }
      }
    }

    if (problems.length === 0) {
      return { ok: true, error: null };
    }

    const groupsDescription =
      `pattern has ${count} capture group${count === 1 ? "" : "s"}` +
      (names.length ? `, named: ${names.join(", ")}` : "");

    return {
      ok: false,
      error: `Replacement references undefined group(s): ${problems.join(", ")} (${groupsDescription})`,
    };
  }

  /**
   * Escape `$` to `$$` so a plain (non-regex) mode replacement string is
   * handed to String.prototype.replace as a pure literal - otherwise a user
   * typing e.g. "$5.00" would have "$5" silently misread as backreference
   * syntax and dropped (plain mode never has capture groups).
   * @param {string} str
   * @returns {string}
   */
  function escapeDollarForReplace(str) {
    return str.split("$").join("$$");
  }

  // ---- Live match preview ---------------------------------------------------

  /**
   * Compute the substitution result of the FIRST match of `find` in
   * `sampleText`, reusing buildMatcher() - the exact same function the
   * count and replace paths use, never a third matching implementation.
   * Used by the popup's live preview so the user can verify capture groups
   * and backreferences land where expected before running a real replace.
   * Handles no-match, invalid-regex, empty-find and backreference-mismatch
   * cases gracefully (never throws).
   * @param {string} sampleText
   * @param {string} find
   * @param {string} replaceStr
   * @param {{matchCase?: boolean, wholeWord?: boolean, regex?: boolean}} options
   * @returns {{ok: boolean, hasMatch: boolean, preview: string|null, error: string|null}}
   */
  function computeFirstMatchPreview(sampleText, find, replaceStr, options) {
    const opts = options || {};
    const text = typeof sampleText === "string" ? sampleText : "";
    const template = typeof replaceStr === "string" ? replaceStr : "";

    if (typeof find !== "string" || find === "") {
      return { ok: true, hasMatch: false, preview: null, error: null };
    }

    const { regex, error } = buildMatcher(find, opts);
    if (error) {
      return { ok: false, hasMatch: false, preview: null, error };
    }

    if (opts.regex) {
      const validation = validateBackreferences(regex, template);
      if (!validation.ok) {
        return { ok: false, hasMatch: false, preview: null, error: validation.error };
      }
    }

    regex.lastIndex = 0;
    const match = regex.exec(text);
    if (!match) {
      return { ok: true, hasMatch: false, preview: null, error: null };
    }

    const effectiveTemplate = opts.regex ? template : escapeDollarForReplace(template);
    // Clone without the "g" flag so String.prototype.replace only touches
    // this first match - the shared matcher's regex is always global (and
    // stateful via lastIndex).
    const singleRegex = new RegExp(regex.source, regex.flags.replace("g", ""));
    const preview = text.replace(singleRegex, effectiveTemplate);

    return { ok: true, hasMatch: true, preview, error: null };
  }

  // ---- Scale constants (phase 5) -------------------------------------------

  /**
   * Number of fields processed per chunk before yielding to the event loop.
   * Tuned by actually measuring test/fixture-bulk.html's 5,000 seeded
   * fields end-to-end (a full-page "field"->"field" no-op replace, so the
   * measurement isolates loop/yield overhead from DOM-mutation cost;
   * `response.wallMs`, 3 runs per chunk size, Firefox via this project's own
   * Playwright harness):
   *   -   50/chunk -> 100 chunk-boundary yields: 414-418ms observed.
   *   -  200/chunk ->  25 chunk-boundary yields: 99-108ms observed.
   *   - 1000/chunk ->   5 chunk-boundary yields: 16-20ms observed.
   * The dominant cost at every size is NOT the per-field work (5,000 trivial
   * regex replacements is sub-millisecond total) - it's `await new
   * Promise(r => setTimeout(r, 0))` itself, which Firefox clamps to
   * ~4ms/call, so wall time scales almost linearly with the NUMBER of
   * chunks (yields), not the field count. That makes the choice a direct
   * trade between responsiveness and overhead: fewer/bigger chunks are
   * strictly faster wall-clock, but cancellation and progress-bar updates
   * can only land at a chunk boundary, so bigger chunks feel less
   * responsive - checking `cancelled` only every 1000 fields means up to
   * 1000 fields could still get mutated after the user clicks Cancel, and
   * on a page whose fields carry expensive framework listeners (unlike this
   * synthetic fixture) that stretch could itself take much longer than the
   * ~4ms yield it saved. 200 keeps overhead low (~100ms is imperceptible
   * for even an 8,715-field page) while keeping cancellation/progress
   * granularity at a comfortable ~4% of the run. Shipped as 200.
   */
  const CHUNK_SIZE = 200;

  /** At most ~10 progress posts per second, so messaging itself never
   * becomes the bottleneck on a large run. */
  const PROGRESS_THROTTLE_MS = 100;

  /**
   * Per-field time budget guarding against catastrophic regex backtracking
   * (SPEC.md "Matching": "if a single field takes over 100ms to process,
   * abort that field and report it"). IMPORTANT LIMITATION, documented
   * rather than hidden: a single `RegExp.prototype.exec`/`String.prototype
   * .replace` call is a synchronous, non-interruptible operation on this
   * single JS thread - there is no way in vanilla JS (no Worker, per the
   * project's no-build-step/no-extra-infra constraint) to preempt a call
   * that is already mid-backtrack. What this guard actually does is time
   * each field's matching+replacement work and, the moment that field's
   * total time exceeds FIELD_TIME_BUDGET_MS, refuse to count it as a normal
   * success or skip - it is reported separately (`timedOut`) so the status
   * line can flag it distinctly, and its result is never added to the undo
   * snapshot, since it's exactly the kind of field an operator should
   * inspect by hand rather than trust to an automated undo. This bounds the
   * damage to a single already-slow field instead of silently treating a
   * pathological regex like any other, and it is the field's OWN pattern
   * that is slow, so the field never being touched again ends the risk.
   */
  const FIELD_TIME_BUDGET_MS = 100;

  /**
   * Undo snapshots are pushed as flat {el, value} entries during the SAME
   * replace pass (never a second DOM walk, never a per-field object graph).
   * Past this many entries the run runs without undo rather than growing an
   * unbounded array on a page with hundreds of thousands of fields; the
   * popup is told the collected field count up front (via handleCount's
   * `totalFields`) so it can warn the user BEFORE Replace all is clicked,
   * not after the run has already completed without undo support.
   */
  const DEFAULT_UNDO_SNAPSHOT_CAP = 50000;

  // Mutable so tests can exercise cap behavior without allocating 50,001
  // real DOM elements. Never touched by production code paths other than
  // the two functions below.
  let undoSnapshotCap = DEFAULT_UNDO_SNAPSHOT_CAP;

  /** Test-only hook: override the undo snapshot cap. Not part of the
   * message protocol. */
  function setUndoSnapshotCapForTesting(n) {
    undoSnapshotCap = typeof n === "number" && n > 0 ? n : DEFAULT_UNDO_SNAPSHOT_CAP;
  }

  /** Test-only hook: restore the real cap after a test overrides it. */
  function resetUndoSnapshotCapForTesting() {
    undoSnapshotCap = DEFAULT_UNDO_SNAPSHOT_CAP;
  }

  // Module-level cancellation flag. Checked at the top of every chunk inside
  // handleReplace(); set by the "cancel" message action (and directly by
  // tests) while a replace run's chunk loop is between `await` yields.
  let cancelled = false;

  /** Signal the in-flight replace run (if any) to stop after its current
   * chunk. Already-replaced fields are left in place. */
  function requestCancel() {
    cancelled = true;
  }

  // The most recently built undo snapshot: a flat array of {el, value}
  // entries (original values, captured before mutation) for the fields this
  // run actually changed. Starting a new replace run overwrites this - one
  // level of undo, per SPEC.md (the Undo action itself is wired up in
  // phase 7; phase 5 only builds and caps the snapshot).
  let lastUndoSnapshot = [];
  let lastUndoAvailable = true;

  /** Test/phase-7 accessor: length of the last replace run's undo snapshot. */
  function getUndoSnapshotLength() {
    return lastUndoSnapshot.length;
  }

  // Registered via window.__ffr.onProgress() (production would instead rely
  // solely on the browser.runtime.sendMessage broadcast below, but a plain
  // callback registry is also exposed so tests - which run in a page with no
  // `browser` global at all - can observe throttled progress messages
  // directly without a messaging layer).
  const progressListeners = [];

  /**
   * @param {(payload: {type: string, done: number, total: number, replaced: number, skipped: number}) => void} callback
   * @returns {() => void} unsubscribe function
   */
  function onProgress(callback) {
    progressListeners.push(callback);
    return () => {
      const idx = progressListeners.indexOf(callback);
      if (idx !== -1) {
        progressListeners.splice(idx, 1);
      }
    };
  }

  /**
   * Broadcast a progress message: to any registered `onProgress` listeners
   * (always - used by tests and available to any in-page consumer), and, in
   * the real extension, to any listening extension page (the popup) via
   * `browser.runtime.sendMessage`. Fire-and-forget - if no popup is open to
   * receive it, Firefox rejects with a "no receiver" error, which is
   * expected and ignored.
   * @param {{done: number, total: number, replaced: number, skipped: number}} payload
   */
  function postProgress(payload) {
    const message = {
      type: "progress",
      done: payload.done,
      total: payload.total,
      replaced: payload.replaced,
      skipped: payload.skipped,
    };
    for (let i = 0; i < progressListeners.length; i++) {
      try {
        progressListeners[i](message);
      } catch (error) {
        // A misbehaving listener must never break the replace loop itself.
        console.warn("Form Field Find & Replace: progress listener threw", error);
      }
    }
    if (
      typeof browser !== "undefined" &&
      browser.runtime &&
      typeof browser.runtime.sendMessage === "function"
    ) {
      const result = browser.runtime.sendMessage(message);
      if (result && typeof result.catch === "function") {
        result.catch(() => {
          // No popup open to receive it - expected and harmless.
        });
      }
    }
  }

  /** Yield one turn of the event loop, per SPEC.md's chunk-and-yield
   * guidance - this is what keeps the page from locking up on a large run
   * and is the only place cancellation actually gets a chance to land
   * between two fields being processed. */
  function yieldToEventLoop() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /**
   * High-resolution timestamp source used for the per-field catastrophic-
   * backtracking budget and the run's total wall-clock time. `performance`
   * is available in every context this file runs in (real page, popup,
   * Playwright's browser-based test harness).
   * @returns {number}
   */
  function now() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  }

  // ---- Replacement --------------------------------------------------------

  /**
   * Input/textarea types whose `value` setter silently rejects anything
   * that isn't a valid value for that type, leaving `value` as "". These
   * require a read-back-and-rollback pass after assignment.
   */
  const VALIDATED_INPUT_TYPES = new Set(NUMERIC_DATE_INPUT_TYPES);

  /**
   * Assign a new value to an <input> or <textarea> via the native prototype
   * setter (never a plain `el.value = x`, which React and other
   * controlled-input patterns silently ignore), then fire the same
   * input/change events a real user edit would produce.
   * @param {HTMLInputElement|HTMLTextAreaElement} el
   * @param {string} newValue
   */
  function setNativeValue(el, newValue) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    descriptor.set.call(el, newValue);
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * Replace matches of `regex` in a single input/textarea field, applying
   * the format read-back/rollback pass for the numeric/date input types.
   * Never called for a field with zero matches - the caller checks that.
   * @param {{el: Element, type: string}} field
   * @param {RegExp} regex
   * @param {string} replaceStr
   * @returns {{replaced: boolean, skippedReason: string|null}}
   */
  function replaceInputField(field, regex, replaceStr) {
    const el = field.el;
    const originalValue = el.value;
    const newValue = originalValue.replace(regex, replaceStr);

    if (newValue === originalValue) {
      // Matched, but substitution produced an identical string - nothing to
      // write, so don't fire events over nothing.
      return { replaced: false, skippedReason: null };
    }

    setNativeValue(el, newValue);

    if (VALIDATED_INPUT_TYPES.has(field.type)) {
      if (el.value !== newValue) {
        // The browser silently rejected the new value (invalid format for
        // this input type) and left `value` as "". Restore the original
        // rather than leaving the field blank, and report it as skipped.
        setNativeValue(el, originalValue);
        return { replaced: false, skippedReason: "invalid format" };
      }
    }

    return { replaced: true, skippedReason: null };
  }

  /**
   * Replace matches of `regex` inside a contenteditable host by walking its
   * text nodes and setting `nodeValue` per node - never reassigning
   * `innerHTML`, which would destroy nested markup and any editor state.
   * Dispatches a single bubbling `input` event on the host afterward if
   * anything actually changed.
   * @param {Element} el
   * @param {RegExp} regex
   * @param {string} replaceStr
   * @returns {boolean} whether any text node was modified
   */
  function replaceContentEditableTextNodes(el, regex, replaceStr) {
    const doc = el.ownerDocument || document;
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let changed = false;

    let node = walker.nextNode();
    while (node) {
      const text = node.nodeValue;
      if (text) {
        regex.lastIndex = 0;
        if (regex.test(text)) {
          const newText = text.replace(regex, replaceStr);
          if (newText !== text) {
            node.nodeValue = newText;
            changed = true;
          }
        }
      }
      node = walker.nextNode();
    }

    if (changed) {
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }

    return changed;
  }

  /**
   * Process a single field: match-count it, and if it has at least one
   * match, mutate it via the appropriate kind-specific path. Wrapped in a
   * time budget (FIELD_TIME_BUDGET_MS) - see that constant's comment for
   * exactly what "abort" can and cannot mean for a synchronous regex call.
   * The regex passed in is the ONE shared instance built once outside the
   * whole loop; `lastIndex` is reset here before each use since a `/g/`
   * regex is stateful and would otherwise skip matches on the next field
   * that reuses it.
   * @param {{el: Element, kind: string, type: string, originalValue: string}} field
   * @param {RegExp} regex
   * @param {string} effectiveReplace
   * @returns {{matched: boolean, matchCount: number, replaced: boolean, skippedReason: string|null, timedOut: boolean}}
   */
  function processField(field, regex, effectiveReplace) {
    const fieldStart = now();

    const value = field.kind === "contenteditable" ? field.el.textContent : field.el.value;
    regex.lastIndex = 0;
    const n = countMatches(regex, value || "");

    if (now() - fieldStart > FIELD_TIME_BUDGET_MS) {
      return { matched: false, matchCount: 0, replaced: false, skippedReason: null, timedOut: true };
    }

    if (n === 0) {
      // No match: never touch this field - no setter call, no events.
      return { matched: false, matchCount: 0, replaced: false, skippedReason: null, timedOut: false };
    }

    let result;
    if (field.kind === "contenteditable") {
      regex.lastIndex = 0;
      const changed = replaceContentEditableTextNodes(field.el, regex, effectiveReplace);
      result = { replaced: changed, skippedReason: null };
    } else {
      regex.lastIndex = 0;
      result = replaceInputField(field, regex, effectiveReplace);
    }

    if (now() - fieldStart > FIELD_TIME_BUDGET_MS) {
      // The mutation (if any) already ran to completion synchronously and
      // cannot be un-executed mid-flight - see FIELD_TIME_BUDGET_MS's
      // comment. Report it as timed out rather than a normal
      // replaced/skipped outcome, and keep it out of the undo snapshot.
      return { matched: true, matchCount: n, replaced: false, skippedReason: null, timedOut: true };
    }

    return { matched: true, matchCount: n, replaced: result.replaced, skippedReason: result.skippedReason, timedOut: false };
  }

  /**
   * Handle the "replace" action: collect fields once, apply field-type
   * filtering, build the SAME shared matcher used by handleCount ONCE
   * outside the loop, and mutate only the fields that actually match.
   * Fields with zero matches are never touched - no setter call, no events.
   *
   * Phase 5: processes `filtered` with a single plain indexed `for` loop
   * (no Array.prototype.map/recursion over the field list), chunked into
   * CHUNK_SIZE batches with an event-loop yield between chunks so the page
   * stays responsive and `cancelled` gets a chance to take effect; posts
   * throttled progress messages; builds the capped, flat undo snapshot in
   * the same pass; and reports timedOut fields and total wall-clock time.
   * @param {{find: string, replace: string, options: object, fieldTypes: object}} message
   * @returns {Promise<{ok: boolean, matches: number|null, fields: number|null, replaced: number, skipped: number, timedOut: number, cancelled: boolean, total: number, done: number, undoAvailable: boolean, wallMs: number, error: string|null}>}
   */
  async function handleReplace(message) {
    const startTime = now();
    const replaceStr = typeof message.replace === "string" ? message.replace : "";
    const options = message.options || {};

    if (message.find === "") {
      return {
        ok: true,
        matches: 0,
        fields: 0,
        replaced: 0,
        skipped: 0,
        timedOut: 0,
        cancelled: false,
        total: 0,
        done: 0,
        undoAvailable: true,
        wallMs: now() - startTime,
        error: null,
      };
    }

    const { regex, error } = buildMatcher(message.find, options);
    if (error) {
      return {
        ok: false,
        matches: 0,
        fields: 0,
        replaced: 0,
        skipped: 0,
        timedOut: 0,
        cancelled: false,
        total: 0,
        done: 0,
        undoAvailable: true,
        wallMs: now() - startTime,
        error,
        code: "invalid-regex",
      };
    }

    if (options.regex) {
      const validation = validateBackreferences(regex, replaceStr);
      if (!validation.ok) {
        // Distinct warning/error code path: returns BEFORE collecting any
        // fields or entering the replace loop below, so nothing is ever
        // mutated when the backreferences don't match the pattern's actual
        // groups.
        return {
          ok: false,
          matches: null,
          fields: null,
          replaced: 0,
          skipped: 0,
          timedOut: 0,
          cancelled: false,
          total: 0,
          done: 0,
          undoAvailable: true,
          wallMs: now() - startTime,
          error: validation.error,
          code: "backreference-mismatch",
        };
      }
    }

    // Plain mode: escape "$" to "$$" so the replacement is passed through to
    // String.prototype.replace as a pure literal (no backreference grammar
    // applies - plain mode never has capture groups). Regex mode: pass the
    // user's replacement straight through so the full substitution grammar
    // ($1-$99, $<name>, $&, $`, $', $$) works.
    const effectiveReplace = options.regex
      ? replaceStr
      : escapeDollarForReplace(replaceStr);

    // Collect once into a flat array - the ONE DOM walk for this whole run.
    const collected = Array.from(collectFields(document));
    const filtered = filterByTypes(collected, message.fieldTypes);
    const total = filtered.length;

    cancelled = false;

    // Up-front undo-cap decision, from the total collected field count (a
    // safe upper bound on how many fields could possibly need an undo
    // entry) - NOT a second DOM walk, just a length check on the array
    // already built above. The popup separately gets this same number via
    // handleCount's `totalFields` so it can warn the user before Replace
    // all is even clicked; this is the run's own authoritative decision.
    const undoEnabledForRun = total <= undoSnapshotCap;
    const undoSnapshot = undoEnabledForRun ? [] : null;

    let totalMatches = 0;
    let fieldsWithMatches = 0;
    let replaced = 0;
    let skipped = 0;
    let timedOut = 0;
    let done = 0;
    let lastProgressPostTime = 0;
    let wasCancelled = false;

    // Outer loop only exists to carve the work into CHUNK_SIZE batches for
    // cancellation checks and event-loop yields - the actual field
    // processing below is still one continuous, plain indexed `for` loop
    // over `filtered` (no Array.prototype.map, no recursion).
    for (let chunkStart = 0; chunkStart < total; chunkStart += CHUNK_SIZE) {
      if (cancelled) {
        wasCancelled = true;
        break;
      }

      const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, total);

      for (let i = chunkStart; i < chunkEnd; i++) {
        const field = filtered[i];
        const result = processField(field, regex, effectiveReplace);

        if (result.timedOut) {
          timedOut++;
        } else if (result.matched) {
          totalMatches += result.matchCount;
          fieldsWithMatches++;

          if (result.replaced) {
            replaced++;
            if (undoEnabledForRun && undoSnapshot.length < undoSnapshotCap) {
              undoSnapshot.push({ el: field.el, value: field.originalValue });
            }
          } else if (result.skippedReason) {
            skipped++;
          }
        }

        done++;
      }

      const nowMs = now();
      const isLastChunk = chunkEnd >= total;
      if (isLastChunk || nowMs - lastProgressPostTime >= PROGRESS_THROTTLE_MS) {
        postProgress({ done, total, replaced, skipped });
        lastProgressPostTime = nowMs;
      }

      if (!isLastChunk) {
        await yieldToEventLoop();
      }
    }

    lastUndoSnapshot = undoSnapshot || [];
    lastUndoAvailable = undoEnabledForRun;

    return {
      ok: true,
      matches: totalMatches,
      fields: fieldsWithMatches,
      replaced,
      skipped,
      timedOut,
      cancelled: wasCancelled,
      total,
      done,
      undoAvailable: undoEnabledForRun,
      wallMs: now() - startTime,
      error: null,
    };
  }

  // ---- Message handling -----------------------------------------------------

  const VALID_ACTIONS = new Set(["count", "replace", "undo", "cancel"]);

  /**
   * Validate the shape of an incoming runtime message before acting on it.
   * @param {*} message
   * @returns {boolean}
   */
  function isValidMessage(message) {
    if (!message || typeof message !== "object") {
      return false;
    }
    if (!VALID_ACTIONS.has(message.action)) {
      return false;
    }
    if (message.action === "count" || message.action === "replace") {
      if (typeof message.find !== "string") {
        return false;
      }
      if (!message.options || typeof message.options !== "object") {
        return false;
      }
      if (!message.fieldTypes || typeof message.fieldTypes !== "object") {
        return false;
      }
    }
    return true;
  }

  /**
   * Handle the "count" action: collect fields, apply field-type filtering,
   * build the shared matcher, and count matches - no mutation.
   *
   * Also reports `totalFields` - the full collected+filtered field count
   * regardless of whether any of them match - independent of `fields`
   * (which counts only fields WITH a match). This is what the popup uses to
   * warn about the undo-snapshot cap (phase 5, SPEC.md "Undo at scale")
   * BEFORE Replace all is ever clicked: a preflight "count" call happens
   * first, `totalFields` is compared against the same 50,000 cap
   * handleReplace itself enforces, and the warning (if any) is shown before
   * any field on the page is touched.
   * @param {{find: string, options: object, fieldTypes: object}} message
   * @returns {{ok: boolean, matches: number, fields: number, totalFields: number, error: string|null}}
   */
  function handleCount(message) {
    const collected = Array.from(collectFields(document));
    const filtered = filterByTypes(collected, message.fieldTypes);
    const totalFields = filtered.length;

    if (message.find === "") {
      return { ok: true, matches: 0, fields: 0, totalFields, error: null };
    }

    const { regex, error } = buildMatcher(message.find, message.options);
    if (error) {
      return { ok: false, matches: 0, fields: 0, totalFields, error };
    }

    let totalMatches = 0;
    let fieldsWithMatches = 0;
    for (let i = 0; i < filtered.length; i++) {
      const value = filtered[i].originalValue || "";
      const n = countMatches(regex, value);
      if (n > 0) {
        totalMatches += n;
        fieldsWithMatches++;
      }
    }

    return { ok: true, matches: totalMatches, fields: fieldsWithMatches, totalFields, error: null };
  }

  // Guard the real listener registration behind an extension-API check so
  // this file can also be injected standalone into a plain fixture page by
  // the test harness without throwing.
  //
  // The second condition matters: popup.html loads this same file to reuse the
  // shared matcher for its live preview, and inside the popup browser.runtime
  // IS defined. Without the extension-page check the popup would register a
  // handler that answers count/replace against the POPUP's own DOM. It is
  // mostly inert today because the popup addresses the tab via
  // tabs.sendMessage, but a runtime.sendMessage broadcast would reach it and
  // get an answer computed from the wrong document. Content scripts run on the
  // page's own URL, so an extension-scheme location means we are NOT a content
  // script and must not register.
  // Extracted as a pure predicate so it is directly testable. Every Playwright
  // fixture loads over file:// with no `browser` global, so an inline condition
  // here would never be exercised by any test.
  function shouldRegisterMessageListener(protocol, browserApi) {
    const isExtensionPage =
      protocol === "moz-extension:" || protocol === "chrome-extension:";
    return (
      !isExtensionPage &&
      !!browserApi &&
      !!browserApi.runtime &&
      !!browserApi.runtime.onMessage &&
      typeof browserApi.runtime.onMessage.addListener === "function"
    );
  }

  if (
    shouldRegisterMessageListener(
      typeof location !== "undefined" ? location.protocol : "",
      typeof browser !== "undefined" ? browser : null
    )
  ) {
    browser.runtime.onMessage.addListener((message, sender) => {
      // Ignore anything not sent by this same extension (e.g. a page script
      // that somehow triggered a runtime message-like event).
      if (
        sender &&
        typeof browser.runtime.id === "string" &&
        typeof sender.id === "string" &&
        sender.id !== browser.runtime.id
      ) {
        return undefined;
      }

      if (!isValidMessage(message)) {
        return undefined;
      }

      if (message.action === "count") {
        return Promise.resolve(handleCount(message));
      }

      if (message.action === "replace") {
        return handleReplace(message);
      }

      if (message.action === "cancel") {
        requestCancel();
        return Promise.resolve({ ok: true });
      }

      // undo is implemented in phase 7.
      return undefined;
    });
  }

  // Expose the pure, side-effect-free functions for direct test access.
  if (typeof window !== "undefined") {
    window.__ffr = {
      collectFields,
      buildMatcher,
      countMatches,
      filterByTypes,
      // Also exposed for white-box assertions in tests, not part of the
      // public message-protocol surface.
      describeField,
      resolveInputType,
      isAlwaysSkippedElement,
      isRenderedVisible,
      handleCount,
      isValidMessage,
      // Phase 3 additions.
      setNativeValue,
      replaceInputField,
      replaceContentEditableTextNodes,
      handleReplace,
      // Phase 4 additions: backreference validation and the live preview.
      analyzeGroups,
      scanReplacementTokens,
      validateBackreferences,
      escapeDollarForReplace,
      computeFirstMatchPreview,
      // Registration guard, exposed so the extension-page case is testable
      // without an actual moz-extension:// document.
      shouldRegisterMessageListener,
      // Phase 5 additions: chunking/progress/cancel/scale constants and
      // hooks, exposed for direct test access (no `browser` global exists
      // in the Playwright fixture pages this file is injected into).
      CHUNK_SIZE,
      PROGRESS_THROTTLE_MS,
      FIELD_TIME_BUDGET_MS,
      DEFAULT_UNDO_SNAPSHOT_CAP,
      onProgress,
      requestCancel,
      getUndoSnapshotLength,
      setUndoSnapshotCapForTesting,
      resetUndoSnapshotCapForTesting,
      // Exposed so the catastrophic-backtracking guard can be exercised
      // deterministically with a fake, controllably-slow "regex" object
      // instead of a genuinely pathological pattern (whose real timing is
      // inherently machine-dependent and unsuitable for a CI test).
      processField,
    };
  }
})();
