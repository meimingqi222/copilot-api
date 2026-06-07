import config from "@echristian/eslint-config"

export default config(
  {
    prettier: {
      plugins: ["prettier-plugin-packagejson"],
      endOfLine: "auto",
    },
  },
  {
    ignores: ["tools/**"],
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
      // Browser globals (Alpine, API, I18n, lucide, Chart) are injected via <script>
      "no-undef": "off",
      // View functions are global entry points referenced from HTML x-data=""
      "@typescript-eslint/no-unused-vars": "off",
      // View functions are inherently longer than 300 lines
      "max-lines-per-function": "off",
      // Alpine event handlers are fire-and-forget by convention
      "@typescript-eslint/no-floating-promises": "off",
      // void Alpine.$data() is standard Alpine.js reactivity tracking pattern
      "@typescript-eslint/no-confusing-void-expression": "off",
      // UI code legitimately uses ternaries for conditional rendering
      "no-nested-ternary": "off",
      // String concatenation with any is unavoidable in Alpine.js template code
      "@typescript-eslint/restrict-plus-operands": "off",
    },
  },
  // Global rule adjustments for practical development
  {
    rules: {
      // max-params: 3 is too restrictive for interface implementations and legitimate use cases
      "max-params": ["error", 5],
      // 100 lines per function is too aggressive for complex API handlers
      "max-lines-per-function": [
        "error",
        { max: 300, skipBlankLines: true, skipComments: true },
      ],
      // require-atomic-updates has many false positives in async code
      "require-atomic-updates": "off",
      // complexity: 16 is too restrictive for complex business logic
      complexity: ["error", 60],
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
      complexity: "off",
    },
  },
  // Pages JS overrides must come after global rules to take precedence
  {
    files: ["pages/**/*.js"],
    rules: {
      "max-lines-per-function": "off",
      "max-lines": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
    },
  },
  // Mimo native protocol adapter handles WebSocket messages with dynamic types
  {
    files: ["src/services/protocols/mimo-native.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
)
