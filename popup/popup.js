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
    els.matchPreview.textContent = "";
    els.matchPreview.classList.remove("status-error");
    return;
  }

  if (state.find === "") {
    els.matchPreview.textContent = "";
    els.matchPreview.classList.remove("status-error");
    return;
  }

  const result = window.__ffr.computeFirstMatchPreview(
    PREVIEW_SAMPLE_TEXT,
    state.find,
    state.replace,
    state.options
  );

  if (!result.ok) {
    els.matchPreview.textContent = result.error || "Invalid pattern.";
    els.matchPreview.classList.add("status-error");
    return;
  }

  els.matchPreview.classList.remove("status-error");

  if (!result.hasMatch) {
    els.matchPreview.textContent = "No match in sample text.";
    return;
  }

  els.matchPreview.textContent = result.preview;
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

// ---- Messaging (stubs until content/find-replace.js exists) -----------

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
 * Send a message to the content script in the active tab. Content script
 * injection and handling arrive in phase 2 - until then this fails
 * gracefully and reports so via the status line, rather than throwing.
 * @param {"count"|"replace"|"undo"|"cancel"} action
 */
async function sendToContentScript(action) {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab || typeof tab.id !== "number") {
      setStatus("No active tab available.", { error: true });
      return null;
    }

    const response = await browser.tabs.sendMessage(tab.id, buildMessage(action));
    return response;
  } catch (error) {
    // Expected until the content script is implemented (phase 2), and also
    // whenever the active page cannot be scripted (about:, add-ons manager,
    // etc.). Surface a friendly status rather than an unhandled rejection.
    setStatus(
      "Could not reach the page. (Content script not available yet.)",
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
  setStatus("Counting matches...");
  const response = await sendToContentScript("count");
  if (!response) {
    return;
  }
  if (response.error) {
    setStatus(response.error, { error: true });
    return;
  }
  setStatus(`${response.matches ?? 0} matches in ${response.fields ?? 0} fields`);
}

async function handleReplaceAll() {
  // Preflight (phase 5, SPEC.md "Undo at scale"): find out whether undo
  // will be disabled for this run BEFORE any field is touched, not after.
  // A lightweight "count" message reports `totalFields` - the full
  // collected+filtered field count regardless of match - independent of
  // the "Count matches" button's own status text below.
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
  hasUndoableChange = false;
  updateButtonStates();
  setStatus("Undo complete.");
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
  await restoreState();
  wireEvents();
  registerProgressListener();
  updateButtonStates();
  setProgress(0, 0);
  updatePreview();
}

init();
