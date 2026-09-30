#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared addons.mozilla.org API helpers: credentials, JWT, GET/PATCH.

Lives here so the AMO tools do not each carry their own copy of the credential
handling. Underscored filename on purpose - `check-amo-status.py` cannot be
imported, because a hyphen is not valid in a Python module name.

CREDENTIALS DISCIPLINE
----------------------
The secret is read from .amo-credentials (gitignored, same file sign.sh uses),
used to compute an HMAC, and never printed, never passed on a command line, and
never written anywhere. JWTs are minted per call with a 60-second life, which is
what AMO expects. Nothing here logs a request body or a header.
"""

import base64
import hashlib
import hmac
import io
import json
import os
import time
import urllib.error
import urllib.request

ROOT = os.path.abspath(os.path.dirname(os.path.dirname(__file__)))
CRED = os.path.join(ROOT, ".amo-credentials")
API = "https://addons.mozilla.org/api/v5"

SLUG = "form-field-find-replace"
GUID = "inquiries@itwerx.net"


def read_credentials():
    if not os.path.isfile(CRED):
        raise SystemExit(
            "amo_api: no .amo-credentials file. See sign.sh for its format."
        )
    key = secret = None
    with io.open(CRED, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, _, value = line.partition("=")
            name = name.strip()
            value = value.strip().strip('"').strip("'")
            if name == "WEB_EXT_API_KEY":
                key = value
            elif name == "WEB_EXT_API_SECRET":
                secret = value
    if not key or not secret:
        raise SystemExit(
            "amo_api: .amo-credentials is missing WEB_EXT_API_KEY or "
            "WEB_EXT_API_SECRET."
        )
    return key, secret


def _b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=")


def make_jwt(key, secret):
    """HS256 JWT with a 60-second life, as AMO's API expects."""
    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "iss": key,
        "jti": base64.b16encode(os.urandom(8)).decode("ascii"),
        "iat": now,
        "exp": now + 60,
    }
    segments = [
        _b64url(json.dumps(header, separators=(",", ":")).encode("utf-8")),
        _b64url(json.dumps(payload, separators=(",", ":")).encode("utf-8")),
    ]
    signing_input = b".".join(segments)
    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    segments.append(_b64url(signature))
    return b".".join(segments).decode("ascii")


def token():
    key, secret = read_credentials()
    return make_jwt(key, secret)


def request(method, path, tok, body=None):
    """-> (parsed_json_or_None, error_string_or_None)"""
    data = None
    headers = {
        "Authorization": "JWT " + tok,
        "Accept": "application/json",
        "User-Agent": "form-field-find-replace tooling",
    }
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
            return (json.loads(raw) if raw.strip() else {}), None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        return None, "HTTP {}: {}".format(exc.code, detail[:500])
    except Exception as exc:
        return None, str(exc)


def get(path, tok):
    return request("GET", path, tok)


def patch(path, tok, body):
    return request("PATCH", path, tok, body)


def localised(value):
    """Unwrap AMO's several shapes for a text or URL field.

    A field comes back as any of:
        "plain string"
        {"en-US": "..."}
        {"url": {"en-US": "..."}, "outgoing": {"en-US": "https://prod.outgoing..."}}

    That last one is what `support_url` and `homepage` look like - AMO wraps
    outbound links in a redirector. Stopping at the first unrecognised shape
    prints the redirector URL instead of the link, which is what an earlier
    version of this did.
    """
    if not isinstance(value, dict):
        return value or ""
    if "url" in value and isinstance(value["url"], (dict, str)):
        return localised(value["url"])
    if "en-US" in value:
        return value["en-US"]
    if "outgoing" in value:
        return localised(value["outgoing"])
    nested = next(iter(value.values()), "")
    return localised(nested) if isinstance(nested, dict) else (nested or "")
