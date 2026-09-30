#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Say whether a .xpi is Mozilla-signed, without launching Firefox.

Installing an UNSIGNED build gives Firefox's unhelpful

    "This add-on could not be installed because it has not been verified"

which looks like a signing failure but is usually just the wrong file: the
build directory holds unsigned dev builds alongside the signed release, and
they differ only by a suffix. This prints the answer in one second.

It also asserts the archive contains EXACTLY the files the extension ships and
nothing else. That check exists because a stray directory once shipped inside a
build and nothing noticed: a shell redirect to the Windows reserved device name
`nul` creates a real directory instead of discarding output, git cannot stat
such a path (so neither `.gitignore` nor `git status` reveals it), and
web-ext packaged it. A security gate found `nul/.last-run.json` — a Playwright
run cache — inside the .xpi.

Adding `nul` to web-ext-config.cjs's ignoreFiles fixes that one name. It does
not fix the next one, because exclusion lists only exclude what you thought of.
So this is an ALLOWLIST: anything in the archive that is not on the list is a
failure, whatever it is called.

Usage:
    python check-xpi.py                 # scan web-ext-artifacts/
    python check-xpi.py path/to/file.xpi
"""

import glob
import hashlib
import io
import os
import sys
import zipfile

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = os.path.abspath(os.path.dirname(__file__))

# Exactly what the extension ships. Update this when the extension genuinely
# gains or loses a file - that is the point, it should take a deliberate edit.
#
# Directory entries ("content/") are tolerated but not required: whether a zip
# writer emits them is an implementation detail of the packer, not of what is
# being shipped.
EXPECTED_FILES = frozenset([
    "manifest.json",
    "background.js",
    "content/find-replace.js",
    "popup/popup.html",
    "popup/popup.js",
    "popup/popup.css",
    "icons/icon.svg",
])

# A Mozilla-signed build legitimately gains these. They are the signature.
SIGNING_FILES = frozenset([
    "META-INF/mozilla.rsa",
    "META-INF/mozilla.sf",
    "META-INF/manifest.mf",
])


def check_contents(names):
    """-> (ok, unexpected, missing)

    Allowlist, not a blocklist. Anything present that is not expected is a
    finding regardless of its name, which is the only way to catch the stray
    file nobody predicted.
    """
    real = set(n for n in names if not n.endswith("/"))
    allowed = EXPECTED_FILES | SIGNING_FILES
    unexpected = sorted(real - allowed)
    missing = sorted(EXPECTED_FILES - real)
    return (not unexpected and not missing, unexpected, missing)


def inspect(path):
    """-> (signed, addon_id, version, sha256, note)"""
    try:
        z = zipfile.ZipFile(path)
    except Exception as exc:
        return (False, None, None, None, "not a readable zip: {}".format(exc))

    names = z.namelist()
    # A Mozilla signature is mozilla.rsa (PKCS#7) + manifest.mf digests.
    signed = "META-INF/mozilla.rsa" in names and "META-INF/manifest.mf" in names

    addon_id = version = None
    try:
        import json
        m = json.loads(z.read("manifest.json").decode("utf-8"))
        version = m.get("version")
        addon_id = (m.get("browser_specific_settings", {})
                     .get("gecko", {})
                     .get("id"))
    except Exception:
        pass

    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)

    note = ""
    if signed:
        # Cheap integrity check: every listed digest must match the payload.
        try:
            mf = z.read("META-INF/manifest.mf").decode("utf-8", "replace")
            import base64, re
            bad = []
            blocks = mf.split("\n\n")
            for b in blocks:
                nm = re.search(r"^Name:\s*(.+?)\s*$", b, re.M)
                dg = re.search(r"^SHA256-Digest:\s*(.+?)\s*$", b, re.M)
                if not nm or not dg:
                    continue
                fn = nm.group(1)
                if fn not in names:
                    bad.append(fn + " (missing)")
                    continue
                actual = base64.b64encode(hashlib.sha256(z.read(fn)).digest()).decode()
                if actual != dg.group(1):
                    bad.append(fn + " (digest mismatch)")
            note = "tampered: " + ", ".join(bad) if bad else "digests verified"
        except Exception as exc:
            note = "could not verify digests: {}".format(exc)

    contents_ok, unexpected, missing = check_contents(names)

    return (signed, addon_id, version, h.hexdigest(), note,
            contents_ok, unexpected, missing)


def report(path):
    (signed, addon_id, version, sha, note,
     contents_ok, unexpected, missing) = inspect(path)
    mark = "SIGNED  " if signed else "UNSIGNED"
    print("{}  {}".format(mark, os.path.basename(path)))
    print("          path    : {}".format(os.path.abspath(path)))
    print("          size    : {} bytes".format(os.path.getsize(path)))
    print("          id      : {}".format(addon_id or "?"))
    print("          version : {}".format(version or "?"))
    print("          sha256  : {}".format(sha))
    if note:
        print("          check   : {}".format(note))

    if contents_ok:
        print("          contents: ok - exactly the {} shipped files"
              .format(len(EXPECTED_FILES)))
    else:
        print("          contents: FAILED")
        for n in unexpected:
            print("            unexpected file in package: {}".format(n))
        for n in missing:
            print("            MISSING from package: {}".format(n))
        print("            -> a package must contain exactly the extension and "
              "nothing else.")
        print("               If the extension genuinely changed, update "
              "EXPECTED_FILES in check-xpi.py.")
        print("               If not, something stray was picked up - see "
              "web-ext-config.cjs's ignoreFiles.")

    if signed and "tampered" not in note:
        print("          -> install THIS one (about:addons -> gear -> "
              "Install Add-on From File)")
    elif not signed:
        print("          -> do NOT install; Firefox will say "
              '"could not be installed because it has not been verified"')
    print()
    return (signed and "tampered" not in note, contents_ok)


def main():
    if len(sys.argv) > 1:
        targets = sys.argv[1:]
    else:
        targets = sorted(glob.glob(os.path.join(ROOT, "web-ext-artifacts", "*.xpi")))
        if not targets:
            print("no .xpi files in web-ext-artifacts/ - run: npm run build:xpi")
            return 2
        print("Scanning web-ext-artifacts/\n")

    any_good = False
    any_contents_bad = False
    for t in targets:
        installable, contents_ok = report(t)
        if installable:
            any_good = True
        if not contents_ok:
            any_contents_bad = True

    # A package containing the wrong FILES is a harder failure than a package
    # that merely is not signed yet: unsigned is a normal state for a dev build
    # and the operator is told to run `npm run sign`, whereas shipping a stray
    # file is a defect in the build itself. So it gets its own exit code and is
    # reported even when a signed build was also found.
    if any_contents_bad:
        print("Package contents check FAILED - see above. This is a build "
              "defect, not a signing step.")
        return 3

    if not any_good:
        print("No installable signed package found. Run: npm run sign")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
