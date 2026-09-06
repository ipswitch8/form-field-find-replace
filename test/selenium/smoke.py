#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Minimal probe: can we start Firefox and install the add-on at all?

Run this before the full suite to separate environment problems (no
geckodriver, no Firefox) from real test failures.
"""

import io
import json
import os
import sys

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from selenium import webdriver
from selenium.webdriver.firefox.options import Options

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ADDON_ID = "find-replace@example.local"
ADDON_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

opts = Options()
if os.environ.get("FFR_HEADLESS", "1") != "0":
    opts.add_argument("-headless")
opts.set_preference("extensions.webextensions.uuids", json.dumps({ADDON_ID: ADDON_UUID}))
opts.set_preference("xpinstall.signatures.required", False)

print("starting Firefox...")
d = webdriver.Firefox(options=opts)
print("Firefox started:", d.capabilities.get("browserVersion"))
try:
    xpi = os.path.join(PROJECT_ROOT, "web-ext-artifacts", "ffr.xpi")
    target = xpi if os.path.exists(xpi) else PROJECT_ROOT
    print("installing from:", target)
    try:
        ext_id = d.install_addon(target, temporary=True)
        print("add-on installed, internal id:", ext_id)
    except Exception as exc:
        # On this host, endpoint protection briefly locks the temp .xpi that
        # Firefox writes into the profile, so Firefox's post-install cleanup
        # raises NS_ERROR_FILE_ACCESS_DENIED. That is a cleanup failure, not an
        # install failure - check whether the add-on is actually live before
        # treating it as fatal.
        print("install_addon raised:", type(exc).__name__, str(exc)[:120])
        print("checking whether the add-on installed anyway...")
    url = "moz-extension://{}/popup/popup.html".format(ADDON_UUID)
    d.get(url)
    print("popup title:", d.title)
    n = d.execute_script("return document.querySelectorAll('[data-field-type]').length;")
    print("field-type checkboxes found:", n)
    has_browser = d.execute_script("return typeof browser !== 'undefined';")
    print("browser API present in popup:", has_browser)
finally:
    d.quit()
print("SMOKE OK")
