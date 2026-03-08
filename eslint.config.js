import config from "@echristian/eslint-config"

export default config(
  {
    prettier: {
      plugins: ["prettier-plugin-packagejson"],
    },
  },
  {
    files: ["pages/**/*.js"],
    rules: {
      // Disable TypeScript rules for frontend JS files
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
    },
  },
  // Test files are inherently more verbose due to comprehensive test cases and fixtures.
  // Disabling line limits for tests is standard practice - test readability matters more
  // than arbitrary line counts.
  {
    files: ["tests/**/*.test.ts"],
    rules: {
      "max-lines-per-function": "off",
      "max-lines": "off",
    },
  },
  {
    files: ["src/routes/messages/stream-translation.ts"],
    rules: {
      // Allow 4 params for this specific function - it's a known baseline issue
      "max-params": ["error", 4],
    },
  },
)
