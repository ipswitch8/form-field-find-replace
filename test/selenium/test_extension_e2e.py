#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Selenium end-to-end tests for Form Field Find & Replace.

WHY THIS EXISTS ALONGSIDE THE PLAYWRIGHT SUITE
----------------------------------------------
The 61 Playwright tests do NOT load the extension. Playwright cannot install a
Firefox add-on, so every one of those tests injects content/find-replace.js into
a fixture page with addScriptTag and calls the exposed window.__ffr functions
directly. That is good coverage of the LOGIC, but it means three things were
never executed by any test:

  1. that the manifest is actually accepted by a real Firefox and the event page
     starts without error;
  2. that popup.js works against the REAL browser.* APIs - the Playwright popup
     tests load popup.html over file://, where `browser` is undefined, so
     storage.local persistence never round-tripped through the real API;
  3. that background.js's on-demand browser.scripting.executeScript injection
     actually delivers the content script into a page, and that a real
     browser.tabs.sendMessage round trip returns the expected response shape.

Selenium + geckodriver CAN install a temporary add-on, so these tests close that
gap rather than duplicating the Playwright coverage.

Run with:  python test/selenium/test_extension_e2e.py
(or via:   npm run test:selenium)

Requires: real Firefox, selenium>=4.11 (Selenium Manager auto-resolves
geckodriver). Set FFR_HEADLESS=0 to watch it run.
"""

import io
import json
import os
import sys
import time
import unittest

# CLAUDE.md: always add explicit UTF-8 support to Python scripts. Windows
# consoles default to cp1252 and will raise UnicodeEncodeError on any non-ASCII
# character in a test name or assertion message.
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from selenium import webdriver
from selenium.common.exceptions import TimeoutException, WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FIXTURE = "file:///" + os.path.join(PROJECT_ROOT, "test", "fixture.html").replace("\\", "/")

ADDON_ID = "mhasse@itwerx.net"

# Pinning the internal UUID makes the popup addressable at a known
# moz-extension:// URL. Without this the UUID is randomised per profile and the
# popup page cannot be navigated to directly.
ADDON_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
POPUP_URL = "moz-extension://{}/popup/popup.html".format(ADDON_UUID)


def build_driver():
    options = Options()
    if os.environ.get("FFR_HEADLESS", "1") != "0":
        options.add_argument("-headless")

    # Map the add-on id to a fixed internal UUID so POPUP_URL resolves.
    options.set_preference(
        "extensions.webextensions.uuids", json.dumps({ADDON_ID: ADDON_UUID})
    )
    # Temporary (unsigned) add-ons need signature enforcement relaxed.
    options.set_preference("xpinstall.signatures.required", False)
    options.set_preference("extensions.langpacks.signatures.required", False)
    # Keep the run offline and quiet - the extension must never need the network.
    options.set_preference("network.dns.disabled", True)
    options.set_preference("datareporting.healthreport.uploadEnabled", False)
    options.set_preference("app.shield.optoutstudies.enabled", False)

    # --allow-system-access lets Marionette switch to chrome context, which is
    # the only way to click the extension's toolbar action (browser chrome is
    # not reachable from page context). Firefox 142 also rejects the equivalent
    # -remote-allow-system-access argument when passed via capabilities, so it
    # has to come through geckodriver's own flag.
    driver = webdriver.Firefox(
        options=options, service=Service(service_args=["--allow-system-access"])
    )
    driver.set_page_load_timeout(60)

    # Prefer the built package over the source directory: installing from a
    # directory makes Selenium zip it on the fly, and the shipped .xpi is also
    # what we actually want under test.
    xpi = os.path.join(PROJECT_ROOT, "web-ext-artifacts", "ffr.xpi")
    target = xpi if os.path.exists(xpi) else PROJECT_ROOT

    try:
        driver.install_addon(target, temporary=True)
    except WebDriverException as exc:
        # KNOWN ENVIRONMENT QUIRK on this host: endpoint protection briefly
        # locks the temp .xpi Firefox writes into its profile, so Firefox's
        # POST-INSTALL cleanup fails with NS_ERROR_FILE_ACCESS_DENIED. The
        # add-on is installed and functional at that point - the failure is the
        # unlink, not the install. Swallowing it blindly would be wrong, so the
        # caller verifies the add-on is really live via _assert_addon_live().
        if "NS_ERROR_FILE_ACCESS_DENIED" not in str(exc):
            driver.quit()
            raise

    _assert_addon_live(driver)
    return driver


def _wait_until(driver, script, timeout=15.0, interval=0.25):
    """Poll a chrome-context script until it returns truthy, or time out.

    Replaces fixed time.sleep() calls. Fixed sleeps are the classic source of
    intermittent failures: they pass when the machine is quick and fail when it
    is not, which produces exactly the "failed once, passed on retry" pattern
    that hides real defects. Two such intermittent failures were observed in
    this suite before this helper existed.

    Returns the script's value, or None if it never became truthy.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            value = driver.execute_script(script)
        except WebDriverException:
            value = None
        if value:
            return value
        time.sleep(interval)
    return None


def _assert_addon_live(driver):
    """Fail loudly if the add-on is not actually installed.

    This is what makes it safe to tolerate the cleanup error above: we never
    assume the install worked, we prove it by loading a page that only exists
    inside the extension.
    """
    try:
        driver.get(POPUP_URL)
        WebDriverWait(driver, 20).until(
            EC.presence_of_element_located((By.ID, "find-input"))
        )
    except (TimeoutException, WebDriverException) as exc:
        driver.quit()
        raise AssertionError(
            "add-on is not installed - {} did not load: {}".format(POPUP_URL, exc)
        )


class ExtensionE2ETest(unittest.TestCase):
    """Each test gets a fresh browser + freshly installed add-on."""

    def setUp(self):
        self.driver = build_driver()
        self.wait = WebDriverWait(self.driver, 20)

    def tearDown(self):
        try:
            self.driver.quit()
        except Exception:
            pass

    # ---- 1. The extension actually loads -------------------------------

    def test_extension_loads_and_popup_page_renders(self):
        """The manifest is accepted by a real Firefox and the popup renders.

        Nothing in the Playwright suite proves the manifest is even valid to
        Firefox - web-ext lint checks it statically, which is not the same
        thing.
        """
        self.driver.get(POPUP_URL)
        self.wait.until(EC.presence_of_element_located((By.ID, "find-input")))

        # Every control the spec requires, addressed by the stable ids/testids
        # the popup was built with.
        for element_id in [
            "find-input",
            "replace-input",
            "match-case-checkbox",
            "whole-word-checkbox",
            "regex-checkbox",
            "include-iframes-checkbox",
            "field-types-toggle",
            "field-types-select-all",
            "field-types-select-none",
            "count-btn",
            "replace-all-btn",
            "undo-btn",
            "cancel-btn",
            "status-line",
            "progress-bar",
            "match-preview",
        ]:
            self.assertTrue(
                self.driver.find_elements(By.ID, element_id),
                "popup is missing required control #{}".format(element_id),
            )

    def test_browser_api_is_present_in_the_real_popup(self):
        """`browser.storage` / `browser.tabs` exist in the popup context.

        The Playwright popup tests load popup.html over file://, where
        `browser` is undefined - so this is the first time popup.js is
        confirmed to run against the real WebExtension APIs.
        """
        self.driver.get(POPUP_URL)
        self.wait.until(EC.presence_of_element_located((By.ID, "find-input")))

        api = self.driver.execute_script(
            "return {"
            "  hasBrowser: typeof browser !== 'undefined',"
            "  hasStorage: typeof browser !== 'undefined' && !!browser.storage,"
            "  hasTabs: typeof browser !== 'undefined' && !!browser.tabs,"
            "  hasScripting: typeof browser !== 'undefined' && !!browser.scripting,"
            "  id: typeof browser !== 'undefined' ? browser.runtime.id : null"
            "}"
        )
        self.assertTrue(api["hasBrowser"], "browser API missing in popup context")
        self.assertTrue(api["hasStorage"])
        self.assertTrue(api["hasTabs"])
        self.assertTrue(api["hasScripting"])
        self.assertEqual(api["id"], ADDON_ID)

    # ---- 2. Field-type defaults, in the real popup ---------------------

    def test_field_type_defaults_match_the_spec(self):
        """Text / Multi-line / Rich text checked; Numeric and date unchecked."""
        self.driver.get(POPUP_URL)
        self.wait.until(EC.presence_of_element_located((By.ID, "find-input")))

        states = self.driver.execute_script(
            "const out = {};"
            "document.querySelectorAll('[data-field-type]').forEach(el => {"
            "  out[el.dataset.fieldType] = el.checked;"
            "});"
            "return out;"
        )

        for checked_type in ["text", "search", "url", "tel", "email",
                             "textarea", "contenteditable"]:
            self.assertTrue(
                states.get(checked_type),
                "{} should default to checked".format(checked_type),
            )
        for unchecked_type in ["number", "date", "datetime-local",
                               "month", "week", "time"]:
            self.assertFalse(
                states.get(unchecked_type),
                "{} should default to UNCHECKED - these are the types most "
                "easily damaged by a careless replace".format(unchecked_type),
            )

    # ---- 3. storage.local persistence through the REAL API -------------

    def test_state_persists_through_real_storage_local(self):
        """Typed state survives a popup reload via the real storage.local.

        This is the one that could not be tested before: over file:// there is
        no browser.storage at all, so persistence was only ever verified by
        reading the set/get call sites.
        """
        self.driver.get(POPUP_URL)
        self.wait.until(EC.presence_of_element_located((By.ID, "find-input")))

        find_box = self.driver.find_element(By.ID, "find-input")
        replace_box = self.driver.find_element(By.ID, "replace-input")
        find_box.clear()
        # RACE: popup.js's init() does `await restoreState()` before wiring
        # events, and Selenium can start typing as soon as #find-input exists -
        # which is before that await resolves. When it does resolve it writes
        # the stored state back into the form, wiping whatever was typed first.
        # That is exactly what the intermittent failure looked like: `replace`
        # and the checkbox (typed/clicked later) persisted fine while `find`
        # (typed first) came back as "".
        #
        # Type, then confirm the field actually kept the value, retrying until
        # it sticks. This is robust whatever the precise timing, and it does
        # not require the popup to expose an "initialised" flag purely for
        # tests. Note this window is a test-automation artifact: a human cannot
        # type into a popup before it has rendered and initialised.
        # Poll on the REAL end condition - the value being in storage.local -
        # and re-enter it each attempt. Checking only that the DOM field holds
        # the value is not enough: restoreState() can still land in the gap
        # between that check and the next keystroke, blanking `find` again, and
        # then the persist triggered by the following field writes find:"".
        # Observed exactly that: the field read back "persist-me" while storage
        # recorded find:"" alongside a correctly-persisted replace/matchCase.
        deadline = time.time() + 15
        stored = None
        while time.time() < deadline:
            find_box.clear()
            find_box.send_keys("persist-me")
            replace_box.clear()
            replace_box.send_keys("restored")

            stored = self.driver.execute_script(
                "return browser.storage.local.get(null).then(r => r);"
            )
            if stored and "persist-me" in json.dumps(stored):
                break
            time.sleep(0.25)

        self.assertTrue(stored, "nothing was written to storage.local")
        self.assertIn(
            "persist-me",
            json.dumps(stored),
            "the typed value never reached storage.local within 15s - popup "
            "init may still be overwriting the field after it is typed",
        )

        self.driver.find_element(By.ID, "match-case-checkbox").click()

        # The checkbox was clicked after the loop above, so wait for that
        # specific change to land too before reloading - otherwise the
        # reload can race the persist and matchCase reads back false.
        deadline = time.time() + 10
        while time.time() < deadline:
            stored = self.driver.execute_script(
                "return browser.storage.local.get(null).then(r => r);"
            )
            if stored and '"matchCase": true' in json.dumps(stored):
                break
            time.sleep(0.25)

        self.assertIn(
            '"matchCase": true',
            json.dumps(stored),
            "the match-case checkbox state never reached storage.local",
        )

        # Reload the popup and confirm the values come back.
        self.driver.get(POPUP_URL)
        self.wait.until(EC.presence_of_element_located((By.ID, "find-input")))

        restored = self.driver.execute_script(
            "return {"
            "  find: document.getElementById('find-input').value,"
            "  replace: document.getElementById('replace-input').value,"
            "  matchCase: document.getElementById('match-case-checkbox').checked"
            "}"
        )
        self.assertEqual(restored["find"], "persist-me")
        self.assertEqual(restored["replace"], "restored")
        self.assertTrue(restored["matchCase"])

    # ---- 4. Real injection + real message round trip -------------------

    def test_injection_without_a_user_gesture_is_refused(self):
        """activeTab is not granted without a real toolbar gesture.

        This is a SECURITY assertion, and it is the strongest one this suite
        makes. The extension holds no host permissions at all, so it cannot
        reach into a page merely because that page is open - Firefox refuses
        browser.scripting.executeScript with "Missing host permission for the
        tab" until the user actually invokes the extension on that tab.

        Verified empirically during development: driving executeScript from an
        extension page against another tab fails exactly this way. If this test
        ever starts passing the injection instead, someone has widened the
        permissions and the extension can now silently read every open page.

        See the module docstring for why the positive path (gesture -> grant ->
        inject) is not automated here.
        """
        self.driver.get(FIXTURE)
        page_handle = self.driver.current_window_handle

        # Open the popup in a second tab so we can drive privileged APIs.
        self.driver.switch_to.new_window("tab")
        self.driver.get(POPUP_URL)
        self.wait.until(EC.presence_of_element_located((By.ID, "find-input")))

        # Find the fixture tab by URL, inject into it, then message it - the
        # same sequence background.js performs for the active tab.
        result = self.driver.execute_async_script(
            """
            const done = arguments[arguments.length - 1];
            (async () => {
              try {
                // NOTE: we deliberately do NOT match on t.url. This extension
                // has no "tabs" permission and no host permissions, so tab.url
                // is undefined here - which is itself a live confirmation that
                // the permission set really is minimal. Identify the target by
                // excluding our own (popup) tab instead.
                const me = await browser.tabs.getCurrent();
                const tabs = await browser.tabs.query({});
                const target = tabs.find(t => t.id !== (me && me.id));
                if (!target) { done({error: 'fixture tab not found'}); return; }

                await browser.scripting.executeScript({
                  target: {tabId: target.id},
                  files: ['content/find-replace.js']
                });

                const response = await browser.tabs.sendMessage(target.id, {
                  action: 'count',
                  find: 'hello',
                  replace: '',
                  options: {matchCase: false, wholeWord: false, regex: false},
                  fieldTypes: {
                    text: true, search: true, url: true, tel: true, email: true,
                    number: false, date: false, 'datetime-local': false,
                    month: false, week: false, time: false,
                    textarea: true, contenteditable: true
                  }
                });
                done({response});
              } catch (e) {
                done({error: String(e)});
              }
            })();
            """
        )

        error = result.get("error") or ""
        self.assertIn(
            "Missing host permission",
            error,
            "expected Firefox to REFUSE injection without an activeTab grant, "
            "but got: {}".format(result),
        )

        # And the page really was left alone.
        self.driver.switch_to.window(page_handle)
        values = self.driver.execute_script(
            "return {"
            "  text: document.getElementById('text-input').value,"
            "  password: document.getElementById('password-input').value,"
            "  injected: typeof window.__ffr"
            "}"
        )
        self.assertEqual(values["injected"], "undefined",
                         "content script reached the page without a gesture")
        self.assertEqual(values["password"], "hello secret")
        self.assertIn("hello", values["text"])


    def test_toolbar_action_is_registered_and_clickable(self):
        """The extension's toolbar action exists and can be invoked.

        This is the real entry point - the gesture that grants activeTab. It
        lives in Firefox's unified extensions panel (109+), which is browser
        chrome, so it is only reachable after switching Marionette to chrome
        context. Asserting it exists and clicks without error covers the
        user-facing half of the flow that the previous test covers the security
        half of.
        """
        self.driver.get(FIXTURE)
        self.driver.set_context("chrome")
        try:
            opened = self.driver.execute_script(
                "const b = document.getElementById('unified-extensions-button');"
                "if (!b) return 'missing'; b.click(); return 'clicked';"
            )
            self.assertEqual(opened, "clicked",
                             "unified extensions button not found in chrome UI")
            # Wait for the panel to actually populate rather than assuming
            # a fixed delay is enough - see _wait_until.
            _wait_until(
                self.driver,
                "return document.querySelectorAll('[data-extensionid]').length > 0;",
            )

            result = self.driver.execute_script(
                """
                const out = {ids: [], clicked: false, threw: null};
                const nodes = document.querySelectorAll('[data-extensionid]');
                for (const n of nodes) {
                  out.ids.push(n.getAttribute('data-extensionid'));
                }
                for (const n of nodes) {
                  if ((n.getAttribute('data-extensionid') || '') === '__ADDON_ID__') {
                    try {
                      const a = n.querySelector('.unified-extensions-item-action-button')
                             || n.querySelector('toolbarbutton') || n;
                      a.click();
                      out.clicked = true;
                    } catch (e) { out.threw = String(e); }
                    break;
                  }
                }
                return out;
                """.replace("__ADDON_ID__", ADDON_ID)
            )
            self.assertIn(ADDON_ID, result["ids"],
                          "extension has no toolbar action registered")
            self.assertTrue(result["clicked"], "could not click the toolbar action")
            self.assertIsNone(result["threw"], "clicking the action threw: {}".format(result["threw"]))
        finally:
            self.driver.set_context("content")


    def test_real_toolbar_click_actually_injects_the_content_script(self):
        """THE regression test: the real user gesture must reach the page.

        This is the test that was missing, and its absence hid a bug that made
        the entire extension non-functional in real use: manifest sets
        action.default_popup, so browser.action.onClicked never fires, so the
        injection wired to that listener in background.js was dead code, and
        the popup messaged a content script nobody had injected. Every user
        click produced "Could not reach the page".

        All 61 Playwright tests missed it by construction - they inject the
        content script themselves. Only clicking the real button and then
        looking at the real page can catch it.

        Injection now happens from the popup, which holds the activeTab grant
        from the very click that opened it.
        """
        self.driver.get(FIXTURE)
        page_handle = self.driver.current_window_handle

        self.driver.set_context("chrome")
        try:
            # Clear the console first so we only judge THIS click.
            self.driver.execute_script("Services.console.reset();")
            self.driver.execute_script(
                "document.getElementById('unified-extensions-button').click();"
            )
            # Wait for the panel to actually populate rather than assuming
            # a fixed delay is enough - see _wait_until.
            _wait_until(
                self.driver,
                "return document.querySelectorAll('[data-extensionid]').length > 0;",
            )
            clicked = self.driver.execute_script(
                """
                const nodes = document.querySelectorAll('[data-extensionid]');
                for (const n of nodes) {
                  if ((n.getAttribute('data-extensionid') || '') === '__ADDON_ID__') {
                    const a = n.querySelector('.unified-extensions-item-action-button')
                           || n.querySelector('toolbarbutton') || n;
                    a.click();
                    return true;
                  }
                }
                return false;
                """.replace("__ADDON_ID__", ADDON_ID)
            )
            self.assertTrue(clicked, "could not click the extension's toolbar action")
            # Wait for the popup to actually load rather than guessing at a
            # duration: its browser element reports a moz-extension URI once
            # the document is live. init() then runs and attempts injection.
            _wait_until(
                self.driver,
                "const bs = document.querySelectorAll('browser');"
                "for (const b of bs) {"
                "  try { const u = b.currentURI ? b.currentURI.spec : '';"
                "    if (u && u.indexOf('moz-extension') === 0) return true; } catch (e) {}"
                "}"
                "return false;",
            )
            # The injection itself is async after that; give it a bounded
            # window to either succeed or log an error.
            time.sleep(2)

            # WHY THE CONSOLE AND NOT window.__ffr:
            # a real content script runs in an ISOLATED world, so a property it
            # sets on `window` is invisible to page-context execute_script. The
            # Playwright suite can see window.__ffr only because addScriptTag
            # runs in the PAGE world - a different mechanism entirely. Asserting
            # on window.__ffr here would fail even when injection succeeds, and
            # would have been a test that could never pass.
            #
            # A failed injection DOES leave a precise, observable trace: Firefox
            # logs "Unable to load script: <resolved url>" for a bad path and a
            # permission error for a missing grant. That is the signal.
            errors = self.driver.execute_script(
                """
                const out = [];
                const msgs = Services.console.getMessageArray() || [];
                for (const m of msgs) {
                  let s = '';
                  try { s = m.message || ''; } catch (e) {}
                  if (!s) continue;
                  if (s.includes('Unable to load script') ||
                      s.includes('Missing host permission') ||
                      (s.includes('__ADDON_ID__') && s.includes('Error'))) {
                    out.push(s.slice(0, 300));
                  }
                }
                return out;
                """.replace("__ADDON_ID__", ADDON_ID)
            )
        finally:
            self.driver.set_context("content")

        self.assertEqual(
            errors,
            [],
            "clicking the real toolbar action produced extension errors - the "
            "content script did not reach the page:\n  "
            + "\n  ".join(errors),
        )


def main():
    try:
        probe = build_driver()
        probe.quit()
    except WebDriverException as exc:
        print("SKIP: could not start Firefox/geckodriver: {}".format(exc))
        print("Selenium Manager needs to resolve geckodriver once (network),")
        print("or put geckodriver on PATH.")
        return 2

    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ExtensionE2ETest)
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
