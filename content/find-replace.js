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
 * no events. Chunking/progress/cancel (phase 5), regex backreferences and
 * the match preview (phase 4), shadow DOM/iframe recursion (phase 6), and
 * undo (phase 7) are explicitly out of scope here; replace is a single
 * straightforward pass for now.
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
   * Handle the "replace" action: collect fields, apply field-type
   * filtering, build the SAME shared matcher used by handleCount, and
   * mutate only the fields that actually match. Fields with zero matches
   * are never touched - no setter call, no events.
   * @param {{find: string, replace: string, options: object, fieldTypes: object}} message
   * @returns {{ok: boolean, matches: number, fields: number, replaced: number, skipped: number, error: string|null}}
   */
  function handleReplace(message) {
    const replaceStr = typeof message.replace === "string" ? message.replace : "";

    if (message.find === "") {
      return { ok: true, matches: 0, fields: 0, replaced: 0, skipped: 0, error: null };
    }

    const { regex, error } = buildMatcher(message.find, message.options);
    if (error) {
      return { ok: false, matches: 0, fields: 0, replaced: 0, skipped: 0, error };
    }

    const collected = Array.from(collectFields(document));
    const filtered = filterByTypes(collected, message.fieldTypes);

    let totalMatches = 0;
    let fieldsWithMatches = 0;
    let replaced = 0;
    let skipped = 0;

    for (let i = 0; i < filtered.length; i++) {
      const field = filtered[i];
      const value = field.kind === "contenteditable" ? field.el.textContent : field.el.value;
      const n = countMatches(regex, value || "");
      if (n === 0) {
        // No match: never touch this field - no setter call, no events.
        continue;
      }

      totalMatches += n;
      fieldsWithMatches++;

      if (field.kind === "contenteditable") {
        regex.lastIndex = 0;
        const changed = replaceContentEditableTextNodes(field.el, regex, replaceStr);
        if (changed) {
          replaced++;
        }
      } else {
        regex.lastIndex = 0;
        const result = replaceInputField(field, regex, replaceStr);
        if (result.replaced) {
          replaced++;
        } else if (result.skippedReason) {
          skipped++;
        }
      }
    }

    return {
      ok: true,
      matches: totalMatches,
      fields: fieldsWithMatches,
      replaced,
      skipped,
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
   * @param {{find: string, options: object, fieldTypes: object}} message
   * @returns {{ok: boolean, matches: number, fields: number, error: string|null}}
   */
  function handleCount(message) {
    if (message.find === "") {
      return { ok: true, matches: 0, fields: 0, error: null };
    }

    const { regex, error } = buildMatcher(message.find, message.options);
    if (error) {
      return { ok: false, matches: 0, fields: 0, error };
    }

    const collected = Array.from(collectFields(document));
    const filtered = filterByTypes(collected, message.fieldTypes);

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

    return { ok: true, matches: totalMatches, fields: fieldsWithMatches, error: null };
  }

  // Guard the real listener registration behind an extension-API check so
  // this file can also be injected standalone into a plain fixture page by
  // the test harness without throwing.
  if (
    typeof browser !== "undefined" &&
    browser.runtime &&
    browser.runtime.onMessage &&
    typeof browser.runtime.onMessage.addListener === "function"
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
        return Promise.resolve(handleReplace(message));
      }

      // undo/cancel are implemented in later phases.
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
    };
  }
})();
