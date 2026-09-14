#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Say whether a .xpi is Mozilla-signed, without launching Firefox.

Installing an UNSIGNED build gives Firefox's unhelpful

    "This add-on could not be installed because it has not been verified"

which looks like a signing failure but is usually just the wrong file: the
build directory holds unsigned dev builds alongside the signed release, and
they differ only by a suffix. This prints the answer in one second.

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

    return (signed, addon_id, version, h.hexdigest(), note)


def report(path):
    signed, addon_id, version, sha, note = inspect(path)
    mark = "SIGNED  " if signed else "UNSIGNED"
    print("{}  {}".format(mark, os.path.basename(path)))
    print("          path    : {}".format(os.path.abspath(path)))
    print("          size    : {} bytes".format(os.path.getsize(path)))
    print("          id      : {}".format(addon_id or "?"))
    print("          version : {}".format(version or "?"))
    print("          sha256  : {}".format(sha))
    if note:
        print("          check   : {}".format(note))
    if signed and "tampered" not in note:
        print("          -> install THIS one (about:addons -> gear -> "
              "Install Add-on From File)")
    elif not signed:
        print("          -> do NOT install; Firefox will say "
              '"could not be installed because it has not been verified"')
    print()
    return signed and "tampered" not in note


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
    for t in targets:
        if report(t):
            any_good = True

    if not any_good:
        print("No installable signed package found. Run: npm run sign")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
