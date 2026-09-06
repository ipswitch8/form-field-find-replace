// Playwright config for the Form Field Find & Replace test harness.
//
// Playwright cannot easily load a real Firefox extension, so these tests
// load the fixture HTML pages directly in a plain Firefox page and inject
// content/find-replace.js via addScriptTag - see content/find-replace.js's
// header comment for how the script supports that dual mode. Firefox is
// used as the project browser for fidelity with the target platform (this
// is a Firefox extension, per SPEC.md / manifest.json's
// browser_specific_settings.gecko).
//
// @ts-check
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./test",
  testMatch: /.*\.spec\.js/,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [
    ["list"],
    ["junit", { outputFile: "test-results/gtest-results.xml" }],
  ],
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
  ],
});
