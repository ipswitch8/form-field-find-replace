// web-ext configuration.
//
// Empirically verified (web-ext 10.6.0) that a bare ".web-ext-ignore" file is
// NOT auto-discovered — only this CommonJS config file (or --ignore-files on
// the CLI) is honored. This is the mechanism that actually keeps test/ and
// other dev-only files out of both `web-ext lint` and `web-ext build` output,
// so the shipped package and the lint report only ever see extension code.
module.exports = {
  ignoreFiles: [
    "test",
    "test/**",
    "test-results",
    "test-results/**",
    "playwright-report/**",
    "playwright.config.js",
    "node_modules/**",
    "web-ext-artifacts/**",
    "package.json",
    "package-lock.json",
    "SPEC.md",
    "ff_plugin.md",
    "security-findings.log",
    "security-audit.sh",
    "sign.sh",
    // NEVER package the AMO credentials. web-ext sign uploads the built
    // archive to Mozilla, so anything not excluded here leaves this machine.
    ".amo-credentials",
    ".amo-credentials.*",
    // web-ext sign's own upload-correlation cache. Machine-local state; it has
    // no business in the shipped archive or in git.
    ".amo-upload-uuid",
    ".claude-security.json",
    "CLAUDE.md",
    "README.md",
    ".claude/**",
    ".claude-flow/**",
    ".git/**",
    ".gitignore",
    ".web-ext-ignore",
    "web-ext-config.cjs",
  ],
};
