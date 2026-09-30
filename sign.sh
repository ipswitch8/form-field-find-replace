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
#
# LISTED submissions additionally need listing metadata. Without it AMO rejects
# the upload outright:
#
#   WebExtError: Submission failed (2): Bad Request
#   {"version": {"license": ["This field, or custom_license, is required
#    for listed versions."]}}
#
# docs/amo/amo-metadata.json carries the licence plus the rest of the listing
# (summary, description, categories, support contact, privacy policy) so the
# submission arrives complete rather than landing in AMO's "incomplete" state
# to be finished by hand. It is not sent on the unlisted channel, where AMO
# neither needs nor uses it.
METADATA_ARGS=()
if [ "$CHANNEL" = "listed" ]; then
  METADATA_FILE="docs/amo/amo-metadata.json"
  if [ ! -f "$METADATA_FILE" ]; then
    echo "sign.sh: ${METADATA_FILE} is missing; a listed submission needs it." >&2
    exit 2
  fi
  METADATA_ARGS=(--amo-metadata="$METADATA_FILE")
  echo "Listing metadata: ${METADATA_FILE}"
  echo
fi

npx --yes web-ext sign \
  --channel="$CHANNEL" \
  --api-key="$WEB_EXT_API_KEY" \
  --api-secret="$WEB_EXT_API_SECRET" \
  "${METADATA_ARGS[@]}"

echo
echo "Signed artifacts:"
ls -la web-ext-artifacts/*.xpi 2>/dev/null || echo "  (none found - check the output above)"
