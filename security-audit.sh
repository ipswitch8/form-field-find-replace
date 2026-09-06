#!/usr/bin/env bash
#
# security-audit.sh - repeatable security scanner for the
# "Form Field Find & Replace" Firefox extension.
#
# Run it with:  bash security-audit.sh   (works regardless of the executable
# bit, which is recorded in git via `git update-index --chmod=+x` but is a
# cosmetic no-op on NTFS hosts - see the .git permission check below).
#
# Exit code: 0 = clean, non-zero = one or more findings (count of findings).
#
# Checks performed (configured by .claude-security.json):
#   1. Credential/secret grep scan (assignment-shaped patterns only)
#   2. .git directory permission check (NTFS-aware - see below)
#   3. manifest.json permission review against the allowlist
#   4. eval / innerHTML / Function( scan under popup/ and content/,
#      distinguishing comments/docs from live code
#   5. Host-permission breadth check (no host_permissions, no wildcard grants)
#
# A finding is a REAL problem, not a keyword hit. In particular:
#   - Comments/docs that *mention* eval, innerHTML, password, secret, token,
#     etc. to document that they are deliberately NOT used are not findings.
#   - SPEC.md, ff_plugin.md, README.md, CLAUDE.md and security-findings.log
#     are specification/audit prose and are excluded from the secret scan.
#   - type="password" markup and `type === "password"` skip-logic in the
#     extension's own code are not credential findings - only an assignment
#     of a literal value to a var/key named password/secret/token/api_key is.

set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

FINDINGS=0
CONFIG=".claude-security.json"

note()   { printf '  [info]  %s\n' "$1"; }
pass()   { printf '  [ok]    %s\n' "$1"; }
finding(){ printf '  [FOUND] %s\n' "$1"; FINDINGS=$((FINDINGS + 1)); }

if [ ! -f "$CONFIG" ]; then
  echo "security-audit: missing $CONFIG - cannot load scan configuration" >&2
  exit 1
fi

echo "=== Form Field Find & Replace - security audit ==="
echo "config: $CONFIG"
echo

# ---------------------------------------------------------------------------
# 1. Credential / secret scan
# ---------------------------------------------------------------------------
echo "--- 1. Credential / secret scan ---"

# Patterns require an assignment shape (name followed by : or = followed by a
# quoted literal of length >= 3), so prose mentioning the bare word is never a
# match. Read directly from .claude-security.json to keep policy in one file.
mapfile -t SECRET_PATTERNS < <(node -e '
  const cfg = require("./.claude-security.json");
  for (const p of cfg.secret_scan.patterns) console.log(p);
')
mapfile -t SECRET_EXCLUDES < <(node -e '
  const cfg = require("./.claude-security.json");
  for (const f of cfg.secret_scan.exclude_files) console.log(f);
')

# Build the file list: tracked-worthy source files, excluding dependency /
# build / test / vcs / pipeline-tooling directories and the documentation
# files this project deliberately excludes (they discuss credentials as
# specification and audit text, not as live secrets).
SECRET_SCAN_FILES=$(find . \
  \( -path ./node_modules -o -path ./.git -o -path ./test -o -path ./test-results \
     -o -path ./playwright-report -o -path ./web-ext-artifacts -o -path ./.claude \) -prune -o \
  -type f \( -name '*.js' -o -name '*.json' -o -name '*.html' -o -name '*.css' \) -print)

SECRET_HIT=0
for f in $SECRET_SCAN_FILES; do
  base=$(basename "$f")
  skip=0
  for ex in "${SECRET_EXCLUDES[@]}"; do
    if [ "$base" = "$ex" ]; then
      skip=1
      break
    fi
  done
  [ "$skip" -eq 1 ] && continue

  for pat in "${SECRET_PATTERNS[@]}"; do
    hit=$(grep -nEi "$pat" "$f" 2>/dev/null)
    if [ -n "$hit" ]; then
      while IFS= read -r line; do
        finding "credential-shaped assignment in $f -> $line"
        SECRET_HIT=1
      done <<< "$hit"
    fi
  done
done

if [ "$SECRET_HIT" -eq 0 ]; then
  pass "no committed-credential patterns found"
fi
echo

# ---------------------------------------------------------------------------
# 2. .git directory permission check
# ---------------------------------------------------------------------------
echo "--- 2. .git directory permission check ---"

if [ ! -d .git ]; then
  note ".git directory not present (not a git checkout) - skipping"
else
  case "${OSTYPE:-}" in
    msys*|cygwin*|win32*)
      note "Windows/NTFS host detected (OSTYPE=${OSTYPE:-unknown}): POSIX permission bits are cosmetic on NTFS and chmod is a documented no-op here. Reporting the current bits as informational only, not as a finding."
      note ".git permissions (advisory, NTFS): $(stat -c '%A' .git 2>/dev/null || ls -ld .git)"
      pass "NTFS host - permission check is informational, no finding raised"
      ;;
    *)
      PERM_OCTAL=$(stat -c '%a' .git 2>/dev/null || stat -f '%Lp' .git 2>/dev/null)
      if [ -n "$PERM_OCTAL" ]; then
        GROUP_OTHER=${PERM_OCTAL: -2}
        if echo "$GROUP_OTHER" | grep -qE '[2367]'; then
          finding ".git directory is group/other-writable (mode $PERM_OCTAL) on a POSIX filesystem"
        else
          pass ".git directory permissions are not group/other-writable (mode $PERM_OCTAL)"
        fi
      else
        note "could not determine .git permissions with stat - skipping"
      fi
      ;;
  esac
fi
echo

# ---------------------------------------------------------------------------
# 3. manifest.json permission review
# ---------------------------------------------------------------------------
echo "--- 3. manifest.json permission review ---"

if [ ! -f manifest.json ]; then
  finding "manifest.json is missing"
else
  MANIFEST_REPORT=$(node -e '
    const fs = require("fs");
    const cfg = require("./.claude-security.json");
    const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
    const allow = new Set(cfg.manifest_review.required_permissions_allowlist);
    const problems = [];

    const perms = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    for (const p of perms) {
      if (!allow.has(p)) problems.push("disallowed permission: " + p);
    }
    const missing = [...allow].filter(p => !perms.includes(p));
    if (missing.length) problems.push("missing required permission(s): " + missing.join(", "));

    for (const key of cfg.manifest_review.forbidden_keys) {
      if (Object.prototype.hasOwnProperty.call(manifest, key)) {
        problems.push("forbidden key present: " + key);
      }
    }

    if (manifest.manifest_version !== cfg.manifest_review.required.manifest_version) {
      problems.push("manifest_version is " + manifest.manifest_version + ", expected " + cfg.manifest_review.required.manifest_version);
    }

    if (cfg.manifest_review.required.background_mode === "scripts") {
      if (!manifest.background || !Array.isArray(manifest.background.scripts)) {
        problems.push("background.scripts (event page) is not declared");
      }
      if (manifest.background && manifest.background.service_worker) {
        problems.push("background.service_worker is declared (event page expected instead)");
      }
    }

    if (problems.length === 0) {
      console.log("OK");
    } else {
      for (const p of problems) console.log("PROBLEM:" + p);
    }
  ' 2>&1)

  if [ "$MANIFEST_REPORT" = "OK" ]; then
    pass "manifest.json permissions match the allowlist exactly (activeTab, scripting, storage); no forbidden keys"
  else
    while IFS= read -r line; do
      case "$line" in
        PROBLEM:*) finding "manifest.json: ${line#PROBLEM:}" ;;
        *) finding "manifest.json review error: $line" ;;
      esac
    done <<< "$MANIFEST_REPORT"
  fi
fi
echo

# ---------------------------------------------------------------------------
# 4. eval / innerHTML / Function( scan under popup/ and content/
# ---------------------------------------------------------------------------
echo "--- 4. eval / innerHTML / Function( live-code scan (popup/, content/) ---"

DANGEROUS_HIT=0
DANGEROUS_FILES=$(find popup content -type f \( -name '*.js' -o -name '*.html' \) 2>/dev/null)

# Combined pattern for a single grep pass per file (cheap - one process per
# file instead of one per line, which matters on Windows where process
# spawn is expensive). Line-level comment filtering happens afterward, in
# pure bash, only on the (typically tiny) set of candidate matches.
DANGEROUS_COMBINED='\beval\s*\(|\.innerHTML\s*=|\bnew[[:space:]]+Function\s*\(|\bFunction\s*\('

for f in $DANGEROUS_FILES; do
  candidates=$(grep -nE "$DANGEROUS_COMBINED" "$f" 2>/dev/null)
  [ -z "$candidates" ] && continue

  while IFS= read -r match; do
    line_no="${match%%:*}"
    raw_line="${match#*:}"
    trimmed="${raw_line#"${raw_line%%[![:space:]]*}"}"

    # A line is treated as a comment (never a finding) when its trimmed
    # form starts with // or * - covers both // line comments and the
    # JSDoc `/** ... * line ... */` block style used throughout this
    # codebase. Trailing inline "// ..." text is also stripped before
    # matching, since this codebase does not put "//" inside string
    # literals in the scanned directories.
    case "$trimmed" in
      '//'*|'*'*|'/**'*)
        continue
        ;;
    esac

    code_part="${raw_line%%//*}"

    if echo "$code_part" | grep -qE '\beval\s*\('; then
      finding "live eval( call in $f:$line_no -> $trimmed"
      DANGEROUS_HIT=1
    fi
    if echo "$code_part" | grep -qE '\.innerHTML\s*='; then
      finding "live .innerHTML assignment in $f:$line_no -> $trimmed"
      DANGEROUS_HIT=1
    fi
    if echo "$code_part" | grep -qE '\bnew[[:space:]]+Function\s*\(|\bFunction\s*\('; then
      finding "live Function( construction in $f:$line_no -> $trimmed"
      DANGEROUS_HIT=1
    fi
  done <<< "$candidates"
done

if [ "$DANGEROUS_HIT" -eq 0 ]; then
  pass "no live eval/innerHTML/Function( usage in popup/ or content/ (comments documenting their absence are ignored)"
fi
echo

# ---------------------------------------------------------------------------
# 5. Host-permission breadth check
# ---------------------------------------------------------------------------
echo "--- 5. Host-permission breadth check ---"

if [ -f manifest.json ]; then
  BREADTH_REPORT=$(node -e '
    const fs = require("fs");
    const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
    const problems = [];
    if (Array.isArray(manifest.host_permissions) && manifest.host_permissions.length > 0) {
      problems.push("host_permissions declared: " + JSON.stringify(manifest.host_permissions));
    }
    const perms = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    for (const p of perms) {
      if (p === "<all_urls>" || (typeof p === "string" && p.includes("*"))) {
        problems.push("wildcard/broad permission requested: " + p);
      }
    }
    if (problems.length === 0) console.log("OK");
    else for (const p of problems) console.log("PROBLEM:" + p);
  ' 2>&1)

  if [ "$BREADTH_REPORT" = "OK" ]; then
    pass "no host_permissions and no wildcard permission grants - injection stays on-demand via activeTab + scripting"
  else
    while IFS= read -r line; do
      case "$line" in
        PROBLEM:*) finding "manifest.json: ${line#PROBLEM:}" ;;
        *) finding "host-permission review error: $line" ;;
      esac
    done <<< "$BREADTH_REPORT"
  fi
fi
echo

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "=== Summary ==="
if [ "$FINDINGS" -eq 0 ]; then
  echo "CLEAN - 0 findings"
  exit 0
else
  echo "$FINDINGS finding(s) - see [FOUND] lines above"
  exit "$FINDINGS"
fi
