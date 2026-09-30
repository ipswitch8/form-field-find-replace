#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Report this add-on's state on addons.mozilla.org, without opening a browser.

WHY
---
While a listed version is in review the public pages 404 and the public API
answers "Authentication credentials were not provided", so there is no way to
see what AMO actually holds - whether the listing is complete, whether the icon
and screenshots arrived, what the reviewers have done - short of logging in and
clicking. This asks the API directly.

It answers three questions that are otherwise guesswork:

  1. Is the listing complete, or is AMO still waiting for something?
  2. Did the images land? (They cannot be submitted through the API, so they
     are the most likely thing to be missing.)
  3. What is the review status of each version?

CREDENTIALS
-----------
Reads .amo-credentials, the same gitignored file sign.sh uses. The secret is
used to compute an HMAC and is never printed, never placed on a command line,
and never written anywhere. A JWT is minted per run with a 60-second lifetime,
which is what AMO's API expects.

No third-party dependency: the JWT is ~15 lines of hmac/base64/json, which is
cheaper than adding PyJWT to a project that ships no runtime dependencies.

Usage:
    python tools/check-amo-status.py
    python tools/check-amo-status.py --json     # raw record, for scripting
"""

import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import amo_api  # noqa: E402

if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SLUG = amo_api.SLUG
GUID = amo_api.GUID
localised = amo_api.localised


def get(path, token):
    return amo_api.get(path, token)


def describe(addon):
    print("Add-on")
    print("  name          : {}".format(localised(addon.get("name")) or "(unset)"))
    print("  guid          : {}".format(addon.get("guid")))
    print("  slug          : {}".format(addon.get("slug")))
    print("  status        : {}".format(addon.get("status")))
    print("  listed as     : {}".format(addon.get("is_disabled") and "DISABLED" or "enabled"))
    url = (addon.get("url") or "")
    if url:
        print("  public page   : {}".format(url))

    print()
    print("Listing fields")
    for label, key in [("summary", "summary"), ("description", "description")]:
        text = localised(addon.get(key))
        mark = "set ({} chars)".format(len(text)) if text else "MISSING"
        print("  {:<14}: {}".format(label, mark))

    # The detail endpoint does not return the policy TEXT, only a boolean, so
    # `privacy_policy` being absent from the payload means nothing on its own -
    # `has_privacy_policy` is the field that actually answers the question.
    has_policy = bool(addon.get("has_privacy_policy"))
    print("  {:<14}: {}".format(
        "privacy policy", "set" if has_policy else "MISSING"))

    cats = addon.get("categories")
    print("  {:<14}: {}".format("categories", cats if cats else "MISSING"))

    support_email = localised(addon.get("support_email"))
    support_url = localised(addon.get("support_url"))
    print("  {:<14}: {}".format("support email", support_email or "MISSING"))
    print("  {:<14}: {}".format("support url", support_url or "MISSING"))
    print("  {:<14}: {}".format("homepage", localised(addon.get("homepage")) or "(unset)"))

    print()
    print("Images  (these cannot be submitted through the API)")
    icon = addon.get("icon_url") or ""
    icons = addon.get("icons") or {}
    # AMO serves a generic placeholder when no icon has been uploaded; its URL
    # says so, which is how "uploaded" is told from "defaulted".
    is_default_icon = (not icon) or ("default" in icon.lower())
    print("  icon          : {}".format(
        "MISSING (AMO placeholder)" if is_default_icon else "uploaded"))
    if icon:
        print("                  {}".format(icon))
    if icons:
        print("                  sizes: {}".format(", ".join(sorted(icons.keys()))))

    previews = addon.get("previews") or []
    print("  screenshots   : {}".format(len(previews) if previews else "MISSING (none)"))
    for i, p in enumerate(previews, 1):
        caption = localised(p.get("caption")) or "(no caption)"
        print("    {}. {}".format(i, caption))


def describe_versions(versions):
    print()
    print("Versions")
    if not versions:
        print("  (none returned)")
        return
    for v in versions[:5]:
        f = (v.get("file") or {})
        print("  {:<10} channel={:<9} file status={:<10} id={}".format(
            v.get("version"),
            v.get("channel") or "?",
            f.get("status") or "?",
            v.get("id"),
        ))
        if f.get("url"):
            print("             download: {}".format(f["url"]))


def main():
    want_json = "--json" in sys.argv[1:]
    token = amo_api.token()

    addon = None
    for ident in (SLUG, GUID):
        addon, err = get("/addons/addon/{}/".format(ident), token)
        if addon:
            break
    if not addon:
        print("could not read the add-on record: {}".format(err), file=sys.stderr)
        return 1

    if want_json:
        print(json.dumps(addon, indent=2, sort_keys=True))
        return 0

    describe(addon)

    versions, verr = get("/addons/addon/{}/versions/?filter=all_with_unlisted"
                         .format(addon.get("slug") or GUID), token)
    if versions:
        describe_versions(versions.get("results") or [])
    elif verr:
        print()
        print("Versions: could not read ({})".format(verr))

    print()
    status = addon.get("status")
    if status == "public":
        print("APPROVED - the public page is live.")
    elif status in ("nominated", "unreviewed", "incomplete"):
        print("Status '{}' - still with Mozilla, or still missing listing "
              "fields. See above for anything marked MISSING.".format(status))
    else:
        print("Status '{}'.".format(status))
    return 0


if __name__ == "__main__":
    sys.exit(main())
