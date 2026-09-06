/**
 * Form Field Find & Replace - popup logic.
 *
 * Phase 1 scope: UI shell, persistence to storage.local, keyboard handling,
 * and button wiring. The content script (content/find-replace.js) does not
 * exist yet - message sends are wrapped so they fail gracefully with a
 * status-line message rather than throwing, until phase 2 lands.
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
};

const fieldTypeCheckboxes = Array.from(
  document.querySelectorAll(".field-type-checkbox")
);

// ---- Run state (not persisted) -----------------------------------------

let runInFlight = false;
let hasUndoableChange = false;

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

  if ((response.replaced ?? 0) > 0) {
    hasUndoableChange = true;
  }
  updateButtonStates();

  setStatus(
    `Replaced ${response.replaced ?? 0} of ${response.fields ?? 0} fields` +
      (response.skipped ? `, ${response.skipped} skipped` : "")
  );
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
  updateButtonStates();
  setProgress(0, 0);
}

init();
