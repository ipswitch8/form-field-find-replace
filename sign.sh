#!/usr/bin/env bash
# Sign the extension through addons.mozilla.org for permanent installation.
#
# WHY THIS SCRIPT EXISTS
# ----------------------
# Release Firefox refuses unsigned extensions permanently and ignores the
# xpinstall.signatures.required pref, so the only way to install this add-on
# permanently on release Firefox is a signed .xpi from AMO.
#
# CHANNEL: unlisted. That means self-distribution - AMO signs the package and
# hands it back, but does not publish it in the public add-on directory. It
# goes through automated validation only, not human review. That is the right
# channel for a private/internal tool. Use --channel=listed only if you
# actually intend to publish it publicly.
#
# CREDENTIALS
# -----------
# Generate them at:
#   https://addons.mozilla.org/en-US/developers/addon/api/key/
# ("JWT issuer" and "JWT secret" - the secret is shown ONCE.)
#
# Put them in a file named .amo-credentials in this directory:
#
#   WEB_EXT_API_KEY=user:12345678:123
#   WEB_EXT_API_SECRET=<the long secret>
#
# That filename is gitignored. Do NOT paste the secret into a chat window, a
# commit message, or this script.
set -euo pipefail

cd "$(dirname "$0")"

CRED_FILE=".amo-credentials"

if [ ! -f "$CRED_FILE" ]; then
  cat >&2 <<'EOF'
sign.sh: no .amo-credentials file found.

Create it in this directory with your AMO API credentials:

    WEB_EXT_API_KEY=user:12345678:123
    WEB_EXT_API_SECRET=<the long secret>

Generate them at https://addons.mozilla.org/en-US/developers/addon/api/key/
(you need a Mozilla account; the secret is displayed only once).

The file is gitignored. Nothing was submitted.
EOF
  exit 2
fi

# Load without echoing. `set -a` exports everything defined in the file.
set -a
# shellcheck source=/dev/null
. "./${CRED_FILE}"
set +a

if [ -z "${WEB_EXT_API_KEY:-}" ] || [ -z "${WEB_EXT_API_SECRET:-}" ]; then
  echo "sign.sh: ${CRED_FILE} is missing WEB_EXT_API_KEY or WEB_EXT_API_SECRET." >&2
  exit 2
fi

CHANNEL="${1:-unlisted}"
case "$CHANNEL" in
  unlisted|listed) ;;
  *) echo "sign.sh: channel must be 'unlisted' or 'listed', got '$CHANNEL'" >&2; exit 2 ;;
esac

echo "Submitting to AMO for signing (channel: ${CHANNEL})..."
echo "Add-on id: $(node -p "require('./manifest.json').browser_specific_settings.gecko.id")"
echo "Version:   $(node -p "require('./manifest.json').version")"
echo

# web-ext sign builds, uploads, waits for validation, and downloads the signed
# .xpi into web-ext-artifacts/ on success.
npx --yes web-ext sign \
  --channel="$CHANNEL" \
  --api-key="$WEB_EXT_API_KEY" \
  --api-secret="$WEB_EXT_API_SECRET"

echo
echo "Signed artifacts:"
ls -la web-ext-artifacts/*.xpi 2>/dev/null || echo "  (none found - check the output above)"
