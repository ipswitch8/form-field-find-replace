/**
 * Form Field Find & Replace - popup logic.
 *
 * Phase 1 scope: UI shell, persistence to storage.local, keyboard handling,
 * and button wiring.
 *
 * Phase 4 scope: the live first-match preview (updatePreview/
 * schedulePreviewUpdate below). It calls window.__ffr.computeFirstMatchPreview,
 * which content/find-replace.js exposes - popup.html loads that file
 * directly ahead of this one purely so this script can reuse its exact
 * buildMatcher()-based matching logic without a round trip to the page and
 * without a second, duplicated matcher implementation. Backreference
 * validation and the group-mismatch warning live in that same shared file
 * and surface here via the normal response.error path in handleReplaceAll.
 *
 * Phase 5 scope: renders the chunked replace run's progress (a
 * `browser.runtime.onMessage` listener for `{type:"progress",...}`
 * broadcasts from the content script - see registerProgressListener
 * below), and runs an undo-cap preflight BEFORE a replace run starts: it
 * sends a lightweight "count" message first, reads back `totalFields`
 * (content/find-replace.js's handleCount reports the full collected field
 * count regardless of match, independent of the match-only `fields`
 * count), and if that exceeds the undo-snapshot cap it shows a dedicated,
 * automation-friendly warning (#undo-warning) BEFORE the mutating
 * "replace" message is ever sent - i.e. before any field on the page is
 * touched, not merely before the Undo button is pressed afterward.
 *
 * Vanilla JS only. No frameworks, no build step, no eval/new Function.
 * No network calls, no telemetry, no analytics.
 */

"use strict";

const STORAGE_KEY = "formFieldFindReplace";

// ---- Remembered find/replace history -----------------------------------
//
// The full design decision, and the reasoning behind each value here, is in
// README.md under "Remembered find/replace history". The short version, so a
// reader of this file is not forced to go looking:
//
//   - History is ONE list of PAIRED entries. Each entry carries the find
//     value, the replace value, all four option flags AND the entire
//     fieldTypes map, captured together. It is deliberately not two
//     independent find-only/replace-only lists: a remembered regex source
//     recalled without its `regex` flag would silently be searched for
//     literally and report no matches.
//   - Its storage key is SEPARATE from STORAGE_KEY above. STORAGE_KEY holds
//     only the last-typed state; this holds the remembered list. Two keys so
//     the two can be read and cleared independently.
//   - Bounded and newest-first. Index 0 is the most recent; re-recording an
//     entry identical in every field moves it to the front instead of
//     duplicating it; the tail is dropped past the bound. Deliberately stated
//     that precisely rather than as "most-recently-used": a gate pointed out
//     that with recording as the only promotion trigger, this is
//     indistinguishable from FIFO-with-move-to-front-on-re-record, and calling
//     it MRU claimed a distinction no test could see. Selection-driven
//     promotion - which is what would make the ordering genuinely
//     usage-based rather than record-based - arrives with the dropdown, NOT
//     here. Do not read this comment as describing something that already
//     happens on select; at this point in the file's history there is no
//     select path at all.
//     The bound is load-bearing, not decoration - a remembered value is
//     arbitrary text the user may have copied off a page, so it can be long,
//     and an unbounded list would grow with every run for the life of the
//     profile.
//   - Recorded ONLY from handleCount/handleReplaceAll, and only with a
//     non-empty find. Recording on `input` would fill the list with prefixes
//     of whatever the user was still typing and evict the entries they
//     actually wanted within a few seconds.
//
// storage.local ONLY, never storage.sync - same as the rest of this
// extension. test/history-dropdown.spec.js asserts that mechanically by
// scanning this file's own source, because .claude-security.json's
// dangerous_code_scan covers eval/innerHTML/Function( and would not catch a
// sync-area call.
const HISTORY_KEY = "formFieldFindReplaceHistory";
const MAX_HISTORY_ENTRIES = 20;

const DEFAULT_STATE = {
  find: "",
  replace: "",
  options: {
    matchCase: false,
    wholeWord: false,
    regex: false,
    includeIframes: false,
  },
  fieldTypes: {
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
  },
};

// ---- Element references -----------------------------------------------

const els = {
  form: document.getElementById("find-replace-form"),
  find: document.getElementById("find-input"),
  replace: document.getElementById("replace-input"),
  matchCase: document.getElementById("match-case-checkbox"),
  wholeWord: document.getElementById("whole-word-checkbox"),
  regex: document.getElementById("regex-checkbox"),
  includeIframes: document.getElementById("include-iframes-checkbox"),
  fieldTypesToggle: document.getElementById("field-types-toggle"),
  fieldTypesContent: document.getElementById("field-types-content"),
  selectAll: document.getElementById("field-types-select-all"),
  selectNone: document.getElementById("field-types-select-none"),
  countBtn: document.getElementById("count-btn"),
  replaceAllBtn: document.getElementById("replace-all-btn"),
  undoBtn: document.getElementById("undo-btn"),
  cancelBtn: document.getElementById("cancel-btn"),
  statusLine: document.getElementById("status-line"),
  progressBar: document.getElementById("progress-bar"),
  fieldCounter: document.getElementById("field-counter"),
  matchPreview: document.getElementById("match-preview"),
  undoWarning: document.getElementById("undo-warning"),
};

// Must match content/find-replace.js's DEFAULT_UNDO_SNAPSHOT_CAP. Read it
// directly off window.__ffr (popup.html loads content/find-replace.js
// ahead of this file for the live-preview matcher reuse, so the same
// constant is available here too) rather than hardcoding a second copy
// that could silently drift out of sync.
const UNDO_SNAPSHOT_CAP =
  (window.__ffr && window.__ffr.DEFAULT_UNDO_SNAPSHOT_CAP) || 50000;

const fieldTypeCheckboxes = Array.from(
  document.querySelectorAll(".field-type-checkbox")
);

// ---- Run state (not persisted) -----------------------------------------

let runInFlight = false;
let hasUndoableChange = false;

// ---- Live match preview (phase 4) --------------------------------------

// The popup cannot reach the page's actual field values without a round
// trip through the content script, and doing that on every keystroke would
// be neither simple nor responsive. Instead the preview runs the user's
// find/replace strings against this fixed, representative sample of common
// field content (a name, an email, a phone number, a date, a dollar
// amount, an order number) - enough surface for $1-$99, $<name>, $&, $`,
// $', and $$ to all have something realistic to land on. Computing against
// this fixed string can never mutate anything on the page.
const PREVIEW_SAMPLE_TEXT =
  "Contact Jane Doe at jane.doe@example.com or 555-123-4567. " +
  "Order #12345 for $5.00 was placed on 2026-03-14.";

const PREVIEW_DEBOUNCE_MS = 200;
let previewDebounceTimer = null;

/**
 * Recompute and render the live first-match preview from the current
 * find/replace/option state, using window.__ffr.computeFirstMatchPreview -
 * the SAME shared matcher (buildMatcher) the count/replace paths use, never
 * a third matching implementation. Handles no-match, invalid-regex, empty
 * find, and backreference-mismatch cases without throwing.
 */
function updatePreview() {
  const state = collectState();

  if (!els.matchPreview) {
    return;
  }

  if (
    !window.__ffr ||
    typeof window.__ffr.computeFirstMatchPreview !== "function"
  ) {
    // content/find-replace.js failed to load for some reason - fail quietly,
    // the preview is a convenience, not a required control path.
    setPreviewText("");
    return;
  }

  if (state.find === "") {
    setPreviewText("");
    return;
  }

  const result = window.__ffr.computeFirstMatchPreview(
    PREVIEW_SAMPLE_TEXT,
    state.find,
    state.replace,
    state.options
  );

  if (!result.ok) {
    setPreviewText(result.error || "Invalid pattern.", { error: true });
    return;
  }

  if (!result.hasMatch) {
    setPreviewText("No match in sample text.");
    return;
  }

  setPreviewText(result.preview);
}

/**
 * Write the preview box's text.
 *
 * The box has a FIXED height (popup.css explains why: a growing preview shifted
 * every control below it a fifth of a second after typing stopped, so a click
 * aimed at a checkbox could land somewhere else). Fixed height means long
 * content is clipped, so the full string also goes on `title` - otherwise a
 * truncated regex error would be actively misleading rather than merely terse.
 * @param {string} text
 * @param {{error?: boolean}} [opts]
 */
function setPreviewText(text, opts = {}) {
  els.matchPreview.textContent = text;
  els.matchPreview.classList.toggle("status-error", Boolean(opts.error));
  if (text) {
    els.matchPreview.setAttribute("title", text);
  } else {
    els.matchPreview.removeAttribute("title");
  }
}

/**
 * Debounce preview recomputation so it happens after the user pauses
 * typing rather than on every keystroke, keeping the popup responsive.
 */
function schedulePreviewUpdate() {
  if (previewDebounceTimer !== null) {
    clearTimeout(previewDebounceTimer);
  }
  previewDebounceTimer = setTimeout(() => {
    previewDebounceTimer = null;
    updatePreview();
  }, PREVIEW_DEBOUNCE_MS);
}

// ---- Persistence ---------------------------------------------------------

/**
 * Read the current form state into a plain object matching DEFAULT_STATE's
 * shape, suitable for storage.local.set.
 */
function collectState() {
  const fieldTypes = {};
  for (const checkbox of fieldTypeCheckboxes) {
    fieldTypes[checkbox.dataset.fieldType] = checkbox.checked;
  }

  return {
    find: els.find.value,
    replace: els.replace.value,
    options: {
      matchCase: els.matchCase.checked,
      wholeWord: els.wholeWord.checked,
      regex: els.regex.checked,
      includeIframes: els.includeIframes.checked,
    },
    fieldTypes,
  };
}

/**
 * Persist the current form state to storage.local. Called on every
 * relevant change event.
 */
function persistState() {
  const state = collectState();
  browser.storage.local.set({ [STORAGE_KEY]: state }).catch((error) => {
    console.warn("Form Field Find & Replace: failed to persist state", error);
  });
}

/**
 * Apply a saved (or default) state object to the form controls.
 * @param {typeof DEFAULT_STATE} state
 */
function applyState(state) {
  els.find.value = state.find ?? DEFAULT_STATE.find;
  els.replace.value = state.replace ?? DEFAULT_STATE.replace;

  const options = { ...DEFAULT_STATE.options, ...(state.options || {}) };
  els.matchCase.checked = Boolean(options.matchCase);
  els.wholeWord.checked = Boolean(options.wholeWord);
  els.regex.checked = Boolean(options.regex);
  els.includeIframes.checked = Boolean(options.includeIframes);

  const fieldTypes = { ...DEFAULT_STATE.fieldTypes, ...(state.fieldTypes || {}) };
  for (const checkbox of fieldTypeCheckboxes) {
    const key = checkbox.dataset.fieldType;
    checkbox.checked = Boolean(fieldTypes[key]);
  }
}

/**
 * Load persisted state (if any) from storage.local and apply it, falling
 * back to DEFAULT_STATE for anything missing.
 */
async function restoreState() {
  try {
    const result = await browser.storage.local.get(STORAGE_KEY);
    const saved = result && result[STORAGE_KEY];
    applyState(saved ? { ...DEFAULT_STATE, ...saved } : DEFAULT_STATE);
  } catch (error) {
    console.warn("Form Field Find & Replace: failed to restore state", error);
    applyState(DEFAULT_STATE);
  }
}

// ---- Remembered history: load, record, persist -------------------------

/**
 * The in-memory copy of the remembered list, newest first. Loaded once during
 * init() and then treated as authoritative for the lifetime of this popup
 * document.
 *
 * Why a cache and not a read-modify-write against storage on every record:
 * two records landing close together would each read the same pre-existing
 * array and the second `set` would clobber the first's entry. Holding the
 * list here and only ever writing the whole pruned array back makes that
 * impossible. The popup document is the only writer while it is open.
 */
let historyEntries = [];

/**
 * Serialises history writes so two records in quick succession cannot
 * interleave their storage.local.set calls out of order.
 *
 * This is load-bearing, not belt-and-braces. `set` resolves asynchronously,
 * and each call carries the snapshot it was given at call time. Issue two
 * unserialised writes and the SLOWER one lands last regardless of which was
 * newer - so a slow one-entry write applied on top of a fast two-entry write
 * silently loses the newer remembered search.
 *
 * Pinned by "a slow earlier history write cannot clobber a newer one" in
 * test/history-dropdown.spec.js, which delays the first `set` by 600ms and
 * asserts both the final contents AND the order the writes actually landed.
 * A gate previously deleted this chain and found every test still green; that
 * test exists so the same deletion now fails.
 */
let historyWriteChain = Promise.resolve();

/**
 * Coerce an arbitrary stored value into a well-formed history entry, or
 * return null if it cannot be one.
 *
 * Everything that comes back out of storage.local is treated as untrusted
 * shape - not untrusted *content* (it is the user's own text), but untrusted
 * structure. A hand-edited or partially-written value must not be able to
 * throw during rendering, so unknown keys are dropped and missing ones take
 * their default. The result contains strings and booleans only: no functions,
 * no DOM nodes, nothing that would fail structured-clone on the way back in.
 * @param {any} raw
 */
function normalizeHistoryEntry(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  if (typeof raw.find !== "string" || raw.find === "") {
    return null;
  }

  const rawOptions = raw.options && typeof raw.options === "object" ? raw.options : {};
  const rawFieldTypes =
    raw.fieldTypes && typeof raw.fieldTypes === "object" ? raw.fieldTypes : {};

  const options = {};
  for (const key of Object.keys(DEFAULT_STATE.options)) {
    options[key] = Boolean(
      Object.prototype.hasOwnProperty.call(rawOptions, key)
        ? rawOptions[key]
        : DEFAULT_STATE.options[key]
    );
  }

  const fieldTypes = {};
  for (const key of Object.keys(DEFAULT_STATE.fieldTypes)) {
    fieldTypes[key] = Boolean(
      Object.prototype.hasOwnProperty.call(rawFieldTypes, key)
        ? rawFieldTypes[key]
        : DEFAULT_STATE.fieldTypes[key]
    );
  }

  return {
    find: raw.find,
    replace: typeof raw.replace === "string" ? raw.replace : "",
    options,
    fieldTypes,
  };
}

/**
 * True when two entries are identical in every remembered field. This is what
 * makes re-running the same search a move-to-front rather than a duplicate -
 * and, just as importantly, what makes the SAME find/replace strings with
 * DIFFERENT options two distinct entries, since the options are the thing the
 * user would otherwise have to remember themselves.
 * @param {ReturnType<typeof normalizeHistoryEntry>} a
 * @param {ReturnType<typeof normalizeHistoryEntry>} b
 */
function sameHistoryEntry(a, b) {
  if (!a || !b) {
    return false;
  }
  if (a.find !== b.find || a.replace !== b.replace) {
    return false;
  }
  for (const key of Object.keys(DEFAULT_STATE.options)) {
    if (Boolean(a.options[key]) !== Boolean(b.options[key])) {
      return false;
    }
  }
  for (const key of Object.keys(DEFAULT_STATE.fieldTypes)) {
    if (Boolean(a.fieldTypes[key]) !== Boolean(b.fieldTypes[key])) {
      return false;
    }
  }
  return true;
}

/**
 * Read the remembered list out of storage.local. Never throws: a missing key,
 * a non-array value, or a storage failure all yield an empty list, because a
 * broken history must not stop the popup from working.
 * @returns {Promise<Array<ReturnType<typeof normalizeHistoryEntry>>>}
 */
async function loadHistory() {
  try {
    const result = await browser.storage.local.get(HISTORY_KEY);
    const raw = result && result[HISTORY_KEY];
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map(normalizeHistoryEntry)
      .filter(Boolean)
      .slice(0, MAX_HISTORY_ENTRIES);
  } catch (error) {
    console.warn("Form Field Find & Replace: failed to load history", error);
    return [];
  }
}

/** Write the current in-memory list back to storage.local. */
function persistHistory() {
  const snapshot = historyEntries;
  historyWriteChain = historyWriteChain
    .then(() => browser.storage.local.set({ [HISTORY_KEY]: snapshot }))
    .catch((error) => {
      console.warn("Form Field Find & Replace: failed to persist history", error);
    });
  return historyWriteChain;
}

/**
 * Record the current form state as the newest history entry.
 *
 * Called from handleCount and handleReplaceAll ONLY - that is the documented
 * save trigger. An empty find is never recorded: there is nothing to
 * remember, and an entry with an empty find could never be usefully recalled.
 */
function recordHistoryEntry() {
  const fresh = normalizeHistoryEntry(collectState());
  if (!fresh) {
    return;
  }

  // Move-to-front semantics: drop any entry identical in every field, then
  // put this one at the head. Filtering rather than searching-and-splicing
  // keeps this correct even if a duplicate somehow appeared twice.
  const rest = historyEntries.filter((existing) => !sameHistoryEntry(existing, fresh));
  historyEntries = [fresh, ...rest].slice(0, MAX_HISTORY_ENTRIES);

  persistHistory();
}

/**
 * Remove every remembered entry, in memory and in storage.local.
 *
 * Why this exists at all: a gate (security-audit, phase 2) pointed out that
 * this feature did not introduce a new data class - the popup's own typed text
 * already went to storage.local - but it did take retention from one entry to
 * twenty, with no way for the user to undo that. Someone who pastes a password
 * or a customer record into the Find box should be able to get rid of it
 * without clearing their whole browser profile. So: one button, both
 * dropdowns, no confirmation prompt (there is nothing destructive about
 * forgetting a search, and a prompt would make people click through it).
 */
function clearHistory() {
  historyEntries = [];
  persistHistory();
}

// ---- History dropdown (the combobox/listbox UI) -------------------------
//
// ARIA combobox/listbox, built entirely with createElement/textContent. NOT
// `innerHTML`: .claude-security.json's dangerous_code_scan fails the build on
// it, and a remembered value is exactly the sort of arbitrary page-copied text
// that makes that rule matter rather than being ceremonial. A test feeds an
// <img onerror> string in as a remembered find value and asserts zero <img>
// elements come out.
//
// Both inputs show the SAME shared list; they differ only in which of the two
// values each row leads with.

/** The two comboboxes, keyed by the field they belong to. */
const historyUi = {
  find: {
    input: els.find,
    overlay: document.getElementById("find-history-overlay"),
    listbox: document.getElementById("find-history-listbox"),
    clearBtn: document.getElementById("find-history-clear"),
    optionIdPrefix: "find-history-option-",
    /** Which value this dropdown leads with. */
    primary: "find",
  },
  replace: {
    input: els.replace,
    overlay: document.getElementById("replace-history-overlay"),
    listbox: document.getElementById("replace-history-listbox"),
    clearBtn: document.getElementById("replace-history-clear"),
    optionIdPrefix: "replace-history-option-",
    primary: "replace",
  },
};

/** Which dropdown is open ("find" | "replace" | null). */
let openHistoryKey = null;
/** Index of the active option in the open dropdown, or -1 for none. */
let activeHistoryIndex = -1;
/**
 * Set while a selection is moving focus back to the input, so the focus
 * handler does not immediately reopen the dropdown the selection just closed.
 */
let suppressHistoryOpen = false;
/**
 * The field whose dropdown was just opened by a `focus` event, so the `click`
 * that produced that focus does not immediately toggle it closed again.
 */
let openedByFocusKey = null;

/**
 * A short, human-readable summary of the option flags an entry carries, or ""
 * when it carries none. This is the part that makes a remembered entry
 * trustworthy: the same find string with `regex` on and off are two different
 * searches, and the row has to show which one you are about to restore.
 * @param {ReturnType<typeof normalizeHistoryEntry>} item
 */
function historyFlagSummary(item) {
  const parts = [];
  if (item.options.regex) parts.push("regex");
  if (item.options.matchCase) parts.push("case");
  if (item.options.wholeWord) parts.push("word");
  if (item.options.includeIframes) parts.push("iframes");
  return parts.join(" · ");
}

/**
 * Build the option rows for one dropdown from the current historyEntries.
 * Rebuilt on every open rather than kept in sync incrementally - the list is
 * bounded at 20, so there is nothing to gain from being clever, and a stale
 * row would show the user a search they can no longer select.
 *
 * Pinned by "reopening the dropdown shows entries recorded since it was last
 * open" and "a cleared-then-repopulated list renders the new rows, not the old
 * ones" in test/history-dropdown.spec.js. Those exist because a gate cached the
 * render on reopen and found all 33 tests still passing: every other
 * post-mutation assertion read storage.local rather than the rendered rows, so
 * nothing would have noticed the list going stale on screen.
 * @param {typeof historyUi.find} ui
 */
function renderHistoryOptions(ui) {
  // Clear existing rows without touching innerHTML.
  while (ui.listbox.firstChild) {
    ui.listbox.removeChild(ui.listbox.firstChild);
  }

  historyEntries.forEach((item, index) => {
    const leading = ui.primary === "find" ? item.find : item.replace;
    const trailing = ui.primary === "find" ? item.replace : item.find;

    const row = document.createElement("li");
    row.id = ui.optionIdPrefix + index;
    row.dataset.testid = ui.optionIdPrefix + index;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");
    row.dataset.historyIndex = String(index);
    row.className = "history-option";

    const primaryEl = document.createElement("span");
    primaryEl.className = "history-option-primary";
    // textContent, so an angle bracket in a remembered value stays an angle
    // bracket the user can read rather than becoming an element.
    primaryEl.textContent = leading === "" ? "(empty)" : leading;
    row.appendChild(primaryEl);

    const arrow = document.createElement("span");
    arrow.className = "history-option-arrow";
    arrow.textContent = ui.primary === "find" ? " → " : " ← ";
    row.appendChild(arrow);

    const secondaryEl = document.createElement("span");
    secondaryEl.className = "history-option-secondary";
    secondaryEl.textContent = trailing === "" ? "(empty)" : trailing;
    row.appendChild(secondaryEl);

    const flags = historyFlagSummary(item);
    if (flags) {
      const flagsEl = document.createElement("span");
      flagsEl.className = "history-option-flags";
      flagsEl.textContent = flags;
      row.appendChild(flagsEl);
    }

    ui.listbox.appendChild(row);
  });
}

/** Reflect activeHistoryIndex into the DOM (aria-activedescendant + class). */
function renderActiveHistoryOption() {
  if (!openHistoryKey) {
    return;
  }
  const ui = historyUi[openHistoryKey];
  const rows = Array.from(ui.listbox.children);

  rows.forEach((row, index) => {
    const isActive = index === activeHistoryIndex;
    row.classList.toggle("is-active", isActive);
    row.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  if (activeHistoryIndex >= 0 && rows[activeHistoryIndex]) {
    ui.input.setAttribute("aria-activedescendant", rows[activeHistoryIndex].id);
    // Keep the active row in view when the list is longer than the overlay.
    if (typeof rows[activeHistoryIndex].scrollIntoView === "function") {
      rows[activeHistoryIndex].scrollIntoView({ block: "nearest" });
    }
  } else {
    ui.input.removeAttribute("aria-activedescendant");
  }
}

/**
 * Open one dropdown. A no-op when there is nothing remembered: an empty
 * listbox announced to a screen reader as a listbox would be worse than no
 * listbox, and there is nothing to click.
 * @param {"find"|"replace"} key
 */
function openHistoryDropdown(key) {
  if (suppressHistoryOpen) {
    return;
  }
  if (historyEntries.length === 0) {
    return;
  }
  if (openHistoryKey && openHistoryKey !== key) {
    closeHistoryDropdown();
  }

  const ui = historyUi[key];
  renderHistoryOptions(ui);
  ui.overlay.hidden = false;
  ui.input.setAttribute("aria-expanded", "true");
  openHistoryKey = key;
  activeHistoryIndex = -1;
  renderActiveHistoryOption();
}

/** Close whichever dropdown is open. Safe to call when none is. */
function closeHistoryDropdown() {
  if (!openHistoryKey) {
    return;
  }
  const ui = historyUi[openHistoryKey];
  ui.overlay.hidden = true;
  ui.input.setAttribute("aria-expanded", "false");
  ui.input.removeAttribute("aria-activedescendant");
  openHistoryKey = null;
  activeHistoryIndex = -1;
}

/**
 * Move the active option by `delta`, wrapping at both ends. Wrapping is the
 * behaviour a keyboard user expects from a short list, and ArrowUp from the
 * closed/none state landing on the LAST entry is how you reach the oldest
 * remembered search in one keystroke.
 * @param {number} delta
 */
function moveActiveHistoryOption(delta) {
  if (!openHistoryKey) {
    return;
  }
  const count = historyEntries.length;
  if (count === 0) {
    return;
  }
  if (activeHistoryIndex < 0) {
    activeHistoryIndex = delta > 0 ? 0 : count - 1;
  } else {
    activeHistoryIndex = (activeHistoryIndex + delta + count) % count;
  }
  renderActiveHistoryOption();
}

/**
 * Restore a remembered entry into the form, in full.
 *
 * "In full" is the whole point: find, replace, all four option flags and every
 * field-type checkbox. Restoring the strings without the flags would hand the
 * user a regex source with regex switched off, which searches for it literally
 * and reports no matches - a silent wrong answer rather than an error.
 *
 * Reuses applyState() rather than assigning the controls a second time here,
 * so there is exactly one place in this file that knows how to put a state
 * object into the form.
 * @param {number} index
 */
function selectHistoryEntry(index) {
  const item = historyEntries[index];
  if (!item) {
    return;
  }

  applyState({
    find: item.find,
    replace: item.replace,
    options: item.options,
    fieldTypes: item.fieldTypes,
  });

  // Selecting an entry is a use of it, so it becomes the most recent. This is
  // what makes the ordering genuinely usage-based rather than merely
  // record-based - see README.md's note on why the docs say "newest-first".
  historyEntries = [item, ...historyEntries.filter((e) => e !== item)];
  persistHistory();

  // The restored values are now the current state, so persist them as such.
  persistState();
  updatePreview();

  const key = openHistoryKey;
  closeHistoryDropdown();

  // Put focus back where the user was, without the focus handler treating that
  // as a fresh request to open the list again.
  if (key) {
    suppressHistoryOpen = true;
    historyUi[key].input.focus();
    suppressHistoryOpen = false;
  }
}

/**
 * Keydown handling for a combobox input. Returns true when the event was
 * consumed by the dropdown, so the caller knows not to let it fall through.
 * @param {"find"|"replace"} key
 * @param {KeyboardEvent} event
 */
function handleHistoryKeydown(key, event) {
  const isOpen = openHistoryKey === key;

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!isOpen) {
      openHistoryDropdown(key);
      // Opening on ArrowDown should also land on the first entry, otherwise
      // the keystroke appears to do nothing on a list the user cannot see yet.
      if (openHistoryKey === key) {
        moveActiveHistoryOption(event.key === "ArrowDown" ? 1 : -1);
      }
    } else {
      moveActiveHistoryOption(event.key === "ArrowDown" ? 1 : -1);
    }
    event.preventDefault();
    return true;
  }

  if (!isOpen) {
    return false;
  }

  if (event.key === "Enter") {
    if (activeHistoryIndex >= 0) {
      selectHistoryEntry(activeHistoryIndex);
      event.preventDefault();
      return true;
    }
    // Open but nothing chosen: close and let Enter mean what it normally
    // means (run Replace all) rather than swallowing it.
    closeHistoryDropdown();
    return false;
  }

  if (event.key === "Escape") {
    // The FIRST Escape belongs to the dropdown. The document-level handler
    // would otherwise cancel a run or close the popup outright, throwing away
    // everything the user had typed just because they dismissed a list.
    // stopPropagation is what keeps it from getting there.
    closeHistoryDropdown();
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  if (event.key === "Tab") {
    closeHistoryDropdown();
    return false;
  }

  return false;
}

// ---- Status / progress helpers -----------------------------------------

/**
 * @param {string} message
 * @param {{error?: boolean}} [opts]
 */
function setStatus(message, opts = {}) {
  els.statusLine.textContent = message;
  els.statusLine.classList.toggle("status-error", Boolean(opts.error));
}

/**
 * @param {number} done
 * @param {number} total
 */
function setProgress(done, total) {
  const max = total > 0 ? total : 0;
  els.progressBar.max = max || 1;
  els.progressBar.value = done;
  els.progressBar.setAttribute("aria-valuemax", String(max));
  els.progressBar.setAttribute("aria-valuenow", String(done));
  els.fieldCounter.textContent = `field ${done} of ${total}`;
}

/**
 * Update button enabled/disabled state to reflect whether a run is
 * currently in flight and whether an undoable change exists.
 */
function updateButtonStates() {
  els.cancelBtn.disabled = !runInFlight;
  els.undoBtn.disabled = !hasUndoableChange || runInFlight;
  els.countBtn.disabled = runInFlight;
  els.replaceAllBtn.disabled = runInFlight;
}

/**
 * Show or hide the dedicated undo-cap warning element. Kept distinct from
 * the general status line so it's independently testable/automatable and
 * so it doesn't get silently overwritten by the next "Replacing..."/
 * "Counting..." status update.
 * @param {string|null} message
 */
function setUndoWarning(message) {
  if (!els.undoWarning) {
    return;
  }
  if (!message) {
    els.undoWarning.textContent = "";
    els.undoWarning.hidden = true;
    return;
  }
  els.undoWarning.textContent = message;
  els.undoWarning.hidden = false;
}

/**
 * Listen for `{type: "progress", done, total, replaced, skipped}` messages
 * broadcast by the content script's chunked replace loop (phase 5) and
 * render them into the existing progress bar / field counter. Registered
 * once at init; harmless if no run is ever in flight (nothing is ever sent
 * in that case).
 */
function registerProgressListener() {
  if (
    typeof browser === "undefined" ||
    !browser.runtime ||
    !browser.runtime.onMessage ||
    typeof browser.runtime.onMessage.addListener !== "function"
  ) {
    return;
  }
  browser.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "progress") {
      return undefined;
    }
    setProgress(message.done ?? 0, message.total ?? 0);
    return undefined;
  });
}

// ---- Messaging -----------------------------------------------------------

// LEADING SLASH IS LOAD-BEARING. Without it Firefox resolves this against the
// calling document's base URI - the popup - and tries to load
// moz-extension://<uuid>/popup/content/find-replace.js, which 404s with
// "Unable to load script" and leaves the page with no content script at all.
// A leading slash is unambiguously extension-root-relative.
// This was found only by clicking the real toolbar button in a real Firefox
// and reading the browser console; a mocked test that asserts the string it
// was given agrees with the bug and passes.
const CONTENT_SCRIPT_PATH = "/content/find-replace.js";

/**
 * Build the message payload sent to the content script for count/replace
 * actions, per the SPEC's message-passing contract.
 * @param {"count"|"replace"|"undo"|"cancel"} action
 */
function buildMessage(action) {
  const state = collectState();
  return {
    action,
    find: state.find,
    replace: state.replace,
    options: state.options,
    fieldTypes: state.fieldTypes,
  };
}

/**
 * Ensure the content script is present in the given tab, injecting it ONLY
 * if it genuinely isn't there yet.
 *
 * Why the ping-first check matters (do not simplify this away): re-injecting
 * content/find-replace.js re-runs its top-level IIFE, which RESETS its
 * module-level state - including the last-replace undo snapshot
 * (lastUndoSnapshot) and the in-flight-run cancellation flag (cancelled). If
 * this function injected unconditionally every time the popup opened, a user
 * who ran a replace, closed the popup, and reopened it would silently lose
 * their undo snapshot. Pinging first and injecting only when the ping fails
 * (no receiver in the tab) preserves that state across popup open/close
 * cycles - injection happens exactly once per page load, not once per popup
 * open.
 *
 * The popup's own module-level state (hasUndoableChange) does NOT persist
 * across a popup close/reopen - the popup document is destroyed and rebuilt
 * every time, resetting every `let`/`const` in this file. The content
 * script's snapshot is the only thing that actually survives, which is why
 * the ping response below is returned to the caller: the content script is
 * the single source of truth for undo availability, and init() uses this
 * return value (never a locally-remembered boolean) to decide whether the
 * Undo button should be enabled on mount.
 *
 * This needs no host_permissions: activeTab is granted by the user's click
 * on the toolbar action that opened this popup, and `scripting` is already
 * declared in manifest.json.
 * @param {number} tabId
 * @returns {Promise<{ok: boolean, undoAvailable?: boolean, undoCount?: number}|null>}
 *   The content script's ping response when one was reachable (either
 *   already present, or freshly injected - in which case undo state is
 *   synthesized as empty, since a fresh injection always starts with no
 *   snapshot); null if the page could not be reached/scripted at all.
 */
async function ensureContentScriptInjected(tabId) {
  if (typeof tabId !== "number") {
    return null;
  }

  try {
    const response = await browser.tabs.sendMessage(tabId, { action: "ping" });
    // Resolved - the content script is already present and its state
    // (undo snapshot, cancelled flag) is intact. Hand the real response
    // back so the caller can trust it over any locally-held assumption.
    return response || null;
  } catch (error) {
    // No receiver in the tab - the content script isn't loaded (fresh
    // navigation, or the very first time the popup has opened against this
    // tab). Fall through and inject it below.
  }

  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT_PATH],
    });
    // A freshly injected content script always starts with an empty undo
    // snapshot - its module-level state was just created from scratch.
    return { ok: true, undoAvailable: false, undoCount: 0 };
  } catch (error) {
    // Genuinely unscriptable page (about:, the add-ons manager,
    // view-source:, etc.) - fail quietly. sendToContentScript's own
    // messaging attempt will fail too and surface the friendly status line;
    // this helper never throws.
    console.warn(
      "Form Field Find & Replace: content script injection failed",
      error
    );
    return null;
  }
}

/**
 * Send a message to the content script in the active tab. If the content
 * script isn't there yet (fresh navigation, or a tab the popup has never
 * talked to), ensure it's injected and retry the send exactly once before
 * giving up. Genuinely unscriptable pages (about:, the add-ons manager,
 * view-source:, etc.) still fail gracefully via the catch below rather than
 * throwing.
 * @param {"count"|"replace"|"undo"|"cancel"} action
 */
async function sendToContentScript(action) {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab || typeof tab.id !== "number") {
      setStatus("No active tab available.", { error: true });
      return null;
    }

    try {
      return await browser.tabs.sendMessage(tab.id, buildMessage(action));
    } catch (firstError) {
      // No receiver - ensure the content script is injected and retry the
      // send exactly once before giving up.
      await ensureContentScriptInjected(tab.id);
      return await browser.tabs.sendMessage(tab.id, buildMessage(action));
    }
  } catch (error) {
    // Both the original send and the retry-after-injection failed - most
    // likely the active page simply can't be scripted by an extension
    // (about:, the add-ons manager, view-source:, etc.). Surface a friendly
    // status rather than an unhandled rejection.
    setStatus(
      "Could not reach the page. (This page can't be scripted by an extension.)",
      { error: true }
    );
    return null;
  }
}

// ---- Field types: collapsible section, select all/none -----------------

function toggleFieldTypesSection() {
  const expanded = els.fieldTypesToggle.getAttribute("aria-expanded") === "true";
  const next = !expanded;
  els.fieldTypesToggle.setAttribute("aria-expanded", String(next));
  if (next) {
    els.fieldTypesContent.removeAttribute("hidden");
  } else {
    els.fieldTypesContent.setAttribute("hidden", "");
  }
}

function setAllFieldTypes(checked) {
  for (const checkbox of fieldTypeCheckboxes) {
    checkbox.checked = checked;
  }
  persistState();
}

// ---- Actions -------------------------------------------------------------

async function handleCount() {
  // One of the two documented save triggers. Recorded here, from the state as
  // it is at the moment the user invoked the action - not later from the
  // response, which could arrive after they have started editing the boxes
  // again.
  recordHistoryEntry();

  setStatus("Counting matches...");
  const response = await sendToContentScript("count");
  if (!response) {
    return;
  }
  if (response.error) {
    setStatus(response.error, { error: true });
    return;
  }

  // Resync the Undo button from the content script while we have a fresh
  // round trip in hand. This closes a real staleness window: the popup can
  // sit open while the tab navigates, which destroys the content script and
  // its undo snapshot. Without this, Undo keeps rendering enabled until the
  // user clicks it and gets "Nothing was restored" - the button promising
  // something that is already gone. `count` is the natural place to do it
  // because it is the one read-only action a user may run repeatedly, and it
  // costs no extra message.
  if (typeof response.undoAvailable === "boolean") {
    hasUndoableChange = response.undoAvailable;
    updateButtonStates();
  }

  setStatus(`${response.matches ?? 0} matches in ${response.fields ?? 0} fields`);
}

async function handleReplaceAll() {
  // Preflight (phase 5, SPEC.md "Undo at scale"): find out whether undo
  // will be disabled for this run BEFORE any field is touched, not after.
  // A lightweight "count" message reports `totalFields` - the full
  // collected+filtered field count regardless of match - independent of
  // the "Count matches" button's own status text below.
  // The other documented save trigger. Recorded before the preflight so the
  // entry exists even if the preflight or the run itself fails - the user
  // still invoked this search, and losing it because the page could not be
  // reached would be the opposite of helpful.
  recordHistoryEntry();

  setUndoWarning(null);
  const preflight = await sendToContentScript("count");
  if (
    preflight &&
    !preflight.error &&
    typeof preflight.totalFields === "number" &&
    preflight.totalFields > UNDO_SNAPSHOT_CAP
  ) {
    setUndoWarning(
      `Warning: ${preflight.totalFields} fields were found, which exceeds the ` +
        `${UNDO_SNAPSHOT_CAP.toLocaleString()}-entry undo limit. Undo will be ` +
        `disabled for this run.`
    );
  }

  runInFlight = true;
  updateButtonStates();
  setStatus("Replacing...");
  setProgress(0, 0);

  const response = await sendToContentScript("replace");

  runInFlight = false;
  updateButtonStates();

  if (!response) {
    return;
  }
  if (response.error) {
    setStatus(response.error, { error: true });
    return;
  }

  setProgress(response.done ?? response.total ?? 0, response.total ?? 0);

  // Phase 7: reflects THIS run's outcome unconditionally (not just "set it
  // to true sometimes") - starting a new replace run replaces the previous
  // undo snapshot in the content script (one level only, never a stack), so
  // a run that changed nothing must also clear any undo state left over
  // from a PRIOR run, not merely leave a stale "enabled" Undo button
  // pointing at a snapshot that no longer exists. Applies identically
  // whether this run completed normally or was cancelled partway through -
  // `response.replaced` already reflects only the fields actually changed
  // before cancellation in that case.
  hasUndoableChange = (response.replaced ?? 0) > 0 && response.undoAvailable !== false;
  updateButtonStates();

  const wallMs = Math.round(response.wallMs ?? 0);
  const parts = [
    response.cancelled
      ? `Cancelled - replaced ${response.replaced ?? 0} of ${response.total ?? 0} fields`
      : `Replaced ${response.replaced ?? 0} of ${response.fields ?? 0} fields`,
  ];
  if (response.skipped) {
    parts.push(`${response.skipped} skipped`);
  }
  if (response.timedOut) {
    parts.push(`${response.timedOut} timed out`);
  }
  setStatus(`${parts.join(", ")} (${wallMs}ms)`);
}

async function handleUndo() {
  setStatus("Undoing last replace...");
  const response = await sendToContentScript("undo");
  if (!response) {
    return;
  }
  if (response.error) {
    setStatus(response.error, { error: true });
    return;
  }

  // The content script is the single source of truth here: `restored` is
  // the count it ACTUALLY wrote back, not a request echo. restored === 0
  // means its snapshot was already empty - most likely because the tab
  // navigated (or the popup's earlier ping failed and re-injection reset
  // the content script's module state) since the last replace. Either way
  // nothing was recovered, and the user must be told that plainly rather
  // than being reassured with "Undo complete."
  const restored = response.restored ?? 0;

  hasUndoableChange = false;
  updateButtonStates();

  if (restored === 0) {
    setStatus(
      "Nothing was restored - the page may have reloaded since the last " +
        "replace, so the previous values could not be recovered.",
      { error: true }
    );
    return;
  }

  setStatus(`Undo complete. Restored ${restored} field${restored === 1 ? "" : "s"}.`);
}

async function handleCancel() {
  if (!runInFlight) {
    return;
  }
  await sendToContentScript("cancel");
  runInFlight = false;
  updateButtonStates();
  setStatus("Cancelled.");
}

// ---- Event wiring --------------------------------------------------------

function wireEvents() {
  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    handleReplaceAll();
  });

  els.countBtn.addEventListener("click", () => {
    handleCount();
  });

  els.undoBtn.addEventListener("click", () => {
    handleUndo();
  });

  els.cancelBtn.addEventListener("click", () => {
    handleCancel();
  });

  els.fieldTypesToggle.addEventListener("click", () => {
    toggleFieldTypesSection();
  });

  els.selectAll.addEventListener("click", (event) => {
    event.preventDefault();
    setAllFieldTypes(true);
  });

  els.selectNone.addEventListener("click", (event) => {
    event.preventDefault();
    setAllFieldTypes(false);
  });

  // Persist on any relevant change.
  const persistOnInputs = [els.find, els.replace];
  for (const el of persistOnInputs) {
    el.addEventListener("input", persistState);
  }

  const persistOnChange = [
    els.matchCase,
    els.wholeWord,
    els.regex,
    els.includeIframes,
    ...fieldTypeCheckboxes,
  ];
  for (const el of persistOnChange) {
    el.addEventListener("change", persistState);
  }

  // Live preview: recompute (debounced) whenever anything that affects
  // matching/substitution changes. Field-type and include-iframes changes
  // don't affect the match/substitution itself, so they're excluded.
  const previewOnInputs = [els.find, els.replace];
  for (const el of previewOnInputs) {
    el.addEventListener("input", schedulePreviewUpdate);
  }

  const previewOnChange = [els.matchCase, els.wholeWord, els.regex];
  for (const el of previewOnChange) {
    el.addEventListener("change", schedulePreviewUpdate);
  }

  // ---- History dropdowns ----
  //
  // Wired here, inside wireEvents, which init() calls only AFTER the remembered
  // list has been read. That ordering is not incidental - see init().
  for (const key of ["find", "replace"]) {
    const ui = historyUi[key];

    // Clicking an UNFOCUSED input fires focus first and click second. Without
    // the flag below, focus opened the dropdown and the click that caused it
    // immediately toggled it shut again - so a single click appeared to do
    // nothing at all. The flag makes the first click after a focus-open a
    // no-op, and every click after that a real toggle.
    ui.input.addEventListener("focus", () => {
      const wasOpen = openHistoryKey === key;
      openHistoryDropdown(key);
      openedByFocusKey = !wasOpen && openHistoryKey === key ? key : null;
    });

    ui.input.addEventListener("click", () => {
      if (openedByFocusKey === key) {
        openedByFocusKey = null;
        return;
      }
      if (openHistoryKey === key) {
        closeHistoryDropdown();
      } else {
        openHistoryDropdown(key);
      }
    });

    ui.input.addEventListener("keydown", (event) => {
      handleHistoryKeydown(key, event);
    });

    // Rows are created and destroyed on every open, so the listener lives on
    // the listbox and reads the index off the row - not one listener per row.
    ui.listbox.addEventListener("click", (event) => {
      const row = event.target.closest("[data-history-index]");
      if (!row) {
        return;
      }
      selectHistoryEntry(Number(row.dataset.historyIndex));
    });

    // Keep the input focused when the user presses the mouse on a ROW, so the
    // blur does not tear the list down before the click can land on anything.
    //
    // Scoped to the listbox, and to rows within it, deliberately. An earlier
    // version bound this to the whole overlay, which made it a
    // preventDefault() sitting across a region that overlaps the option
    // checkboxes below - and under parallel-test contention that produced
    // clicks on "Regular expression" that focused the checkbox without
    // toggling it. A guard wide enough to swallow input meant for other
    // controls is worse than the blur it was preventing.
    ui.listbox.addEventListener("mousedown", (event) => {
      if (event.target.closest("[data-history-index]")) {
        event.preventDefault();
      }
    });

    ui.clearBtn.addEventListener("click", () => {
      clearHistory();
      closeHistoryDropdown();
      setStatus("Remembered searches cleared.");
    });
  }

  // A click anywhere outside an open dropdown dismisses it, leaving whatever
  // the user had typed untouched.
  document.addEventListener("click", (event) => {
    if (!openHistoryKey) {
      return;
    }
    const combo = historyUi[openHistoryKey].input.closest(".combo");
    if (combo && !combo.contains(event.target)) {
      closeHistoryDropdown();
    }
  });

  // Escape cancels an in-flight run, otherwise closes the popup.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (runInFlight) {
        handleCancel();
      } else {
        window.close();
      }
    }
  });
}

// ---- Init ------------------------------------------------------------------

async function init() {
  // Both reads happen BEFORE wireEvents, so no handler can run against an
  // empty historyEntries and write a truncated list back over a real one.
  // They are independent reads of different keys, so they run concurrently
  // rather than one after the other.
  //
  // Reversing this order is a real data-loss bug, not a tidiness issue: a
  // click landing before the load resolved would record against an empty
  // cache and persist a ONE-entry array over however many were really stored.
  // That is the same shape as the restoreState()-overwrites-typed-input defect
  // this project already shipped once. Pinned by "an action fired before
  // init() finishes cannot truncate the stored history" in
  // test/history-dropdown.spec.js, which holds storage open for 800ms, clicks
  // inside the gap, and asserts all five seeded entries survive.
  const [, loadedHistory] = await Promise.all([restoreState(), loadHistory()]);
  historyEntries = loadedHistory;

  wireEvents();
  registerProgressListener();
  updateButtonStates();
  setProgress(0, 0);
  updatePreview();

  // Automation-friendly readiness marker. Every control in popup.html exists
  // in the static markup and is enabled from first paint, so "the button is
  // there and not disabled" does NOT mean init() has finished wiring it. A
  // click landing in that gap reaches no handler at all: nothing is sent to
  // the content script and no status is written, which in a test reads as an
  // inexplicable no-op rather than as a race. This attribute is set only after
  // every listener is attached and the remembered list has been loaded, so a
  // test can wait on something that is actually true rather than on a proxy
  // for it.
  //
  // That gap is not hypothetical and not merely asserted here - a test pins
  // it: "no action handler is attached until the readiness marker is set" in
  // test/history-dropdown.spec.js holds storage open, checks the button is
  // present and enabled while the marker is still absent, clicks it, and
  // asserts zero messages were sent.
  //
  // Set before the content-script injection below, deliberately: injection
  // depends on a scriptable tab and may legitimately fail, but the popup UI
  // is fully functional either way.
  document.body.dataset.ffrReady = "true";

  // Ensure the content script is present in the active tab as soon as the
  // popup opens, using the activeTab grant from the click that opened it.
  // This is what makes the real click-to-use flow actually work (see
  // background.js's comment on why injection can't happen from onClicked),
  // and it makes the flow testable end-to-end without requiring the user to
  // press Count/Replace first. ensureContentScriptInjected pings before
  // injecting, so this is a no-op if the script is already there.
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab && typeof tab.id === "number") {
      const pingResponse = await ensureContentScriptInjected(tab.id);
      // The content script is the single source of truth for undo
      // availability - this popup document was just created from scratch,
      // so hasUndoableChange's initial `false` is only a placeholder until
      // this real answer comes back. A prior popup session may have left a
      // valid snapshot behind in this tab; do not leave Undo disabled just
      // because this fresh module instance has never heard about it.
      hasUndoableChange = Boolean(pingResponse && pingResponse.undoAvailable);
      updateButtonStates();
    }
  } catch (error) {
    // No active tab, or a page that can't be scripted - the first real
    // action (Count/Replace) will surface its own friendly status.
    console.warn(
      "Form Field Find & Replace: could not ensure content script on init",
      error
    );
  }
}

init();
